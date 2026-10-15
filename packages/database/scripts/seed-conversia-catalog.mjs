#!/usr/bin/env node
/**
 * Seed ACOTADO del catálogo Conversia (F2/F5): planes conversia_*, sobre de créditos,
 * pesos de bolsa por marca y plantillas verticales. SEGURO para producción: solo hace
 * upsert de catálogo GLOBAL — NO toca tenants (a diferencia de `db:seed`, que
 * re-sembraría digital-dent/demo-clinic). Idempotente.
 *
 *   railway run --service Postgres -- bash -c 'cd packages/database && \
 *     DATABASE_URL="$DATABASE_PUBLIC_URL" node scripts/seed-conversia-catalog.mjs'
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const prisma = new PrismaClient();
const here = dirname(fileURLToPath(import.meta.url));

const PLANS = [
  {
    code: "conversia_funcionando",
    name: "Funcionando",
    brand: "conversia",
    priceClp: 149900,
    priceUsd: 159,
    order: 10,
    isPublic: false,
    limits: { users: 5, clinics: 2, channels: 2, agents: 5, workflows: 20, aiTokensDaily: 3000000 },
    features: { managed: false, whiteLabel: false, api: true, whatsappTemplates: true, serviceDebitsWallet: true, templateMessages: 1500, conversationsPerPeriod: -1, conversationOverageClp: 0, conversationHardCap: false },
  },
  {
    code: "conversia_gestionado",
    name: "Gestionado",
    brand: "conversia",
    priceClp: 299900,
    priceUsd: 319,
    order: 11,
    isPublic: false,
    limits: { users: 15, clinics: 5, channels: 3, agents: 15, workflows: 50, aiTokensDaily: 8000000 },
    features: { managed: true, whiteLabel: true, api: true, whatsappTemplates: true, serviceDebitsWallet: true, templateMessages: 4000, conversationsPerPeriod: -1, conversationOverageClp: 0, conversationHardCap: false },
  },
  {
    code: "conversia_custom",
    name: "Custom",
    brand: "conversia",
    priceClp: 0,
    priceUsd: 0,
    order: 12,
    isPublic: false,
    limits: { users: 0, clinics: 0, channels: 0, agents: 0, workflows: 0, aiTokensDaily: 0 },
    features: { managed: true, whiteLabel: true, api: true, sso: true, whatsappTemplates: true, serviceDebitsWallet: true, templateMessages: 1500, conversationsPerPeriod: -1, conversationOverageClp: 0, conversationHardCap: false },
  },
  // V2-0 — plan base del modelo "por conversación". Sembrado INACTIVO e invisible
  // (active:false, isPublic:false): nada visible al público hasta el go-live V2-9
  // (scripts/v2-golive.mjs lo activa y lo hace público). La CONVERSACIÓN absorbe
  // servicio+IA → conversationDebitsWallet:true / serviceDebitsWallet:false.
  // 100 conversaciones/mes incluidas. $18.900 CLP / USD 19.
  {
    code: "conversia_v2_base",
    name: "Base",
    brand: "conversia",
    priceClp: 18900,
    priceUsd: 19,
    order: 9,
    isPublic: false,
    active: false,
    limits: { users: 3, clinics: 1, channels: 1, agents: 3, workflows: 10, aiTokensDaily: 3000000 },
    features: { v2SelfServe: true, conversationDebitsWallet: true, serviceDebitsWallet: false, aiPlus: false, whatsappTemplates: true, api: true, managed: false, conversationsIncluded: 100, conversationsPerPeriod: -1, conversationHardCap: false },
  },
  // V2-9 — plan de PRUEBA del modelo por conversación (30 gratis, sin tarjeta). Debita
  // de la bolsa (conversationDebitsWallet:true) para que las 30 cuenten de verdad, pero
  // conversationsIncluded:0 → NO acredita créditos de plan (el único saldo es el lote
  // regalo de 30). Al ACTIVAR (pagar la Base) la suscripción pasa a conversia_v2_base y
  // recién ahí acredita 100/período. active:true pero isPublic:false (interno, se asigna
  // al registrarse en modo V2; jamás aparece en precios públicos). Precio 0.
  {
    code: "conversia_v2_trial",
    name: "Prueba",
    brand: "conversia",
    priceClp: 0,
    priceUsd: 0,
    order: 8,
    isPublic: false,
    active: true,
    limits: { users: 3, clinics: 1, channels: 1, agents: 3, workflows: 10, aiTokensDaily: 3000000 },
    features: { v2SelfServe: true, conversationDebitsWallet: true, serviceDebitsWallet: false, aiPlus: false, whatsappTemplates: true, api: true, managed: false, conversationsIncluded: 0, conversationsPerPeriod: -1, conversationHardCap: false, trial: true },
  },
];

// V2-0 — packs de CONVERSACIONES (type "conversation"), por marca conversia. Precios
// corregidos por el cálculo a máximo uso (CONVERSIA_V2.md §2.1): ≥ ~$200/conv para no
// quedar bajo el costo Meta. Sembrados INACTIVOS (active:false) hasta el go-live V2-9.
const CONV_PACKS = [
  { code: "conversia-conv-400", name: "Pack 400 conversaciones", credits: 400, priceClp: 84900, priceUsd: 89, order: 20 },
  { code: "conversia-conv-1000", name: "Pack 1.000 conversaciones", credits: 1000, priceClp: 199900, priceUsd: 209, order: 21 },
  { code: "conversia-conv-100", name: "Recarga 100 conversaciones", credits: 100, priceClp: 21900, priceUsd: 23, order: 22 },
];

async function main() {
  for (const p of PLANS) {
    const active = p.active ?? true; // V2-0: el plan base V2 nace inactivo
    await prisma.plan.upsert({
      where: { code: p.code },
      update: { name: p.name, priceClp: p.priceClp, priceUsd: p.priceUsd, order: p.order, limits: p.limits, features: p.features, isPublic: p.isPublic, brand: p.brand, active },
      create: { ...p, active },
    });
  }
  console.log(`✔ ${PLANS.length} planes conversia_* (conversia_v2_base INACTIVO)`);

  await prisma.messagePackage.upsert({
    where: { code: "conversia-sobre-500" },
    update: { name: "Sobre 500 créditos", credits: 500, priceClp: 21900, priceUsd: 25, active: true, order: 10, brand: "conversia" },
    create: { code: "conversia-sobre-500", name: "Sobre 500 créditos", credits: 500, priceClp: 21900, priceUsd: 25, active: true, order: 10, brand: "conversia", type: "message" },
  });
  console.log("✔ sobre de 500 créditos");

  // V2-0 — packs de conversaciones (type "conversation"), INACTIVOS hasta el go-live V2-9.
  for (const p of CONV_PACKS) {
    await prisma.messagePackage.upsert({
      where: { code: p.code },
      update: { name: p.name, credits: p.credits, priceClp: p.priceClp, priceUsd: p.priceUsd, order: p.order, active: false, brand: "conversia", type: "conversation" },
      create: { code: p.code, name: p.name, credits: p.credits, priceClp: p.priceClp, priceUsd: p.priceUsd, order: p.order, active: false, brand: "conversia", type: "conversation" },
    });
  }
  console.log(`✔ ${CONV_PACKS.length} packs de conversaciones V2 (INACTIVOS)`);

  await prisma.platformSetting.upsert({
    where: { key: "walletWeights:conversia" },
    update: { value: JSON.stringify({ utility: 1, authentication: 1, marketing: 4, service: 1 }) },
    create: { key: "walletWeights:conversia", value: JSON.stringify({ utility: 1, authentication: 1, marketing: 4, service: 1 }) },
  });
  console.log("✔ walletWeights:conversia (1/1/1·marketing 4)");

  // V2-4 — pool de "Pruébalo en TU WhatsApp": OFF hasta que el dueño cargue número(s) reales (P1).
  // NO pisa el valor si ya existe (para no apagar un pool ya encendido por el dueño).
  const existingTrialPool = await prisma.platformSetting.findUnique({ where: { key: "trialPool" } }).catch(() => null);
  if (!existingTrialPool) {
    await prisma.platformSetting.create({ data: { key: "trialPool", value: JSON.stringify({ enabled: false, maxConvPerDay: 20 }) } });
    console.log("✔ trialPool (OFF — P1: cargar número real para encender)");
  } else console.log("• trialPool ya existe (no se toca)");

  // V2-9 — switch de autoservicio V2 por marca: OFF por defecto. Al encenderlo
  // (scripts/v2-golive.mjs → {conversia:true}), /registro y /crear de conversia
  // enrolan al flujo V2 (plan prueba + 30 conversaciones gratis sin tarjeta). NO pisa
  // el valor si ya existe (para no apagar un go-live ya hecho por el dueño).
  const existingSelfServe = await prisma.platformSetting.findUnique({ where: { key: "selfServeV2" } }).catch(() => null);
  if (!existingSelfServe) {
    await prisma.platformSetting.create({ data: { key: "selfServeV2", value: JSON.stringify({ conversia: false }) } });
    console.log("✔ selfServeV2 (OFF — V2-9: v2-golive.mjs lo enciende)");
  } else console.log("• selfServeV2 ya existe (no se toca)");

  const verticals = JSON.parse(readFileSync(join(here, "..", "seeds", "vertical-templates.json"), "utf-8"));
  for (const v of verticals) {
    const meta = { wave: v.wave ?? 1, status: v.status ?? "active", variant: v.variant ?? "citas", requiresFeature: v.requiresFeature ?? [] };
    await prisma.verticalTemplate.upsert({
      where: { key_version: { key: v.key, version: v.version } },
      update: { name: v.name, definition: v.definition, active: true, ...meta },
      create: { key: v.key, version: v.version, name: v.name, definition: v.definition, active: true, ...meta },
    });
  }
  console.log(`✔ ${verticals.length} paquetes verticales`);
  console.log("Catálogo Conversia sembrado (sin tocar tenants).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
