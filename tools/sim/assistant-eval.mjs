#!/usr/bin/env node
/**
 * F4 — Evaluación del ASISTENTE DE IMPLEMENTACIÓN con IA REAL (no mock). Corre guiones de
 * clientes que NO saben de tecnología contra POST /assistant/message, guarda transcripts
 * para que un agente JUEZ los califique, y hace checks deterministas (cross-brand 404,
 * rate-limit, servicio creado en BD). NUNCA contra producción; la clave va en el compose.
 *
 *   SIM_API=http://localhost:4000 SIM_ORIGIN_CV=https://app.conversia.cl \
 *   node tools/sim/assistant-eval.mjs
 */
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const API = process.env.SIM_API ?? "http://localhost:4000";
const ORIGIN_CV = process.env.SIM_ORIGIN_CV ?? "https://app.conversia.cl";
const ORIGIN_TB = process.env.SIM_ORIGIN_TB ?? "http://localhost:3000";
const OUT = process.env.SIM_OUT ?? "./tools/sim/out";
const PSQL = process.env.SIM_PSQL ?? "psql";
const DB = ["-h", process.env.SIM_PG_HOST ?? "localhost", "-p", process.env.SIM_PG_PORT ?? "5433", "-U", process.env.SIM_PG_USER ?? "postgres", "-d", process.env.SIM_PG_DB ?? "conversia_sim", "-t", "-A"];
const psql = (sql) => { try { return execFileSync(PSQL, [...DB, "-c", sql], { env: { ...process.env, PGPASSWORD: process.env.SIM_PG_PASSWORD ?? "postgres" }, encoding: "utf8" }).trim(); } catch (e) { return `ERR:${e.message}`; } };
const rid = () => Math.random().toString(36).slice(2, 8);

async function http(method, path, { token, origin = ORIGIN_CV, body } = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", Origin: origin, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function registerOwner(rubro) {
  const email = `aev_${rubro}_${rid()}@conversia.test`;
  const r = await http("POST", "/auth/register", { body: { email, password: "Eval-123456!", name: "Dueño Eval", organizationName: `Eval ${rubro} ${rid()}`, country: "CL", vertical: rubro } });
  if (r.status >= 300 || !r.data?.token) throw new Error(`registro ${rubro} falló: ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
  return { token: r.data.token, orgId: r.data.organizationId, email };
}

/** Corre una conversación de varios turnos manteniendo el historial. */
async function runScript(owner, turns, route = "/inicio") {
  const history = [];
  const transcript = [];
  for (const user of turns) {
    const r = await http("POST", "/assistant/message", { token: owner.token, body: { message: user, route, history } });
    if (r.status !== 200) { transcript.push({ user, error: `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 120)}` }); break; }
    const reply = r.data?.reply ?? "";
    transcript.push({ user, reply, mode: r.data?.mode, wrote: r.data?.wrote === true });
    history.push({ role: "user", content: user });
    history.push({ role: "assistant", content: reply });
  }
  return transcript;
}

// ---- Banco de guiones (12+) ----
const SCRIPTS = [
  { id: "que-falta", rubro: "gimnasio", turns: ["hola, ¿qué me falta para empezar a usar esto?"] },
  { id: "conectar-wsp-coex", rubro: "barberia", turns: ["¿cómo conecto mi whatsapp? tengo el número en mi teléfono y no lo quiero perder"] },
  { id: "error-popup-meta", rubro: "barberia", turns: ["me salió un mensaje que dice: tu navegador bloqueó la ventana de Meta. ¿qué hago?"], route: "/canales" },
  { id: "cobrar-servicios", rubro: "barberia", turns: ["quiero cobrar $15.000 el corte y $25.000 la barba", "sí, dale, créalos"], checkDb: "corte" },
  { id: "saldo-convs", rubro: "gimnasio", turns: ["¿cuántas conversaciones me quedan?", "se me están acabando, ¿cómo recargo?"] },
  { id: "cargar-tarjeta", rubro: "dental", turns: ["¿cómo cargo mi tarjeta para pagar?"] },
  { id: "cambiar-horario", rubro: "barberia", turns: ["cambia el horario del local a 10 a 20", "sí, confirmo"] },
  { id: "ayuda-telefono", rubro: "gimnasio", turns: ["esto no me funciona y estoy aburrido, ¿me pueden ayudar por teléfono una persona de verdad?"] },
  { id: "rubro-gimnasio", rubro: "gimnasio", turns: ["¿el bot puede responder por las mensualidades y los planes del gimnasio?"] },
  { id: "rubro-abogados", rubro: "abogados", turns: ["¿sirve para agendar consultas legales y cobrar la primera asesoría?"] },
  { id: "rubro-dental", rubro: "dental", turns: ["¿puede confirmar las horas de los pacientes y recordar la limpieza dental?"] },
  { id: "intuicion-primer-paso", rubro: "gimnasio", turns: ["no entiendo nada de tecnología, ayúdame tú paso a paso"] },
];

async function main() {
  const results = [];
  // Un dueño por rubro distinto (contexto del rubro instalado).
  const owners = {};
  for (const rubro of [...new Set(SCRIPTS.map((s) => s.rubro))]) owners[rubro] = await registerOwner(rubro);

  for (const s of SCRIPTS) {
    const owner = owners[s.rubro];
    process.stdout.write(`▶ ${s.id} (${s.rubro})… `);
    const transcript = await runScript(owner, s.turns, s.route);
    const entry = { id: s.id, rubro: s.rubro, transcript };
    if (s.checkDb) {
      const n = psql(`SELECT count(*) FROM services WHERE organization_id='${owner.orgId}' AND lower(name) LIKE '%${s.checkDb}%';`);
      entry.dbCheck = { looking: s.checkDb, found: n };
    }
    results.push(entry);
    console.log("ok");
  }

  // ---- Checks deterministas ----
  const det = {};
  // Cross-brand: un dueño TuBot no puede usar el asistente (404).
  const tb = await http("POST", "/auth/register", { origin: ORIGIN_TB, body: { email: `aev_tb_${rid()}@tubot.test`, password: "Eval-123456!", name: "Dueño TB", organizationName: `Eval TB ${rid()}`, country: "CL" } });
  if (tb.data?.token) {
    const xb = await http("POST", "/assistant/message", { token: tb.data.token, origin: ORIGIN_TB, body: { message: "hola" } });
    det.crossBrand404 = xb.status === 404;
  }
  // Rate limit 20/5min: 22 mensajes rápidos → debe aparecer 429.
  const rlOwner = await registerOwner("gimnasio");
  let got429 = false;
  for (let i = 0; i < 22; i++) { const r = await http("POST", "/assistant/message", { token: rlOwner.token, body: { message: `ping ${i}` } }); if (r.status === 429) { got429 = true; break; } }
  det.rateLimit429 = got429;

  writeFileSync(`${OUT}/assistant-transcripts.json`, JSON.stringify({ results, det, generatedAt: new Date().toISOString() }, null, 2));
  console.log("\n==================== RESUMEN F4 ====================");
  console.log(`Guiones corridos: ${results.length}`);
  console.log(`Cross-brand 404 (TuBot sin asistente): ${det.crossBrand404 ? "SÍ ✓" : "NO ✗"}`);
  console.log(`Rate limit 429: ${det.rateLimit429 ? "SÍ ✓" : "NO ✗"}`);
  const svc = results.find((r) => r.dbCheck);
  if (svc) console.log(`Servicio creado por chat (DB): busca "${svc.dbCheck.looking}" → ${svc.dbCheck.found}`);
  console.log(`Transcripts → ${OUT}/assistant-transcripts.json (para el agente JUEZ)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
