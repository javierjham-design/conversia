import type { Job } from "bullmq";
import { withTenant } from "@conversia/database";
import type { ContactImportJob, ContactImportResult } from "@conversia/types";

// Import CSV de contactos en 2.º plano. La API valida con zod y encola; acá se
// procesa por lotes (transacción corta por lote) reportando progreso vía
// job.updateProgress. Mismas reglas que el alta manual: teléfono E.164, dedupe
// por teléfono, updateExisting solo rellena campos vacíos.
// NOTA deliberada: las etiquetas asignadas por import NO disparan el trigger
// tag_added (un CSV de miles de filas dispararía miles de flujos).

const CHUNK = 200;

/** Normaliza a E.164 conservando solo dígitos (mismo criterio que la API). */
function normalizePhone(raw?: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

export async function processContactImport(job: Job<ContactImportJob>): Promise<ContactImportResult> {
  const { organizationId: orgId, userId, rows, updateExisting } = job.data;
  let created = 0,
    updated = 0,
    skipped = 0;
  const errors: { row: number; reason: string }[] = [];

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await withTenant(orgId, async (tx) => {
      for (let j = 0; j < chunk.length; j++) {
        const idx = i + j + 1; // fila 1-based (sin cabecera)
        const row = chunk[j];
        const phone = normalizePhone(row.phone);
        if (!phone && !row.email && !row.firstName && !row.lastName) {
          errors.push({ row: idx, reason: "fila sin datos" });
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
            updated++;
          } else {
            skipped++;
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
          created++;
        }
        // Etiquetas (separadas por coma) → upsert Tag + asignación
        if (row.tags) {
          for (const raw of row.tags.split(",").map((t) => t.trim()).filter(Boolean)) {
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
      }
    });
    await job.updateProgress({ processed: Math.min(i + CHUNK, rows.length), total: rows.length });
  }

  await withTenant(orgId, (tx) =>
    tx.auditLog.create({
      data: { organizationId: orgId, actorType: "user", actorId: userId, action: "contact.import", entityType: "contact", after: { created, updated, skipped } },
    }),
  );
  return { created, updated, skipped, errors: errors.slice(0, 100) };
}
