#!/usr/bin/env node
/** SIMULACIÓN 250 CLIENTES — 14 rubros, rol BD de producción, compras por API,
 *  + BATERÍA DE SEGURIDAD OFENSIVA (inyección de inbound, IDOR, carreras de débito,
 *  cross-brand, JWT forjado, rate limits). Fases: w1 registro · w2 compras · w3 tráfico ·
 *  w4 bordes · w5 montaje×14 · w6 SEGURIDAD · w7 validación global. */
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";

// Todo parametrizable por env (defaults = entorno local típico). El harness corre
// SIEMPRE contra un stack AISLADO (BD/Redis propios + providers mock) — jamás producción.
const API = process.env.SIM_API ?? "http://127.0.0.1:4000";
const ORIGIN_CV = process.env.SIM_ORIGIN_CV ?? "https://app.conversia.cl"; // debe calzar con WEB_URL_CONVERSIA del stack sim
const ORIGIN_TB = process.env.SIM_ORIGIN_TB ?? "http://localhost:3000";
const PSQL = process.env.SIM_PSQL ?? "psql";
const REDIS = process.env.SIM_REDIS_CLI ?? "redis-cli";
const DB = ["-h", process.env.SIM_PG_HOST ?? "localhost", "-p", process.env.SIM_PG_PORT ?? "5433", "-U", process.env.SIM_PG_USER ?? "postgres", "-d", process.env.SIM_PG_DB ?? "conversia_sim", "-t", "-A"];
const OUT_DIR = process.env.SIM_OUT ?? "./tools/sim/out";
import { mkdirSync } from "node:fs";
try { mkdirSync(OUT_DIR, { recursive: true }); } catch { /* existe */ }
const OUT = (p) => `${OUT_DIR}/${p}`;

const findings = [];
const metrics = {};
const F = (sev, area, msg) => { findings.push({ sev, area, msg }); console.log(`  [${sev}] ${area}: ${msg}`); };
const OK = (name, detail) => console.log(`  PASS · ${name}${detail ? " — " + detail : ""}`);
const CHECK = (ok, sev, area, failMsg, okDetail) => { if (ok) OK(area, okDetail); else F(sev, area, failMsg); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function psql(sql) {
  try { return execFileSync(PSQL, [...DB, "-c", sql], { env: { ...process.env, PGPASSWORD: process.env.SIM_PG_PASSWORD ?? "postgres" }, encoding: "utf8" }).trim(); }
  catch (e) { F("ERROR", "psql", `${sql.slice(0, 80)} → ${String(e.stderr || e.message).slice(0, 160)}`); return ""; }
}
function redis(...args) { try { return execFileSync(REDIS, args, { encoding: "utf8" }).trim(); } catch (e) { return `ERR:${e.message}`; } }
async function http(method, path, { token, origin = ORIGIN_CV, body, headers = {}, rawToken } = {}) {
  for (let a = 1; ; a++) {
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { "content-type": "application/json", Origin: origin, ...(rawToken ? { authorization: rawToken } : token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null; try { data = await res.json(); } catch {}
      return { status: res.status, data };
    } catch (e) {
      if (a >= 4) { F("ERROR", "http", `${method} ${path} → ${String(e.cause?.code ?? e.message).slice(0, 70)}`); return { status: 599, data: null }; }
      await sleep(800 * a);
    }
  }
}
function inboundPayload(slug, phone, text, wamid) {
  return { object: "whatsapp_business_account", entry: [{ id: "0", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { display_phone_number: "56900000000", phone_number_id: `mock:${slug}` },
    contacts: [{ profile: { name: `Cliente ${phone.slice(-4)}` }, wa_id: phone }],
    messages: [{ from: phone, id: wamid ?? `wamid.s250.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
  } }] }] };
}
async function sendInbound(slug, phone, text, wamid, token = "dev-mock-inbound-token") {
  const body = JSON.stringify(inboundPayload(slug, phone, text, wamid));
  for (let a = 1; ; a++) {
    try {
      const res = await fetch(`${API}/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-conversia-mock-token": token }, body });
      return res.status;
    } catch (e) {
      if (a >= 4) { F("ERROR", "inbound", `${slug} ${phone} → ${String(e.cause?.code ?? e.message).slice(0, 50)}`); return 599; }
      await sleep(700 * a);
    }
  }
}
async function drain(label, maxMs = 240000) {
  let prev = -1, stable = 0; const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const n = Number(psql(`SELECT count(*) FROM messages;`));
    if (n === prev) { stable++; if (stable >= 4) break; } else stable = 0;
    prev = n; await sleep(2500);
  }
  console.log(`  drain(${label}): messages=${prev} en ${((Date.now() - t0) / 1000) | 0}s`);
}
function wireOrg(orgId, idSuffix) {
  psql(`INSERT INTO channel_connections SELECT (jsonb_populate_record(t.*, jsonb_build_object('id','cc250_${idSuffix}','organization_id','${orgId}','default_agent_id',(SELECT id FROM agents WHERE organization_id='${orgId}' AND deleted_at IS NULL LIMIT 1)))).* FROM channel_connections t WHERE t.id=(SELECT id FROM channel_connections WHERE type='MOCK' LIMIT 1);`);
  psql(`UPDATE agent_versions SET status='PUBLISHED', published_at=now() WHERE id=(SELECT v.id FROM agent_versions v JOIN agents a ON a.id=v.agent_id WHERE a.organization_id='${orgId}' ORDER BY v.created_at ASC LIMIT 1);`);
  psql(`UPDATE agents SET current_version_id=(SELECT v.id FROM agent_versions v WHERE v.agent_id=agents.id AND v.status='PUBLISHED' ORDER BY v.created_at ASC LIMIT 1) WHERE organization_id='${orgId}' AND current_version_id IS NULL;`);
}
// Fallback para orgs sin agente del paquete (tubot): agente mínimo publicado, con slug.
function ensureAgent(orgId, idSuffix) {
  const has = psql(`SELECT count(*) FROM agents WHERE organization_id='${orgId}' AND deleted_at IS NULL;`);
  if (Number(has) === 0) {
    psql(`INSERT INTO agents (id, organization_id, slug, name, kind, active, created_at, updated_at) VALUES ('ag250_${idSuffix}','${orgId}','asistente','Asistente','sales',true,now(),now());`);
    psql(`INSERT INTO agent_versions (id, organization_id, agent_id, version, status, system_prompt, config, tools, published_at, created_at) VALUES ('agv250_${idSuffix}','${orgId}','ag250_${idSuffix}',1,'PUBLISHED','Eres el asistente del negocio. Responde breve.','{}','[]',now(),now());`);
    psql(`UPDATE agents SET current_version_id='agv250_${idSuffix}' WHERE id='ag250_${idSuffix}';`);
  }
}

// ============ MATRIZ 250 — 14 RUBROS ============
const RUBROS = ["barberia", "peluqueria", "estetica", "centro_medico", "dental", "generico", "gimnasio", "abogados", "taller", "veterinaria", "kinesiologia", "medspa", "psicologia", "servicios_domicilio"];
const ORGS = [];
function mk(i, tag, extra = {}) {
  const v = extra.vertical ?? RUBROS[(i - 1) % RUBROS.length];
  ORGS.push({ i, tag, brand: extra.brand ?? "conversia", vertical: v, convs: extra.convs ?? 0, country: extra.country ?? "CL",
    name: `S250 ${String(i).padStart(3, "0")} ${v} ${tag}`, email: `s250.${i}@sim.conversia.test`, pass: "Sim250-2026!", ...extra });
}
for (let i = 1; i <= 120; i++) mk(i, "trial", { convs: i % 5 === 0 ? 0 : 2 + (i % 9) * 2 });
for (let i = 121; i <= 160; i++) mk(i, "base", { convs: 8 + (i % 7) * 5 });
for (let i = 161; i <= 166; i++) mk(i, "base_exhaust", { convs: 124 });
for (let i = 167; i <= 172; i++) mk(i, "base_pack", { convs: 40 });
for (let i = 173; i <= 178; i++) mk(i, "aiplus", { convs: 12 });
for (let i = 179; i <= 184; i++) mk(i, "v1_fun", { convs: 10 });
for (let i = 185; i <= 194; i++) mk(i, "tubot", { brand: "tubot", convs: 6 });
mk(195, "pais", { country: "CO", convs: 8 }); mk(196, "pais", { country: "MX", convs: 8 });
mk(197, "pais", { country: "PE", convs: 8 }); mk(198, "pais", { country: "AR", convs: 8 });
mk(199, "autorecarga", { convs: 8 }); mk(200, "autorecarga", { convs: 8 });
mk(201, "freetier_v1", { convs: 20 }); mk(202, "freetier_v2", { convs: 20 }); mk(203, "freetier_co", { country: "CO", convs: 20 });
mk(204, "fusible", { convs: 0 }); mk(205, "dupwamid", { convs: 0 }); mk(206, "xphone", { convs: 4 }); mk(207, "demo", { convs: 4 });
for (let k = 0; k < 14; k++) mk(208 + k, "montaje", { vertical: RUBROS[k], convs: 4 });
mk(222, "upgrade_mid", { convs: 24 }); mk(223, "v2_migrate", { convs: 8 }); mk(224, "cancelacion", { convs: 6 });
mk(225, "seguridad", { convs: 2 });
for (let i = 226; i <= 250; i++) mk(i, "carga", { convs: 10 });

// ============ W1: REGISTRO + SMOKE + FIXUPS ============
async function w1() {
  console.log("\n== W1 REGISTRO (250 orgs, 14 rubros) ==");
  redis("DEL", "rl:register:127.0.0.1");
  const probe = await http("POST", "/auth/register", { body: { email: "probe250@sim.conversia.test", password: "Probe-123456!", name: "Probe", organizationName: "Probe Gate 250", vertical: "gimnasio", country: "CL" } });
  const pOrg = probe.data?.organizationId;
  const gate = psql(`SELECT o.brand||'/'||p.code||'/'||coalesce((SELECT sum(amount)::text FROM conversation_credit_lots l WHERE l.organization_id=o.id),'0')||'/'||coalesce((SELECT to_char(w.period_start,'YYYY') FROM conversation_wallets w WHERE w.organization_id=o.id),'?')||'/'||coalesce(o.settings->'vertical'->>'key','SIN')||'@v'||coalesce(o.settings->'vertical'->>'version','?') FROM organizations o JOIN subscriptions s ON s.organization_id=o.id JOIN plans p ON p.id=s.plan_id WHERE o.id='${pOrg}';`);
  if (gate !== "conversia/conversia_v2_trial/30/1970/gimnasio@v2") { F("CRITICO", "smoke-gate", `sonda=${gate} — ABORTO`); throw new Error("smoke gate"); }
  OK("smoke gate (gimnasio v2 desde seed puro)", gate);
  const t0 = Date.now();
  for (const o of ORGS) {
    redis("DEL", "rl:register:127.0.0.1");
    const origin = o.brand === "tubot" ? ORIGIN_TB : ORIGIN_CV;
    let r;
    for (let a = 0; a < 3; a++) {
      try { r = await http("POST", "/auth/register", { origin, body: { email: o.email, password: o.pass, name: `Dueño ${o.i}`, organizationName: o.name, country: o.country, ...(o.brand === "conversia" ? { vertical: o.vertical } : {}) } }); if (r.status < 500) break; } catch {}
      await sleep(1500);
    }
    if (!r || r.status >= 300 || !r.data?.token) { F("CRITICO", "registro", `org ${o.i} (${o.tag}/${o.vertical}): HTTP ${r?.status} ${JSON.stringify(r?.data ?? {}).slice(0, 120)}`); continue; }
    o.token = r.data.token; o.orgId = r.data.organizationId;
    o.slug = psql(`SELECT slug FROM organizations WHERE id='${o.orgId}';`);
    if (o.i % 50 === 0) console.log(`  ... ${o.i}/250 (${((Date.now() - t0) / 1000) | 0}s)`);
  }
  metrics.registered = ORGS.filter((o) => o.token).length;
  console.log(`  registradas: ${metrics.registered}/250`);
  for (const o of ORGS.filter((x) => x.token)) {
    ensureAgent(o.orgId, o.i);
    wireOrg(o.orgId, o.i);
  }
  const sinAgente = psql(`SELECT count(*) FROM organizations o WHERE o.name LIKE 'S250 %' AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.organization_id=o.id AND a.current_version_id IS NOT NULL);`);
  CHECK(Number(sinAgente) === 0, "ALTO", "fixups-agentes", `${sinAgente} orgs sin agente publicado`, "250/250 con agente publicado y canal");
  writeFileSync(OUT("sims250.json"), JSON.stringify(ORGS, null, 1));
}

// ============ W2: COMPRAS/UPGRADES POR API ============
async function w2() {
  console.log("\n== W2 COMPRAS/UPGRADES POR API ==");
  psql(`INSERT INTO plans (id, code, name, price_clp, price_usd, interval, is_public, active, "order", brand, limits, features, created_at)
        SELECT 'plan250_plus','conversia_v2_plus',name,price_clp,price_usd,interval,false,true,25,brand,limits, features || '{"aiPlus":true}', now()
        FROM plans WHERE code='conversia_v2_base' ON CONFLICT (code) DO NOTHING;`);
  const confirm = async (o, planCode) => {
    const c = await http("POST", "/billing/checkout", { token: o.token, body: { planCode } });
    if (c.status >= 300) { F("ALTO", "checkout", `org ${o.i} ${planCode}: HTTP ${c.status} ${JSON.stringify(c.data).slice(0, 110)}`); return false; }
    const m = await http("POST", "/billing/mock-confirm", { token: o.token, body: { planCode } });
    if (m.status >= 300) { F("ALTO", "mock-confirm", `org ${o.i} ${planCode}: HTTP ${m.status}`); return false; }
    return true;
  };
  const upgrade = { base: "conversia_v2_base", base_exhaust: "conversia_v2_base", base_pack: "conversia_v2_base", autorecarga: "conversia_v2_base", freetier_v2: "conversia_v2_base", fusible: "conversia_v2_base", dupwamid: "conversia_v2_base", xphone: "conversia_v2_base", demo: "conversia_v2_base", cancelacion: "conversia_v2_base", freetier_co: "conversia_v2_base", pais: "conversia_v2_base", aiplus: "conversia_v2_plus", v1_fun: "conversia_funcionando", freetier_v1: "conversia_funcionando", v2_migrate: "conversia_funcionando" };
  let done = 0;
  for (const o of ORGS.filter((x) => x.token && upgrade[x.tag])) if (await confirm(o, upgrade[o.tag])) done++;
  console.log(`  upgrades confirmados: ${done}`);
  for (const o of ORGS.filter((x) => x.token && x.tag === "base_exhaust")) {
    psql(`DELETE FROM conversation_credit_lots WHERE organization_id='${o.orgId}' AND ref_type='signup_gift';`);
  }
  for (const o of ORGS.filter((x) => x.token && x.tag === "base_pack")) {
    const b = await http("POST", "/billing/buy-package", { token: o.token, body: { code: "conv-pack-400" } });
    if (b.status < 300) await http("POST", "/billing/mock-confirm", { token: o.token, body: { planCode: "pkg:conv-pack-400" } });
    else F("ALTO", "buy-package", `org ${o.i}: HTTP ${b.status}`);
  }
  // Idempotencia pack (doble confirm mismo día = 1 lote).
  const oP = ORGS.find((x) => x.tag === "base_pack" && x.token);
  if (oP) {
    await http("POST", "/billing/mock-confirm", { token: oP.token, body: { planCode: "pkg:conv-pack-400" } });
    const lots = psql(`SELECT count(*)||'/'||coalesce(sum(amount),0) FROM conversation_credit_lots WHERE organization_id='${oP.orgId}' AND source='purchase';`);
    CHECK(lots === "1/400", "CRITICO", "pack-idempotencia", `doble confirm acreditó ${lots} (esperado 1/400)`, `doble confirm → ${lots}`);
  }
  // Sobre V1 (marca corregida): la org V1 Conversia compra SU sobre; la bolsa sube 500.
  const oFT1 = ORGS.find((x) => x.tag === "freetier_v1" && x.token);
  if (oFT1) {
    const b = await http("POST", "/billing/buy-package", { token: oFT1.token, body: { code: "conversia-sobre-500" } });
    const m = b.status < 300 ? await http("POST", "/billing/mock-confirm", { token: oFT1.token, body: { planCode: "pkg:conversia-sobre-500" } }) : { status: 599 };
    const bal = psql(`SELECT balance FROM message_wallets WHERE organization_id='${oFT1.orgId}';`);
    CHECK(b.status < 300 && m.status < 300 && Number(bal) >= 500, "ALTO", "sobre-v1-marca", `compra sobre V1: HTTP ${b.status}/${m.status} balance=${bal}`, `sobre 500 acreditado (balance=${bal})`);
  }
  for (const o of ORGS.filter((x) => x.token && x.tag === "autorecarga")) {
    const put = await http("PUT", "/billing/auto-recharge", { token: o.token, body: { enabled: true, thresholdRemaining: 20, packCode: "conv-recarga-100", monthlyCapClp: 40000 } });
    CHECK(put.status < 300, "MEDIO", `auto-recarga-${o.i}`, `PUT HTTP ${put.status} ${JSON.stringify(put.data).slice(0, 100)}`, "config guardada");
  }
  const oM = ORGS.find((x) => x.tag === "v2_migrate" && x.token);
  if (oM) {
    const r = await http("POST", "/billing/v2-migrate", { token: oM.token });
    CHECK(r.status < 300 && r.data?.courtesyCredits === 100, "ALTO", "v2-migrate", `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 110)}`, "cortesía 100");
  }
  writeFileSync(OUT("sims250.json"), JSON.stringify(ORGS, null, 1));
}

// ============ W3: TRÁFICO CONCURRENTE ============
async function w3() {
  console.log("\n== W3 TRÁFICO (12 orgs en paralelo) ==");
  const batch = 12;
  const list = ORGS.filter((o) => o.token && o.convs > 0 && !["fusible", "dupwamid"].includes(o.tag));
  const t0 = Date.now();
  for (let b = 0; b < list.length; b += batch) {
    const group = list.slice(b, b + batch);
    await Promise.all(group.map(async (o) => {
      for (let c = 1; c <= o.convs; c++) {
        const phone = `569${String(o.i).padStart(3, "0")}${String(c).padStart(5, "0")}`;
        await sendInbound(o.slug, phone, o.vertical === "abogados" ? "Hola, necesito orientación legal" : "Hola, quiero información y precios");
        await sleep(10);
        if (c % 4 === 0) { await sendInbound(o.slug, phone, "¿Tienen hora esta semana?"); await sleep(10); }
      }
    }));
    console.log(`  lote ${b / batch + 1}/${Math.ceil(list.length / batch)} (orgs ${group[0].i}–${group[group.length - 1].i})`);
    await drain(`lote${b / batch + 1}`);
  }
  console.log(`  tráfico en ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

// ============ W4: BORDES ============
async function w4() {
  console.log("\n== W4 BORDES ==");
  const mkMonth = (tz) => new Date().toLocaleDateString("sv-SE", { timeZone: tz }).slice(0, 7);
  // upgrade en vuelo (fix ledger plan+período)
  const oU = ORGS.find((x) => x.tag === "upgrade_mid" && x.token);
  if (oU) {
    const c = await http("POST", "/billing/checkout", { token: oU.token, body: { planCode: "conversia_v2_base" } });
    const m = c.status < 300 ? await http("POST", "/billing/mock-confirm", { token: oU.token, body: { planCode: "conversia_v2_base" } }) : { status: 599 };
    for (let c2 = 50; c2 < 58; c2++) { await sendInbound(oU.slug, `569222${String(c2).padStart(5, "0")}`, "hola, sigo aquí"); await sleep(25); }
    await drain("upgrade-mid", 90000);
    const planLot = psql(`SELECT amount||'/'||remaining FROM conversation_credit_lots WHERE organization_id='${oU.orgId}' AND source='plan';`);
    const grace = psql(`SELECT coalesce(grace_used,0) FROM conversation_wallets WHERE organization_id='${oU.orgId}';`);
    CHECK(m.status < 300 && planLot.startsWith("100/") && Number(grace) === 0, "CRITICO", "upgrade-en-vuelo", `lote=${planLot || "NINGUNO"} gracia=${grace} (HTTP ${c.status}/${m.status})`, `lote ${planLot}, gracia 0`);
  }
  // cancelación: bot sigue hasta fin de período
  const oC = ORGS.find((x) => x.tag === "cancelacion" && x.token);
  if (oC) {
    const r = await http("POST", "/billing/subscription/cancel", { token: oC.token, body: {} });
    for (let c2 = 20; c2 < 24; c2++) { await sendInbound(oC.slug, `569224${String(c2).padStart(5, "0")}`, "hola, una consulta"); await sleep(30); }
    await drain("cancelacion", 90000);
    const sent = psql(`SELECT count(*) FROM messages m JOIN conversations cv ON cv.id=m.conversation_id WHERE cv.organization_id='${oC.orgId}' AND m.direction='OUTBOUND' AND m.status='SENT' AND m.created_at > now() - interval '4 minutes';`);
    CHECK(r.status < 300 && Number(sent) >= 4, "ALTO", "cancelacion-periodo", `cancel HTTP ${r.status}, respuestas=${sent}/4`, `bot sigue (${sent}/4)`);
  }
  // free tier por número (3 orgs cruzan 1.000; v1 con saldo del sobre)
  for (const tag of ["freetier_v1", "freetier_v2", "freetier_co"]) {
    const o = ORGS.find((x) => x.tag === tag && x.token);
    if (!o) continue;
    redis("SET", `svc:ft:mock:${o.slug}:${mkMonth("America/Santiago")}`, "990");
    if (o.country === "CO") redis("SET", `svc:ft:mock:${o.slug}:${mkMonth("America/Bogota")}`, "990");
    for (let c = 500; c < 518; c++) { await sendInbound(o.slug, `569${String(o.i).padStart(3, "0")}${String(c).padStart(5, "0")}`, "hola"); await sleep(25); }
  }
  await drain("freetier-250");
  for (const tag of ["freetier_v1", "freetier_v2", "freetier_co"]) {
    const o = ORGS.find((x) => x.tag === tag && x.token);
    if (!o) continue;
    const paid = psql(`SELECT count(*)||'/'||coalesce(round(sum(cost_usd),4),0) FROM wallet_ledger WHERE organization_id='${o.orgId}' AND reason='service_send' AND cost_usd>0;`);
    CHECK(Number(paid.split("/")[0]) >= 6, "ALTO", `freetier-${tag}`, `con_costo=${paid} (esperado ≥6 sobre 1.000)`, `sobre 1.000 con costo: ${paid}`);
  }
  const nCounters = redis("KEYS", "svc:ft:mock:*").split("\n").filter(Boolean).length;
  CHECK(nCounters >= 150, "ALTO", "freetier-por-numero", `${nCounters} contadores (esperado ≥150)`, `${nCounters} contadores independientes (1.000 por cliente)`);
  // dedupe + xphone + demo
  const oD = ORGS.find((x) => x.tag === "dupwamid" && x.token);
  if (oD) {
    const wamid = `wamid.s250.DUP.${Date.now()}`;
    for (let r = 0; r < 10; r++) await sendInbound(oD.slug, "56990000001", "hola duplicado", wamid);
    await drain("dup", 60000);
    const n = psql(`SELECT count(*) FROM messages m JOIN conversations cv ON cv.id=m.conversation_id WHERE cv.organization_id='${oD.orgId}' AND m.direction='INBOUND';`);
    CHECK(Number(n) === 1, "ALTO", "dedupe-wamid-x10", `10 reintentos del mismo wamid crearon ${n} mensajes`, "10 replays → 1 mensaje");
  }
  const oX = ORGS.find((x) => x.tag === "xphone" && x.token);
  if (oX) {
    await sendInbound(oX.slug, `56900100001`, "hola cruzado");
    await drain("xphone", 60000);
  }
  // FUSIBLE AL FINAL
  const oFu = ORGS.find((x) => x.tag === "fusible" && x.token);
  if (oFu) {
    psql(`INSERT INTO platform_settings (key, value, updated_at) VALUES ('messagingCapSvcPerTenantDay','12', now()) ON CONFLICT (key) DO UPDATE SET value='12', updated_at=now();`);
    console.log("  (65s cache de techos…)");
    await sleep(65000);
    for (let c = 1; c <= 20; c++) { await sendInbound(oFu.slug, `569204${String(c).padStart(5, "0")}`, "hola"); await sleep(40); }
    await drain("fusible", 90000);
    const sent = psql(`SELECT count(*) FROM messages m JOIN conversations cv ON cv.id=m.conversation_id WHERE cv.organization_id='${oFu.orgId}' AND m.direction='OUTBOUND' AND m.status='SENT';`);
    const failed = psql(`SELECT count(*) FROM messages m JOIN conversations cv ON cv.id=m.conversation_id WHERE cv.organization_id='${oFu.orgId}' AND m.direction='OUTBOUND' AND m.status='FAILED';`);
    CHECK(Number(sent) <= 13 && Number(failed) >= 5, "ALTO", "fusible-svc", `sent=${sent} failed=${failed}`, `corta en ${sent} (techo 12)`);
    psql(`UPDATE platform_settings SET value='3000', updated_at=now() WHERE key='messagingCapSvcPerTenantDay';`);
    console.log("  (65s para restaurar el techo…)");
    await sleep(65000);
  }
}

// ============ W5: MONTAJE ×14 RUBROS ============
async function w5() {
  console.log("\n== W5 MONTAJE (los 14 rubros) ==");
  for (const o of ORGS.filter((x) => x.token && x.tag === "montaje")) {
    const ob = await http("GET", "/onboarding", { token: o.token });
    const steps = ob.data?.steps ?? [];
    // ETAPA 0 — estas orgs son de marca conversia, así que /onboarding devuelve el CHECKLIST
    // ÚNICO de montaje (7 bloqueantes + 5 opcionales, `href` a rutas de conversia-web) en vez
    // de los 7 pasos históricos de TuBot. Comprobamos su contrato: pasos clave presentes,
    // `blocking`/`href` en cada uno y el % contando solo los bloqueantes. El paso "negocio"
    // debe venir con rubro cargado porque el registro instaló el paquete vertical.
    const okBase =
      ob.status === 200 &&
      steps.length >= 7 &&
      ["negocio", "servicios", "asistente", "whatsapp", "prueba", "pago"].every((k) => steps.some((s) => s.key === k)) &&
      steps.every((s) => typeof s.blocking === "boolean" && typeof s.href === "string" && s.href.startsWith("/")) &&
      typeof ob.data?.percent === "number" &&
      ob.data.blockingTotal >= 6;
    const pl = await http("GET", "/onboarding/plantillas", { token: o.token });
    const re = await http("POST", "/onboarding/vertical", { token: o.token, body: { key: o.vertical } });
    const cx = await http("GET", "/assistant/context", { token: o.token });
    const am = await http("POST", "/assistant/message", { token: o.token, body: { message: "¿Qué me falta para empezar a atender?", route: "/inicio" } });
    const ags = await http("GET", "/agents", { token: o.token });
    const ag = (Array.isArray(ags.data) ? ags.data : ags.data?.items ?? [])[0];
    let ciclo = false;
    if (ag) {
      const dr = await http("PUT", `/agents/${ag.id}/draft`, { token: o.token, body: { systemPrompt: `Asistente de ${o.name}. Ajuste sim250.`, config: {}, tools: [] } });
      const ts = await http("POST", `/agents/${ag.id}/test`, { token: o.token, body: { systemPrompt: "Asistente de prueba.", config: {}, tools: [], messages: [{ role: "user", content: "Hola, ¿qué servicios tienen?" }] } });
      const pb = await http("POST", `/agents/${ag.id}/publish`, { token: o.token });
      const ac = await http("POST", `/agents/${ag.id}/active`, { token: o.token, body: { active: true } });
      ciclo = dr.status < 300 && ts.status < 300 && pb.status < 300 && ac.status < 300;
    }
    const v2p = await http("GET", "/billing/v2", { token: o.token });
    const asu = await http("GET", "/assisted-setup/status", { token: o.token });
    const all = okBase && pl.status === 200 && (pl.data?.suggestions?.length ?? 0) > 0 && re.status < 300 && cx.status === 200 && am.status < 300 && ciclo && v2p.status === 200 && asu.status < 500;
    CHECK(all, "ALTO", `montaje-${o.vertical}`,
      `checklist=${ob.status}/${steps.length} vertical_done=${steps.find((s) => s.key === "vertical")?.done} plantillas=${pl.status}/${pl.data?.suggestions?.length} reinstall=${re.status} asistente=${cx.status}/${am.status} ciclo=${ciclo} v2=${v2p.status} setup=${asu.status}`,
      `checklist 7 pasos (con pago) · plantillas ${pl.data?.suggestions?.length} · asistente · agente ciclo completo · panel V2`);
  }
}

// ============ W6: SEGURIDAD OFENSIVA ============
async function w6() {
  console.log("\n== W6 SEGURIDAD OFENSIVA ==");
  const sims = ORGS.filter((x) => x.token);
  const oA = sims.find((x) => x.tag === "seguridad");
  const oB = sims.find((x) => x.tag === "base");
  const oTB = sims.find((x) => x.tag === "tubot");
  // s1 — inyección de inbound sin token / token malo
  const s1a = await sendInbound(oB.slug, "56999000001", "inyección", undefined, "");
  const s1b = await sendInbound(oB.slug, "56999000002", "inyección", undefined, "token-falso");
  CHECK(s1a === 403 && s1b === 403, "CRITICO", "sec-inyeccion-inbound", `webhook mock sin/mal token devolvió ${s1a}/${s1b} (esperado 403)`, `403/403`);
  // s1c — slug sin canal MOCK no enruta (defensa en profundidad del worker)
  psql(`INSERT INTO organizations (id, name, slug, brand, created_at, updated_at) VALUES ('org_sincanal','Org Sin Canal','org-sin-canal','conversia',now(),now()) ON CONFLICT (id) DO NOTHING;`);
  await sendInbound("org-sin-canal", "56999000003", "a la deriva");
  await sleep(4000);
  const sc = psql(`SELECT count(*) FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.organization_id='org_sincanal';`);
  CHECK(Number(sc) === 0, "CRITICO", "sec-slug-sin-canal", `org sin canal MOCK recibió ${sc} mensajes (el slug no debe bastar)`, "mensaje descartado sin canal MOCK");
  // s2 — JWT forjado / sin esquema
  const forged = await http("GET", "/contacts?limit=1", { rawToken: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4Iiwib3JnIjoieSJ9.firma-invalida" });
  const noAuth = await http("GET", "/contacts?limit=1", {});
  CHECK(forged.status === 401 && noAuth.status === 401, "CRITICO", "sec-jwt", `token forjado=${forged.status} sin token=${noAuth.status}`, "401/401");
  // s3 — tenant hacia la consola de plataforma
  const plat = await http("GET", "/platform/organizations", { token: oA.token });
  const plat2 = await http("GET", "/platform/exceptions", { token: oA.token });
  CHECK(plat.status >= 401 && plat2.status >= 401, "CRITICO", "sec-platform", `tenant accedió a /platform: ${plat.status}/${plat2.status}`, `${plat.status}/${plat2.status}`);
  // s4 — caja: montos inválidos + reversa ajena (IDOR) + idempotencia entre orgs
  const neg = await http("POST", "/cash/entry", { token: oB.token, body: { type: "ingreso", method: "efectivo", amount: -5000, currency: "CLP" } });
  const zero = await http("POST", "/cash/entry", { token: oB.token, body: { type: "ingreso", method: "efectivo", amount: 0, currency: "CLP" } });
  CHECK(neg.status === 400 && zero.status === 400, "CRITICO", "sec-caja-montos", `monto negativo=${neg.status} cero=${zero.status}`, "400/400");
  const e1 = await http("POST", "/cash/entry", { token: oB.token, body: { type: "ingreso", method: "efectivo", amount: 10000, currency: "CLP", concept: "mío", idempotencyKey: "sec-idem-x" } });
  const e2 = await http("POST", "/cash/entry", { token: oA.token, body: { type: "ingreso", method: "efectivo", amount: 7000, currency: "CLP", concept: "también mío", idempotencyKey: "sec-idem-x" } });
  CHECK(e1.status < 300 && e2.status < 300 && !e2.data?.idempotent, "ALTO", "sec-caja-idem-cruzada", `misma clave entre orgs: ${e1.status}/${e2.status} idem=${e2.data?.idempotent}`, "clave idempotente es POR ORG");
  const revAjena = await http("POST", "/cash/reverse", { token: oA.token, body: { entryId: e1.data?.id, reason: "robo" } });
  CHECK(revAjena.status === 404, "CRITICO", "sec-caja-idor-reversa", `reversé un asiento AJENO: HTTP ${revAjena.status}`, "asiento ajeno → 404");
  // s5 — cross-brand: org conversia compra pack tubot y viceversa
  const xb1 = await http("POST", "/billing/buy-package", { token: oB.token, body: { code: "msgs_1000" } });
  const xb2 = await http("POST", "/billing/buy-package", { token: oTB.token, origin: ORIGIN_TB, body: { code: "conv-pack-400" } });
  CHECK(xb1.status === 400 && xb2.status === 400, "ALTO", "sec-cross-brand-pack", `conversia→pack tubot=${xb1.status} · tubot→pack conversia=${xb2.status}`, "400/400 (catálogo por marca)");
  // s5b — cross-brand en CONTRATACIÓN (auditoría frontera de marcas): checkout,
  // subscription/start y mock-confirm deben rechazar planes de la otra marca.
  const xc1 = await http("POST", "/billing/checkout", { token: oTB.token, origin: ORIGIN_TB, body: { planCode: "conversia_v2_base" } });
  const xc2 = await http("POST", "/billing/checkout", { token: oB.token, body: { planCode: "pro" } });
  const xc3 = await http("POST", "/billing/mock-confirm", { token: oTB.token, origin: ORIGIN_TB, body: { planCode: "conversia_v2_base" } });
  const xc4 = await http("POST", "/billing/mock-confirm", { token: oTB.token, origin: ORIGIN_TB, body: { planCode: "pkg:conv-pack-400" } });
  CHECK(xc1.status === 400 && xc2.status === 400 && xc3.status === 400 && xc4.status === 400, "CRITICO", "sec-cross-brand-plan",
    `tubot→base=${xc1.status} conversia→pro=${xc2.status} mock-plan=${xc3.status} mock-pack=${xc4.status} (esperado 400×4)`,
    "contratación cruzada bloqueada en checkout y mock-confirm");
  // s6 — v2-migrate desde TuBot
  const mig = await http("POST", "/billing/v2-migrate", { token: oTB.token, origin: ORIGIN_TB });
  CHECK(mig.status === 400, "ALTO", "sec-migrate-tubot", `TuBot pudo migrar a V2: ${mig.status}`, "400");
  // s7 — auto-recarga con pack inválido
  const ar = await http("PUT", "/billing/auto-recharge", { token: oB.token, body: { enabled: true, packCode: "msgs_1000", monthlyCapClp: 40000 } });
  CHECK(ar.status === 400, "ALTO", "sec-autorecarga-pack", `pack de mensajes aceptado en auto-recarga: ${ar.status}`, "400 (solo packs de conversación)");
  // s8 — carrera de débitos: 12 mensajes PARALELOS del mismo cliente → 1 débito
  const oR = sims.find((x) => x.i === 226);
  const prevDeb = Number(psql(`SELECT coalesce(sum(delta),0)*-1 FROM conversation_credit_ledger WHERE organization_id='${oR.orgId}' AND delta<0;`));
  await Promise.all(Array.from({ length: 12 }, (_, k) => sendInbound(oR.slug, "56988000001", `ráfaga ${k}`)));
  await drain("carrera", 90000);
  const postDeb = Number(psql(`SELECT coalesce(sum(delta),0)*-1 FROM conversation_credit_ledger WHERE organization_id='${oR.orgId}' AND delta<0;`));
  const marks = Number(psql(`SELECT count(*) FROM conversation_quota_marks WHERE organization_id='${oR.orgId}' AND conversation_id=(SELECT c.id FROM conversations c JOIN contacts k ON k.id=c.contact_id WHERE c.organization_id='${oR.orgId}' AND k.phone LIKE '%56988000001' LIMIT 1);`));
  CHECK(postDeb - prevDeb === 1 && marks === 1, "CRITICO", "sec-carrera-debitos", `12 mensajes paralelos → ${postDeb - prevDeb} débitos / ${marks} marks (esperado 1/1)`, "12 paralelos → 1 débito");
  // s9 — register con campos extra maliciosos (brand/organizationId/planId por body)
  redis("DEL", "rl:register:127.0.0.1");
  const spoof = await http("POST", "/auth/register", { origin: ORIGIN_TB, body: { email: "spoof@sim.conversia.test", password: "Spoof-123456!", name: "Spoof", organizationName: "Spoof Brand", brand: "conversia", organizationId: "org_sincanal", planId: "x", vertical: "barberia" } });
  const spoofBrand = psql(`SELECT brand FROM organizations WHERE id='${spoof.data?.organizationId}';`);
  CHECK(spoof.status < 300 && spoofBrand === "tubot", "CRITICO", "sec-brand-spoof", `body brand=conversia con Origin tubot nació "${spoofBrand}"`, `la marca sale del Origin (${spoofBrand})`);
  // s10 — IDOR agenda/contacts bajo RLS real
  const myContacts = await http("GET", "/contacts?limit=1", { token: oB.token });
  const foreignId = psql(`SELECT id FROM contacts WHERE organization_id='${oA.orgId}' LIMIT 1;`);
  if (foreignId) {
    const idor = await http("GET", `/contacts/${foreignId}`, { token: oB.token });
    CHECK(idor.status === 404 || idor.status === 403, "CRITICO", "sec-idor-contacto", `contacto ajeno devolvió ${idor.status}`, `${idor.status}`);
  }
  const foreignAppt = psql(`SELECT id FROM appointments WHERE organization_id!='${oB.orgId}' LIMIT 1;`);
  if (foreignAppt) {
    const idorA = await http("PATCH", `/agenda/appointments/${foreignAppt}`, { token: oB.token, body: { status: "CANCELLED" } });
    CHECK(idorA.status === 404 || idorA.status === 403, "CRITICO", "sec-idor-agenda", `cita ajena: ${idorA.status}`, `${idorA.status}`);
  }
  void myContacts;
  // s11 — rate limit del simulador de agentes (fix nuevo): ráfaga de 35 → aparecen 429
  const agsB = await http("GET", "/agents", { token: oB.token });
  const agB = (Array.isArray(agsB.data) ? agsB.data : agsB.data?.items ?? [])[0];
  if (agB) {
    let got429 = 0;
    for (let k = 0; k < 35; k++) {
      const r = await http("POST", `/agents/${agB.id}/test`, { token: oB.token, body: { systemPrompt: "x", config: {}, tools: [], messages: [{ role: "user", content: "hola" }] } });
      if (r.status === 429) got429++;
    }
    CHECK(got429 >= 3, "ALTO", "sec-ratelimit-agente-test", `35 pruebas seguidas sin 429 (${got429})`, `${got429} bloqueadas con 429`);
  }
  // s12 — RLS directo + aislamiento con los scripts del repo
  const leak = execFileSync(PSQL, ["-h", process.env.SIM_PG_HOST ?? "localhost", "-p", process.env.SIM_PG_PORT ?? "5433", "-U", "conversia_app", "-d", process.env.SIM_PG_DB ?? "conversia_sim", "-t", "-A", "-c", "SELECT count(*) FROM conversations;"], { env: { ...process.env, PGPASSWORD: process.env.SIM_APP_ROLE_PASSWORD ?? "conversia_app_dev_password" }, encoding: "utf8" }).trim();
  CHECK(Number(leak) === 0, "CRITICO", "sec-rls-directo", `rol app sin contexto ve ${leak} filas`, "0 filas sin contexto");
  console.log("== W6 FIN ==");
}

// ============ W7: VALIDACIÓN GLOBAL ============
async function w7() {
  console.log("\n== W7 VALIDACIÓN GLOBAL ==");
  let okDebitos = 0, badDebitos = 0;
  for (const o of ORGS.filter((x) => x.token)) {
    const marks = Number(psql(`SELECT count(*) FROM conversation_quota_marks WHERE organization_id='${o.orgId}';`));
    const debits = Number(psql(`SELECT coalesce(sum(delta),0)*-1 FROM conversation_credit_ledger WHERE organization_id='${o.orgId}' AND delta<0;`));
    const mult = o.tag === "aiplus" ? 2 : 1;
    if (o.brand === "conversia" && !["v1_fun", "freetier_v1", "v2_migrate", "base_exhaust", "upgrade_mid"].includes(o.tag) && o.convs > 0) {
      if (debits === marks * mult) okDebitos++; else { badDebitos++; F("CRITICO", "debito≠marks", `org ${o.i} (${o.tag}): marks=${marks}×${mult} ≠ débitos=${debits}`); }
    }
    if (o.brand === "tubot" && debits > 0) F("CRITICO", "tubot-debitado", `org ${o.i} TuBot con débitos V2 (${debits})`);
  }
  console.log(`  invariante débito=conversaciones: ${okDebitos} OK / ${badDebitos} mal`);
  for (const o of ORGS.filter((x) => x.token && x.tag === "base_exhaust")) {
    const lot = psql(`SELECT amount||'/'||remaining FROM conversation_credit_lots WHERE organization_id='${o.orgId}' AND source='plan';`);
    const g = psql(`SELECT grace_used FROM conversation_wallets WHERE organization_id='${o.orgId}';`);
    const exc = psql(`SELECT count(*) FROM platform_exceptions WHERE organization_id='${o.orgId}' AND type='saldo_gracia_sin_recarga';`);
    const der = psql(`SELECT count(*) FROM conversations WHERE organization_id='${o.orgId}' AND ai_enabled=false;`);
    CHECK(lot === "100/0" && Number(g) === 20 && Number(exc) === 1 && Number(der) >= 3, "CRITICO", `exhaust-${o.i}`, `lote=${lot} gracia=${g} exc=${exc} deriva=${der}`, `100/0 · gracia 20 · exc 1 · deriva ${der}`);
  }
  const oA = ORGS.find((x) => x.tag === "aiplus" && x.token);
  if (oA) {
    const d = Number(psql(`SELECT coalesce(sum(delta),0)*-1 FROM conversation_credit_ledger WHERE organization_id='${oA.orgId}' AND reason='conversation_debit';`));
    const m = Number(psql(`SELECT count(*) FROM conversation_quota_marks WHERE organization_id='${oA.orgId}';`));
    CHECK(d === m * 2, "ALTO", "aiplus-x2", `débitos=${d} marks=${m}`, `${m}→${d} (×2)`);
  }
  metrics.notifs = psql(`SELECT type||':'||count(*) FROM notifications GROUP BY type ORDER BY count(*) DESC;`).replaceAll("\n", " · ");
  metrics.exceptions = psql(`SELECT type||':'||count(*) FROM platform_exceptions GROUP BY type;`).replaceAll("\n", " · ");
  writeFileSync(OUT("sim250-results.json"), JSON.stringify({ metrics, findings }, null, 1));
  console.log("\n===== RESUMEN 250 =====");
  console.log(`orgs: ${metrics.registered} · mensajes: ${psql("SELECT count(*) FROM messages;")} · conversaciones: ${psql("SELECT count(*) FROM conversations;")}`);
  console.log(`débitos: ${psql("SELECT coalesce(sum(delta),0)*-1 FROM conversation_credit_ledger WHERE delta<0;")} · service_send: ${psql("SELECT count(*) FROM wallet_ledger WHERE reason='service_send';")} (con costo: ${psql("SELECT count(*) FROM wallet_ledger WHERE reason='service_send' AND cost_usd>0;")})`);
  console.log(`notifs: ${metrics.notifs}`);
  console.log(`excepciones: ${metrics.exceptions}`);
  const crit = findings.filter((f) => f.sev === "CRITICO").length, alto = findings.filter((f) => f.sev === "ALTO").length;
  console.log(`hallazgos: ${findings.length} (CRITICO=${crit} ALTO=${alto} MEDIO=${findings.filter((f) => f.sev === "MEDIO").length} ERROR=${findings.filter((f) => f.sev === "ERROR").length})`);
  for (const f of findings.filter((x) => x.sev !== "ERROR")) console.log(`  - [${f.sev}] ${f.area}: ${f.msg}`);
}

// ============ W8: CARGA MASIVA (ramp-up · sostenido · ráfaga · soak · panel) ============
// Fase de resistencia bajo carga. Reusa las 250 orgs registradas por w1/w2 (cargadas desde
// tools/sim/out/sims250.json en MAIN). Generador con concurrencia controlada (token-bucket +
// limiter) y paso Poisson por tick: NADA de sleep fijo que serialice el throughput — el ritmo
// de llegada se pacea, pero los envíos (fire-and-forget al webhook) se solapan vía el limiter.

// --- Perillas de W8 (TODO override por env para poder escalar en un laptop) ---
const W8_SCALE = Number(process.env.SIM_W8_SCALE ?? "1");          // multiplica TODAS las tasas
const W8_FAST = (process.env.SIM_W8_FAST ?? "0") === "1";          // encoge TODAS las duraciones a ~1 min
const W8_FAST_MIN = Number(process.env.SIM_W8_FAST_MIN ?? "1");    // minutos por fase cuando FAST=1
const w8DurMin = (key, def) => (W8_FAST ? W8_FAST_MIN : Number(process.env[key] ?? def));
const w8Rate = (key, def) => Math.max(0, Number(process.env[key] ?? def) * W8_SCALE);
const w8MinToMs = (m) => Math.max(1, Math.round(m * 60_000));

const W8_RAMP_MIN = w8DurMin("SIM_W8_RAMP_MIN", 5);
const W8_SUSTAIN_MIN = w8DurMin("SIM_W8_SUSTAIN_MIN", 15);
const W8_BURST_MIN = w8DurMin("SIM_W8_BURST_MIN", 2);
const W8_SOAK_MIN = w8DurMin("SIM_W8_SOAK_MIN", 20);
const W8_SUSTAIN_RATE = w8Rate("SIM_W8_RATE", 50);                 // msg/s sostenido
const W8_BURST_RATE = w8Rate("SIM_W8_BURST_RATE", 150);            // msg/s ráfaga
const W8_SOAK_RATE = w8Rate("SIM_W8_SOAK_RATE", 20);              // msg/s soak
const W8_RAMP_PEAK_RATE = w8Rate("SIM_W8_RAMP_PEAK_RATE", Number(process.env.SIM_W8_RATE ?? 50)); // pico al final del ramp
const W8_CONC_MIN = Math.max(1, Number(process.env.SIM_W8_CONC_MIN ?? "10"));   // concurrencia al inicio del ramp
const W8_CONC_MAX = Math.max(W8_CONC_MIN, Number(process.env.SIM_W8_CONC_MAX ?? "100")); // concurrencia pico
const W8_PER_ORG = Math.max(1, Number(process.env.SIM_W8_CONTACTS_PER_ORG ?? "4")); // contactos activos por org (4×250=1.000)
const W8_CONV_MIN = Math.max(1, Number(process.env.SIM_W8_CONV_MIN ?? "2"));   // mensajes mín. por conversación
const W8_CONV_MAX = Math.max(W8_CONV_MIN, Number(process.env.SIM_W8_CONV_MAX ?? "5")); // mensajes máx. por conversación
const W8_BURST_ORGS = Math.max(1, Number(process.env.SIM_W8_BURST_ORGS ?? "30")); // orgs "virales" de la ráfaga
const W8_PANEL_SESSIONS = Math.max(0, Number(process.env.SIM_W8_PANEL_SESSIONS ?? "50")); // logins de panel bajo carga
const W8_PANEL_INTERVAL_MS = Math.max(1000, Number(process.env.SIM_W8_PANEL_INTERVAL_MS ?? "10000")); // cadencia de navegación
const W8_PANEL_CONC = Math.max(1, Number(process.env.SIM_W8_PANEL_CONC ?? "25")); // concurrencia de requests del panel
const W8_TICK_MS = Math.max(20, Number(process.env.SIM_W8_TICK_MS ?? "100"));  // granularidad del scheduler
const W8_REQ_TIMEOUT_MS = Math.max(1000, Number(process.env.SIM_W8_REQ_TIMEOUT_MS ?? "15000")); // timeout por request (no bloquear slots)
const W8_FLUSH_MS = Math.max(500, Number(process.env.SIM_W8_FLUSH_MS ?? "3000")); // flush del log de enviados a disco
const W8_DRAIN_MS = Math.max(10000, Number(process.env.SIM_W8_DRAIN_MS ?? "600000")); // techo de espera para drenar colas y reconciliar
const W8_INCLUDE_TUBOT = (process.env.SIM_W8_INCLUDE_TUBOT ?? "0") === "1"; // por defecto NO cargamos tráfico a orgs TuBot
const W8_PHASES = (process.env.SIM_W8_PHASES ?? "ramp,sustain,burst,soak").split(",").map((s) => s.trim()).filter(Boolean);
const W8_BURST_CAP = process.env.SIM_W8_BURST_CAP ?? ""; // opcional: baja messagingCapSvcPerTenantDay antes de la ráfaga (cache 65s); vacío = no tocar
const W8_MOCK_TOKEN = process.env.MOCK_INBOUND_TOKEN ?? "dev-mock-inbound-token"; // header x-conversia-mock-token

// Frases de la conversación (español): la 1.ª "abre", el resto "continúan".
const W8_OPENERS = ["Hola, quiero información y precios", "Buenas, ¿tienen horas disponibles?", "Hola, necesito una consulta", "Hola, ¿me ayudan con una cotización?"];
const W8_FOLLOWUPS = ["¿Tienen hora esta semana?", "¿Cuánto sale?", "Perfecto, ¿cómo agendo?", "¿Atienden los sábados?", "Gracias, lo voy a pensar"];

// --- Limiter estilo p-limit: capa la concurrencia de requests en vuelo (max ajustable en caliente) ---
function w8Limiter(max) {
  let active = 0;
  const q = [];
  const pump = () => {
    while (active < max && q.length) {
      const job = q.shift();
      active++;
      Promise.resolve().then(job).catch(() => {}).finally(() => { active--; pump(); });
    }
  };
  return {
    submit(job) { q.push(job); pump(); },
    setMax(n) { max = Math.max(1, n); pump(); },
    get active() { return active; },
    get pending() { return q.length; },
    async drain() { while (active > 0 || q.length) await sleep(50); },
  };
}

// Muestra Gaussiana (Box-Muller) y Poisson (Knuth para λ chico, aproximación normal para λ grande).
function w8Gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function w8Poisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda > 30) { const n = Math.round(lambda + Math.sqrt(lambda) * w8Gaussian()); return n < 0 ? 0 : n; }
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= Math.random(); } while (p > L);
  return k - 1;
}
function w8Pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// Teléfono namespaced para W8 (7.º dígito = '8') → no colisiona con los de w3/w4/w6, así la
// reconciliación de pérdidas (enviados vs filas INBOUND) queda limpia.
const w8Phone = (orgIdx, slot) => `569${String(orgIdx).padStart(3, "0")}8${String(slot).padStart(4, "0")}`;

// --- Envíos mínimos con timeout (1 intento): no reintentan para no retener slots del limiter ---
async function w8Send(slug, phone, text, wamid, token) {
  try {
    const res = await fetch(`${API}/webhooks/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-conversia-mock-token": token },
      body: JSON.stringify(inboundPayload(slug, phone, text, wamid)),
      signal: AbortSignal.timeout(W8_REQ_TIMEOUT_MS),
    });
    return res.status;
  } catch { return 0; } // 0 = error de red / timeout (contado como rechazo)
}
async function w8Get(path, token, origin) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API}${path}`, { headers: { "content-type": "application/json", Origin: origin, authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(W8_REQ_TIMEOUT_MS) });
    try { await res.json(); } catch {}
    return { status: res.status, ms: Date.now() - t0 };
  } catch { return { status: 0, ms: Date.now() - t0 }; }
}
async function w8Login(email, pass, origin) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API}/auth/login`, { method: "POST", headers: { "content-type": "application/json", Origin: origin }, body: JSON.stringify({ email, password: pass }), signal: AbortSignal.timeout(W8_REQ_TIMEOUT_MS) });
    let data = null; try { data = await res.json(); } catch {}
    return { status: res.status, ms: Date.now() - t0, token: data?.token };
  } catch { return { status: 0, ms: Date.now() - t0 }; }
}

// --- Pool de conversaciones: perOrg contactos por org, intercalados por slot para que el ramp
//     active contactos repartidos entre TODAS las orgs (primero slot0 de todas, luego slot1…). ---
function w8BuildPool(orgs, perOrg, convMin, convMax) {
  const contacts = [];
  for (let s = 0; s < perOrg; s++) {
    for (const o of orgs) {
      contacts.push({ i: o.i, slug: o.slug, phone: w8Phone(o.i, s), step: 0, target: convMin + Math.floor(Math.random() * (convMax - convMin + 1)) });
    }
  }
  return {
    size: contacts.length,
    // next(frac): elige al azar un contacto dentro de la ventana activa (frac del pool) y avanza
    // su paso de conversación; al llegar a su target reinicia (contacto reutilizado = nueva charla).
    next(frac = 1) {
      if (!contacts.length) return null;
      const activeCount = Math.min(contacts.length, Math.max(1, Math.ceil(contacts.length * frac)));
      const c = contacts[Math.floor(Math.random() * activeCount)];
      const snap = { i: c.i, slug: c.slug, phone: c.phone, step: c.step };
      c.step++;
      if (c.step >= c.target) { c.step = 0; c.target = convMin + Math.floor(Math.random() * (convMax - convMin + 1)); }
      return snap;
    },
  };
}

// Buffer de "lo enviado" → se vuelca a JSONL periódicamente (memoria acotada; permite que la
// observabilidad reconcilie EN VIVO y que la verificación de pérdidas cuadre por wamid).
let w8FlushBuf = [];
let w8Seq = 0;
function w8Flush() {
  if (!w8FlushBuf.length) return;
  const chunk = w8FlushBuf; w8FlushBuf = [];
  try { appendFileSync(OUT("w8-sent.jsonl"), chunk.join("\n") + "\n"); } catch { /* no romper la corrida por I/O */ }
}
// Fábrica de "jobs": cada llamada elige el próximo contacto y devuelve una función async que
// envía 1 inbound y registra el resultado (status + wamid) sin bloquear al scheduler.
function w8MakeSender(phase, pool, counters, activeFracFn) {
  return (frac) => {
    const c = pool.next(activeFracFn(frac));
    if (!c) return null;
    const text = c.step === 0 ? W8_OPENERS[Math.floor(Math.random() * W8_OPENERS.length)] : W8_FOLLOWUPS[(c.step - 1) % W8_FOLLOWUPS.length];
    const wamid = `wamid.w8.${phase}.${w8Seq++}.${Math.random().toString(36).slice(2, 8)}`;
    const ts = Date.now();
    return async () => {
      const status = await w8Send(c.slug, c.phone, text, wamid, W8_MOCK_TOKEN);
      const ok = status >= 200 && status < 300;
      if (ok) counters.accepted++; else counters.rejected++;
      counters.byStatus[status] = (counters.byStatus[status] ?? 0) + 1;
      w8FlushBuf.push(JSON.stringify({ ts, phase, org: c.i, slug: c.slug, phone: c.phone, wamid, status, step: c.step }));
    };
  };
}

// --- Panel bajo carga: N logins + navegación por API cada intervalo, concurrente con el sostenido ---
function w8StartPanel(orgs) {
  const sessions = [];
  const nav = [];
  const navByPath = {};
  const logins = { ok: 0, fail: 0, ms: [] };
  let stop = false;
  const paths = ["/auth/me", "/billing/wallet/summary", "/conversations", "/onboarding"];
  const lim = w8Limiter(W8_PANEL_CONC);
  const done = (async () => {
    // 1) Logins iniciales (mide latencia de /auth/login).
    await Promise.all(orgs.map((o) => new Promise((res) => lim.submit(async () => {
      const origin = o.brand === "tubot" ? ORIGIN_TB : ORIGIN_CV;
      const r = await w8Login(o.email, o.pass, origin);
      logins.ms.push(r.ms);
      if (r.status >= 200 && r.status < 300 && r.token) { logins.ok++; sessions.push({ token: r.token, origin }); }
      else logins.fail++;
      res();
    }))));
    console.log(`  [panel] logins ${logins.ok}/${orgs.length} ok (fail ${logins.fail}), login p95=${w8Pct(logins.ms, 95)}ms`);
    // 2) Navegación periódica (GET /auth/me · /billing/wallet/summary · /conversations · /onboarding).
    while (!stop) {
      const cycleT0 = Date.now();
      await Promise.all(sessions.map((s) => new Promise((res) => lim.submit(async () => {
        for (const p of paths) { const g = await w8Get(p, s.token, s.origin); nav.push(g.ms); (navByPath[p] ??= []).push(g.ms); }
        res();
      }))));
      const wait = W8_PANEL_INTERVAL_MS - (Date.now() - cycleT0);
      if (wait > 0 && !stop) await sleep(wait);
    }
  })();
  return { stop: () => { stop = true; }, done, logins, nav, navByPath };
}

async function w8() {
  console.log("\n== W8 CARGA MASIVA ==");
  const pool0 = ORGS.filter((o) => o.token && o.orgId && o.slug && (W8_INCLUDE_TUBOT || o.brand !== "tubot"));
  if (!pool0.length) {
    F("CRITICO", "w8-orgs", "no hay orgs cargadas (corre w1/w2 o 'all' primero; falta tools/sim/out/sims250.json con token/orgId/slug)");
    return;
  }
  const burstOrgs = pool0.slice(0, Math.min(W8_BURST_ORGS, pool0.length));
  const panelOrgs = pool0.slice(0, Math.min(W8_PANEL_SESSIONS, pool0.length));
  const mainPool = w8BuildPool(pool0, W8_PER_ORG, W8_CONV_MIN, W8_CONV_MAX);
  const burstPool = w8BuildPool(burstOrgs, W8_PER_ORG, W8_CONV_MIN, W8_CONV_MAX);

  // Perfil efectivo (imprime lo que REALMENTE se va a correr tras SCALE/FAST).
  const profile = {
    orgs: pool0.length, includeTuBot: W8_INCLUDE_TUBOT, contactsPerOrg: W8_PER_ORG, activeContacts: mainPool.size,
    scale: W8_SCALE, fast: W8_FAST, phases: W8_PHASES, mockToken: W8_MOCK_TOKEN === "dev-mock-inbound-token" ? "(default)" : "(custom)",
    ramp: { min: W8_RAMP_MIN, peakRate: W8_RAMP_PEAK_RATE, conc: `${W8_CONC_MIN}→${W8_CONC_MAX}` },
    sustain: { min: W8_SUSTAIN_MIN, rate: W8_SUSTAIN_RATE, conc: W8_CONC_MAX, panelSessions: panelOrgs.length, panelEveryMs: W8_PANEL_INTERVAL_MS },
    burst: { min: W8_BURST_MIN, rate: W8_BURST_RATE, orgs: burstOrgs.length, cap: W8_BURST_CAP || "(no tocar)" },
    soak: { min: W8_SOAK_MIN, rate: W8_SOAK_RATE, conc: W8_CONC_MAX },
    tickMs: W8_TICK_MS, reqTimeoutMs: W8_REQ_TIMEOUT_MS,
  };
  console.log("  PERFIL EFECTIVO:", JSON.stringify(profile));

  const w8Start = Date.now();
  writeFileSync(OUT("w8-sent.jsonl"), ""); // trunca el log de enviados al inicio
  const flushTimer = setInterval(w8Flush, W8_FLUSH_MS);
  const limiter = w8Limiter(W8_CONC_MAX);
  const phaseStats = [];

  // Motor de una fase: paso Poisson por tick; despacha N jobs/tick al limiter sin esperar su fin.
  async function runLoadPhase(name, { durationMs, rateAt, concAt, pool, activeFracFn }) {
    const c = { phase: name, dispatched: 0, accepted: 0, rejected: 0, byStatus: {}, startedAt: Date.now() };
    const sender = w8MakeSender(name, pool, c, activeFracFn);
    limiter.setMax(concAt ? Math.round(concAt(0)) : W8_CONC_MAX);
    let maxPending = 0;
    const t0 = Date.now();
    let nextAt = t0;
    while (Date.now() - t0 < durationMs) {
      const frac = Math.min(1, (Date.now() - t0) / durationMs);
      if (concAt) limiter.setMax(Math.max(1, Math.round(concAt(frac))));
      const n = w8Poisson(Math.max(0, rateAt(frac)) * (W8_TICK_MS / 1000));
      for (let k = 0; k < n; k++) { const job = sender(frac); if (!job) break; c.dispatched++; limiter.submit(job); }
      if (limiter.pending > maxPending) maxPending = limiter.pending;
      nextAt += W8_TICK_MS;
      const wait = nextAt - Date.now();
      if (wait > 0) await sleep(wait); else nextAt = Date.now(); // sin acumular deuda si vamos atrasados
    }
    await limiter.drain(); // deja asentar los jobs en vuelo antes de medir
    c.endedAt = Date.now();
    c.durationSec = (c.endedAt - c.startedAt) / 1000;
    c.targetRate = Math.max(0, rateAt(1));
    c.achievedRate = c.accepted / Math.max(0.001, c.durationSec);
    c.maxPending = maxPending;
    c.concMax = concAt ? Math.round(concAt(1)) : W8_CONC_MAX;
    phaseStats.push(c);
    console.log(`  [${name}] dispatched=${c.dispatched} accepted=${c.accepted} rejected=${c.rejected} achieved=${c.achievedRate.toFixed(1)}/s (target ${c.targetRate.toFixed(1)}/s) maxPending=${maxPending} dur=${c.durationSec.toFixed(0)}s status=${JSON.stringify(c.byStatus)}`);
    return c;
  }

  let panel = null;
  try {
    // 1) RAMP-UP: tasa 0→pico, concurrencia MIN→MAX, contactos activos 0→1.000 (frac del pool).
    if (W8_PHASES.includes("ramp")) {
      await runLoadPhase("ramp", {
        durationMs: w8MinToMs(W8_RAMP_MIN),
        rateAt: (f) => W8_RAMP_PEAK_RATE * f,
        concAt: (f) => W8_CONC_MIN + (W8_CONC_MAX - W8_CONC_MIN) * f,
        pool: mainPool,
        activeFracFn: (f) => f,
      });
    }
    // 2) SOSTENIDO: ~RATE msg/s repartido en todas las orgs (Poisson) + PANEL bajo carga en paralelo.
    if (W8_PHASES.includes("sustain")) {
      if (W8_PANEL_SESSIONS > 0 && panelOrgs.length) panel = w8StartPanel(panelOrgs);
      await runLoadPhase("sustain", {
        durationMs: w8MinToMs(W8_SUSTAIN_MIN),
        rateAt: () => W8_SUSTAIN_RATE,
        concAt: null,
        pool: mainPool,
        activeFracFn: () => 1,
      });
      if (panel) { panel.stop(); await panel.done; }
    }
    // 3) RÁFAGA: pico concentrado en W8_BURST_ORGS orgs (campaña viral) → los fusibles por tenant
    //    deben cortar al abusador sin degradar al resto. Opcional: bajar el techo svc (cache 65s).
    if (W8_PHASES.includes("burst")) {
      let prevCap = null;
      if (W8_BURST_CAP) {
        prevCap = psql(`SELECT value FROM platform_settings WHERE key='messagingCapSvcPerTenantDay';`) || "3000";
        psql(`INSERT INTO platform_settings (key, value, updated_at) VALUES ('messagingCapSvcPerTenantDay','${W8_BURST_CAP}', now()) ON CONFLICT (key) DO UPDATE SET value='${W8_BURST_CAP}', updated_at=now();`);
        console.log(`  (fusible ráfaga: techo svc=${W8_BURST_CAP}; esperando 65s de cache…)`);
        await sleep(65000);
      }
      try {
        await runLoadPhase("burst", {
          durationMs: w8MinToMs(W8_BURST_MIN),
          rateAt: () => W8_BURST_RATE,
          concAt: null,
          pool: burstPool,
          activeFracFn: () => 1,
        });
      } finally {
        if (prevCap !== null) {
          psql(`UPDATE platform_settings SET value='${prevCap}', updated_at=now() WHERE key='messagingCapSvcPerTenantDay';`);
          console.log(`  (restaurando techo svc=${prevCap}; esperando 65s de cache…)`);
          await sleep(65000);
        }
      }
    }
    // 4) SOAK: tasa baja y constante para cazar fugas de memoria/conexiones.
    if (W8_PHASES.includes("soak")) {
      await runLoadPhase("soak", {
        durationMs: w8MinToMs(W8_SOAK_MIN),
        rateAt: () => W8_SOAK_RATE,
        concAt: null,
        pool: mainPool,
        activeFracFn: () => 1,
      });
    }
  } finally {
    if (panel) { panel.stop(); try { await panel.done; } catch {} }
    clearInterval(flushTimer);
    w8Flush();
  }

  // Panel: percentiles de latencia de navegación (criterio: <2s p95 en los GET).
  let panelStats = null;
  if (panel) {
    const byPath = {};
    for (const [p, arr] of Object.entries(panel.navByPath)) byPath[p] = { n: arr.length, p50: w8Pct(arr, 50), p95: w8Pct(arr, 95), p99: w8Pct(arr, 99) };
    panelStats = {
      logins: { ok: panel.logins.ok, fail: panel.logins.fail, p50: w8Pct(panel.logins.ms, 50), p95: w8Pct(panel.logins.ms, 95) },
      nav: { n: panel.nav.length, p50: w8Pct(panel.nav, 50), p95: w8Pct(panel.nav, 95), p99: w8Pct(panel.nav, 99) },
      byPath,
    };
    console.log(`  [panel] nav p50=${panelStats.nav.p50}ms p95=${panelStats.nav.p95}ms p99=${panelStats.nav.p99}ms (n=${panelStats.nav.n})`);
    CHECK(panelStats.nav.p95 < 2000, "ALTO", "w8-panel-p95", `panel p95=${panelStats.nav.p95}ms (>2000ms bajo carga)`, `panel p95=${panelStats.nav.p95}ms (<2s)`);
  }

  // Reconciliación de pérdidas: enviados 2xx vs filas INBOUND creadas desde el inicio de W8
  // (unicidad de wamid → 1:1; dedupe no colapsa nada porque cada wamid es único).
  console.log("  drenando colas para reconciliación…");
  await drain("w8", W8_DRAIN_MS);
  const since = new Date(w8Start).toISOString();
  const inboundRows = Number(psql(`SELECT count(*) FROM messages WHERE direction='INBOUND' AND created_at >= '${since}';`));
  const totalDispatched = phaseStats.reduce((a, c) => a + c.dispatched, 0);
  const totalAccepted = phaseStats.reduce((a, c) => a + c.accepted, 0);
  const totalRejected = phaseStats.reduce((a, c) => a + c.rejected, 0);
  const loss = totalAccepted - inboundRows;
  CHECK(loss <= 0 || totalAccepted === 0 || loss / totalAccepted < 0.001, "ALTO", "w8-perdidas",
    `enviados(2xx)=${totalAccepted} vs filas INBOUND=${inboundRows} (delta ${loss})`,
    `sin pérdida: enviados(2xx)=${totalAccepted} == INBOUND=${inboundRows}`);

  const summary = {
    profile, startedAt: new Date(w8Start).toISOString(), finishedAt: new Date().toISOString(),
    totals: { dispatched: totalDispatched, accepted: totalAccepted, rejected: totalRejected, inboundRows, loss },
    phases: phaseStats, panel: panelStats,
    sentLog: OUT("w8-sent.jsonl"),
  };
  writeFileSync(OUT("w8-summary.json"), JSON.stringify(summary, null, 1));
  metrics.w8 = summary.totals;
  console.log("\n===== RESUMEN W8 =====");
  console.log(`  despachados=${totalDispatched} aceptados(2xx)=${totalAccepted} rechazados=${totalRejected} · INBOUND en BD=${inboundRows} · pérdida=${loss}`);
  for (const c of phaseStats) console.log(`  ${c.phase}: ${c.achievedRate.toFixed(1)}/s (target ${c.targetRate.toFixed(1)}/s) maxPending=${c.maxPending}`);
  console.log(`  artefactos: ${OUT("w8-summary.json")} · ${OUT("w8-sent.jsonl")}`);
}

// ============ MAIN ============
const phase = process.argv[2] ?? "all";
const saved = existsSync(OUT("sims250.json")) ? JSON.parse(readFileSync(OUT("sims250.json"), "utf8")) : null;
if (saved && phase !== "all" && phase !== "w1") for (let k = 0; k < ORGS.length && k < saved.length; k++) Object.assign(ORGS[k], saved[k]);
try {
  if (phase === "all" || phase === "w1") await w1();
  if (phase === "all" || phase === "w2") await w2();
  if (phase === "all" || phase === "w3") await w3();
  if (phase === "all" || phase === "w4") await w4();
  if (phase === "all" || phase === "w5") await w5();
  if (phase === "all" || phase === "w6") await w6();
  if (phase === "all" || phase === "w7") await w7();
  if (phase === "w8") await w8(); // carga masiva: corrida aparte (no entra en 'all' por su duración ~42 min)
} finally {
  writeFileSync(OUT("sims250.json"), JSON.stringify(ORGS, null, 1));
  writeFileSync(OUT("sim250-findings.json"), JSON.stringify({ metrics, findings }, null, 1));
}
console.log("\nFIN fase:", phase);
