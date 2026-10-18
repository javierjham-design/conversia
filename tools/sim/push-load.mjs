#!/usr/bin/env node
/**
 * M6.3 — CARGA DE PUSH contra el stack Docker (NUNCA producción).
 * Crea N orgs sintéticas, cada una con 1 usuario y D suscripciones web_push (claves ECDH
 * válidas) apuntando al push-mock-server (host.docker.internal, alcanzable desde el worker en
 * Docker). Dispara una ola de ai.escalation + credits.low y verifica:
 *   - todas las entregas llegan al mock,
 *   - las suscripciones muertas (el mock responde 410 a ~10%) quedan REVOCADAS,
 *   - el flujo origen no se rompe (se crean las filas in_app),
 *   - api/worker siguen sanos mientras despacha.
 *
 * Requisitos: `pnpm sim:up` corriendo + `node tools/sim/push-mock-server.mjs` en otra terminal.
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/conversia_sim \
 *   REDIS_URL=redis://localhost:6379 MOCK_HOST=host.docker.internal \
 *   node tools/sim/push-load.mjs
 */
import { createRequire } from "node:module";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Cada dependencia se resuelve desde el paquete que la declara (pnpm no las iza a la raíz).
const dbRequire = createRequire(join(ROOT, "packages/database/package.json"));
const wRequire = createRequire(join(ROOT, "apps/worker/package.json"));
const { PrismaClient } = dbRequire("@prisma/client");
const { Queue } = wRequire("bullmq");
const IORedis = wRequire("ioredis");

const ORGS = Number(process.env.PUSH_ORGS || 250);
const DEVICES_PER_USER = Number(process.env.PUSH_DEVICES_PER_USER || 2);
const MOCK_HOST = process.env.MOCK_HOST || "host.docker.internal";
const MOCK_PORT = Number(process.env.PUSH_MOCK_PORT || 8099);
// web-push exige TLS → en la carga real el mock sirve HTTPS (self-signed). El worker y este
// script lo aceptan con NODE_TLS_REJECT_UNAUTHORIZED=0 (solo sim).
const MOCK_SCHEME = process.env.MOCK_SCHEME || "https";
const MOCK_STATS = `${MOCK_SCHEME}://localhost:${MOCK_PORT}/stats`;
const API = process.env.API || "http://localhost:4000";
const TAG = "pushload";

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", { maxRetriesPerRequest: null });
const queue = new Queue("notifications", { connection });

function genSub() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function stats() {
  try {
    return await (await fetch(MOCK_STATS)).json();
  } catch {
    return null;
  }
}

const RUN = Date.now().toString(36);

async function main() {
  // Limpia restos de corridas anteriores (por si alguna no hizo CLEANUP).
  const stale = await prisma.organization.findMany({ where: { slug: { startsWith: TAG + "-" } }, select: { id: true } });
  if (stale.length) {
    const ids = stale.map((o) => o.id);
    await prisma.notificationDelivery.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.pushDevice.deleteMany({ where: { organizationId: { in: ids } } });
    await prisma.organization.deleteMany({ where: { id: { in: ids } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: "@pushload.local" } } });
    console.log(`  (limpié ${ids.length} orgs de una corrida previa)`);
  }
  console.log(`▶ Sembrando ${ORGS} orgs × ${DEVICES_PER_USER} dispositivos (${ORGS * DEVICES_PER_USER} suscripciones)…`);
  const orgIds = [];
  const userIds = [];
  const devices = [];
  let seq = 0;
  for (let i = 0; i < ORGS; i++) {
    const orgId = "pl_o_" + randomUUID().replace(/-/g, "").slice(0, 20);
    const userId = "pl_u_" + randomUUID().replace(/-/g, "").slice(0, 20);
    orgIds.push(orgId);
    userIds.push(userId);
    await prisma.user.create({ data: { id: userId, email: `${userId}@pushload.local`, passwordHash: "x", name: "PushLoad", brand: "conversia" } });
    // Habilita web_push para credits.low (por defecto va a whatsapp) vía prefs del usuario.
    await prisma.organization.create({
      data: {
        id: orgId,
        name: "PushLoad " + i,
        slug: `${TAG}-${RUN}-${i}`,
        brand: "conversia",
        settings: { notifPrefs: { [userId]: { matrix: { "credits.low": { web_push: true } } } }, tag: TAG },
      },
    });
    for (let d = 0; d < DEVICES_PER_USER; d++) {
      const { p256dh, auth } = genSub();
      devices.push({
        organizationId: orgId,
        userId,
        platform: "web",
        kind: "web_push",
        identifier: `${MOCK_SCHEME}://${MOCK_HOST}:${MOCK_PORT}/push/${seq}`,
        keys: { p256dh, auth },
        active: true,
      });
      seq++;
    }
  }
  await prisma.pushDevice.createMany({ data: devices });
  const totalSubs = devices.length;
  console.log(`  ✓ ${orgIds.length} orgs, ${userIds.length} usuarios, ${totalSubs} suscripciones.`);

  const before = (await stats()) ?? { received: 0, gone: 0 };
  const apiBefore = await fetch(`${API}/health`).then((r) => r.status).catch(() => 0);

  console.log("▶ Encolando la ola (ai.escalation + credits.low por org)…");
  const t0 = Date.now();
  for (let i = 0; i < ORGS; i++) {
    await queue.add("notify", { eventKey: "ai.escalation", organizationId: orgIds[i], userIds: [userIds[i]], data: { contactName: "Cliente " + i, reason: "IA no disponible" }, conversationId: "pl_c_" + i });
    await queue.add("notify", { eventKey: "credits.low", organizationId: orgIds[i], userIds: [userIds[i]], data: { pct: 15, used: 85, included: 100 } });
  }
  console.log(`  ✓ ${ORGS * 2} jobs encolados.`);

  // Espera a que el mock deje de recibir (drenado).
  let last = -1,
    stable = 0;
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    const s = (await stats()) ?? { received: 0, gone: 0 };
    const total = s.received + s.gone - (before.received + before.gone);
    if (total === last) {
      stable++;
      if (stable >= 3 && total > 0) break;
    } else stable = 0;
    last = total;
    process.stdout.write(`\r  entregas al mock: ${total} (201:${s.received - before.received} / 410:${s.gone - before.gone})   `);
  }
  const drainMs = Date.now() - t0;
  console.log("");

  // Verificaciones en BD.
  const after = (await stats()) ?? { received: 0, gone: 0 };
  const delivered = after.received + after.gone - (before.received + before.gone);
  const revoked = await prisma.pushDevice.count({ where: { organizationId: { in: orgIds }, active: false } });
  const inApp = await prisma.notification.count({ where: { organizationId: { in: orgIds } } });
  const deliveries = await prisma.notificationDelivery.groupBy({ by: ["channel", "status"], where: { organizationId: { in: orgIds } }, _count: true }).catch(() => []);
  const apiAfter = await fetch(`${API}/health`).then((r) => r.status).catch(() => 0);
  let workerFresh = "?";
  try {
    const raw = await connection.get("conversia:health:worker");
    workerFresh = raw ? "sí (" + raw + ")" : "sin latido";
  } catch {}

  console.log("\n==================== RESULTADO M6.3 ====================");
  console.log(`Suscripciones sembradas:      ${totalSubs}`);
  console.log(`Entregas al mock:             ${delivered}  (201: ${after.received - before.received} · 410: ${after.gone - before.gone})`);
  console.log(`Suscripciones revocadas (410→active=false): ${revoked}`);
  console.log(`Filas in_app creadas (flujo origen intacto): ${inApp}  (esperado ~${ORGS * 2})`);
  console.log(`notification_deliveries:`, JSON.stringify(deliveries.map((d) => ({ [`${d.channel}/${d.status}`]: d._count }))));
  console.log(`Drenado de la ola:            ${(drainMs / 1000).toFixed(1)}s`);
  console.log(`api /health:                  antes ${apiBefore} · después ${apiAfter}`);
  console.log(`worker (latido Redis):        ${workerFresh}`);
  console.log("========================================================");

  if (process.env.CLEANUP === "1") {
    await prisma.pushDevice.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.notificationDelivery.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.notification.deleteMany({ where: { organizationId: { in: orgIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    console.log("🧹 limpieza hecha (CLEANUP=1).");
  }

  await queue.close();
  await connection.quit();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
