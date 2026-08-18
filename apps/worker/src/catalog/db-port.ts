/**
 * Puerto real del motor de sync: admin prisma + withTenant (RLS). Upsert por
 * (org, source, externalId); desactiva lo ausente sin borrarlo; registra la corrida.
 */
import { getAdminPrisma, withTenant } from "@conversia/database";
import type { CatalogSyncPort } from "./sync-engine";
import type { NormalizedItem } from "./types";

function toRow(orgId: string, source: string, i: NormalizedItem) {
  return {
    organizationId: orgId,
    source,
    externalId: i.externalId,
    kind: i.kind,
    sku: i.sku ?? undefined,
    name: i.name,
    description: i.description ?? undefined,
    category: i.category ?? undefined,
    subcategory: i.subcategory ?? undefined,
    price: i.price ?? undefined,
    compareAtPrice: i.compareAtPrice ?? undefined,
    currency: i.currency,
    stock: i.stock ?? undefined,
    trackStock: i.trackStock,
    available: i.available,
    variants: i.variants as object,
    imageUrl: i.imageUrl ?? undefined,
    images: i.images as object,
    productUrl: i.productUrl ?? undefined,
    buyUrl: i.buyUrl ?? undefined,
    tags: i.tags as object,
    attributes: i.attributes as object,
    brand: i.brand ?? undefined,
    barcode: i.barcode ?? undefined,
    unit: i.unit ?? undefined,
    menuSection: i.menuSection ?? undefined,
    availability: i.availability as object,
    raw: i.raw as object,
    syncedAt: new Date(),
  };
}

export function createDbCatalogPort(): CatalogSyncPort {
  const admin = getAdminPrisma();
  return {
    async startRun(orgId, source, mode) {
      const run = await admin.catalogSyncRun.create({ data: { organizationId: orgId, source, mode, status: "running" } });
      return run.id;
    },

    async upsertItems(orgId, source, items) {
      let created = 0;
      let updated = 0;
      // ¿Cuáles ya existen? (una consulta por lote para contar created vs updated)
      const ids = items.map((i) => i.externalId);
      const existing = await admin.catalogItem.findMany({
        where: { organizationId: orgId, source, externalId: { in: ids } },
        select: { externalId: true },
      });
      const existingSet = new Set(existing.map((e) => e.externalId));
      await withTenant(orgId, async (tx) => {
        for (const i of items) {
          const row = toRow(orgId, source, i);
          if (existingSet.has(i.externalId)) {
            await tx.catalogItem.updateMany({ where: { organizationId: orgId, source, externalId: i.externalId }, data: row });
            updated++;
          } else {
            // No pisar la botDescription ni el active del tenant al crear (aún no existen).
            await tx.catalogItem.create({ data: row });
            created++;
          }
        }
      });
      return { created, updated };
    },

    async deactivateMissing(orgId, source, seen) {
      // Lo que no vino en esta sync completa: available=false (no se borra). Preserva
      // botDescription y active (toggle del tenant); solo cambia la disponibilidad.
      const r = await withTenant(orgId, (tx) =>
        tx.catalogItem.updateMany({
          where: { organizationId: orgId, source, available: true, externalId: { notIn: seen.length ? seen : ["__none__"] } },
          data: { available: false },
        }),
      );
      return r.count;
    },

    async finishRun(runId, status, counts, error) {
      await admin.catalogSyncRun.update({
        where: { id: runId },
        data: { status, created: counts.created, updated: counts.updated, deactivated: counts.deactivated, failed: counts.failed, error: error ?? undefined, finishedAt: new Date() },
      });
    },
  };
}
