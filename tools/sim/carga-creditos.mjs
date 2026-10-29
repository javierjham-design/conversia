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
 *  5. EL WEBHOOK DE LA RECARGA QUE SE PIERDE. La pasarela cobra la tarjeta y la confirmación
 *     no llega: cargo hecho, cero créditos, cero factura, cero alerta, y el bot del cliente
 *     cortándose cuando se le acabe la gracia. Se ensaya con el Flow de juguete del stack
 *     (`tools/sim/mock-flow.mjs`), que NUNCA llama a la URL de confirmación.
 *
 * Y al final cierra el círculo: el **marcador que ve el cliente** (`/billing/wallet/summary`)
 * tiene que decir exactamente el mismo número que la base, y la auditoría del libro
 * (`packages/database/scripts/auditar-creditos.mjs`) tiene que cuadrar al crédito.
 *
 * Uso:  pnpm sim:up  &&  node tools/sim/carga-creditos.mjs
 * Env:  ORGS (8) · CONTACTOS (20) · MSGS (2, vueltas por contacto) · RAFAGA (20) ·
 *       MSGS_KILL (30) · SIM_API · SIM_DATABASE_URL
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.SIM_API || "http://localhost:4000";
const ORIGIN_CV = "http://localhost:3002";
const REPO = process.env.REPO_DIR || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSE = ["compose", "-f", "tools/sim/docker-compose.sim.yml"];
const DB_URL = process.env.SIM_DATABASE_URL || "postgresql://postgres:postgres@localhost:5433/conversia_sim";
const ORGS = Number(process.env.ORGS ?? 8);
const CONTACTOS = Number(process.env.CONTACTOS ?? 20);
const MSGS = Number(process.env.MSGS ?? 2);
const RAFAGA = Number(process.env.RAFAGA ?? 20);
const PASSWORD = process.env.ENSAYO_PASSWORD || `Carga-${Date.now()}-${Math.random().toString(36).slice(2, 10)}A1`;
const INFORME = join(REPO, "tools", "sim", "out", "carga-creditos.json");

/**
 * Cómo devolver la política de pesos a su lugar. La fija la fase 6 (que la pisa) y la llama
 * el `finally` de `main`: una prueba que aborta no puede dejar el stack mintiéndole a la
 * siguiente.
 */
let restaurarPolitica = null;

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

/**
 * Un script de packages/database contra la base del stack, desde el host — igual que el
 * ensayo y que producción. Dentro del contenedor se probaría la copia CONGELADA del repo
 * que lleva la imagen, no el código que se está arreglando.
 */
/** Un comando de compose contra el stack (matar/arrancar/reiniciar un servicio). */
function docker(args) {
  return execFileSync("docker", [...COMPOSE, ...args], { cwd: REPO, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
}

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
  // SE DISTINGUE "la API rechazó" de "la llamada nunca llegó". Un `fetch` que revienta en
  // Windows/Docker —el socket que se corta al reiniciar un contenedor— no es la API
  // rechazando un mensaje, y contarlo igual hacía fallar la prueba por el host. Devuelve 0
  // para que el contador lo sume aparte: lo que no se puede confundir es un 4xx/5xx NUESTRO,
  // que sí es un mensaje perdido por nuestra culpa.
  try {
    const r = await fetch(`${API}/webhooks/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-conversia-mock-token": "dev-mock-inbound-token" },
      body: JSON.stringify(body),
    });
    return r.status;
  } catch {
    return 0;
  }
}

/** Turnos (`ai_requests`) de la org. Es el HECHO contra el que se audita el cobro. */
const turnosDe = (orgId) => sqlNum(`SELECT count(*) FROM ai_requests WHERE organization_id='${orgId}' AND purpose='CHAT';`);
/** Respuestas que de verdad salieron al cliente. Dos por un mismo mensaje = trabajo (y cobro) repetido. */
const respuestasDe = (orgId) =>
  sqlNum(`SELECT count(*) FROM messages WHERE organization_id='${orgId}' AND direction='OUTBOUND' AND author_type='AGENT';`);
/** Turnos con MÁS DE UN asiento: el detector directo del doble cobro. */
const turnosCobradosDosVeces = (orgId) =>
  sqlNum(
    `SELECT count(*) FROM (SELECT ref_id FROM conversation_credit_ledger WHERE organization_id='${orgId}'` +
      ` AND reason='ai_credit_debit' GROUP BY ref_id HAVING count(*) > 1) t;`,
  );
const excepcionesDe = (orgId, tipo) =>
  sqlNum(`SELECT count(*) FROM platform_exceptions WHERE organization_id='${orgId}' AND type='${tipo}';`);
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

/**
 * Cifra un secreto como lo guarda la plataforma (AES-256-GCM, misma forma que
 * `apps/api/src/common/crypto.ts`): base64(iv[12] || tag[16] || ciphertext). La clave es la
 * del stack, que está en `.env.sim` y es de PRUEBA.
 *
 * Se replica acá en vez de importar la del api porque el api es TypeScript compilado dentro
 * de su imagen; esto corre en el host con node pelado.
 */
function cifrar(plano) {
  const env = readFileSync(join(REPO, "tools", "sim", ".env.sim"), "utf-8");
  const clave = /^CREDENTIALS_ENCRYPTION_KEY=(.+)$/m.exec(env)?.[1]?.trim();
  if (!clave) throw new Error("falta CREDENTIALS_ENCRYPTION_KEY en tools/sim/.env.sim");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(clave, "hex"), iv);
  const enc = Buffer.concat([cipher.update(plano, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

/** Token del Flow de juguete: lleva el pago dentro (ver tools/sim/mock-flow.mjs). */
const tokenMockFlow = (pago) => `simtok.${Buffer.from(JSON.stringify(pago), "utf8").toString("base64url")}`;

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

/**
 * ¿El stack está corriendo el código del working copy?
 *
 * Trampa que ya costó una corrida entera: el servicio `api` del compose no tiene sección
 * `build` (su imagen la construye `db-init`), así que `docker compose build api` no
 * construye nada y NO AVISA. Se queda con la imagen vieja y la prueba "verifica" los
 * arreglos contra el código anterior, en verde. Se comprueba con un canario: un símbolo que
 * solo existe en el código nuevo.
 */
function verificarStackAlDia() {
  // Los símbolos son los del cambio MÁS RECIENTE de cada servicio: un canario viejo pasa
  // con una imagen a medio actualizar. Al tocar el cobro, mover también estos.
  const canarios = [
    ["api", "packages/database/scripts/seed-ai-credits-policy.mjs", "FORZAR"],
    ["api", "apps/api/dist/billing/billing.controller.js", "conSello"],
    ["api", "apps/api/dist/billing/cobro-en-vuelo.js", "pg_advisory_xact_lock"],
    ["worker", "apps/worker/dist/ai-credits-reconcile.js", "cobrarTurnosSinCobrar"],
    ["worker", "apps/worker/dist/auto-recharge.js", "sin_respuesta"],
    ["worker", "apps/worker/dist/recharge-reconcile.js", "reconciliarRecargas"],
  ];
  for (const [servicio, archivo, simbolo] of canarios) {
    let hay = "0";
    try {
      hay = execFileSync("docker", [...COMPOSE, "exec", "-T", servicio, "sh", "-c", `grep -c '${simbolo}' ${archivo} 2>/dev/null || echo 0`], {
        cwd: REPO,
        encoding: "utf8",
      }).trim();
    } catch {
      hay = "0";
    }
    if (Number(hay) < 1) {
      console.error(
        `\n✖ El contenedor "${servicio}" está corriendo código VIEJO (no encuentro "${simbolo}" en ${archivo}).\n` +
          `  Reconstruilo antes de probar, o la prueba te va a dar verde sobre el código anterior:\n` +
          `    docker compose -f tools/sim/docker-compose.sim.yml build db-init worker\n` +
          `    docker compose -f tools/sim/docker-compose.sim.yml up -d --force-recreate api worker\n`,
      );
      process.exit(3);
    }
  }
  console.log("   ✔ el stack corre el código del working copy (canarios api y worker)");
  verificarPoliticaLimpia();
}

/**
 * LA POLÍTICA DE PESOS TIENE QUE ESTAR COMO LA DEJÓ EL SEEDER.
 *
 * La fase 6 PISA el peso de `gpt-4o-mini` (lo sube a 70 para que un turno no quepa en el
 * colchón) y lo restaura al terminar. Si la prueba ABORTA entremedio —pasó: un corte de
 * socket del host al reiniciar el worker—, el peso roto queda en la base y la corrida
 * siguiente cobra 70 créditos por respuesta. El informe sale en ROJO por todos lados y
 * apuntando al lugar equivocado: "2.400 créditos cobrados = 46 esperados" parece una fuga
 * gravísima del contador cuando lo único que pasó es que la prueba anterior se cayó.
 *
 * Media hora de diagnóstico por un estado sucio. Mejor no empezar.
 */
function verificarPoliticaLimpia() {
  const peso = sqlNum(`SELECT (value::json->'models'->'gpt-4o-mini'->>'credits')::numeric FROM platform_settings WHERE key='aiCredits';`);
  if (peso === 1) {
    console.log("   ✔ la política de pesos está limpia (gpt-4o-mini = 1)");
    return;
  }
  console.error(
    [
      "",
      `✖ La política de créditos del stack está SUCIA: gpt-4o-mini pesa ${peso} y tiene que pesar 1.`,
      "  Lo normal es que una corrida anterior abortara en la fase 6 (que lo pisa a propósito) y no",
      "  alcanzara a restaurarlo. Si se corre así, TODO el informe sale en rojo apuntando al lugar",
      '  equivocado ("2.400 créditos cobrados = 46 esperados" parece una fuga gravísima del contador',
      "  cuando lo único que pasó es que la prueba anterior se cayó). Restauralo y volvé a intentar:",
      "    cd packages/database && FORZAR=1 DATABASE_URL=postgresql://postgres:postgres@localhost:5433/conversia_sim node scripts/seed-ai-credits-policy.mjs",
      "",
    ].join("\n"),
  );
  process.exit(4);
}

async function main() {
  console.log("══ PRUEBA DE CARGA DEL CONTADOR DE CRÉDITOS ══");
  verificarStackAlDia();
  console.log(`   ${ORGS} cuentas · ${CONTACTOS} contactos × ${MSGS} mensajes · ráfaga de ${RAFAGA} simultáneos\n`);

  // ─────── 0. Créditos encendidos (idempotente) ───────
  paso("0. Encender Créditos IA en el stack (idempotente)");
  correrScript("seed-conversia-catalog.mjs");
  await esperarApi();
  const on = correrScript("creditos-golive.mjs");
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
  paso(`2. Carga: ${ORGS} cuentas × ${CONTACTOS} contactos × ${MSGS} vuelta(s) = ${ORGS * CONTACTOS * MSGS} mensajes`);
  const largo = "necesito saber todo sobre sus servicios y precios, cuéntame con mucho detalle. ".repeat(1_100); // ~85k chars → >1 bloque
  const contactos = cuentas.map((c) =>
    Array.from({ length: CONTACTOS }, (_, k) => `5691${String(1_000_000 + Math.floor(Math.random() * 8_999_999))}${k % 10}`.slice(0, 12)),
  );
  // POR VUELTAS, no todo de una: el bot agrupa las ráfagas de un mismo contacto en un solo
  // turno (debounce), así que tres mensajes seguidos del mismo número son UNA respuesta.
  // Mandarlos todos juntos "medía" 144 mensajes y generaba 48 turnos. Por vueltas, cada
  // vuelta es un turno más por contacto y además la conversación crece: el historial suma
  // tokens y el ajuste por largo entra en juego solo.
  const tCarga = Date.now();
  let aceptadosTotal = 0;
  let enviadosTotal = 0;
  // Llamadas que nunca llegaron a la API (socket del host) vs. rechazadas por la API. Son
  // dos cosas distintas y solo la segunda es un defecto del producto.
  let sinLlegarTotal = 0;
  let rechazadosTotal = 0;
  for (let m = 0; m < MSGS; m++) {
    const tareas = [];
    for (const [i, c] of cuentas.entries()) {
      for (const [k, waId] of contactos[i].entries()) {
        // Uno de cada ocho mensajes es LARGO: tiene que cobrar más de un bloque.
        const texto = (k + m) % 8 === 3 ? largo : `hola, consulta ${m + 1} del contacto ${k + 1}`;
        tareas.push(() => entra(c.slug, texto, waId));
      }
    }
    const envios = await enParalelo(tareas, 24);
    enviadosTotal += tareas.length;
    aceptadosTotal += envios.filter((s) => s === 200 || s === 201).length;
    // Llamadas que nunca llegaron (socket cortado del host) vs. rechazadas por la API.
    sinLlegarTotal += envios.filter((s) => s === 0).length;
    rechazadosTotal += envios.filter((s) => s !== 0 && s !== 200 && s !== 201).length;
    await esperarCola(cuentas.map((c) => c.organizationId), { quietoMs: 6_000 });
  }
  // La API no puede RECHAZAR ni uno: eso sería un mensaje perdido por nuestra culpa. Las
  // llamadas que nunca llegaron se informan aparte y no fallan la prueba: es el host, no el
  // producto, y confundirlos deja la prueba roja por el motivo equivocado.
  check(rechazadosTotal === 0, `el webhook no rechazó ningún mensaje (de ${enviadosTotal})`, `→ ${rechazadosTotal} rechazado(s)`);
  if (sinLlegarTotal > 0) {
    console.log(
      `      ℹ ${sinLlegarTotal} llamada(s) de ${enviadosTotal} no llegaron a la API (socket del host, no la API rechazando). ` +
        "Se descuentan de lo esperado; si fueran muchas, el stack está ahogado.",
    );
  }
  check(
    aceptadosTotal + sinLlegarTotal === enviadosTotal,
    `todas las llamadas que llegaron fueron aceptadas (${aceptadosTotal} de ${enviadosTotal - sinLlegarTotal})`,
  );
  const turnos = cuentas.reduce((a, c) => a + turnosDe(c.organizationId), 0);
  const seg = (Date.now() - tCarga) / 1000;
  console.log(`      ${nf(turnos)} respuestas del bot en ${seg.toFixed(0)}s (${(turnos / seg).toFixed(1)}/s)`);
  check(turnos >= enviadosTotal * 0.9, `se respondió al menos el 90% de los mensajes: ${nf(turnos)}/${nf(enviadosTotal)}`);

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

  // ─────── 5. Matar el worker con trabajo en vuelo ───────
  paso("5. Matar el worker a mitad del trabajo: el reintento NO puede cobrar dos veces");
  const kc = await registrar("reintento");
  await dejarOperando(kc.token);
  const MENSAJES_KILL = Number(process.env.MSGS_KILL ?? 30);
  await Promise.all(
    Array.from({ length: MENSAJES_KILL }, (_, k) => entra(kc.slug, `consulta urgente ${k}`, `5695${String(1_000_000 + k)}`)),
  );
  // Matar cuando YA hay cobros escritos: así el kill cae con débitos hechos y cola
  // pendiente, que es el estado donde un reintento cobraría dos veces.
  const hastaDebito = Date.now() + 60_000;
  while (asientosDe(kc.organizationId) < 2 && Date.now() < hastaDebito) await dormir(500);
  console.log(`      matando el worker con ${nf(asientosDe(kc.organizationId))} cobro(s) ya escritos y cola pendiente`);
  docker(["kill", "worker"]);
  docker(["start", "worker"]);
  // El lock de la cola de IA dura 120 s: el job huérfano se reencola como "stalled" y se
  // reintenta (attempts: 2). Por eso la espera es larga — sin ella no se prueba el reintento.
  await esperarCola([kc.organizationId], { quietoMs: 20_000, maxMs: 420_000 });
  const kTurnos = turnosDe(kc.organizationId);
  const kRespuestas = respuestasDe(kc.organizationId);
  const kDobles = turnosCobradosDosVeces(kc.organizationId);
  const kCobrado = debitosDe(kc.organizationId);
  const kEsperado = esperadoDe(kc.organizationId);
  console.log(
    `      ${nf(kTurnos)} turnos · ${nf(kRespuestas)} respuestas enviadas de ${MENSAJES_KILL} mensajes · cobrado ${nf(kCobrado)}/${nf(kEsperado)}`,
  );
  check(kDobles === 0, "ningún turno quedó con dos asientos tras el reintento", `→ ${nf(kDobles)} turno(s) cobrados dos veces`);
  // Matar el worker DEJA cargos sin cobrar: el cobro no frena la respuesta, así que el
  // turno que estaba en vuelo sale gratis. Medido: 29 de 30. Eso no se arregla "con
  // cuidado", se arregla con una red — el pase de reconciliación— y lo que hay que exigir
  // es que la red FUNCIONE, no que el hueco no exista.
  if (kCobrado < kEsperado) {
    console.log(`      ⓘ el kill dejó ${nf(kEsperado - kCobrado)} crédito(s) sin cobrar; esperando al pase de reconciliación…`);
  }
  const limiteRec = Date.now() + 180_000;
  let recuperado = debitosDe(kc.organizationId);
  while (recuperado < kEsperado && Date.now() < limiteRec) {
    await dormir(5_000);
    recuperado = debitosDe(kc.organizationId);
  }
  check(
    recuperado === kEsperado,
    `la reconciliación recuperó TODOS los cargos: ${nf(recuperado)} = ${nf(kEsperado)}`,
    `→ quedaron ${nf(kEsperado - recuperado)} crédito(s) sin cobrar después de ${Math.round((Date.now() - (limiteRec - 180_000)) / 1000)}s`,
  );
  check(
    turnosCobradosDosVeces(kc.organizationId) === 0,
    "y no cobró dos veces lo que el cobro en vivo ya había cobrado (sello del turno)",
  );
  // Lo que de verdad duele, y que el sello de idempotencia NO cubre: el sello es el id del
  // turno y cada intento crea un turno nuevo, así que si el reintento vuelve a generar la
  // respuesta, el cliente paga dos veces el mismo mensaje y encima recibe dos respuestas.
  // Eso lo tiene que frenar el guardián de arriba del turno, no el cobrador.
  check(
    kTurnos <= MENSAJES_KILL && kRespuestas <= MENSAJES_KILL,
    `ni un mensaje se respondió dos veces: ${nf(kTurnos)} turnos y ${nf(kRespuestas)} respuestas para ${MENSAJES_KILL} mensajes`,
    `→ el reintento DUPLICÓ trabajo: el cliente paga dos veces el mismo mensaje`,
  );
  if (kTurnos < MENSAJES_KILL) {
    console.log(`      ⓘ ${MENSAJES_KILL - kTurnos} mensaje(s) quedaron sin respuesta por el kill (pérdida de servicio, no de plata).`);
  }

  // ─────── 6. Modelo sin peso + la gracia exactamente en el tope ───────
  paso("6. El turno que no cabe en el colchón: se cobra parcial, la gracia topea y el gate corta");
  const gc = await registrar("gracia");
  await dejarOperando(gc.token);
  const graciaLimite = 100;
  const politicaOriginal = sql(`SELECT value FROM platform_settings WHERE key='aiCredits';`);
  // Se registra para restaurarla PASE LO QUE PASE (ver el `finally` de main): si la prueba
  // aborta entre el `jsonb_set` de abajo y la restauración, el peso roto queda en la base y
  // la corrida siguiente mide cualquier cosa.
  restaurarPolitica = () => sql(`UPDATE platform_settings SET value = '${politicaOriginal}' WHERE key='aiCredits';`);
  // Se le sube el PESO a gpt-4o-mini —el modelo con que responde todo bot— a 70 por bloque.
  //
  // Por qué 70 y no 50: tiene que NO dividir el saldo. Con 200 créditos de prueba y 100 de
  // colchón, un peso que divide (50) hace que la gracia aterrice siempre exacta en el tope
  // y el caso interesante no aparece nunca. Con 70: dos respuestas (140), la tercera toma
  // los 60 que quedan más 10 de gracia, la cuarta llega a 80, y la QUINTA pide 70 teniendo
  // solo 20 de colchón. Ese es el turno que antes no se cobraba —y la respuesta salía
  // igual, dejando el estado idéntico para el turno siguiente: respuestas gratis para
  // siempre—. Ahora cobra los 20 y la gracia aterriza en el tope, así el gate corta.
  //
  // Se sube el peso en vez de borrar el modelo de la política a propósito: `parseCreditPolicy`
  // FUSIONA la fila con la semilla del repo (tolerante por diseño: una fila mal editada no
  // puede dejar el cobro en 0), así que borrar un modelo no lo deja sin peso. La primera
  // versión de esta prueba lo intentaba así y "pasaba" cobrando peso 1.
  sql(`UPDATE platform_settings SET value = jsonb_set(value::jsonb, '{models,gpt-4o-mini,credits}', '70')::text WHERE key='aiCredits';`);
  docker(["restart", "worker"]); // la política se cachea 60 s dentro del proceso
  await esperarApi();
  let gTurnos = 0;
  for (let k = 0; k < 12 && graciaDe(gc.organizationId) < graciaLimite; k++) {
    await entra(gc.slug, `consulta ${k} con el modelo caro`, `5696${String(1_000_000 + k)}`);
    await esperarCola([gc.organizationId], { quietoMs: 5_000, maxMs: 120_000 });
    gTurnos = turnosDe(gc.organizationId);
  }
  const gGracia = graciaDe(gc.organizationId);
  const gSaldo = saldoDe(gc.organizationId);
  const gCobrado = debitosDe(gc.organizationId);
  const gPedido = esperadoDe(gc.organizationId, 70);
  const gTopeados = sqlNum(
    `SELECT count(*) FROM usage_events WHERE organization_id='${gc.organizationId}' AND type='ai_credits' AND meta->>'alTope'='true';`,
  );
  console.log(
    `      ${nf(gTurnos)} respuestas · pedido ${nf(gPedido)} · cobrado ${nf(gCobrado)} · saldo ${nf(gSaldo)} · gracia ${nf(gGracia)}/${graciaLimite}`,
  );
  // 200 de saldo + 100 de colchón = 300, ni un crédito más ni uno menos. Es la cuenta que
  // demuestra que no se regaló nada por el camino: lo pedido fue más (peso 70 × turnos) y
  // lo cobrado es exactamente todo lo que se podía cobrar.
  check(
    gCobrado === 300,
    `se cobró TODO lo cobrable: ${nf(gCobrado)} = 200 de saldo + ${graciaLimite} de colchón`,
    `→ se cobró ${nf(gCobrado)} de ${nf(gPedido)} pedidos`,
  );
  check(
    gTopeados >= 1,
    `el turno que no cabía se cobró PARCIAL y quedó marcado (${gTopeados} turno(s) al tope)`,
    "→ sin esa marca, la auditoría leería un cobro parcial como un cobro mal hecho",
  );
  check(
    excepcionesDe(gc.organizationId, "saldo_gracia_sin_recarga") >= 1,
    "y queda la excepción para el super admin antes de que el bot se corte",
  );
  check(gGracia === graciaLimite, `la gracia se detuvo EXACTAMENTE en el tope: ${nf(gGracia)} = ${graciaLimite}`, `→ ${nf(gGracia)}`);
  check(gSaldo === -graciaLimite, `el saldo quedó en −${graciaLimite}, no más abajo: ${nf(gSaldo)}`);
  // Agotado el colchón: el bot NO queda mudo, pero tampoco se cobra lo que no se puede cobrar.
  // Y acá se prueba la otra mitad: que con el colchón en el tope el gate CORTE. Si no
  // cortara, cada turno siguiente sería una respuesta gratis más, que es el agujero entero.
  const antesDelMudo = { asientos: asientosDe(gc.organizationId), respuestas: respuestasDe(gc.organizationId) };
  await entra(gc.slug, "¿me atienden sin saldo?", "56969999999");
  await esperarCola([gc.organizationId], { quietoMs: 5_000, maxMs: 90_000 });
  check(
    respuestasDe(gc.organizationId) > antesDelMudo.respuestas,
    "sin saldo ni gracia el cliente IGUAL recibe respuesta (el bot no queda mudo)",
  );
  check(
    asientosDe(gc.organizationId) === antesDelMudo.asientos && graciaDe(gc.organizationId) === graciaLimite,
    `y no se cobró nada de más: la gracia sigue en ${graciaLimite}`,
  );
  // La recarga PAGA la gracia primero: si no, el cliente compraría 420 y vería 320 sin
  // explicación, o peor, 420 con la deuda perdonada en silencio.
  await api("/billing/buy-package", { method: "POST", token: gc.token, body: { code: "conversia-cred-420" } });
  const compra = await api("/billing/mock-confirm", { method: "POST", token: gc.token, body: { planCode: "pkg:conversia-cred-420" } });
  check(compra.ok, `la recarga de 420 se confirma (HTTP ${compra.status})`);
  const gSaldoFinal = saldoDe(gc.organizationId);
  check(
    gSaldoFinal === 420 - graciaLimite && graciaDe(gc.organizationId) === 0,
    `la recarga pagó la gracia primero: saldo ${nf(gSaldoFinal)} = 420 − ${graciaLimite} y gracia en 0`,
    `→ saldo ${nf(gSaldoFinal)} · gracia ${nf(graciaDe(gc.organizationId))}`,
  );
  // Devolver la política como estaba ANTES de auditar: la auditoría recalcula con ella.
  sql(`UPDATE platform_settings SET value = '${politicaOriginal}' WHERE key='aiCredits';`);
  docker(["restart", "worker"]);
  await esperarApi();
  check(
    sql(`SELECT value FROM platform_settings WHERE key='aiCredits';`) === politicaOriginal,
    "la política quedó restaurada tal como estaba",
  );

  // ─────── 7. La recarga cobrada cuyo webhook se perdió ───────
  //
  // El peor modo de falla del producto: Flow cobra la tarjeta, llama a nuestra URL de
  // confirmación y ese POST no llega. El cargo queda hecho, el cliente sin créditos, sin
  // factura y sin una sola alerta — y su bot se corta cuando se le acaba la gracia. El motor
  // de suscripciones no lo recupera porque excluye a propósito los cobros `rec-` (si los
  // viera, al confirmarse una recarga le renovaría el mes GRATIS al cliente).
  //
  // Se ensaya con el Flow de juguete del stack, que NUNCA llama a `urlConfirmation`: el pago
  // existe, está pagado, y la única forma de que el cliente reciba lo suyo es que la
  // reconciliación del worker lo note. Se fabrica el estado que deja el webhook perdido —un
  // intento `rec-` pendiente con su token— y se exige que el crédito llegue.
  paso("7. La recarga cobrada cuyo webhook SE PERDIÓ: el cliente no puede quedarse sin créditos");
  const saldoAntesRecarga = saldoDe(gc.organizationId);
  const subId = sql(`SELECT id FROM subscriptions WHERE organization_id='${gc.organizationId}' ORDER BY created_at DESC LIMIT 1;`);
  const ordenPerdida = `rec-${gc.organizationId}-${Date.now()}`;
  const tokenPerdido = tokenMockFlow({
    commerceOrder: ordenPerdida,
    amount: 24_990,
    optional: JSON.stringify({
      organizationId: gc.organizationId,
      planCode: "pkg:conversia-cred-420",
      expectedAmount: "24990",
      autoRecharge: "1",
    }),
    status: 2,
  });
  check(Boolean(subId), `la cuenta tiene suscripción para colgar el cobro (${subId.slice(0, 8)}…)`);
  // Credenciales de la pasarela de juguete. Se escriben acá y se borran al final del paso:
  // mientras existan, `mock-confirm` queda bloqueado ("hay pasarela real configurada"), que
  // es justo la guarda que no se quiere desarmar.
  sql(
    `INSERT INTO platform_settings (key, value, updated_at) VALUES ` +
      `('flow.apiKey', '${cifrar("sim-flow-api-key")}', now()), ` +
      `('flow.secretKey', '${cifrar("sim-flow-secret-key")}', now()), ` +
      `('flow.baseUrl', 'http://mock-flow:4021/api', now()) ` +
      `ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();`,
  );
  // El intento que dejó el webhook perdido: cobrado, con token, y nadie que lo cierre. Diez
  // minutos de antigüedad para que haya pasado la gracia que la reconciliación le da al
  // webhook (5 min) y no se ensaye un caso que en producción se resuelve solo.
  sql(
    `INSERT INTO payment_attempts (id, organization_id, subscription_id, commerce_order, amount, currency, kind, attempt_number, status, provider, provider_ref, created_at, updated_at)` +
      ` VALUES ('${ordenPerdida}', '${gc.organizationId}', '${subId}', '${ordenPerdida}', 24990, 'CLP', 'auto', 1, 'pending', 'flow', '${tokenPerdido}', now() - interval '10 minutes', now());`,
  );
  const estadoDelCobro = () => sql(`SELECT status FROM payment_attempts WHERE commerce_order='${ordenPerdida}';`);
  const asientosDeLaRecarga = () =>
    sqlNum(
      `SELECT count(*) FROM conversation_credit_ledger WHERE organization_id='${gc.organizationId}'` +
        ` AND reason='package_purchase' AND ref_id='${tokenPerdido}';`,
    );
  check(estadoDelCobro() === "pending", "el cobro arranca pendiente (lo que deja un webhook perdido)");
  const limiteWebhook = Date.now() + 150_000;
  while (Date.now() < limiteWebhook && estadoDelCobro() === "pending") await dormir(3000);
  const estadoFinal = estadoDelCobro();
  check(estadoFinal === "succeeded", `la reconciliación cerró el cobro como cobrado (quedó "${estadoFinal}")`);
  const asientosRec = asientosDeLaRecarga();
  check(asientosRec === 1, `y acreditó el pack UNA vez (asientos: ${nf(asientosRec)})`);
  const saldoTrasRecarga = saldoDe(gc.organizationId);
  check(
    saldoTrasRecarga === saldoAntesRecarga + 420,
    `el cliente recibió sus 420 créditos: ${nf(saldoAntesRecarga)} → ${nf(saldoTrasRecarga)}`,
  );
  check(
    sqlNum(`SELECT count(*) FROM invoices WHERE organization_id='${gc.organizationId}' AND provider_ref='${tokenPerdido}';`) === 1,
    "y su boleta, con la referencia del pago",
  );
  // El pase corre cada 20 s en el stack: se le deja dar otra vuelta COMPLETA y se exige que
  // no haya acreditado de nuevo. Un reconciliador que cobra bien una vez y acredita dos es
  // peor que no tenerlo.
  await dormir(45_000);
  check(asientosDeLaRecarga() === 1, "tras otra vuelta del pase, sigue acreditado una sola vez (no hay doble crédito)");
  check(saldoDe(gc.organizationId) === saldoTrasRecarga, "y el saldo no se movió solo");
  sql(`DELETE FROM platform_settings WHERE key IN ('flow.apiKey','flow.secretKey','flow.baseUrl');`);
  check(
    sqlNum(`SELECT count(*) FROM platform_settings WHERE key LIKE 'flow.%';`) === 0,
    "las credenciales de la pasarela de juguete quedaron borradas",
  );

  // ─────── 8. El marcador que ve el cliente ───────
  paso("8. El marcador del panel contra la base, cuenta por cuenta");
  for (const [i, c] of [...cuentas, rc, dc, kc, gc].entries()) {
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

  // ─────── 9. La auditoría del libro ───────
  paso("9. Auditoría del libro contra ai_requests (el script que va a correr en producción)");
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
          DATABASE_URL: DB_URL,
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
  // El auditor cierra en ERROR si encuentra un descuadre en CUALQUIER cuenta del stack, que
  // es lo correcto para producción. Acá se informa y no se falla: el veredicto de esta
  // corrida se mide sobre SUS cuentas unas líneas más abajo, y la base del sim arrastra
  // cuentas de pruebas anteriores (una que abortó a medias deja turnos que nunca se van a
  // poder cobrar). Lo que sí se exige es que el auditor haya CORRIDO y dejado su informe.
  if (!auditoriaOk) {
    console.log("      ℹ el auditor cerró en error: hay descuadre en alguna cuenta del stack (abajo se dice si es de esta corrida).");
  }
  try {
    const j = JSON.parse(readFileSync(INFORME, "utf-8"));
    // Que la auditoría haya MIRADO lo que tenía que mirar. Sin esto, un recorte de fechas
    // mal puesto la deja auditando cero y el informe sale verde: pasó en la primera corrida
    // de esta prueba ("respuestas auditadas: 0 · saldo 196") y es el peor fallo posible en
    // un auditor, porque no se distingue de que todo esté bien.
    const mias = [...cuentas, rc, dc, kc, gc];
    const ciegas = mias.filter((c) => {
      const fila = j.porOrg.find((o) => o.id === c.organizationId);
      return !fila || fila.turnos !== turnosDe(c.organizationId);
    });
    check(
      ciegas.length === 0,
      `la auditoría miró TODAS las respuestas de las ${mias.length} cuentas de esta prueba`,
      `→ ${ciegas.length} cuenta(s) auditadas de menos`,
    );

    // EL VEREDICTO SE JUZGA SOBRE LAS CUENTAS DE ESTA CORRIDA, no sobre toda la base.
    //
    // La auditoría mira el stack COMPLETO, que es lo correcto —así se prueba el script que
    // va a correr en producción— pero la base del sim acumula cuentas de pruebas anteriores,
    // y una corrida que abortó a medias deja turnos que nunca se van a poder cobrar (sin
    // saldo, con la política pisada). Juzgando el total, cualquier residuo deja esta prueba
    // en ROJO PARA SIEMPRE y apuntando a un problema que no existe — y una prueba que
    // siempre está roja es una prueba que se aprende a ignorar.
    const idsMios = new Set(mias.map((c) => c.organizationId));
    const filasMias = j.porOrg.filter((o) => idsMios.has(o.id));
    const mioRegalados = filasMias.reduce((a, o) => a + (o.resumen?.regalados ?? 0), 0);
    const mioDeMas = filasMias.reduce((a, o) => a + (o.resumen?.deMas ?? 0), 0);
    const mioDoble = filasMias.reduce((a, o) => a + (o.resumen?.porVeredicto?.doble_cobro ?? 0), 0);
    check(mioRegalados === 0, `ningún crédito regalado en las cuentas de esta corrida (${nf(mioRegalados)})`);
    check(mioDeMas === 0, `ni cobrados de más (${nf(mioDeMas)})`);
    check(mioDoble === 0, `ni un solo doble cobro (${nf(mioDoble)})`);
    check(
      filasMias.every((o) => o.inv.libroCuadra && o.inv.ultimoAsientoCuadra && o.inv.graciaDentroDelLimite && o.inv.sinLotesNegativos),
      "el libro de todas las cuentas de esta corrida explica su saldo",
    );
    // Lo del RESTO de la base se informa, no se falla: es residuo de pruebas viejas y tiene
    // que verse (puede estar tapando algo), pero no es lo que esta corrida midió.
    const ajenoRegalados = j.total.regalados - mioRegalados;
    const ajenoDeMas = j.total.deMas - mioDeMas;
    if (ajenoRegalados > 0 || ajenoDeMas > 0) {
      const sospechosas = j.porOrg
        .filter((o) => !idsMios.has(o.id) && ((o.resumen?.regalados ?? 0) > 0 || (o.resumen?.deMas ?? 0) > 0))
        .map((o) => `${o.slug ?? o.id} (${nf(o.resumen?.regalados ?? 0)} regalados)`);
      console.log(
        `      ℹ en el RESTO de la base (cuentas de pruebas anteriores) hay ${nf(ajenoRegalados)} crédito(s) ` +
          `regalados y ${nf(ajenoDeMas)} cobrados de más: ${sospechosas.slice(0, 5).join(", ")}` +
          `${sospechosas.length > 5 ? ` y ${sospechosas.length - 5} más` : ""}.
` +
          "        No falla esta corrida (no es lo que midió), pero si no venía de una prueba abortada, mirarlo.",
      );
    }
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
  // LA POLÍTICA SE RESTAURA AUNQUE LA PRUEBA REVIENTE. Si no, el peso que la fase 6 pisa a
  // propósito queda en la base y la corrida siguiente cobra 70 créditos por respuesta: el
  // informe sale en rojo por todos lados y apuntando al lugar equivocado. El canario del
  // arranque es la segunda red, para cuando ni esto alcance (un kill -9, por ejemplo).
  if (restaurarPolitica) {
    try {
      restaurarPolitica();
      console.error("  (la política de pesos quedó restaurada)");
    } catch (err) {
      console.error(
        `  ✖ Y NO SE PUDO RESTAURAR LA POLÍTICA (${err.message}). Corré esto antes de volver a probar:\n` +
          "    cd packages/database && FORZAR=1 DATABASE_URL=postgresql://postgres:postgres@localhost:5433/conversia_sim node scripts/seed-ai-credits-policy.mjs",
      );
    }
  }
  process.exit(2);
});
