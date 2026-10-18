#!/usr/bin/env node
/**
 * smoke-prod.mjs — Suite de humo CONTRA PRODUCCIÓN REAL (post-deploy).
 *
 * Node >=18, SIN dependencias (fetch nativo). SOLO LECTURA: jamás escribe ni muta datos
 * en producción (ningún POST que cambie estado; solo GET/OPTIONS y POST de VALIDACIÓN
 * que el backend rechaza por diseño — webhook mock sin token, mock-confirm sin sesión,
 * API key inválida).
 *
 * Contexto: el 17-oct-2026 se escaparon a prod tres bugs de ENTORNO (bundle sin
 * NEXT_PUBLIC_API_URL → localhost; CORS solo app.conversia.cl; HTML con s-maxage=1año).
 * Esta suite VERIFICA que esos arreglos se sostienen y caza toda la familia.
 *
 * Uso:   node tools/sim/smoke-prod.mjs
 * Salida: resumen PASS/FAIL legible + JSON en tools/sim/out/smoke-prod-<ISO>.json
 * Código de salida: 0 si todo PASS/WARN/SKIP; 1 si hay algún FAIL.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// ───────────────────────────── Configuración ─────────────────────────────

const API = "https://api-production-cf8e.up.railway.app";

// Dominios que deben estar ARRIBA (200 + TLS válido).
const DOMAINS = {
  "conversia.cl": "https://conversia.cl",
  "www.conversia.cl": "https://www.conversia.cl",
  "app.conversia.cl": "https://app.conversia.cl",
  "tubot.cl": "https://tubot.cl",
};

// Fronts de Conversia (comparten un solo deploy de conversia-web detrás de Cloudflare).
const CONVERSIA_WEB = ["https://app.conversia.cl", "https://conversia.cl"];

// Rutas servidas cuyo bundle hay que auditar (en ambos orígenes de Conversia).
const BUNDLE_ROUTES = ["/", "/crear", "/registro", "/login"];

// Orígenes que DEBEN poder llamar la API por CORS (hallazgo 17-oct: la landing en
// conversia.cl/www.conversia.cl quedaba bloqueada en silencio).
const CORS_CONVERSIA = ["https://conversia.cl", "https://www.conversia.cl", "https://app.conversia.cl"];
// TuBot (solo lectura): el apex y www se permiten por la lógica apex/www del backend.
// app.tubot.cl depende de WEB_URL del servicio y puede NO estar permitido → informativo.
const CORS_TUBOT_REQUIRED = ["https://tubot.cl"];
const CORS_TUBOT_INFO = ["https://www.tubot.cl", "https://app.tubot.cl"];
// Control negativo: un origen ajeno JAMÁS debe ser reflejado por CORS.
const CORS_EVIL = "https://evil.example";

// Único literal localhost permitido en el bundle (fallback documentado de api-base.ts).
const ALLOWED_LOCAL_FALLBACK = "http://localhost:4000";
// Señal de que el build llevó la URL pública (o al menos el fallback) — nunca un build "pelado".
const PUBLIC_API_MARKERS = ["api-production-cf8e", "api.conversia.cl"];

// Umbrales (criterios del prompt §1).
const MIN_VERTICALS = 14; // ≥14 rubros tras el seed
const MIN_PACKS = 3; // 3 packs de conversación
const MIN_PLANS = 1; // ≥1 plan público de conversia
const MAX_HTML_SMAXAGE = 300; // s-maxage del HTML ≤ 300s (el bug era 31536000)

const FETCH_TIMEOUT_MS = 20000;

// ───────────────────────────── Utilidades ─────────────────────────────

const C = (() => {
  const on = process.stdout.isTTY && !process.env.NO_COLOR;
  const w = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { green: w(32), red: w(31), yellow: w(33), gray: w(90), bold: w(1), cyan: w(36) };
})();

/** fetch con timeout (AbortController). Nunca cuelga la suite. */
async function fetchT(url, init = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Extrae las URLs de chunks JS de Next referenciadas en un HTML (resueltas al origen). */
function extractChunks(html, origin) {
  const rels = [...html.matchAll(/\/_next\/static\/[^"'\s)\\]+?\.js/g)].map((m) => m[0]);
  return [...new Set(rels)].map((r) => origin + r);
}

/** Huella de build: hashes de los chunks estables (webpack + main-app). App Router no
 *  expone "buildId" en el HTML, así que estos hashes identifican el deploy. */
function buildFingerprint(html) {
  const wp = html.match(/webpack-([a-f0-9]+)\.js/);
  const ma = html.match(/main-app-([a-f0-9]+)\.js/);
  if (wp || ma) return `webpack:${wp ? wp[1] : "?"}|main-app:${ma ? ma[1] : "?"}`;
  // Fallback: lista ordenada de basenames de chunks.
  const names = [...new Set([...html.matchAll(/\/_next\/static\/chunks\/([^"'\s)\\]+?\.js)/g)].map((m) => m[1]))].sort();
  return "chunks:" + names.join(",");
}

/** Parsea Cache-Control a un objeto { 'max-age': 0, 's-maxage': 60, ... }. */
function parseCacheControl(h) {
  const out = {};
  for (const part of String(h || "").split(",")) {
    const [k, v] = part.trim().split("=");
    if (!k) continue;
    out[k.toLowerCase()] = v === undefined ? true : Number(v);
  }
  return out;
}

/** Devuelve la directiva connect-src de una CSP (o null). */
function cspConnectSrc(csp) {
  const m = String(csp || "").split(";").map((s) => s.trim()).find((d) => d.toLowerCase().startsWith("connect-src"));
  return m || null;
}

// ───────────────────────────── Motor de checks ─────────────────────────────

const results = [];

/** Envuelve un check: una excepción NO aborta el resto de la suite. */
async function runCheck(id, title, fn) {
  const started = Date.now();
  try {
    const r = await fn();
    results.push({ id, title, status: r.status, detail: r.detail, extra: r.extra ?? null, ms: Date.now() - started });
  } catch (e) {
    results.push({ id, title, status: "FAIL", detail: `Excepción no controlada: ${e.message}`, extra: null, ms: Date.now() - started });
  }
}

/** Combina sub-resultados booleanos en un status global. */
function rollup(subs) {
  // subs: [{ ok:boolean, label:string }]
  const failed = subs.filter((s) => s.ok === false);
  const status = failed.length === 0 ? "PASS" : "FAIL";
  const detail = subs.map((s) => `${s.ok === false ? "✗" : s.ok === true ? "✓" : "·"} ${s.label}`).join("\n    ");
  return { status, detail, extra: { subs } };
}

// ───────────────────────────── Checks ─────────────────────────────

// 1. Dominios arriba (+ API /health): 200 y TLS válido (fetch rechaza TLS inválido).
async function checkDomainsUp() {
  const subs = [];
  for (const [name, url] of Object.entries(DOMAINS)) {
    try {
      const r = await fetchT(url, { redirect: "follow" });
      subs.push({ ok: r.status === 200, label: `${name} → HTTP ${r.status} (TLS OK)` });
    } catch (e) {
      subs.push({ ok: false, label: `${name} → ERROR ${e.message}` });
    }
  }
  try {
    const r = await fetchT(API + "/health");
    const body = await r.json().catch(() => ({}));
    const ok = r.status === 200 && body?.ok === true;
    subs.push({ ok, label: `API /health → HTTP ${r.status} (${body?.env ?? "?"})` });
  } catch (e) {
    subs.push({ ok: false, label: `API /health → ERROR ${e.message}` });
  }
  return rollup(subs);
}

// 2. Bundle sin parámetros locales + con la URL pública de la API.
async function checkBundleNoLocal() {
  const subs = [];
  const scannedChunks = new Set();
  let anyPublicApi = false;
  const offenders = [];

  for (const origin of CONVERSIA_WEB) {
    for (const route of BUNDLE_ROUTES) {
      let html;
      try {
        const r = await fetchT(origin + route, { redirect: "follow" });
        if (r.status !== 200) {
          subs.push({ ok: null, label: `${origin}${route} → HTTP ${r.status} (sin HTML que auditar)` });
          continue;
        }
        html = await r.text();
      } catch (e) {
        subs.push({ ok: false, label: `${origin}${route} → ERROR ${e.message}` });
        continue;
      }
      for (const chunkUrl of extractChunks(html, origin)) {
        if (scannedChunks.has(chunkUrl)) continue;
        scannedChunks.add(chunkUrl);
        try {
          const cr = await fetchT(chunkUrl);
          const txt = await cr.text();
          // Quita el fallback documentado antes de buscar restos locales. Solo nos importa una
          // URL local REAL (host local CON PUERTO, p. ej. localhost:4000 / 127.0.0.1:4000); un
          // hostname pelado "127.0.0.1" / "localhost" es una comparación legítima en api-base.ts
          // (`host !== "127.0.0.1"`), no una URL filtrada → no debe marcar.
          const scrub = txt.split(ALLOWED_LOCAL_FALLBACK).join("");
          const hasLocalColon = /localhost:\d/.test(scrub);
          const has127 = /127\.0\.0\.1:\d/.test(scrub);
          if (hasLocalColon || has127) {
            offenders.push(`${chunkUrl} (${hasLocalColon ? "localhost:<puerto>" : ""}${has127 ? " 127.0.0.1:<puerto>" : ""})`);
          }
          if (PUBLIC_API_MARKERS.some((m) => txt.includes(m))) anyPublicApi = true;
        } catch (e) {
          subs.push({ ok: false, label: `chunk ${chunkUrl} → ERROR ${e.message}` });
        }
      }
    }
  }

  subs.push({ ok: offenders.length === 0, label: offenders.length === 0 ? `0 chunks con localhost/127.0.0.1 (de ${scannedChunks.size} escaneados)` : `CHUNKS CON LOCALHOST: ${offenders.join("; ")}` });
  subs.push({ ok: anyPublicApi, label: anyPublicApi ? `URL pública de la API presente en el bundle` : `NINGÚN chunk contiene la URL pública (${PUBLIC_API_MARKERS.join("/")}) → posible build SIN NEXT_PUBLIC_API_URL` });
  return rollup(subs);
}

// 3. CORS por dominio (preflight OPTIONS con Origin).
async function checkCors() {
  const subs = [];
  async function preflight(origin) {
    const r = await fetchT(API + "/public/verticals", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET" } });
    return r.headers.get("access-control-allow-origin");
  }
  for (const origin of CORS_CONVERSIA) {
    try {
      const acao = await preflight(origin);
      subs.push({ ok: acao === origin, label: `Conversia ${origin} → ACAO=${acao ?? "(ausente)"}` });
    } catch (e) {
      subs.push({ ok: false, label: `Conversia ${origin} → ERROR ${e.message}` });
    }
  }
  for (const origin of CORS_TUBOT_REQUIRED) {
    try {
      const acao = await preflight(origin);
      subs.push({ ok: acao === origin, label: `TuBot ${origin} → ACAO=${acao ?? "(ausente)"}` });
    } catch (e) {
      subs.push({ ok: false, label: `TuBot ${origin} → ERROR ${e.message}` });
    }
  }
  for (const origin of CORS_TUBOT_INFO) {
    try {
      const acao = await preflight(origin);
      // Informativo (no hace fallar): depende de WEB_URL del servicio TuBot.
      subs.push({ ok: null, label: `TuBot ${origin} → ACAO=${acao ?? "(ausente)"} ${acao === origin ? "(permitido)" : "(no permitido — informativo)"}` });
    } catch (e) {
      subs.push({ ok: null, label: `TuBot ${origin} → ERROR ${e.message} (informativo)` });
    }
  }
  // Control negativo: un origen ajeno NO debe ser reflejado.
  try {
    const acao = await preflight(CORS_EVIL);
    subs.push({ ok: acao !== CORS_EVIL, label: `Control negativo ${CORS_EVIL} → ACAO=${acao ?? "(ausente)"} ${acao === CORS_EVIL ? "(¡REFLEJADO! CORS demasiado abierto)" : "(rechazado correctamente)"}` });
  } catch (e) {
    subs.push({ ok: false, label: `Control negativo → ERROR ${e.message}` });
  }
  return rollup(subs);
}

// 4. Endpoints públicos del funnel.
async function checkPublicEndpoints() {
  const subs = [];
  async function getJson(path) {
    const r = await fetchT(API + path);
    const body = await r.json().catch(() => null);
    return { status: r.status, body };
  }
  try {
    const { status, body } = await getJson("/public/verticals");
    const n = Array.isArray(body) ? body.length : -1;
    subs.push({ ok: status === 200 && n >= MIN_VERTICALS, label: `/public/verticals → HTTP ${status}, ${n} rubros (esperado ≥${MIN_VERTICALS})` });
  } catch (e) {
    subs.push({ ok: false, label: `/public/verticals → ERROR ${e.message}` });
  }
  try {
    const { status, body } = await getJson("/public/conversation-packs?brand=conversia");
    const n = Array.isArray(body) ? body.length : -1;
    subs.push({ ok: status === 200 && n >= MIN_PACKS, label: `/public/conversation-packs?brand=conversia → HTTP ${status}, ${n} packs (esperado ≥${MIN_PACKS})` });
  } catch (e) {
    subs.push({ ok: false, label: `/public/conversation-packs → ERROR ${e.message}` });
  }
  try {
    const { status, body } = await getJson("/public/plans?brand=conversia");
    const n = Array.isArray(body) ? body.length : -1;
    subs.push({ ok: status === 200 && n >= MIN_PLANS, label: `/public/plans?brand=conversia → HTTP ${status}, ${n} planes (esperado ≥${MIN_PLANS})` });
  } catch (e) {
    subs.push({ ok: false, label: `/public/plans → ERROR ${e.message}` });
  }
  try {
    const r = await fetchT(API + "/billing/plans");
    subs.push({ ok: r.status === 401, label: `/billing/plans (sin auth) → HTTP ${r.status} (esperado 401)` });
  } catch (e) {
    subs.push({ ok: false, label: `/billing/plans → ERROR ${e.message}` });
  }
  return rollup(subs);
}

// 5. Cabeceras (CSP/connect-src, Cache-Control del HTML, immutable en estáticos, HSTS).
async function checkHeaders() {
  const subs = [];
  const sample = "https://app.conversia.cl/";
  let r;
  try {
    r = await fetchT(sample, { redirect: "follow" });
  } catch (e) {
    return { status: "FAIL", detail: `No se pudo leer ${sample}: ${e.message}`, extra: null };
  }
  const csp = r.headers.get("content-security-policy");
  const connect = cspConnectSrc(csp);
  const cspOk = Boolean(csp) && Boolean(connect) && PUBLIC_API_MARKERS.some((m) => connect.includes(m));
  subs.push({ ok: cspOk, label: csp ? `CSP presente; connect-src ${connect ? (cspOk ? "incluye la API" : "NO incluye la API → " + connect) : "AUSENTE"}` : "CSP AUSENTE en el HTML" });

  const cc = r.headers.get("cache-control");
  const parsed = parseCacheControl(cc);
  const effective = parsed["s-maxage"] !== undefined ? parsed["s-maxage"] : parsed["max-age"];
  const cacheOk = typeof effective === "number" && !Number.isNaN(effective) && effective <= MAX_HTML_SMAXAGE;
  subs.push({ ok: cacheOk, label: `HTML Cache-Control: "${cc}" (efectivo ${effective}s ≤ ${MAX_HTML_SMAXAGE}; cf-cache=${r.headers.get("cf-cache-status") ?? "n/a"})` });

  const hsts = r.headers.get("strict-transport-security");
  subs.push({ ok: Boolean(hsts && /max-age=\d+/.test(hsts)), label: `HSTS: ${hsts ?? "AUSENTE"}` });

  // immutable en un chunk estático versionado por hash.
  try {
    const chunks = extractChunks(await r.clone().text(), "https://app.conversia.cl");
    if (chunks.length) {
      const sr = await fetchT(chunks[0]);
      const scc = sr.headers.get("cache-control") || "";
      subs.push({ ok: /immutable/.test(scc), label: `/_next/static → "${scc}" ${/immutable/.test(scc) ? "(immutable ✓)" : "(sin immutable)"}` });
    } else {
      subs.push({ ok: null, label: "No se hallaron chunks estáticos para validar immutable" });
    }
  } catch (e) {
    subs.push({ ok: false, label: `static immutable → ERROR ${e.message}` });
  }
  return rollup(subs);
}

// 6. Caché/versión: chunks referenciados existen (200) + mismo build entre dominios.
async function checkCacheVersion() {
  const subs = [];
  const fp = {};
  for (const origin of CONVERSIA_WEB) {
    try {
      const r = await fetchT(origin + "/", { redirect: "follow" });
      const html = await r.text();
      fp[origin] = buildFingerprint(html);
      const chunks = extractChunks(html, origin);
      let missing = 0;
      for (const c of chunks) {
        try {
          const cr = await fetchT(c, { method: "GET" });
          if (cr.status !== 200) missing++;
        } catch {
          missing++;
        }
      }
      subs.push({ ok: missing === 0, label: `${origin} → ${chunks.length} chunks, ${missing} rotos (HTML viejo apuntando a chunks purgados si >0). build=${fp[origin]}` });
    } catch (e) {
      subs.push({ ok: false, label: `${origin} → ERROR ${e.message}` });
      fp[origin] = `ERROR:${e.message}`;
    }
  }
  const a = fp["https://app.conversia.cl"];
  const b = fp["https://conversia.cl"];
  subs.push({ ok: Boolean(a) && a === b, label: `Mismo build en app.conversia.cl y conversia.cl: ${a === b ? "SÍ" : "NO"} (app=${a} | apex=${b})` });
  return rollup(subs);
}

// 7. Enlaces internos de la landing (sin 404 en la ruta de campaña).
async function checkInternalLinks() {
  const subs = [];
  const origin = "https://conversia.cl";
  let html;
  try {
    const r = await fetchT(origin + "/", { redirect: "follow" });
    html = await r.text();
  } catch (e) {
    return { status: "FAIL", detail: `No se pudo leer la landing: ${e.message}`, extra: null };
  }
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  const internal = [...new Set(hrefs.filter((h) => h.startsWith("/") && !h.startsWith("//") && !h.startsWith("/#")))];
  if (internal.length === 0) {
    subs.push({ ok: null, label: "La landing no expone enlaces internos en el HTML inicial (SPA cliente)" });
  }
  for (const href of internal) {
    try {
      const r = await fetchT(origin + href, { redirect: "follow" });
      subs.push({ ok: r.status < 400, label: `${href} → HTTP ${r.status}` });
    } catch (e) {
      subs.push({ ok: false, label: `${href} → ERROR ${e.message}` });
    }
  }
  return rollup(subs);
}

// 8. Consola limpia: requiere navegador headless. No hay puppeteer/playwright → SKIP.
async function checkConsoleClean() {
  const candidates = ["puppeteer", "playwright", "playwright-core", "puppeteer-core"];
  const found = [];
  for (const mod of candidates) {
    try {
      await import(mod);
      found.push(mod);
    } catch {
      /* no instalado */
    }
  }
  if (found.length === 0) {
    return { status: "SKIP", detail: "Sin navegador headless (puppeteer/playwright) en node_modules; no se agrega dependencia. Verificación de consola manual.", extra: null };
  }
  return { status: "WARN", detail: `Navegador headless disponible (${found.join(", ")}) pero la automatización de consola no está implementada en este script (se mantiene sin dependencias).`, extra: null };
}

// 9. Seguridad de borde (no destructivo): respuestas de RECHAZO esperadas.
async function checkSecurityEdges() {
  const subs = [];
  // Webhook con payload mock: → 403 (canal de simulación cerrado en prod).
  try {
    const r = await fetchT(API + "/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "mock:qa-smoke", entry: [] }),
    });
    subs.push({ ok: r.status === 403, label: `POST /webhooks/whatsapp (payload mock:, sin token) → HTTP ${r.status} (esperado 403)` });
  } catch (e) {
    subs.push({ ok: false, label: `/webhooks/whatsapp → ERROR ${e.message}` });
  }
  // mock-confirm sin sesión → 401.
  try {
    const r = await fetchT(API + "/billing/mock-confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ planCode: "qa-smoke-noop" }),
    });
    subs.push({ ok: r.status === 401, label: `POST /billing/mock-confirm (sin sesión) → HTTP ${r.status} (esperado 401)` });
  } catch (e) {
    subs.push({ ok: false, label: `/billing/mock-confirm → ERROR ${e.message}` });
  }
  // API key inválida → 401.
  try {
    const r = await fetchT(API + "/public/v1/contacts", { headers: { authorization: "Bearer cnvk_invalid_smoke" } });
    subs.push({ ok: r.status === 401, label: `GET /public/v1/contacts (API key cnvk_ inválida) → HTTP ${r.status} (esperado 401)` });
  } catch (e) {
    subs.push({ ok: false, label: `/public/v1/contacts → ERROR ${e.message}` });
  }
  return rollup(subs);
}

// 10. Asistente de Conversia (OPT-IN, post-deploy): burbuja útil para una cuenta conversia y
//     ausente (404) para una cuenta de otra marca. Requiere credenciales QA por env para NO
//     mutar prod por defecto (sin ellas → SKIP). La marca se fija por el Origin (D8).
//     Env:  SMOKE_QA_EMAIL / SMOKE_QA_PASSWORD        (cuenta conversia QA del flujo documentado)
//           SMOKE_TUBOT_EMAIL / SMOKE_TUBOT_PASSWORD  (cuenta tubot; opcional — verifica el 404)
const QA = { email: process.env.SMOKE_QA_EMAIL, password: process.env.SMOKE_QA_PASSWORD };
const TB = { email: process.env.SMOKE_TUBOT_EMAIL, password: process.env.SMOKE_TUBOT_PASSWORD };
const CONVERSIA_ORIGIN = "https://app.conversia.cl";
const TUBOT_ORIGIN = "https://tubot.cl";

async function apiLogin(email, password, origin) {
  const r = await fetchT(API + "/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, token: body?.token ?? null, body };
}

async function checkAssistant() {
  if (!QA.email && !TB.email) {
    return { status: "SKIP", detail: "Sin credenciales QA (SMOKE_QA_EMAIL/…). Verificación del asistente post-deploy omitida.", extra: null };
  }
  const subs = [];

  // Cuenta conversia: contexto 200 + respuesta útil (menciona ventanas/popup) a la pregunta del popup.
  if (QA.email && QA.password) {
    try {
      const login = await apiLogin(QA.email, QA.password, CONVERSIA_ORIGIN);
      if (!login.token) {
        subs.push({ ok: false, label: `QA conversia login → HTTP ${login.status} (¿credenciales?/${login.body?.message ?? ""})` });
      } else {
        const auth = { authorization: `Bearer ${login.token}` };
        const ctx = await fetchT(API + "/assistant/context", { headers: auth });
        subs.push({ ok: ctx.status === 200, label: `QA conversia /assistant/context → HTTP ${ctx.status} (esperado 200: la burbuja se muestra)` });
        const mr = await fetchT(API + "/assistant/message", {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({ message: "Al conectar WhatsApp me dice que se bloqueó la ventana de Meta. ¿Qué hago?", route: "/canales" }),
        });
        const mbody = await mr.json().catch(() => ({}));
        const reply = String(mbody?.reply ?? "");
        const menciona = /ventana|emergente|popup|pop-up|bloque/i.test(reply);
        const esFallback = /problema para responder|reintenta|soporte/i.test(reply) && !menciona;
        subs.push({ ok: mr.status < 300 && reply.length > 0, label: `QA conversia /assistant/message → HTTP ${mr.status}, ${reply.length} chars` });
        // Calidad: útil (menciona ventanas) = PASS; fallback de IA caída = neutral (WARN, no rompe el gate).
        subs.push({ ok: menciona ? true : esFallback ? null : false, label: menciona ? `respuesta ESPECÍFICA sobre ventanas emergentes ✓` : esFallback ? `respuesta de respaldo (¿IA no configurada en prod? AI_PROVIDER/ANTHROPIC_API_KEY)` : `respuesta genérica (no menciona ventanas): "${reply.slice(0, 90)}…"` });
      }
    } catch (e) {
      subs.push({ ok: false, label: `QA conversia → ERROR ${e.message}` });
    }
  } else {
    subs.push({ ok: null, label: "SMOKE_QA_EMAIL/PASSWORD no provistos → no se verifica la cuenta conversia" });
  }

  // Cuenta tubot: el gate debe RECHAZAR el asistente (404 → la burbuja no aparece).
  if (TB.email && TB.password) {
    try {
      const login = await apiLogin(TB.email, TB.password, TUBOT_ORIGIN);
      if (!login.token) {
        subs.push({ ok: null, label: `tubot login → HTTP ${login.status} (informativo; no se pudo verificar el 404)` });
      } else {
        const ctx = await fetchT(API + "/assistant/context", { headers: { authorization: `Bearer ${login.token}` } });
        subs.push({ ok: ctx.status === 404, label: `tubot /assistant/context → HTTP ${ctx.status} (esperado 404: la burbuja NO se muestra)` });
      }
    } catch (e) {
      subs.push({ ok: false, label: `tubot → ERROR ${e.message}` });
    }
  } else {
    subs.push({ ok: null, label: "SMOKE_TUBOT_EMAIL/PASSWORD no provistos → no se verifica el 404 de marca ajena (informativo)" });
  }

  return rollup(subs);
}

// ───────────────────────────── Runner ─────────────────────────────

async function main() {
  const startedAt = new Date();
  console.log(C.bold(`\n🔎 QA de Producción — smoke-prod  (${startedAt.toISOString()})`));
  console.log(C.gray(`   API=${API}  |  SOLO LECTURA\n`));

  await runCheck("1-domains", "Dominios arriba + API /health (200 + TLS)", checkDomainsUp);
  await runCheck("2-bundle", "Bundle sin localhost + con URL pública de la API", checkBundleNoLocal);
  await runCheck("3-cors", "CORS por dominio (Conversia + TuBot + control negativo)", checkCors);
  await runCheck("4-public", "Endpoints públicos del funnel", checkPublicEndpoints);
  await runCheck("5-headers", "Cabeceras (CSP/connect-src, Cache-Control, immutable, HSTS)", checkHeaders);
  await runCheck("6-cache", "Caché/versión (chunks existen + mismo build entre dominios)", checkCacheVersion);
  await runCheck("7-links", "Enlaces internos de la landing (sin 404)", checkInternalLinks);
  await runCheck("8-console", "Consola limpia (navegador headless)", checkConsoleClean);
  await runCheck("9-security", "Seguridad de borde (rechazos esperados, no destructivo)", checkSecurityEdges);
  await runCheck("10-assistant", "Asistente: burbuja útil en conversia + 404 en marca ajena (opt-in QA)", checkAssistant);

  // Resumen legible.
  const icon = { PASS: C.green("PASS"), FAIL: C.red("FAIL"), WARN: C.yellow("WARN"), SKIP: C.gray("SKIP") };
  console.log(C.bold("Resultados por punto:\n"));
  for (const r of results) {
    console.log(`  [${icon[r.status] ?? r.status}] ${C.cyan(r.id)}  ${r.title}  ${C.gray(`(${r.ms}ms)`)}`);
    if (r.detail) console.log(`    ${r.detail.split("\n").join("\n    ")}`);
    console.log("");
  }

  const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
  const anyFail = (counts.FAIL ?? 0) > 0;
  console.log(C.bold("Resumen: ") + `${C.green((counts.PASS ?? 0) + " PASS")} · ${C.red((counts.FAIL ?? 0) + " FAIL")} · ${C.yellow((counts.WARN ?? 0) + " WARN")} · ${C.gray((counts.SKIP ?? 0) + " SKIP")}`);

  // Salida JSON.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outDir = join(__dirname, "out");
  await mkdir(outDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const outPath = join(outDir, `smoke-prod-${stamp}.json`);
  const payload = {
    tool: "smoke-prod",
    api: API,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    summary: { pass: counts.PASS ?? 0, fail: counts.FAIL ?? 0, warn: counts.WARN ?? 0, skip: counts.SKIP ?? 0, ok: !anyFail },
    results,
  };
  await writeFile(outPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log(C.gray(`\nJSON → ${outPath}`));

  process.exit(anyFail ? 1 : 0);
}

main().catch((e) => {
  console.error(C.red(`Error fatal de la suite: ${e.stack || e.message}`));
  process.exit(2);
});
