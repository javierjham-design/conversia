#!/usr/bin/env node
/**
 * V2-9 — ENCENDER (o apagar) el go-live del modelo por conversación de Conversia.
 * Es la ÚNICA acción que hace visible V2 al público; requiere OK EXPLÍCITO del dueño.
 * Idempotente y reversible. NO toca TuBot ni los planes conversia V1 (grandfathered).
 *
 * Qué hace al ENCENDER:
 *   1. platformSetting selfServeV2 = { conversia: true } → /registro y /crear enrolan V2.
 *   2. plan conversia_v2_base → active:true, isPublic:true (aparece en precios públicos y es comprable).
 *   3. packs de conversaciones (type "conversation", brand conversia) → active:true.
 * NO activa nada de USD/Lemon (P4 variantId pendiente del dueño): CLP/Flow basta para Chile.
 *
 *   # encender:
 *   railway run -s Postgres -- bash -c 'cd packages/database && DATABASE_URL="$DATABASE_PUBLIC_URL" node scripts/v2-golive.mjs'
 *   # apagar (rollback):
 *   railway run -s Postgres -- bash -c 'cd packages/database && OFF=1 DATABASE_URL="$DATABASE_PUBLIC_URL" node scripts/v2-golive.mjs'
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const ON = process.env.OFF !== "1";

async function main() {
  // 1. Switch de autoservicio V2.
  const cur = await prisma.platformSetting.findUnique({ where: { key: "selfServeV2" } }).catch(() => null);
  const val = { ...(cur ? JSON.parse(cur.value) : {}), conversia: ON };
  await prisma.platformSetting.upsert({
    where: { key: "selfServeV2" },
    update: { value: JSON.stringify(val) },
    create: { key: "selfServeV2", value: JSON.stringify(val) },
  });
  console.log(`✔ selfServeV2.conversia = ${ON}`);

  // 2. Plan base V2 visible/comprable (o oculto en rollback).
  const base = await prisma.plan.updateMany({ where: { code: "conversia_v2_base" }, data: { active: ON, isPublic: ON } });
  console.log(`✔ conversia_v2_base active/isPublic = ${ON} (${base.count} fila)`);

  // 3. Packs de conversaciones activos (o inactivos en rollback). No tocan los USD (precio ya sembrado).
  const packs = await prisma.messagePackage.updateMany({ where: { brand: "conversia", type: "conversation" }, data: { active: ON } });
  console.log(`✔ packs de conversaciones active = ${ON} (${packs.count} filas)`);

  console.log(ON ? "\n🟢 V2 ENCENDIDO. Nuevos registros conversia entran al flujo por conversación." : "\n⚪ V2 APAGADO (rollback). Catálogo V2 oculto; registros vuelven al flujo previo.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
