import type { Job } from "bullmq";
import { withTenant } from "@conversia/database";
import type { ContactImportJob, ContactImportResult, ContactImportRow } from "@conversia/types";

// Import CSV de contactos en 2.º plano. La API valida con zod y encola; acá se
// procesa por lotes (transacción por lote con timeout AMPLIADO — ver abajo)
// reportando progreso vía job.updateProgress. Mismas reglas que el alta manual:
// teléfono E.164, dedupe por teléfono, updateExisting solo rellena campos vacíos.
// NOTA deliberada: las etiquetas asignadas por import NO disparan el trigger
// tag_added (un CSV de miles de filas dispararía miles de flujos).
//
// Rendimiento (bug real de prod, 2026-08: 3.763 filas fallaban enteras):
// ~11 consultas por fila → 200 filas NO entran en los 5 s por defecto de la
// transacción interactiva de Prisma. Por eso: (1) las lecturas que no dependen
// de la fila (etapas + definiciones de campos) se hacen UNA vez por job, (2)
// lotes de 50 con { timeout: 30 s, maxWait: 10 s }, y (3) un lote que falla
// registra su rango en errors y NO se lleva el import entero.

const CHUNK = 50;
const BATCH_TX_OPTS = { timeout: 30_000, maxWait: 10_000 };

/** Normaliza a E.164 conservando solo dígitos (mismo criterio que la API). */
function normalizePhone(raw?: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

interface ImportRefs {
  statuses: Array<{ id: string; code: string; name: string }>;
  fieldDefs: Array<{ id: string; key: string }>;
}

interface BatchCounters {
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; reason: string }[];
}

/** Procesa un lote dentro de una transacción de tenant (RLS activo). */
async function processBatch(
  tx: any,
  orgId: string,
  chunk: ContactImportRow[],
  offset: number,
  updateExisting: boolean,
  refs: ImportRefs,
): Promise<BatchCounters> {
  const out: BatchCounters = { created: 0, updated: 0, skipped: 0, errors: [] };
  const fieldByKey = new Map(refs.fieldDefs.map((d) => [d.key, d.id]));

  for (let j = 0; j < chunk.length; j++) {
    const idx = offset + j + 1; // fila 1-based (sin cabecera)
    const row = chunk[j];
    const phone = normalizePhone(row.phone);
    if (!phone && !row.email && !row.firstName && !row.lastName) {
      out.errors.push({ row: idx, reason: "fila sin datos" });
      continue;
    }
    let contactId: string;
    const existing = phone ? await tx.contact.findFirst({ where: { phone, deletedAt: null } }) : null;
    if (existing) {
      contactId = existing.id;
      if (updateExisting) {
        const data: Record<string, unknown> = {};
        if (row.firstName && !existing.firstName) data.firstName = row.firstName;
        if (row.lastName && !existing.lastName) data.lastName = row.lastName;
        if (row.email && !existing.email) data.email = row.email;
        if (row.country && !existing.country) data.country = row.country.toUpperCase().slice(0, 2);
        if (Object.keys(data).length) await tx.contact.update({ where: { id: existing.id }, data });
        out.updated++;
      } else {
        out.skipped++;
      }
    } else {
      const c = await tx.contact.create({
        data: {
          organizationId: orgId,
          firstName: row.firstName || null,
          lastName: row.lastName || null,
          phone,
          email: row.email || null,
          country: row.country ? row.country.toUpperCase().slice(0, 2) : null,
          locale: row.locale || "es",
          source: "import",
          createdVia: "import",
          acquisitionSource: "organic",
        },
        select: { id: true },
      });
      contactId = c.id;
      out.created++;
    }
    // Etiquetas (separadas por coma o |) → upsert Tag + asignación
    if (row.tags) {
      for (const raw of row.tags.split(/[|,]/).map((t) => t.trim()).filter(Boolean)) {
        const tag = await tx.tag.upsert({
          where: { organizationId_name: { organizationId: orgId, name: raw } },
          create: { organizationId: orgId, name: raw },
          update: {},
          select: { id: true },
        });
        await tx.tagAssignment.createMany({
          data: [{ organizationId: orgId, tagId: tag.id, entityType: "contact", entityId: contactId }],
          skipDuplicates: true,
        });
      }
    }
    // Etapa del ciclo de vida (acepta code o nombre, insensible a mayúsculas)
    if (row.stage?.trim()) {
      const wanted = row.stage.trim().toLowerCase();
      const status = refs.statuses.find((st) => st.code.toLowerCase() === wanted || st.name.toLowerCase() === wanted);
      if (status) {
        const lead = await tx.lead.findFirst({ where: { contactId }, orderBy: { createdAt: "desc" } });
        if (!lead) await tx.lead.create({ data: { organizationId: orgId, contactId, statusId: status.id } });
        else if (lead.statusId !== status.id) await tx.lead.update({ where: { id: lead.id }, data: { statusId: status.id } });
      } else {
        out.errors.push({ row: idx, reason: `etapa desconocida: ${row.stage}` });
      }
    }
    // Campos personalizados por key
    if (row.custom && Object.keys(row.custom).length) {
      for (const [key, value] of Object.entries(row.custom)) {
        const defId = fieldByKey.get(key);
        if (!defId || !value.trim()) continue;
        await tx.customFieldValue.upsert({
          where: { organizationId_definitionId_entityId: { organizationId: orgId, definitionId: defId, entityId: contactId } },
          create: { organizationId: orgId, definitionId: defId, entityId: contactId, value: value.trim() },
          update: { value: value.trim() },
        });
      }
    }
  }
  return out;
}

export async function processContactImport(job: Job<ContactImportJob>): Promise<ContactImportResult> {
  const { organizationId: orgId, userId, rows, updateExisting } = job.data;
  let created = 0,
    updated = 0,
    skipped = 0;
  const errors: { row: number; reason: string }[] = [];

  // Lecturas que NO dependen de la fila: una vez por job (withTenant corto).
  const refs: ImportRefs = await withTenant(orgId, async (tx) => ({
    statuses: await tx.leadStatus.findMany({ where: { active: true }, select: { id: true, code: true, name: true } }),
    fieldDefs: await tx.customFieldDefinition.findMany({ where: { entity: "contact" }, select: { id: true, key: true } }),
  }));

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    try {
      const r = await withTenant(orgId, (tx) => processBatch(tx, orgId, chunk, i, updateExisting, refs), undefined, BATCH_TX_OPTS);
      created += r.created;
      updated += r.updated;
      skipped += r.skipped;
      errors.push(...r.errors);
    } catch (err) {
      // Un lote fallido NO se lleva el import: se registra el rango y se sigue.
      // (La transacción del lote se revirtió entera: esas filas no entraron.)
      errors.push({ row: i + 1, reason: `lote filas ${i + 1}-${Math.min(i + CHUNK, rows.length)} falló: ${(err as Error).message.slice(0, 200)}` });
    }
    await job.updateProgress({ processed: Math.min(i + CHUNK, rows.length), total: rows.length });
  }

  await withTenant(orgId, (tx) =>
    tx.auditLog.create({
      data: { organizationId: orgId, actorType: "user", actorId: userId, action: "contact.import", entityType: "contact", after: { created, updated, skipped, errors: errors.length } },
    }),
  );
  return { created, updated, skipped, errors: errors.slice(0, 100) };
}
