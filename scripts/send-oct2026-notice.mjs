#!/usr/bin/env node
/**
 * Aviso ÚNICO a clientes por el cambio de cobro de Meta (servicio 24 h) desde el
 * 2026-10-01. Encola el evento "announcement.oct2026" UNA vez por organización ACTIVE.
 *
 *   node scripts/send-oct2026-notice.mjs                 # DRY-RUN (solo lista)
 *   node scripts/send-oct2026-notice.mjs --confirm SI-ENVIAR   # envía de verdad
 *
 * Idempotente: un SETNX en Redis por org evita reenviar si se corre dos veces.
 * NO ejecutar contra producción sin que el dueño lo pida (ni siquiera en dry-run).
 * Requiere DATABASE_URL y REDIS_URL en el entorno.
 */
import { PrismaClient } from "@prisma/client";
import IORedis from "ioredis";
import { Queue } from "bullmq";

const args = process.argv.slice(2);
const confirmIdx = args.indexOf("--confirm");
const confirmed = confirmIdx >= 0 && args[confirmIdx + 1] === "SI-ENVIAR";

const prisma = new PrismaClient();
const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
const notifications = new Queue("notifications", { connection });

async function main() {
  const orgs = await prisma.organization.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true } });
  console.log(`${confirmed ? "ENVÍO REAL" : "DRY-RUN"} — ${orgs.length} organizaciones ACTIVE:`);

  let sent = 0;
  let skipped = 0;
  for (const org of orgs) {
    if (!confirmed) {
      console.log(`  • ${org.name} (${org.id})`);
      continue;
    }
    // Idempotencia: solo encola si el flag del aviso no existía para esta org.
    const first = await connection.set(`announce:oct2026:${org.id}`, "1", "EX", 365 * 24 * 3600, "NX");
    if (first !== "OK") {
      skipped++;
      continue;
    }
    await notifications.add("notify", { eventKey: "announcement.oct2026", organizationId: org.id, data: {} }, { attempts: 4, backoff: { type: "exponential", delay: 15_000 }, removeOnComplete: 1000, removeOnFail: 2000 });
    sent++;
    console.log(`  ✓ encolado: ${org.name} (${org.id})`);
  }

  if (confirmed) console.log(`\nEncolados: ${sent} · ya avisados antes (omitidos): ${skipped}`);
  else console.log(`\nDRY-RUN: nada se encoló. Para enviar: --confirm SI-ENVIAR`);
}

main()
  .catch((err) => {
    console.error("✖ Error:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await notifications.close();
    connection.disconnect();
  });
