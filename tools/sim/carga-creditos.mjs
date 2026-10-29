#!/usr/bin/env node
/**
 * PRUEBA DE CARGA DEL CONTADOR DE CRÉDITOS — contra el stack Docker, nunca producción.
 *
 * El ensayo del go-live prueba que el camino FUNCIONA (una cuenta nueva, dos respuestas, el
 * saldo baja). Esto prueba algo distinto y más difícil: que con tráfico de verdad el
 * contador **no pierda ni invente un solo crédito**. Es el número del que vive la
 * plataforma, así que no alcanza con que la fórmula esté bien probada: hay que verlo
 * aguantar lo que lo va a romper.
 *
 * Las cuatro cosas que ataca, en orden de cuánta plata se van si fallan:
 *
 *  1. LA CARRERA. El débito serializa los turnos de una organización con un
 *     `SELECT … FOR UPDATE` sobre la fila de su monedero. Si dos respuestas se cobran a la
 *     vez, el segundo lee el saldo viejo y el consumo del primero se PIERDE (lost update).
 *     Se dispara una ráfaga simultánea sobre UNA sola cuenta y se cuenta crédito por crédito.
 *  2. EL WEBHOOK DUPLICADO. Meta reintenta los webhooks. El mismo mensaje entregado tres
 *     veces no puede cobrarse tres veces.
 *  3. EL BLOQUE DE TOKENS. Una respuesta larga tiene que cobrar más de un bloque; si el
 *     ajuste por largo no funciona, las conversaciones caras se cobran como las baratas y
 *     el margen se va justo con los clientes que más gastan.
 *  4. LA GRACIA. El bot sigue respondiendo en negativo hasta el colchón. Si el tope no
 *     frena, un cliente sin saldo opera gratis para siempre.
 *
 * Y al final cierra el círculo: el **marcador que ve el cliente** (`/billing/wallet/summary`)
 * tiene que decir exactamente el mismo número que la base, y la auditoría del libro
 * (`packages/database/scripts/auditar-creditos.mjs`) tiene que cuadrar al crédito.
 *
 * Uso:  pnpm sim:up  &&  node tools/sim/carga-creditos.mjs
 * Env:  ORGS (6) · CONTACTOS (8) · MSGS (3) · RAFAGA (12) · SIM_API
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.SIM_API || "http://localhost:4000";
const ORIGIN_CV = "http://localhost:3002";
const REPO = process.env.REPO_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE = ["compose", "-f", "tools/sim/docker-compose.sim.yml"];
const ORGS = Number(process.env.ORGS ?? 6);
const CONTACTOS = Number(process.env.CONTACTOS ?? 8);
const MSGS = Number(process.env.MSGS ?? 3);
const RAFAGA = Number(process.env.RAFAGA ?? 12);
const PASSWORD = process.env.ENSAYO_PASSWORD || `Carga-${Date.now()}-${Math.random().toString(36).slice(2, 10)}A1`;
const INFORME = join(REPO, "tools", "sim", "out", "carga-creditos.json");

let pass = 0;
let fail = 0;
const fallos = [];
const check = (ok, label, extra = "") => {
  if (ok) {
    pass++;
    console.log(`  ✔ ${label}`);
  } else {
    fail++;
    fallos.push(label);
    console.log(`  ✖ ${label} ${extra}`);
  }
  return ok;
};
const paso = (t) => console.log(`\n── ${t}`);
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const nf = (x) => Number(x ?? 0).toLocaleString("es-CL");

// ───────────────────────────────── plomería ─────────────────────────────────

/** SQL contra el Postgres del stack, sin depender de un psql en el host. */
function sql(q) {
  const out = execFileSync(
    "docker",
    [...COMPOSE, "exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "conversia_sim", "-t", "-A", "-c", q],
    { cwd: REPO, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  return out.trim();
}
const sqlNum = (q) => Number(sql(q) || 0);

function enContenedor(script, env = "") {
  const cmd = `cd packages/database && ${env} DATABASE_URL="$DIRECT_DATABASE_URL" node scripts/${script}`;
  return execFileSync("docker", [...COMPOSE, "exec", "-T", "api", "sh", "-c", cmd], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
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
    await dormir(2000);
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
    /* no-JSON */
  }
  return { status: r.status, ok: r.ok, json, txt };
}

async function registrar(etiqueta) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `qa+carga-${etiqueta}-${stamp}@conversia.local`;
  const r = await api("/auth/register", {
    method: "POST",
    origin: ORIGIN_CV,
    body: { email, password: PASSWORD, name: "Dueño Carga", organizationName: `Carga ${etiqueta} ${stamp}`, country: "CL", vertical: "barberia" },
  });
  if (!r.ok) throw new Error(`register falló: ${r.status} ${r.txt.slice(0, 200)}`);
  const me = await api("/auth/me", { token: r.json.token });
  return { token: r.json.token, organizationId: r.json.organizationId, slug: me.json?.organization?.slug ?? me.json?.org?.slug, email };
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
}

/** Un inbound de WhatsApp por el webhook mock. `wamid` fijo = entrega repetida de Meta. */
async function entra(slug, texto, waId, wamid) {
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
              contacts: [{ profile: { name: `Cliente ${waId.slice(-4)}` }, wa_id: waId }],
              messages: [
                {
                  from: waId,
                  id: wamid ?? `wamid.carga.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: texto },
                },
              ],
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
  return r.status;
}

/** Turnos (`ai_requests`) de la org. Es el HECHO contra el que se audita el cobro. */
const turnosDe = (orgId) => sqlNum(`SELECT count(*) FROM ai_requests WHERE organization_id='${orgId}' AND purpose='CHAT';`);
const debitosDe = (orgId) =>
  sqlNum(`SELECT coalesce(sum(-delta),0) FROM conversation_credit_ledger WHERE organization_id='${orgId}' AND reason='ai_credit_debit';`);
const asientosDe = (orgId) =>
  sqlNum(`SELECT count(*) FROM conversation_credit_ledger WHERE organization_id='${orgId}' AND reason='ai_credit_debit';`);
const saldoDe = (orgId) =>
  sqlNum(
    `SELECT coalesce((SELECT sum(remaining) FROM conversation_credit_lots WHERE organization_id='${orgId}' AND remaining>0 AND (expires_at IS NULL OR expires_at>now())),0)` +
      ` - coalesce((SELECT grace_used FROM conversation_wallets WHERE organization_id='${orgId}'),0);`,
  );
const graciaDe = (orgId) => sqlNum(`SELECT coalesce(grace_used,0) FROM conversation_wallets WHERE organization_id='${orgId}';`);
/** Lo que DEBERÍA cobrarse por los turnos de la org, calculado desde los tokens guardados. */
const esperadoDe = (orgId, pesoPorBloque = 1, bloque = 20000) =>
  sqlNum(
    `SELECT coalesce(sum(${pesoPorBloque} * greatest(1, ceil((input_tokens + output_tokens)::numeric / ${bloque}))),0)` +
      ` FROM ai_requests WHERE organization_id='${orgId}' AND purpose='CHAT' AND (input_tokens + output_tokens) > 0;`,
  );

/**
 * Espera a que la cola termine: los turnos dejan de crecer durante `quietoMs`.
 *
 * No se espera "a que haya N turnos" a propósito: si el worker PIERDE un mensaje, esperar
 * un número exacto se cuelga hasta el timeout y el informe culpa al tiempo en vez de decir
 * que faltó un turno. Así se mide lo que de verdad pasó.
 */
async function esperarCola(orgIds, { quietoMs = 8_000, maxMs = 420_000 } = {}) {
  const limite = Date.now() + maxMs;
  let ultimo = -1;
  let quietoDesde = 0;
  while (Date.now() < limite) {
    const total = orgIds.reduce((a, id) => a + turnosDe(id), 0);
    if (total === ultimo) {
      if (!quietoDesde) quietoDesde = Date.now();
      if (Date.now() - quietoDesde >= quietoMs) return total;
    } else {
      ultimo = total;
      quietoDesde = 0;
    }
    await dormir(2000);
  }
  return ultimo;
}

/** Pool de concurrencia: dispara `tareas` con `n` en vuelo. */
async function enParalelo(tareas, n) {
  const resultados = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, tareas.length) }, async () => {
      while (i < tareas.length) {
        const mio = i++;
        resultados[mio] = await tareas[mio]().catch((e) => ({ error: e.message }));
      }
    }),
  );
  return resultados;
}

// ───────────────────────────────── la prueba ─────────────────────────────────

async function main() {
  console.log("══ PRUEBA DE CARGA DEL CONTADOR DE CRÉDITOS ══");
  console.log(`   ${ORGS} cuentas · ${CONTACTOS} contactos × ${MSGS} mensajes · ráfaga de ${RAFAGA} simultáneos\n`);

  // ─────── 0. Créditos encendidos (idempotente) ───────
  paso("0. Encender Créditos IA en el stack (idempotente)");
  enContenedor("seed-conversia-catalog.mjs");
  await esperarApi();
  const on = enContenedor("creditos-golive.mjs");
  await esperarApi();
  check(/CRÉDITOS IA ENCENDIDO/.test(on), "catálogo de créditos activo en el stack");

  // ─────── 1. Cuentas operando ───────
  paso(`1. Crear ${ORGS} cuentas y dejarlas operando`);
  const t0 = Date.now();
  const cuentas = [];
  for (let i = 0; i < ORGS; i++) {
    const c = await registrar(`c${i}`);
    await dejarOperando(c.token);
    cuentas.push(c);
  }
  const saldos0 = cuentas.map((c) => saldoDe(c.organizationId));
  check(
    saldos0.every((s) => s === 200),
    `las ${ORGS} cuentas nacen con 200 créditos de prueba`,
    `→ ${saldos0.join(", ")}`,
  );
  // El cerrojo del débito es un FOR UPDATE sobre la fila del monedero. Si el registro no la
  // crea, el cerrojo no agarra nada y la carrera del paso 3 es real.
  const sinMonedero = cuentas.filter((c) => sqlNum(`SELECT count(*) FROM conversation_wallets WHERE organization_id='${c.organizationId}';`) === 0);
  console.log(`      cuentas sin fila de monedero al registrarse: ${sinMonedero.length}/${ORGS}`);

  // ─────── 2. Carga general ───────
  paso(`2. Carga: ${ORGS * CONTACTOS * MSGS} mensajes entrantes`);
  const largo = "necesito saber todo sobre sus servicios y precios, cuéntame con mucho detalle. ".repeat(1_100); // ~85k chars → >1 bloque
  const tareas = [];
  for (const c of cuentas) {
    for (let k = 0; k < CONTACTOS; k++) {
      const waId = `5691${String(1_000_000 + Math.floor(Math.random() * 8_999_999))}`;
      for (let m = 0; m < MSGS; m++) {
        // Uno de cada ocho mensajes es LARGO: tiene que cobrar más de un bloque.
        const texto = (k * MSGS + m) % 8 === 3 ? largo : `hola, consulta ${m + 1} del contacto ${k + 1}`;
        tareas.push(() => entra(c.slug, texto, waId));
      }
    }
  }
  const envios = await enParalelo(tareas, 24);
  const aceptados = envios.filter((s) => s === 200 || s === 201).length;
  check(aceptados === tareas.length, `el webhook aceptó los ${tareas.length} mensajes`, `→ ${aceptados}`);
  const turnos = await esperarCola(cuentas.map((c) => c.organizationId));
  const seg = (Date.now() - t0) / 1000;
  console.log(`      ${nf(turnos)} respuestas del bot en ${seg.toFixed(0)}s (${(turnos / seg).toFixed(1)}/s)`);

  let bloquesMultiples = 0;
  for (const c of cuentas) {
    bloquesMultiples += sqlNum(
      `SELECT count(*) FROM ai_requests WHERE organization_id='${c.organizationId}' AND purpose='CHAT' AND (input_tokens+output_tokens) > 20000;`,
    );
  }
  check(bloquesMultiples > 0, `${bloquesMultiples} respuesta(s) pasaron de un bloque de tokens (el ajuste por largo se ejercita)`);

  // El esperado se calcula con peso 1 (gpt-4o-mini, el modelo con que nace todo bot). Si
  // alguna respuesta hubiera salido con otro modelo, el peso sería otro y TODAS las
  // comprobaciones de abajo compararían contra un número equivocado.
  const modelos = sql(
    `SELECT DISTINCT model FROM ai_requests WHERE organization_id IN (${cuentas.map((c) => `'${c.organizationId}'`).join(",")}) AND purpose='CHAT';`,
  )
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  check(
    modelos.length === 1 && modelos[0] === "gpt-4o-mini",
    `todas las respuestas salieron con gpt-4o-mini (peso 1), así que el esperado es comparable`,
    `→ modelos: ${modelos.join(", ")}`,
  );

  // Cada cuenta, crédito por crédito.
  let totalEsperado = 0;
  let totalCobrado = 0;
  for (const [i, c] of cuentas.entries()) {
    const esperado = esperadoDe(c.organizationId);
    const cobrado = debitosDe(c.organizationId);
    const asientos = asientosDe(c.organizationId);
    const turnosOrg = turnosDe(c.organizationId);
    totalEsperado += esperado;
    totalCobrado += cobrado;
    check(
      cobrado === esperado,
      `cuenta ${i + 1}: cobrado ${nf(cobrado)} = esperado ${nf(esperado)} (${nf(turnosOrg)} respuestas)`,
      `→ diferencia ${nf(cobrado - esperado)} crédito(s)`,
    );
    check(asientos <= turnosOrg, `cuenta ${i + 1}: ${nf(asientos)} asientos para ${nf(turnosOrg)} respuestas (ninguna cobrada dos veces)`);
    const saldo = saldoDe(c.organizationId);
    check(saldo === saldos0[i] - cobrado, `cuenta ${i + 1}: saldo ${nf(saldo)} = ${nf(saldos0[i])} − ${nf(cobrado)}`, `→ ${nf(saldo)}`);
  }
  check(totalCobrado === totalEsperado, `TOTAL de la carga: ${nf(totalCobrado)} créditos cobrados = ${nf(totalEsperado)} esperados`);

  // ─────── 3. La carrera: ráfaga simultánea sobre UNA cuenta ───────
  paso(`3. Carrera: ${RAFAGA} conversaciones simultáneas en la MISMA cuenta`);
  const rc = await registrar("carrera");
  await dejarOperando(rc.token);
  const saldoAntes = saldoDe(rc.organizationId);
  const rafaga = Array.from({ length: RAFAGA }, (_, k) => {
    const waId = `5692${String(1_000_000 + k)}`;
    return () => entra(rc.slug, `hola, atiéndanme ya mismo (${k})`, waId);
  });
  await Promise.all(rafaga.map((f) => f())); // TODAS a la vez, sin pool: es el punto
  await esperarCola([rc.organizationId]);
  const rTurnos = turnosDe(rc.organizationId);
  const rEsperado = esperadoDe(rc.organizationId);
  const rCobrado = debitosDe(rc.organizationId);
  const rAsientos = asientosDe(rc.organizationId);
  const rSaldo = saldoDe(rc.organizationId);
  console.log(`      ${nf(rTurnos)} respuestas · ${nf(rAsientos)} asientos · esperado ${nf(rEsperado)} · cobrado ${nf(rCobrado)}`);
  check(
    rCobrado === rEsperado,
    `la ráfaga no perdió ni un crédito: cobrado ${nf(rCobrado)} = esperado ${nf(rEsperado)}`,
    `→ se PERDIERON ${nf(rEsperado - rCobrado)} crédito(s) en la carrera (lost update del FOR UPDATE)`,
  );
  check(rAsientos === rTurnos, `un asiento por respuesta: ${nf(rAsientos)} = ${nf(rTurnos)}`);
  check(rSaldo === saldoAntes - rCobrado, `el saldo refleja la ráfaga completa: ${nf(rSaldo)} = ${nf(saldoAntes)} − ${nf(rCobrado)}`);

  // ─────── 4. El webhook duplicado ───────
  paso("4. Meta reentrega el mismo mensaje tres veces");
  const dc = await registrar("duplicado");
  await dejarOperando(dc.token);
  const wamid = `wamid.carga.dup.${Date.now()}`;
  const waDup = "56931234567";
  await Promise.all([
    entra(dc.slug, "¿atienden los domingos?", waDup, wamid),
    entra(dc.slug, "¿atienden los domingos?", waDup, wamid),
    entra(dc.slug, "¿atienden los domingos?", waDup, wamid),
  ]);
  await esperarCola([dc.organizationId]);
  const dTurnos = turnosDe(dc.organizationId);
  const dAsientos = asientosDe(dc.organizationId);
  const dCobrado = debitosDe(dc.organizationId);
  const dEsperado = esperadoDe(dc.organizationId);
  check(dTurnos === 1, `tres entregas del mismo mensaje = UNA respuesta del bot`, `→ ${nf(dTurnos)} respuestas`);
  check(dAsientos <= 1 && dCobrado === dEsperado, `y UN solo cobro: ${nf(dAsientos)} asiento(s), ${nf(dCobrado)} crédito(s)`);

  // ─────── 5. La gracia: nadie opera gratis para siempre ───────
  paso("5. Gracia: gastar el saldo y pasarse");
  const gc = await registrar("gracia");
  await dejarOperando(gc.token);
  const graciaLimite = 100;
  // Mensajes largos (varios bloques) para agotar 200 + 100 sin mandar 300 mensajes.
  let vueltas = 0;
  let bloqueado = false;
  while (vueltas < 40 && !bloqueado) {
    const lote = Array.from({ length: 4 }, (_, k) => {
      const waId = `5694${String(1_000_000 + vueltas * 4 + k)}`;
      return () => entra(gc.slug, largo, waId);
    });
    await enParalelo(lote, 4);
    await esperarCola([gc.organizationId], { quietoMs: 4_000, maxMs: 120_000 });
    vueltas++;
    const gracia = graciaDe(gc.organizationId);
    if (gracia >= graciaLimite) bloqueado = true;
    if (gracia > graciaLimite) break;
  }
  const gGracia = graciaDe(gc.organizationId);
  const gSaldo = saldoDe(gc.organizationId);
  const gCobrado = debitosDe(gc.organizationId);
  const gEsperado = esperadoDe(gc.organizationId);
  console.log(`      saldo ${nf(gSaldo)} · gracia usada ${nf(gGracia)}/${graciaLimite} · cobrado ${nf(gCobrado)} de ${nf(gEsperado)} esperados`);
  check(gGracia <= graciaLimite, `la gracia NO pasó del tope: ${nf(gGracia)} ≤ ${graciaLimite}`, `→ se operó gratis ${nf(gGracia - graciaLimite)} crédito(s) de más`);
  check(gSaldo >= -graciaLimite, `el saldo no cae más allá del colchón: ${nf(gSaldo)} ≥ −${graciaLimite}`);
  // Pasado el colchón, el turno NO se cobra (el gate ni llama al modelo): lo que no se puede
  // es cobrar MÁS de lo que manda la fórmula. Regalar algo acá es el comportamiento diseñado
  // (el bot no queda mudo), y el informe lo dice con el número exacto.
  check(gCobrado <= gEsperado, `nunca se cobró de más: ${nf(gCobrado)} ≤ ${nf(gEsperado)}`);
  if (gCobrado < gEsperado) {
    console.log(`      ⓘ ${nf(gEsperado - gCobrado)} crédito(s) de respuestas que ya estaban generadas y no se pudieron cobrar (colchón agotado: diseño).`);
  }

  // ─────── 6. El marcador que ve el cliente ───────
  paso("6. El marcador del panel contra la base, cuenta por cuenta");
  for (const [i, c] of [...cuentas, rc, dc, gc].entries()) {
    const w = await api("/billing/wallet/summary", { token: c.token });
    const base = saldoDe(c.organizationId);
    const ok = check(
      w.ok && w.json?.balance === base,
      `cuenta ${i + 1}: el panel dice ${nf(w.json?.balance)} y la base ${nf(base)}`,
      `→ HTTP ${w.status}`,
    );
    if (ok && i === 0) console.log(`      medidor: ${w.json?.medidor?.frase ?? "(sin medidor)"}`);
    if (w.json?.unit) check(w.json.unit === "credit", `cuenta ${i + 1}: la unidad del panel es "credit"`);
  }

  // ─────── 7. La auditoría del libro ───────
  paso("7. Auditoría del libro contra ai_requests (el script que va a correr en producción)");
  try {
    rmSync(INFORME, { force: true });
  } catch {
    /* no existía */
  }
  let auditoria = "";
  let auditoriaOk = true;
  try {
    auditoria = execFileSync(
      process.execPath,
      ["scripts/auditar-creditos.mjs"],
      {
        cwd: join(REPO, "packages", "database"),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://postgres:postgres@localhost:5433/conversia_sim",
          DIAS: "1",
          JSON_OUT: INFORME,
        },
      },
    );
  } catch (e) {
    auditoriaOk = false;
    auditoria = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  console.log(
    auditoria
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => `      ${l}`)
      .join("\n"),
  );
  check(auditoriaOk, "la auditoría del libro cierra sin un solo descuadre");
  try {
    const j = JSON.parse(readFileSync(INFORME, "utf-8"));
    check(j.total.regalados === 0, `la auditoría no encontró créditos regalados (${nf(j.total.regalados)})`);
    check(j.total.deMas === 0, `ni cobrados de más (${nf(j.total.deMas)})`);
    check(j.total.porVeredicto.doble_cobro === 0, `ni un solo doble cobro (${nf(j.total.porVeredicto.doble_cobro)})`);
    check(
      j.porOrg.every((o) => o.inv.libroCuadra && o.inv.ultimoAsientoCuadra && o.inv.graciaDentroDelLimite && o.inv.sinLotesNegativos),
      "el libro de todas las cuentas explica su saldo",
    );
    console.log(`      informe: ${INFORME}`);
  } catch (e) {
    check(false, "el informe JSON de la auditoría se pudo leer", `→ ${e.message}`);
  }

  console.log(`\n${fail === 0 ? "✔" : "✖"} ${pass} comprobaciones OK · ${fail} fallidas`);
  if (fail > 0) console.log(fallos.map((f) => `   ✖ ${f}`).join("\n"));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n✖ prueba abortada: ${e.message}`);
  process.exit(2);
});
