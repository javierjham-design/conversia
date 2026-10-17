#!/usr/bin/env node
/**
 * Re-siembra SOLO el catálogo de rubros (vertical_templates) desde seeds/vertical-templates.json.
 * Acotado y SEGURO para prod: upsert idempotente de tablas GLOBALes, NO toca tenants NI planes
 * (a diferencia de seed-conversia-catalog.mjs, que re-sembraría conversia_v2_base como inactivo).
 * Corrige el hueco del funnel donde prod exponía 6 rubros wave-1 en vez de los 14 del seed.
 *   railway run -s Postgres -- node packages/database/scripts/seed-verticals-only.mjs
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL } } });
const here = dirname(fileURLToPath(import.meta.url));
const verticals = JSON.parse(readFileSync(join(here, "..", "seeds", "vertical-templates.json"), "utf-8"));

let created = 0, updated = 0;
for (const v of verticals) {
  const meta = { wave: v.wave ?? 1, status: v.status ?? "active", variant: v.variant ?? "citas", requiresFeature: v.requiresFeature ?? [] };
  const existed = await prisma.verticalTemplate.findUnique({ where: { key_version: { key: v.key, version: v.version } }, select: { id: true } }).catch(() => null);
  await prisma.verticalTemplate.upsert({
    where: { key_version: { key: v.key, version: v.version } },
    update: { name: v.name, definition: v.definition, active: true, ...meta },
    create: { key: v.key, version: v.version, name: v.name, definition: v.definition, active: true, ...meta },
  });
  existed ? updated++ : created++;
}
const pub = await prisma.$queryRawUnsafe("SELECT DISTINCT ON (key) key FROM vertical_templates WHERE active=true AND status='active' AND wave=1 ORDER BY key, version DESC");
console.log(`✔ verticales: ${created} creados, ${updated} actualizados (total ${verticals.length})`);
console.log(`✔ rubros públicos wave-1 ahora: ${pub.length} → ${pub.map((r) => r.key).join(",")}`);
await prisma.$disconnect();
