#!/usr/bin/env node
/**
 * ENSAYO DEL GO-LIVE DE CRÉDITOS IA contra el stack Docker (nunca producción).
 *
 * Por qué: el catálogo de créditos está apagado, así que TODAS las jornadas del dueño
 * corren con el cobro por conversación. El día que el dueño corra `creditos-golive.mjs`,
 * cada cuenta nueva entra al modelo nuevo — y ese camino completo (plan de prueba, regalo
 * de bienvenida, débito por respuesta, medidor con datos reales, recarga, rollback) no lo
 * ha recorrido nadie de punta a punta.
 *
 * Uso: node ensayo-golive.mjs     (requiere `pnpm sim:up` arriba)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.SIM_API || "http://localhost:4000";
const ORIGIN_CV = "http://localhost:3002";
const DB_URL = process.env.SIM_DATABASE_URL || "postgresql://postgres:postgres@localhost:5433/conversia_sim";
const REPO = process.env.REPO_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/**
 * Contraseña de UN SOLO USO para las cuentas del ensayo. Se genera en cada corrida en vez
 * de llevar una literal: las cuentas viven en una base desechable, nadie tiene que volver
 * a entrar con ellas, y una contraseña escrita en un archivo del repo la marca —con
 * razón— el escáner de secretos. Lo cazó gitleaks en el PR de este mismo archivo.
 */
const PASSWORD = process.env.ENSAYO_PASSWORD || `Ensayo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}A1`;

let pass = 0;
let fail = 0;
const check = (ok, label, extra = "") => {
  if (ok) {
    pass++;
    console.log(`  ✔ ${label}`);
  } else {
    fail++;
    console.log(`  ✖ ${label} ${extra}`);
  }
};
const paso = (t) => console.log(`\n── ${t}`);

/**
 * Corre un script de packages/database contra la base del stack, DESDE EL HOST.
 *
 * Antes se corrían dentro del contenedor api (`docker compose exec`) y eso tenía dos
 * problemas: el contenedor lleva una copia CONGELADA del repo —así que el ensayo probaba
 * los scripts de la última imagen construida, no los del working copy, y un arreglo recién
 * escrito se "verificaba" con el código viejo— y además correr un script pesado dentro del
 * mismo contenedor reiniciaba el proceso de la API, que es por lo que había que esperarla.
 *
 * Desde el host es más fiel, además: es exactamente como se corren en producción
 * (`railway run -s Postgres -- … node scripts/…`), con la URL de la base por env.
 */
function correrScript(script, env = {}) {
  return execFileSync(process.execPath, [`scripts/${script}`], {
    cwd: join(REPO, "packages", "database"),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DATABASE_URL: DB_URL, DIRECT_DATABASE_URL: DB_URL, ...env },
  });
}

async function esperarApi(ms = 90_000) {
  const limite = Date.now() + ms;
  let ultimo = "";
  while (Date.now() < limite) {
    try {
      const r = await fetch(`${API}/health`);
      if (r.ok) return;
      ultimo = `HTTP ${r.status}`;
    } catch (e) {
      ultimo = e.message;
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
  throw new Error(`la API no volvió a responder (${ultimo})`);
}

async function api(path, { method = "GET", token, body, origin } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const txt = await r.text();
  let json = null;
  try {
    json = JSON.parse(txt);
  } catch {
    /* respuesta no-JSON */
  }
  return { status: r.status, ok: r.ok, json, txt };
}

async function registrar(etiqueta) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `qa+golive-${etiqueta}-${stamp}@conversia.local`;
  const r = await api("/auth/register", {
    method: "POST",
    origin: ORIGIN_CV,
    body: { email, password: PASSWORD, name: "Dueño Ensayo", organizationName: `Ensayo ${etiqueta} ${stamp}`, country: "CL", vertical: "barberia" },
  });
  if (!r.ok) throw new Error(`register falló: ${r.status} ${r.txt.slice(0, 300)}`);
  return { token: r.json.token, organizationId: r.json.organizationId, email };
}

async function saldo(token) {
  const r = await api("/billing/wallet/summary", { token });
  if (!r.ok) throw new Error(`wallet/summary: ${r.status} ${r.txt.slice(0, 200)}`);
  return r.json;
}

async function dejarOperando(token) {
  const list = await api("/agents", { token });
  const agents = Array.isArray(list.json) ? list.json : (list.json?.items ?? []);
  const agentId = agents[0]?.id;
  if (!agentId) throw new Error("la org no tiene agente");
  await api(`/agents/${agentId}/draft`, { method: "PUT", token, body: { systemPrompt: "Eres el asistente de prueba. Responde breve.", config: {}, tools: [] } });
  const pub = await api(`/agents/${agentId}/publish`, { method: "POST", token, body: {} });
  if (!pub.ok) throw new Error(`publish: ${pub.status} ${pub.txt.slice(0, 200)}`);
  await api(`/agents/${agentId}/active`, { method: "POST", token, body: { active: true } });
  const ch = await api("/channels", { method: "POST", token, body: { type: "MOCK", name: "Simulado", defaultAgentId: agentId } });
  if (!ch.ok) throw new Error(`channels: ${ch.status} ${ch.txt.slice(0, 200)}`);
  const me = await api("/auth/me", { token });
  return me.json?.organization?.slug ?? me.json?.org?.slug;
}

async function entra(slug, texto, waId = "56911111111") {
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "0",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "56900000000", phone_number_id: `mock:${slug}` },
              contacts: [{ profile: { name: "Cliente Simulado" }, wa_id: waId }],
              messages: [{ from: waId, id: `wamid.sim.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: texto } }],
            },
          },
        ],
      },
    ],
  };
  const r = await fetch(`${API}/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-conversia-mock-token": "dev-mock-inbound-token" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`webhook mock: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function esperarRespuestas(token, n = 1, ms = 90_000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    const cs = await api("/conversations?status=all&order=recent", { token });
    const conv = (cs.json?.items ?? [])[0];
    if (conv?.id) {
      const msgs = await api(`/conversations/${conv.id}/messages`, { token });
      const respuestas = (msgs.json?.messages ?? []).filter((m) => m.direction === "OUTBOUND" && m.authorType === "AGENT");
      if (respuestas.length >= n) return conv.id;
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
  throw new Error(`el bot no llegó a ${n} respuesta(s)`);
}

async function main() {
  console.log("══ ENSAYO DEL GO-LIVE DE CRÉDITOS IA (stack Docker) ══");

  // ─────── 0. Punto de partida conocido: el modelo por conversación ───────
  // Idempotente y necesario para que el ensayo se pueda repetir: si quedó encendido de una
  // corrida anterior, el paso 1 mediría el modelo nuevo creyendo medir el viejo.
  paso("0. Normalizar el punto de partida (rollback, idempotente)");
  const base0 = correrScript("creditos-golive.mjs", { OFF: "1" });
  check(/APAGADO/.test(base0), "se parte del modelo por conversación");
  await esperarApi();

  // ───────────────────────── 1. Antes: el modelo viejo ─────────────────────────
  paso("1. ANTES del go-live: una cuenta nueva entra por conversación");
  const antes = await registrar("antes");
  const sAntes = await saldo(antes.token);
  check(sAntes.unit === "conversation", `unidad = ${sAntes.unit} (esperaba conversation)`);
  check(sAntes.balance > 0, `saldo de regalo = ${sAntes.balance}`);
  check(sAntes.medidor == null, "sin medidor de créditos (no corresponde en esta unidad)");

  // ───────────────────────── 2. Sembrar + encender ─────────────────────────
  paso("2. Siembra del catálogo (queda INACTIVO) y go-live");
  const seed = correrScript("seed-conversia-catalog.mjs");
  await esperarApi();
  check(/créditos|creditos|credit/i.test(seed), "el seeder corrió y tocó el catálogo de créditos");
  const dry = correrScript("creditos-migrar-saldos.mjs");
  await esperarApi();
  check(/DRY-RUN/.test(dry), "la migración de saldos en dry-run no escribe nada");
  const golive = correrScript("creditos-golive.mjs");
  await esperarApi();
  check(/CRÉDITOS IA ENCENDIDO/.test(golive), "go-live encendido");
  console.log(golive.split("\n").filter((l) => l.trim()).map((l) => `      ${l}`).join("\n"));

  // ───────────────────────── 3. El catálogo público cambió ─────────────────────────
  paso("3. Lo que se ofrece al público es el modelo nuevo");
  const planes = await api("/public/plans?brand=conversia");
  const codes = (Array.isArray(planes.json) ? planes.json : planes.json?.plans ?? []).map((p) => p.code);
  check(codes.includes("conversia_creditos_base"), `planes públicos: ${codes.join(", ")}`);
  check(!codes.includes("conversia_v2_base"), "el plan por conversación ya no se ofrece");
  const packs = await api("/public/conversation-packs?brand=conversia");
  const pcodes = (Array.isArray(packs.json) ? packs.json : []).map((p) => p.code);
  // EXACTAMENTE los del catálogo, no "alguno que empiece con conversia-cred-". Un pack que
  // el dueño sacó del catálogo y quedó en la base se vendería igual, y los viejos costaban
  // $12,5–$19 por crédito contra los $59,5 aprobados: encender el modelo nuevo con ellos
  // vivos es regalar el 79% del precio justo a los clientes que más gastan. Lo encontró
  // este ensayo: el paso 3 listaba 6 packs públicos donde el catálogo tiene 1.
  const delCatalogo = JSON.parse(readFileSync(join(REPO, "packages", "database", "seeds", "creditos-catalogo.json"), "utf-8")).packs.map(
    (p) => p.code,
  );
  const creditos = pcodes.filter((c) => c.startsWith("conversia-cred-")).sort();
  check(
    creditos.join(",") === [...delCatalogo].sort().join(","),
    `los packs públicos de créditos son EXACTAMENTE los del catálogo (${delCatalogo.join(", ")})`,
    `→ públicos: ${creditos.join(", ") || "(ninguno)"}`,
  );

  // ───────────────────────── 4. Una cuenta nueva nace en créditos ─────────────────────────
  paso("4. DESPUÉS del go-live: una cuenta nueva entra en Créditos IA");
  const cta = await registrar("despues");
  const s0 = await saldo(cta.token);
  check(s0.unit === "credit", `unidad = ${s0.unit} (esperaba credit)`);
  check(s0.balance === 200, `regalo de bienvenida = ${s0.balance} (esperaba 200)`);
  check(s0.medidor != null, "trae medidor");
  if (s0.medidor) {
    console.log(`      medidor: ${s0.medidor.frase}`);
    console.log(`      base: ${s0.medidor.base} · ${s0.medidor.explicacion}`);
    check(s0.medidor.conversaciones > 0, `estima ${s0.medidor.conversaciones} conversaciones`);
    check(s0.medidor.base === "defecto" || s0.medidor.base === "rubro", `base = ${s0.medidor.base} (sin historia propia)`);
    check(s0.medidor.dias === null, `sin ritmo propio no inventa días (dias = ${s0.medidor.dias})`);
  }

  // ───────────────────────── 5. El bot responde y se cobra por respuesta ─────────────────────────
  paso("5. El bot atiende y el cobro es por RESPUESTA (no por conversación)");
  const slug = await dejarOperando(cta.token);
  await entra(slug, "hola, ¿a qué hora abren?");
  await esperarRespuestas(cta.token, 1);
  const s1 = await saldo(cta.token);
  check(s1.balance < s0.balance, `saldo ${s0.balance} → ${s1.balance} (bajó ${s0.balance - s1.balance} créditos)`);
  check(s1.unit === "credit", "sigue en créditos");

  // Segunda respuesta en la MISMA conversación: por conversación no cobraría; por crédito sí.
  await entra(slug, "¿y los sábados?");
  await esperarRespuestas(cta.token, 2);
  await new Promise((s) => setTimeout(s, 3000)); // el débito va después de persistir el mensaje
  const s2 = await saldo(cta.token);
  check(
    s2.balance < s1.balance,
    `la SEGUNDA respuesta de la misma conversación también cobra: ${s1.balance} → ${s2.balance}`,
    "(cobrando por conversación esto no bajaría: es la diferencia del modelo nuevo)",
  );

  // ───────────────────────── 6. El medidor con datos REALES ─────────────────────────
  paso("6. El medidor, ya con consumo real en la base");
  const s3 = await saldo(cta.token);
  check(s3.medidor != null, "el medidor sigue llegando");
  if (s3.medidor) {
    console.log(`      ${s3.medidor.frase}`);
    console.log(`      ${s3.medidor.explicacion}`);
    check(Number.isFinite(s3.medidor.conversaciones), `conversaciones = ${s3.medidor.conversaciones}`);
    check(s3.medidor.creditosPorConversacion > 0, `créditos por conversación = ${s3.medidor.creditosPorConversacion}`);
    // Con un día de uso NO se promete un ritmo: antes decía "≈ 199 días a tu ritmo" porque
    // había gastado 1 crédito en 1 día.
    check(s3.medidor.dias === null, `con un día de datos no inventa días (dias = ${s3.medidor.dias})`);
  }
  const costos = await api("/billing/meta-costs", { token: cta.token });
  check(costos.ok, `/billing/meta-costs responde ${costos.status}`);

  // ───────────────────────── 7. Recarga de un pack de créditos ─────────────────────────
  paso("7. Comprar una recarga acredita los LOTES (no la bolsa de plantillas)");
  const pack = (Array.isArray(packs.json) ? packs.json : []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
  if (!pack) check(false, "no hay pack de créditos para comprar");
  else {
    await api("/billing/buy-package", { method: "POST", token: cta.token, body: { code: pack.code } });
    const mc = await api("/billing/mock-confirm", { method: "POST", token: cta.token, body: { planCode: `pkg:${pack.code}` } });
    check(mc.ok, `mock-confirm ${pack.code} → ${mc.status}`, mc.txt.slice(0, 200));
    const s4 = await saldo(cta.token);
    check(s4.balance >= s3.balance + pack.credits - 5, `saldo ${s3.balance} → ${s4.balance} (pack de ${pack.credits})`);
  }

  // ───────────────────────── 8. Rollback ─────────────────────────
  paso("8. Rollback: vuelve el modelo por conversación sin borrar nada");
  const off = correrScript("creditos-golive.mjs", { OFF: "1" });
  await esperarApi();
  check(/APAGADO/.test(off), "rollback ejecutado");
  const planes2 = await api("/public/plans?brand=conversia");
  const codes2 = (Array.isArray(planes2.json) ? planes2.json : planes2.json?.plans ?? []).map((p) => p.code);
  check(codes2.includes("conversia_v2_base"), `planes públicos tras rollback: ${codes2.join(", ")}`);
  check(!codes2.includes("conversia_creditos_base"), "el plan de créditos deja de ofrecerse");
  const sFinal = await saldo(cta.token);
  check(sFinal.balance > 0, `el cliente que ya estaba en créditos NO perdió su saldo: ${sFinal.balance}`);

  console.log(`\n${fail === 0 ? "✔" : "✖"} ${pass} comprobaciones OK · ${fail} fallidas`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n✖ ensayo abortado: ${e.message}`);
  process.exit(2);
});
