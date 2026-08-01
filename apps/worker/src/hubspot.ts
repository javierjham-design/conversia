import { withTenant } from "@conversia/database";
import { getFreshOAuthToken, NoConnectionError, ReauthorizeError } from "./oauth-tokens.js";

/**
 * HubSpot: sincronización UNIDIRECCIONAL Conversia → HubSpot de contactos.
 * OAuth por tenant (tokens cifrados, refresh automático). El id del contacto
 * en HubSpot se guarda en contact.meta.hubspotContactId; antes de crear se
 * busca por teléfono/email → cero duplicados. Log por registro en
 * integration_events. 429/5xx relanzan para que BullMQ reintente.
 */

const HS = "https://api.hubapi.com";

/** Mapeo por defecto propiedad HubSpot ← campo Conversia (config.fieldMapping lo sobreescribe). */
export const DEFAULT_HUBSPOT_MAPPING: Record<string, string> = {
  firstname: "firstName",
  lastname: "lastName",
  email: "email",
  phone: "phone",
};

export interface ConversiaContactFields {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  country?: string | null;
  source?: string | null;
}

/** Construye las properties de HubSpot desde el contacto (puro; testeado). */
export function buildHubspotProperties(contact: ConversiaContactFields, mapping: Record<string, string> = DEFAULT_HUBSPOT_MAPPING): Record<string, string> {
  const props: Record<string, string> = {};
  for (const [hubspotProp, field] of Object.entries(mapping)) {
    const value = (contact as Record<string, unknown>)[field];
    if (value != null && String(value).trim() !== "") props[hubspotProp] = String(value);
  }
  return props;
}

/** Filtros de búsqueda anti-duplicados: por teléfono y/o email (puro; testeado). */
export function buildHubspotSearch(contact: ConversiaContactFields): { filterGroups: { filters: { propertyName: string; operator: string; value: string }[] }[] } | null {
  const groups: { filters: { propertyName: string; operator: string; value: string }[] }[] = [];
  if (contact.phone) groups.push({ filters: [{ propertyName: "phone", operator: "EQ", value: contact.phone }] });
  if (contact.email) groups.push({ filters: [{ propertyName: "email", operator: "EQ", value: contact.email }] });
  return groups.length ? { filterGroups: groups } : null; // OR entre grupos
}

async function getHubspotConfig(organizationId: string): Promise<{ fieldMapping: Record<string, string>; syncAuto: boolean } | null> {
  return withTenant(organizationId, async (tx) => {
    const conn = await tx.integrationConnection.findFirst({ where: { provider: "hubspot" } });
    if (!conn) return null;
    const cfg = (conn.config as Record<string, any>) ?? {};
    return {
      fieldMapping: cfg.fieldMapping && Object.keys(cfg.fieldMapping).length ? cfg.fieldMapping : DEFAULT_HUBSPOT_MAPPING,
      syncAuto: cfg.syncAuto !== false, // por defecto sincroniza al crear/editar
    };
  });
}

/** Encola la sincronización de un contacto si HubSpot está conectado con sync automático. */
export async function enqueueHubspotContact(organizationId: string, contactId: string): Promise<void> {
  try {
    const config = await getHubspotConfig(organizationId);
    if (!config?.syncAuto) return;
    const { getSyncQueue } = await import("./ga4.js");
    // jobId por contacto+minuto: colapsa ráfagas de ediciones sin perder cambios
    await getSyncQueue().add(
      "hubspot",
      { organizationId, kind: "hubspot_contact", payload: { contactId } },
      { attempts: 5, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000, jobId: `hs-${contactId}-${Math.floor(Date.now() / 60_000)}` },
    );
  } catch (err) {
    console.error("✖ enqueueHubspotContact:", (err as Error).message);
  }
}

/** Procesa un job hubspot_contact (upsert sin duplicados + log por registro). */
export async function syncContactToHubspot(organizationId: string, payload: { contactId: string }): Promise<void> {
  const config = await getHubspotConfig(organizationId);
  if (!config) return;

  let token: string;
  try {
    token = await getFreshOAuthToken(organizationId, "hubspot");
  } catch (err) {
    if (err instanceof NoConnectionError || err instanceof ReauthorizeError) return; // reintento inútil
    throw err;
  }

  const contact = await withTenant(organizationId, (tx) => tx.contact.findUnique({ where: { id: payload.contactId } }));
  if (!contact || contact.deletedAt) return;
  const properties = buildHubspotProperties(contact, config.fieldMapping);
  if (!Object.keys(properties).length) return;

  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const meta = (contact.meta as Record<string, any>) ?? {};
  let hubspotId: string | undefined = meta.hubspotContactId;

  const log = (status: "ok" | "error", message: string) =>
    withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: { organizationId, provider: "hubspot", type: status === "ok" ? "hubspot.synced" : "hubspot.error", status, message },
      }),
    ).catch(() => undefined);

  const fail = async (res: Response, action: string): Promise<never> => {
    const text = await res.text().catch(() => "");
    await log("error", `HubSpot ${action} → ${res.status}: ${text.slice(0, 200)}`);
    throw new Error(`hubspot ${action} ${res.status}`);
  };

  // 1) Sin id conocido: buscar por teléfono/email para no duplicar.
  if (!hubspotId) {
    const search = buildHubspotSearch(contact);
    if (search) {
      const res = await fetch(`${HS}/crm/v3/objects/contacts/search`, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...search, limit: 1, properties: ["email", "phone"] }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429 || res.status >= 500) return fail(res, "search");
      if (res.ok) {
        const data: any = await res.json();
        hubspotId = data.results?.[0]?.id;
      }
    }
  }

  // 2) Upsert
  if (hubspotId) {
    const res = await fetch(`${HS}/crm/v3/objects/contacts/${hubspotId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ properties }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) {
      hubspotId = undefined; // borrado en HubSpot → crear de nuevo
    } else if (!res.ok) {
      return fail(res, "update");
    }
  }
  if (!hubspotId) {
    const res = await fetch(`${HS}/crm/v3/objects/contacts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ properties }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 409) {
      // conflicto por email ya existente: HubSpot responde "Existing ID: NNN"
      const text = await res.text().catch(() => "");
      const m = /Existing ID:\s*(\d+)/i.exec(text);
      if (!m) return fail(res, "create");
      hubspotId = m[1];
    } else if (!res.ok) {
      return fail(res, "create");
    } else {
      hubspotId = ((await res.json()) as any).id;
    }
  }

  await withTenant(organizationId, async (tx) => {
    await tx.contact.update({ where: { id: contact.id }, data: { meta: { ...meta, hubspotContactId: hubspotId } as object } });
    await tx.integrationConnection.updateMany({ where: { provider: "hubspot" }, data: { lastSyncAt: new Date(), lastError: null } });
  });
  const label = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.phone || contact.id;
  await log("ok", `Contacto «${label}» sincronizado a HubSpot (#${hubspotId})`);
}
