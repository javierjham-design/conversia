#!/usr/bin/env node
/**
 * token-health-sim.mjs — Prueba END-TO-END (stack Docker, provider mock) de la SALUD DE TOKENS
 * de WhatsApp: reproduce el incidente 19-oct-2026 (token 190) y verifica que JAMÁS sea silencioso.
 *
 * Simula el 190 con el flag Redis `sim:wa-token-invalid` (lo lee el MockChannelProvider al ENVIAR
 * y al VERIFICAR). Cubre:
 *   A) Fail-fast en el ENVÍO: un cliente escribe → el bot intenta responder → 190 → mensaje FAILED
 *      legible + excepción crítica `token_invalido` + canal "error".
 *   B) Chequeo ACTIVO sin tráfico: una 2.ª org SIN inbound → el chequeo periódico (CLI on-demand)
 *      detecta el token muerto igual → excepción + canal "error".
 *   C) Recuperación: se borra el flag → el chequeo reactiva los canales y RESUELVE las excepciones.
 *
 * Requisitos: `pnpm sim:up` arriba, y worker/api reconstruidos con este código.
 * Uso:  node tools/sim/token-health-sim.mjs
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.SIM_API || "http://localhost:4000";
const DB = process.env.SIM_DB_URL || "postgresql://postgres:postgres@localhost:5433/conversia_sim";
const REDIS_CTR = "conversia-sim-redis";
const WORKER_CTR = "conversia-sim-worker";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dbRequire = createRequire(join(ROOT, "packages/database/package.json"));
const { PrismaClient } = dbRequire("@prisma/client");
const prisma = new PrismaClient({ datasources: { db: { url: DB } } });

const C = { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, gray: (s) => `\x1b[90m${s}\x1b[0m` };
// Log a archivo además de stdout: así la corrida es observable aunque se ejecute en segundo
// plano (stdout se bufferea al pipe). El archivo queda como evidencia.
const LOG = join(dirname(fileURLToPath(import.meta.url)), "out", "token-health-sim.log");
try { mkdirSync(dirname(LOG), { recursive: true }); writeFileSync(LOG, ""); } catch { /* noop */ }
function say(line) { console.log(line); try { appendFileSync(LOG, line.replace(/\x1b\[[0-9;]*m/g, "") + "\n"); } catch { /* noop */ } }
const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  say(`  ${ok ? C.g("✓") : C.r("✗")} ${name}${detail ? C.gray("  — " + detail) : ""}`);
}
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

function redis(...args) { return execFileSync("docker", ["exec", REDIS_CTR, "redis-cli", ...args], { encoding: "utf8" }).trim(); }
function runHealthCli() {
  const out = execFileSync("docker", ["exec", WORKER_CTR, "node", "apps/worker/dist/token-health-cli.js"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("SNAPSHOT:"));
  return line ? JSON.parse(line.slice("SNAPSHOT:".length)) : null;
}

async function registerOperando(label) {
  const email = `qa+tokensim-${label}-${Date.now()}@conversia.local`;
  const reg = await api("/auth/register", { method: "POST", headers: { origin: "http://localhost:3002" }, body: JSON.stringify({ email, password: "PruebaTokenSim2026", name: "QA Token", organizationName: `QA Token ${label} ${Date.now()}`, country: "CL", vertical: "gimnasio" }) });
  if (!reg.body?.token) throw new Error(`register ${label}: ${reg.status} ${JSON.stringify(reg.body).slice(0, 200)}`);
  const token = reg.body.token;
  const orgId = reg.body.organizationId;
  const H = { authorization: `Bearer ${token}` };
  // publicar + activar agente
  const agents = (await api("/agents", { headers: H })).body;
  const agentId = (Array.isArray(agents) ? agents : agents?.items ?? [])[0]?.id;
  await api(`/agents/${agentId}/draft`, { method: "PUT", headers: H, body: JSON.stringify({ systemPrompt: "Responde breve.", config: {}, tools: [] }) });
  await api(`/agents/${agentId}/publish`, { method: "POST", headers: H, body: "{}" });
  await api(`/agents/${agentId}/active`, { method: "POST", headers: H, body: JSON.stringify({ active: true }) });
  // canal MOCK con ese agente por defecto (sin esto el bot no responde)
  await api("/channels", { method: "POST", headers: H, body: JSON.stringify({ type: "MOCK", name: "Simulado", defaultAgentId: agentId }) });
  const me = (await api("/auth/me", { headers: H })).body;
  const slug = me?.organization?.slug ?? me?.org?.slug;
  return { token, orgId, slug, H };
}

async function sendInbound(slug, text, waId) {
  const body = { object: "whatsapp_business_account", entry: [{ id: "0", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "56900000000", phone_number_id: `mock:${slug}` }, contacts: [{ profile: { name: "Cliente Sim" }, wa_id: waId } ], messages: [{ from: waId, id: `wamid.toksim.${Date.now()}.${Math.random().toString(36).slice(2, 7)}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }] } }] }] };
  await api("/webhooks/whatsapp", { method: "POST", headers: { "x-conversia-mock-token": "dev-mock-inbound-token" }, body: JSON.stringify(body) });
}

const openException = (orgId) => prisma.platformException.findFirst({ where: { organizationId: orgId, type: "token_invalido", status: { in: ["open", "assigned"] } } });
const channelStatus = (orgId) => prisma.channelConnection.findFirst({ where: { organizationId: orgId, type: "MOCK" }, select: { status: true } });
async function pollFailed(orgId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = await prisma.message.findFirst({ where: { organizationId: orgId, status: "FAILED" }, orderBy: { createdAt: "desc" }, select: { error: true } });
    if (m) return m;
    await sleep(2500);
  }
  return null;
}

async function main() {
  say(C.b("\n🔌 Salud de tokens de WhatsApp — simulación del 190 (Docker, mock)\n"));
  // Partimos en limpio.
  redis("DEL", "sim:wa-token-invalid");

  say(C.b("Preparando dos orgs operando (agente + canal MOCK activo)…"));
  const A = await registerOperando("envio");
  const B = await registerOperando("periodico");
  check("Org A y B nacen con canal activo", (await channelStatus(A.orgId))?.status === "active" && (await channelStatus(B.orgId))?.status === "active");

  say(C.b("\n① Simulamos el token caído (flag 190 ON, acotado a los 2 números de prueba)"));
  // Acotado por phone_number_id (mock:<slug>): solo A y B fallan, no los demás canales del sim.
  redis("SET", "sim:wa-token-invalid", `mock:${A.slug},mock:${B.slug}`);

  say(C.b("\n② Fail-fast en el ENVÍO (Org A): un cliente escribe → el bot falla con 190"));
  await sendInbound(A.slug, "Hola, ¿tienen hora?", "56911100001");
  const failed = await pollFailed(A.orgId);
  check("El mensaje del bot quedó FAILED", !!failed);
  check("El FAILED trae el motivo claro (token inválido / Railway)", !!failed && /token de WhatsApp inv|Railway/i.test(failed.error ?? ""), failed?.error?.slice(0, 80));
  check("Canal A marcado 'error' (token muerto)", (await channelStatus(A.orgId))?.status === "error");
  check("Excepción crítica token_invalido abierta para A", !!(await openException(A.orgId)) && (await openException(A.orgId))?.severity === "critical");

  say(C.b("\n③ Chequeo ACTIVO sin tráfico (Org B NO recibió nada): el CLI detecta el token muerto"));
  const snap1 = runHealthCli();
  check("El snapshot del chequeo reporta ok:false", snap1 && snap1.ok === false, snap1 ? `${snap1.dead?.length} caído(s)` : "sin snapshot");
  check("Canal B marcado 'error' SIN tráfico de por medio", (await channelStatus(B.orgId))?.status === "error");
  check("Excepción crítica token_invalido abierta para B", !!(await openException(B.orgId)));

  say(C.b("\n④ Recuperación: borramos el flag (token repuesto) → el chequeo resuelve solo"));
  redis("DEL", "sim:wa-token-invalid");
  const snap2 = runHealthCli();
  check("El snapshot vuelve a ok:true", snap2 && snap2.ok === true);
  check("Canal A reactivado", (await channelStatus(A.orgId))?.status === "active");
  check("Canal B reactivado", (await channelStatus(B.orgId))?.status === "active");
  check("Excepción de A resuelta (ya no abierta)", !(await openException(A.orgId)));
  check("Excepción de B resuelta (ya no abierta)", !(await openException(B.orgId)));

  const failedN = results.filter((r) => !r.ok).length;
  say("\n" + C.b(`Resultado: ${C.g(results.filter((r) => r.ok).length + " ok")} · ${failedN ? C.r(failedN + " fallidos") : C.g("0 fallidos")}`));
  await prisma.$disconnect();
  process.exit(failedN ? 1 : 0);
}

main().catch(async (e) => {
  console.error(C.r(`Error fatal: ${e.stack || e.message}`));
  await prisma.$disconnect().catch(() => {});
  process.exit(2);
});
