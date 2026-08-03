import { getAdminPrisma, withTenant } from "@conversia/database";
import { getEnv } from "@conversia/config";
import { decryptCredential } from "./credentials";
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

/** Obtiene los campos del lead desde Graph (camino real, requiere token). */
async function fetchLeadFromGraph(
  organizationId: string,
  leadgenId: string,
): Promise<Array<{ name: string; values: string[] }> | null> {
  const env = getEnv();
  const token = await withTenant(organizationId, async (tx) => {
    const connection = await tx.metaBusinessConnection.findUnique({ where: { organizationId } });
    if (connection?.credentialId) {
      const cred = await tx.integrationCredential.findUnique({ where: { id: connection.credentialId } });
      if (cred) return decryptCredential(cred.ciphertext);
    }
    return env.META_ACCESS_TOKEN || null;
  });
  if (!token) return null;
  const res = await fetch(
    `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${leadgenId}?fields=field_data,campaign_id,ad_id,form_id,created_time&access_token=${encodeURIComponent(token)}`,
  );
  if (!res.ok) throw new Error(`Graph ${res.status}`);
  const json: any = await res.json();
  return json.field_data ?? [];
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
  if (!fieldData) {
    try {
      fieldData = await fetchLeadFromGraph(organizationId, change.leadgen_id);
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
          firstContactAt: new Date(),
          attributes: { metaLead: { leadgenId: change.leadgen_id, formId: change.form_id, ...custom } },
        },
      });
    } else {
      await tx.contact.update({
        where: { id: contact.id },
        data: {
          email: contact.email ?? contactData.email ?? null,
          attributes: {
            ...((contact.attributes as object) ?? {}),
            metaLead: { leadgenId: change.leadgen_id, formId: change.form_id, ...custom },
          },
        },
      });
    }

    // Lead con estado inicial configurado; si el código no existe (etapas
    // renombradas por el tenant), cae a la primera etapa OPEN del ciclo.
    const statusCode = config.leadStatusCode as string | undefined;
    let status = statusCode
      ? await tx.leadStatus.findUnique({ where: { organizationId_code: { organizationId, code: statusCode } } })
      : null;
    if (!status) {
      status = await tx.leadStatus.findFirst({ where: { category: "OPEN", active: true }, orderBy: { order: "asc" } });
    }
    let leadId: string | null = null;
    if (status) {
      const lead = await tx.lead.create({
        data: { organizationId, contactId: contact.id, statusId: status.id, meta: { source: "meta_lead_ads", formId: change.form_id } },
      });
      leadId = lead.id;
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

    return { contactId: contact.id, leadId, phone, newTags };
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
    { contactPhone: result.phone || null, leadId: result.leadId },
  );
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
