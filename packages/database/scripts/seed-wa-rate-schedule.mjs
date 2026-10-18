#!/usr/bin/env node
/**
 * Siembra el platformSetting `whatsappRateSchedule` (tarifa de servicio por país, vigente
 * por fecha). Es un OVERRIDE de las tarifas base (packages/agents pricing). Para el stack de
 * SIMULACIÓN deja CL/CO/PE/AR con tarifa de servicio activa, de modo que el excedente del
 * free tier cobre (invariante de dinero del sim). Idempotente.
 *   DATABASE_URL=... node packages/database/scripts/seed-wa-rate-schedule.mjs
 */
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const schedule = {
  CL: { service: [{ effectiveFrom: "2026-01-01T00:00:00Z", rateUsd: 0.02 }] },
  CO: { service: [{ effectiveFrom: "2026-01-01T00:00:00Z", rateUsd: 0.02 }] },
  PE: { service: [{ effectiveFrom: "2026-01-01T00:00:00Z", rateUsd: 0.02 }] },
  AR: { service: [{ effectiveFrom: "2026-01-01T00:00:00Z", rateUsd: 0.02 }] },
};

async function main() {
  await prisma.platformSetting.upsert({
    where: { key: "whatsappRateSchedule" },
    update: { value: JSON.stringify(schedule) },
    create: { key: "whatsappRateSchedule", value: JSON.stringify(schedule) },
  });
  console.log("✔ whatsappRateSchedule sembrado (CL/CO/PE/AR service 0.02 USD)");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
