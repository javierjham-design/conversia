import { getAdminPrisma, withTenant } from "@conversia/database";
import { fetchGraphWithProof, getEnv } from "@conversia/config";
import { pageToken } from "./messaging-send";
import { resolveMetaLeadToken } from "./meta-token";
import { dispatchEvent } from "./workflow-runtime";
import { emitPlatformEvent } from "./platform-events";

interface LeadgenChange {
  page_id: string;
  form_id: string;
  leadgen_id: string;
  created_time: number;
  /** presente solo en payloads de prueba; el real se obtiene de Graph */
  field_data?: Array<{ name: string; values: string[] }>;
  organization_hint?: string;
}

/** Resuelve el tenant dueño de la página/formulario (lookup global de ruteo). */
async function resolveLeadTenant(change: LeadgenChange, internal: boolean): Promise<string | null> {
  const prisma = getAdminPrisma();
  const byForm = await prisma.metaAsset.findFirst({
    where: { kind: "lead_form", externalId: change.form_id },
  });
  if (byForm) return byForm.organizationId;
  const byPage = await prisma.metaAsset.findFirst({ where: { kind: "page", externalId: change.page_id } });
  if (byPage) return byPage.organizationId;
  // organization_hint SOLO se acepta de encolados internos autenticados
  // (lead de prueba del panel). Un webhook público jamás puede elegir tenant.
  return internal ? (change.organization_hint ?? null) : null;
}

interface GraphLead {
  fieldData: Array<{ name: string; values: string[] }>;
  campaignId: string | null;
  adId: string | null;
}

/** GET del lead con un token dado; en fallo devuelve el error REAL de Meta
 *  (message/code), no solo el status HTTP — sin eso el diagnóstico es a ciegas. */
async function graphGetLead(
  leadgenId: string,
  token: string,
): Promise<{ ok: true; json: any } | { ok: false; detail: string }> {
  const env = getEnv();
  // Con dos apps (principal + TuBot CRM) el proof se resuelve con fallback.
  const res = await fetchGraphWithProof(
    `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${leadgenId}?fields=field_data,campaign_id,ad_id,form_id,created_time&access_token=${encodeURIComponent(token)}`,
    token,
  );
  const json: any = await res.json().catch(() => null);
  if (!res.ok) {
    const e = json?.error;
    const detail = e?.message
      ? `${e.message} [code ${e.code}${e.error_subcode ? `/${e.error_subcode}` : ""}]`
      : `HTTP ${res.status}`;
    return { ok: false, detail };
  }
  return { ok: true, json };
}

/** Obtiene el lead completo desde Graph (campos + atribución de campaña). */
async function fetchLeadFromGraph(organizationId: string, pageId: string, leadgenId: string): Promise<GraphLead | null> {
  // Prefiere el token de la conexión Meta CRM del tenant (app separada).
  const token = await resolveMetaLeadToken(organizationId);
  if (!token) return null;
  let r = await graphGetLead(leadgenId, token);
  if (!r.ok) {
    // Fallback con token de PÁGINA: es la vía canónica para leer leads y el
    // Administrador de acceso a clientes potenciales lo evalúa distinto.
    try {
      const pt = await pageToken(organizationId, pageId);
      const r2 = await graphGetLead(leadgenId, pt);
      r = r2.ok ? r2 : { ok: false, detail: `${r.detail} · con token de página: ${r2.detail}` };
    } catch {
      /* mantiene el error original del token de usuario */
    }
  }
  if (!r.ok) throw new Error(r.detail);
  const json = r.json;
  return {
    fieldData: json.field_data ?? [],
    campaignId: json.campaign_id ? String(json.campaign_id) : null,
    adId: json.ad_id ? String(json.ad_id) : null,
  };
}

/**
 * Procesa un lead de Meta Lead Ads por el pipeline real:
 * mapeo de campos → contacto (dedupe por teléfono) → lead + etiquetas →
 * actividad → workflows con trigger lead_created → webhooks/CAPI.
 */
export async function processLeadgen(change: LeadgenChange, internal = false): Promise<void> {
  const organizationId = await resolveLeadTenant(change, internal);
  if (!organizationId) {
    console.warn(`⚠ Leadgen para página desconocida ${change.page_id} — descartado`);
    return;
  }

  // Datos del formulario: embebidos (prueba) o vía Graph (real)
  let fieldData = change.field_data ?? null;
  let campaignId: string | null = null;
  let adId: string | null = null;
  if (!fieldData) {
    try {
      const graphLead = await fetchLeadFromGraph(organizationId, change.page_id, change.leadgen_id);
      fieldData = graphLead?.fieldData ?? null;
      campaignId = graphLead?.campaignId ?? null;
      adId = graphLead?.adId ?? null;
    } catch (err) {
      await withTenant(organizationId, (tx) =>
        tx.integrationEvent.create({
          data: {
            organizationId,
            provider: "lead_ads",
            type: "lead.error",
            status: "error",
            message: `No se pudo obtener el lead ${change.leadgen_id} de Graph: ${(err as Error).message}`,
          },
        }),
      );
      return;
    }
    if (!fieldData) {
      await withTenant(organizationId, (tx) =>
        tx.integrationEvent.create({
          data: {
            organizationId,
            provider: "lead_ads",
            type: "lead.pending_credentials",
            status: "warning",
            message: `Lead ${change.leadgen_id} recibido pero sin credenciales de Meta para leer sus datos`,
            payload: { formId: change.form_id, leadgenId: change.leadgen_id } as object,
          },
        }),
      );
      return;
    }
  }

  const result = await withTenant(organizationId, async (tx) => {
    // Idempotencia por leadgen_id
    const dup = await tx.integrationEvent.findFirst({
      where: { provider: "lead_ads", type: "lead.received", payload: { path: ["leadgenId"], equals: change.leadgen_id } },
    });
    if (dup) return null;

    const mappingRow =
      (await tx.metaFieldMapping.findFirst({ where: { formExternalId: change.form_id } })) ??
      (await tx.metaFieldMapping.findFirst({ where: { formExternalId: null } }));
    const mappings: Array<{ source: string; target: string }> = (mappingRow?.mappings as any[]) ?? [
      { source: "full_name", target: "firstName" },
      { source: "phone_number", target: "phone" },
      { source: "email", target: "email" },
    ];
    const config = (mappingRow?.config as Record<string, any>) ?? {};

    const values = new Map(fieldData!.map((f) => [f.name, f.values?.[0] ?? ""]));
    const contactData: Record<string, string> = {};
    const custom: Record<string, string> = {};
    for (const m of mappings) {
      const value = values.get(m.source);
      if (!value) continue;
      if (["firstName", "lastName", "phone", "email"].includes(m.target)) contactData[m.target] = value;
      else custom[m.target] = value;
    }
    const phone = (contactData.phone ?? "").replace(/[^\d+]/g, "").replace(/^\+/, "");

    // Atribución estructurada del formulario (alimenta CAPI lead_id + filtros CRM)
    const metaLead = {
      leadgenId: change.leadgen_id,
      formId: change.form_id,
      ...(campaignId ? { campaignId } : {}),
      ...(adId ? { adId } : {}),
      ...custom,
    };
    // Contacto: dedupe por teléfono
    let contact = phone ? await tx.contact.findFirst({ where: { phone } }) : null;
    if (!contact) {
      contact = await tx.contact.create({
        data: {
          organizationId,
          clinicId: config.clinicId ?? null,
          firstName: contactData.firstName ?? null,
          lastName: contactData.lastName ?? null,
          phone: phone || null,
          email: contactData.email ?? null,
          source: "meta_lead_ads",
          acquisitionSource: "ad",
          ...(adId ? { adId } : {}),
          firstContactAt: new Date(),
          attributes: { metaLead },
        },
      });
    } else {
      await tx.contact.update({
        where: { id: contact.id },
        data: {
          email: contact.email ?? contactData.email ?? null,
          ...(adId && !contact.adId ? { adId, acquisitionSource: "ad" } : {}),
          attributes: {
            ...((contact.attributes as object) ?? {}),
            metaLead,
          },
        },
      });
    }

    // Lead con estado inicial configurado. La etapa DEBE ser visible en el
    // tablero (activa); si la configurada no existe o está inactiva (código
    // renombrado/desactivado), cae a la primera etapa OPEN activa y, si no hay
    // ninguna OPEN, a CUALQUIER etapa activa — así el lead SIEMPRE aparece en el
    // CRM (antes: sin etapa activa no se creaba el Lead y el lead solo llegaba a
    // los workflows/Sheets pero no al listado del CRM).
    const statusCode = config.leadStatusCode as string | undefined;
    let status = statusCode
      ? await tx.leadStatus.findUnique({ where: { organizationId_code: { organizationId, code: statusCode } } })
      : null;
    if (!status || !status.active) {
      status =
        (await tx.leadStatus.findFirst({ where: { category: "OPEN", active: true }, orderBy: { order: "asc" } })) ??
        (await tx.leadStatus.findFirst({ where: { active: true }, orderBy: { order: "asc" } }));
    }
    let leadId: string | null = null;
    if (status) {
      const lead = await tx.lead.create({
        data: {
          organizationId,
          contactId: contact.id,
          statusId: status.id,
          meta: { source: "meta_lead_ads", formId: change.form_id, leadgenId: change.leadgen_id, ...(campaignId ? { campaignId } : {}), ...(adId ? { adId } : {}) },
        },
      });
      leadId = lead.id;
    } else {
      // Sin ninguna etapa activa en el ciclo de vida: no se puede ubicar el lead
      // en el tablero. Se deja rastro claro para que el tenant active una etapa.
      await tx.integrationEvent.create({
        data: {
          organizationId,
          provider: "lead_ads",
          type: "lead.no_stage",
          status: "warning",
          message: `Lead recibido pero SIN etapa activa en el ciclo de vida: el contacto se creó pero no aparece en el tablero del CRM. Activa al menos una etapa en Configuración → Etapas.`,
          payload: { leadgenId: change.leadgen_id, contactId: contact.id } as object,
        },
      });
    }

    const newTags: string[] = [];
    for (const tagName of (config.tags as string[]) ?? []) {
      const tag = await tx.tag.upsert({
        where: { organizationId_name: { organizationId, name: tagName } },
        update: {},
        create: { organizationId, name: tagName },
      });
      const existing = await tx.tagAssignment.findUnique({
        where: {
          organizationId_tagId_entityType_entityId: {
            organizationId,
            tagId: tag.id,
            entityType: "contact",
            entityId: contact.id,
          },
        },
      });
      if (!existing) {
        await tx.tagAssignment.create({
          data: { organizationId, tagId: tag.id, entityType: "contact", entityId: contact.id },
        });
        newTags.push(tagName);
      }
    }

    await tx.integrationEvent.create({
      data: {
        organizationId,
        provider: "lead_ads",
        type: "lead.received",
        message: `Lead de formulario ${change.form_id}: ${contactData.firstName ?? "sin nombre"} (${phone || "sin teléfono"})`,
        payload: { leadgenId: change.leadgen_id, formId: change.form_id, contactId: contact.id } as object,
      },
    });

    const displayName = [contactData.firstName, contactData.lastName].filter(Boolean).join(" ");
    return { contactId: contact.id, leadId, phone, newTags, displayName };
  });

  if (!result) return; // duplicado

  // Sincronización unidireccional a HubSpot (si el tenant la activó)
  const { enqueueHubspotContact } = await import("./hubspot.js");
  await enqueueHubspotContact(organizationId, result.contactId);

  await dispatchEvent({
    organizationId,
    type: "lead_created",
    contactId: result.contactId,
    data: { source: "meta_lead_ads", formId: change.form_id },
    occurredAt: new Date().toISOString(),
  });
  // Etiquetas de la config del formulario recién asignadas → trigger tag_added.
  for (const tagName of result.newTags) {
    await emitPlatformEvent(organizationId, "tag.added", { tag: tagName, contactId: result.contactId });
    await dispatchEvent({
      organizationId,
      type: "tag_added",
      contactId: result.contactId,
      data: { tag: tagName },
      occurredAt: new Date().toISOString(),
    });
  }
  await emitPlatformEvent(
    organizationId,
    "lead.created",
    { source: "meta_lead_ads", formId: change.form_id, contactId: result.contactId },
    { contactPhone: result.phone || null, leadId: result.leadId, contactId: result.contactId },
  );
  // Aviso al equipo del tenant: con una campaña activa, un lead sin respuesta
  // rápida es un lead perdido. El catálogo define canales y audiencia.
  const { enqueueNotification } = await import("./notifications/queue.js");
  await enqueueNotification({
    eventKey: "lead.created",
    organizationId,
    data: {
      contactName: result.displayName || result.phone || "Nuevo contacto",
      source: "Meta Lead Ads",
    },
  });
}

/** Extrae los cambios leadgen de un payload de webhook de Meta (object=page). */
export function parseLeadgenChanges(raw: any): LeadgenChange[] {
  const changes: LeadgenChange[] = [];
  for (const entry of raw?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      if (change?.field === "leadgen" && change?.value?.leadgen_id) {
        changes.push(change.value as LeadgenChange);
      }
    }
  }
  return changes;
}
