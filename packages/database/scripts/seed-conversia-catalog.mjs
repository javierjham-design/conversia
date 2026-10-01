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
];

async function main() {
  for (const p of PLANS) {
    await prisma.plan.upsert({
      where: { code: p.code },
      update: { name: p.name, priceClp: p.priceClp, priceUsd: p.priceUsd, order: p.order, limits: p.limits, features: p.features, isPublic: p.isPublic, brand: p.brand },
      create: p,
    });
  }
  console.log(`✔ ${PLANS.length} planes conversia_*`);

  await prisma.messagePackage.upsert({
    where: { code: "conversia-sobre-500" },
    update: { name: "Sobre 500 créditos", credits: 500, priceClp: 21900, priceUsd: 25, active: true, order: 10 },
    create: { code: "conversia-sobre-500", name: "Sobre 500 créditos", credits: 500, priceClp: 21900, priceUsd: 25, active: true, order: 10 },
  });
  console.log("✔ sobre de 500 créditos");

  await prisma.platformSetting.upsert({
    where: { key: "walletWeights:conversia" },
    update: { value: JSON.stringify({ utility: 1, authentication: 1, marketing: 4, service: 1 }) },
    create: { key: "walletWeights:conversia", value: JSON.stringify({ utility: 1, authentication: 1, marketing: 4, service: 1 }) },
  });
  console.log("✔ walletWeights:conversia (1/1/1·marketing 4)");

  const verticals = JSON.parse(readFileSync(join(here, "..", "seeds", "vertical-templates.json"), "utf-8"));
  for (const v of verticals) {
    await prisma.verticalTemplate.upsert({
      where: { key_version: { key: v.key, version: v.version } },
      update: { name: v.name, definition: v.definition, active: true },
      create: { key: v.key, version: v.version, name: v.name, definition: v.definition, active: true },
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
