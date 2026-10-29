#!/usr/bin/env node
/**
 * AUDITORÍA DEL CONTADOR DE CRÉDITOS IA. **Solo lee** — ni un UPDATE, ni un INSERT.
 *
 * Responde la pregunta de la que depende la rentabilidad: *¿cada respuesta que dio el bot
 * quedó cobrada, una sola vez y por el monto exacto?* No es lo mismo que probar la fórmula
 * (eso ya lo hacen los tests): es una propiedad de los DATOS, y se rompe por donde la
 * fórmula no mira —un reintento que cobra dos veces, una carrera que pierde un débito, un
 * turno que respondió gratis porque el cobro falló y el `catch` lo dejó pasar (en
 * `agent-turn.ts` el cobro nunca frena la respuesta, a propósito)—.
 *
 * Compara DOS fuentes escritas por caminos distintos:
 *   · `ai_requests`                → el HECHO: el bot respondió, con este modelo y estos tokens.
 *   · `conversation_credit_ledger` → el COBRO: el asiento sellado con el id del turno.
 * La aritmética es la de `@conversia/agents` (`credit-audit.ts`), la MISMA que cobra, y
 * tiene sus propios tests. Acá va solo la lectura.
 *
 * Además verifica, por cliente, las cuatro cosas que tienen que ser verdad siempre:
 * el libro explica el saldo, el último asiento dice el saldo de hoy, la gracia no pasó del
 * tope y ningún lote quedó en negativo. Y cierra con el costo REAL de un crédito contra el
 * que supone el catálogo, que es de donde sale el margen.
 *
 *   # sim (stack Docker, desde el repo):
 *   cd packages/database && DATABASE_URL="postgresql://postgres:postgres@localhost:5433/conversia_sim" \
 *     node scripts/auditar-creditos.mjs
 *
 *   # producción (solo lectura):
 *   railway run -s Postgres -- bash -c 'cd packages/database && \
 *     DATABASE_URL="$DATABASE_PUBLIC_URL" DIAS=30 node scripts/auditar-creditos.mjs'
 *
 * Env: DIAS (7) · ORG (un solo organization_id) · COMO_SI=<id|slug,…> con DESDE/HASTA
 *      (simula la fórmula sobre el consumo REAL de esa cuenta, para medir el costo por
 *      crédito con plata de verdad) · CLP_POR_USD (950) · DETALLE=1 (lista
 * turno por turno los que no cuadran) · EXIGIR_COSTO=1 (falla si los proveedores no
 * reportaron costo, para que el margen no se dé por bueno sin datos) · JSON_OUT=archivo.
 *
 * Sale con 1 si algo no cuadra, para poder colgarlo de un chequeo automático.
 */
import { PrismaClient } from "@prisma/client";
import {
  CLP_PER_USD_REF,
  CREDIT_POLICY_SEED,
  auditarTurno,
  creditsForTurn,
  costoPorCreditoClp,
  margenSobreCostoPct,
  parseCreditPolicy,
  resumirAuditoria,
  verificarMonedero,
} from "@conversia/agents";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const prisma = new PrismaClient();
const here = dirname(fileURLToPath(import.meta.url));
const DIAS = Number(process.env.DIAS ?? 7);
const ORG = process.env.ORG?.trim() || null;
const CLP_POR_USD = Number(process.env.CLP_POR_USD ?? CLP_PER_USD_REF);
const DETALLE = process.env.DETALLE === "1";
const JSON_OUT = process.env.JSON_OUT?.trim() || null;
/** Cuentas (id o slug) para la simulación "¿y si estuviera en Créditos IA?". */
const COMO_SI = (process.env.COMO_SI ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const VENTANA_DESDE = process.env.DESDE?.trim() || null;
const VENTANA_HASTA = process.env.HASTA?.trim() || null;

const n = (x) => Number(x ?? 0).toLocaleString("es-CL");
const num = (x) => (x == null ? 0 : typeof x === "object" && typeof x.toNumber === "function" ? x.toNumber() : Number(x));

let problemas = 0;
const avisos = [];

/** Catálogo: el precio al que se vende un crédito sale de la recarga básica, no de acá. */
function precioDelCredito() {
  const cat = JSON.parse(readFileSync(join(here, "..", "seeds", "creditos-catalogo.json"), "utf-8"));
  const recarga = cat.packs.find((p) => p.esRecargaBasica) ?? cat.packs[0];
  return {
    precioCreditoClp: recarga ? Math.round((recarga.priceClp / recarga.credits) * 100) / 100 : 0,
    recarga: recarga?.code ?? "(sin recarga en el catálogo)",
    costoSupuesto: Number(cat.supuestos?.costoPorCreditoClp ?? 0),
    gananciaMinimaPct: Number(cat.supuestos?.gananciaMinimaPct ?? 300),
    codigos: cat.packs.map((p) => p.code),
  };
}

async function politicaVigente() {
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: "aiCredits" } });
    if (row) return { policy: parseCreditPolicy(JSON.parse(row.value)), fuente: "platform_settings.aiCredits" };
  } catch {
    /* cae a la semilla */
  }
  return { policy: CREDIT_POLICY_SEED, fuente: "semilla del repo (la fila aiCredits no está)" };
}

/** Organizaciones cuyo plan VIGENTE cobra Créditos IA. */
async function orgsEnCreditos() {
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT o.id, o.name, o.slug
    FROM organizations o
    JOIN subscriptions s ON s.organization_id = o.id AND s.status IN ('ACTIVE', 'TRIALING')
    JOIN plans p ON p.id = s.plan_id
    WHERE o.deleted_at IS NULL
      AND (p.features ->> 'aiCreditsWallet') = 'true'
      AND (${ORG}::text IS NULL OR o.id = ${ORG})
    ORDER BY o.name`;
  return rows;
}

/**
 * Desde cuándo tiene sentido auditar a esta organización.
 *
 * Un turno anterior al momento en que la cuenta pasó a Créditos IA no debía cobrarse en
 * créditos —cobraba por conversación—, así que contarlo daría "regalado" sobre algo que se
 * cobró bien en la otra unidad. Pero recortar por fecha es peligroso: la primera versión de
 * esto usaba el primer asiento de turno como piso, y el asiento se escribe unos
 * milisegundos DESPUÉS del turno, así que en una cuenta cuyo tráfico entero cabe en un
 * segundo se excluían TODOS los turnos y la auditoría daba verde habiendo mirado cero.
 * Lo cazó la prueba de carga: "respuestas auditadas: 0 · saldo 196".
 *
 * Así que el recorte se aplica SOLO si la cuenta de verdad vivió en la unidad vieja, y eso
 * se sabe sin fechas: tiene asientos `conversation_debit`. Si nunca cobró por conversación,
 * todos sus turnos debían cobrarse en créditos y se auditan todos.
 */
async function inicioCreditos(orgId) {
  const [{ cuantos }] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS cuantos
    FROM conversation_credit_ledger
    WHERE organization_id = ${orgId} AND reason = 'conversation_debit'`;
  if (Number(cuantos) === 0) return null; // nunca cobró por conversación: nada que recortar
  const r = await prisma.$queryRaw`
    SELECT MIN(created_at) AS desde
    FROM conversation_credit_ledger
    WHERE organization_id = ${orgId}
      AND (ref_type = 'turn' OR ref_id LIKE 'ai:%')`;
  return r[0]?.desde ?? null;
}

async function turnosDelPeriodo(orgId, desde) {
  return prisma.$queryRaw`
    SELECT id, model, input_tokens AS "inputTokens", output_tokens AS "outputTokens",
           cost_usd AS "costUsd", status, created_at AS "createdAt"
    FROM ai_requests
    WHERE organization_id = ${orgId}
      AND purpose = 'CHAT'
      AND created_at >= ${desde}
    ORDER BY created_at`;
}

async function debitosDe(orgId, turnIds) {
  if (turnIds.length === 0) return new Map();
  const porTurno = new Map();
  // En tandas: un IN con miles de ids revienta el límite de parámetros del driver.
  for (let i = 0; i < turnIds.length; i += 500) {
    const tanda = turnIds.slice(i, i + 500);
    const rows = await prisma.conversationCreditLedger.findMany({
      where: { organizationId: orgId, reason: "ai_credit_debit", refType: "turn", refId: { in: tanda } },
      select: { refId: true, delta: true },
    });
    for (const r of rows) {
      const arr = porTurno.get(r.refId) ?? [];
      arr.push(r.delta);
      porTurno.set(r.refId, arr);
    }
  }
  return porTurno;
}

/**
 * El peso y el bloque que se APLICARON en cada cobro, tal como quedaron en
 * `usage_events.meta`. Sin esto, la auditoría recalcularía todo con la política de HOY y el
 * día después de que el dueño ajuste un peso marcaría como robo cada turno cobrado con el
 * peso de ayer — y cambiar pesos sin desplegar es justo para lo que existe esa fila.
 */
async function pesosAplicados(orgId, desde) {
  const rows = await prisma.$queryRaw`
    SELECT meta ->> 'turnId' AS "turnId",
           (meta ->> 'weight')::numeric AS weight,
           (meta ->> 'tokensPerCredit')::numeric AS "tokensPerCredit",
           (meta ->> 'alTope') = 'true' AS "alTope",
           (meta ->> 'pedido')::numeric AS pedido
    FROM usage_events
    WHERE organization_id = ${orgId}
      AND type = 'ai_credits'
      AND occurred_at >= ${desde}
      AND meta ->> 'turnId' IS NOT NULL`;
  const m = new Map();
  for (const r of rows) {
    const weight = Number(r.weight);
    const tokensPerCredit = Number(r.tokensPerCredit);
    const pedido = Number(r.pedido);
    if (Number.isFinite(weight) && Number.isFinite(tokensPerCredit)) {
      m.set(r.turnId, {
        weight,
        tokensPerCredit,
        alTope: r.alTope === true,
        ...(Number.isFinite(pedido) ? { pedido } : {}),
      });
    }
  }
  return m;
}

/**
 * Asientos de turno que NO tienen un `ai_requests` detrás: un cobro sin respuesta. No puede
 * pasar por el camino normal (el débito usa el id del turno recién creado), y justamente
 * por eso hay que mirarlo: si aparece, alguien cobró por algo que no existió.
 */
async function cobrosHuerfanos(orgId, desde) {
  return prisma.$queryRaw`
    SELECT l.ref_id AS "refId", l.delta, l.created_at AS "createdAt"
    FROM conversation_credit_ledger l
    LEFT JOIN ai_requests r ON r.id = l.ref_id
    WHERE l.organization_id = ${orgId}
      AND l.reason = 'ai_credit_debit'
      AND l.ref_type = 'turn'
      AND l.created_at >= ${desde}
      AND r.id IS NULL`;
}

async function estadoMonedero(orgId, graciaLimite) {
  const ahora = new Date();
  const [lotes] = await prisma.$queryRaw`
    SELECT
      COALESCE(SUM(CASE WHEN remaining > 0 AND (expires_at IS NULL OR expires_at > ${ahora}) THEN remaining ELSE 0 END), 0) AS vigentes,
      COALESCE(SUM(CASE WHEN remaining > 0 AND expires_at IS NOT NULL AND expires_at <= ${ahora} THEN remaining ELSE 0 END), 0) AS vencidos,
      COUNT(*) FILTER (WHERE remaining < 0) AS negativos
    FROM conversation_credit_lots
    WHERE organization_id = ${orgId}`;
  const [libro] = await prisma.$queryRaw`
    SELECT COALESCE(SUM(delta), 0) AS suma, COUNT(*) AS asientos
    FROM conversation_credit_ledger
    WHERE organization_id = ${orgId}`;
  const ultimo = await prisma.conversationCreditLedger.findFirst({
    where: { organizationId: orgId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { balanceAfter: true },
  });
  const wallet = await prisma.conversationWallet.findUnique({
    where: { organizationId: orgId },
    select: { graceUsed: true },
  });
  return {
    estado: {
      organizationId: orgId,
      lotesVigentes: Number(lotes.vigentes),
      lotesVencidosSinBarrer: Number(lotes.vencidos),
      graciaUsada: wallet?.graceUsed ?? 0,
      sumaDelLibro: Number(libro.suma),
      ultimoBalanceAfter: ultimo?.balanceAfter ?? null,
      lotesNegativos: Number(lotes.negativos),
      graciaLimite,
    },
    asientos: Number(libro.asientos),
    sinMonedero: wallet == null,
  };
}

/**
 * "¿Y si ESTA cuenta estuviera en Créditos IA?" — sobre consumo REAL ya facturado.
 *
 * Es la única forma de medir la rentabilidad antes de tener un solo cliente en el modelo
 * nuevo: el stack simulado no gasta plata (proveedores mock, `cost_usd` = 0), así que ahí
 * el costo por crédito no se puede medir ni con la mejor prueba de carga. Acá se toman los
 * turnos de verdad de una cuenta —con sus tokens, su modelo y lo que nos costaron en
 * dólares— y se les aplica la fórmula vigente. El resultado es el número del que cuelga
 * todo el modelo de precios: cuánto nos cuesta producir un crédito.
 */
async function comoSi(ids, desde, hasta, cat) {
  console.log("── SIMULACIÓN SOBRE CONSUMO REAL (qué pasaría si esta cuenta estuviera en Créditos IA)");
  console.log(`   ventana: ${desde.toISOString().slice(0, 10)} → ${hasta.toISOString().slice(0, 10)}\n`);
  for (const ref of ids) {
    const org = await prisma.organization.findFirst({
      where: { OR: [{ id: ref }, { slug: ref }] },
      select: { id: true, name: true, slug: true, brand: true },
    });
    if (!org) {
      console.log(`   ✖ no existe ninguna organización con id o slug "${ref}"`);
      continue;
    }
    const turnos = await prisma.$queryRaw`
      SELECT model, input_tokens AS "inputTokens", output_tokens AS "outputTokens",
             cost_usd AS "costUsd", conversation_id AS "conversationId"
      FROM ai_requests
      WHERE organization_id = ${org.id} AND purpose = 'CHAT'
        AND created_at >= ${desde} AND created_at < ${hasta}`;
    if (turnos.length === 0) {
      console.log(`   · ${org.name} (${org.slug}, ${org.brand}): sin respuestas en la ventana`);
      continue;
    }
    let creditos = 0;
    let tokens = 0;
    let costoUsd = 0;
    const conversaciones = new Set();
    const porModelo = new Map();
    for (const t of turnos) {
      const tk = Number(t.inputTokens) + Number(t.outputTokens);
      const c = creditsForTurn({ model: t.model, tokens: tk, policy: await politicaCache() });
      creditos += c.credits;
      tokens += tk;
      costoUsd += num(t.costUsd);
      if (t.conversationId) conversaciones.add(t.conversationId);
      const m = porModelo.get(t.model) ?? { turnos: 0, creditos: 0, costoUsd: 0, peso: c.weight, conocido: c.modelKnown };
      m.turnos++;
      m.creditos += c.credits;
      m.costoUsd += num(t.costUsd);
      porModelo.set(t.model, m);
    }
    const costoCredito = costoPorCreditoClp({ costoIaUsd: costoUsd, creditos, clpPorUsd: CLP_POR_USD });
    const margen = margenSobreCostoPct({ precioCreditoClp: cat.precioCreditoClp, costoPorCreditoClp: costoCredito });
    const porConversacion = conversaciones.size > 0 ? Math.round((creditos / conversaciones.size) * 100) / 100 : 0;
    const recargas = Math.ceil(Math.max(0, creditos - 300) / 420); // plan Base (300) + recargas
    console.log(
      `   · ${org.name} (${org.slug}, ${org.brand})\n` +
        `       ${n(turnos.length)} respuestas · ${n(tokens)} tokens · ${n(conversaciones.size)} conversaciones\n` +
        // Por modelo, porque es lo que valida los PESOS: cada peso se calibró para que un
        // crédito cueste ~$2 con cualquier modelo. Si un modelo sale muy arriba su peso
        // quedó corto, y ahí se va el margen de los clientes que justamente lo usan.
        `       por modelo:\n${[...porModelo]
          .map(([k, v]) => {
            const cc = costoPorCreditoClp({ costoIaUsd: v.costoUsd, creditos: v.creditos, clpPorUsd: CLP_POR_USD });
            return (
              `         ${k}${v.conocido ? "" : " (SIN PESO → premium)"}: peso ${v.peso} · ${n(v.turnos)} resp · ${n(v.creditos)} cr · ` +
              `${cc > 0 ? `$${cc}/crédito` : "sin costo registrado"}`
            );
          })
          .join("\n")}\n` +
        `       créditos que habría cobrado: ${n(creditos)} (${porConversacion} por conversación)\n` +
        `       costo real de IA: USD ${costoUsd.toFixed(4)} → $${n(Math.round(costoUsd * CLP_POR_USD))} CLP\n` +
        `       un crédito nos CUESTA $${costoCredito} (el catálogo supone $${cat.costoSupuesto}) y se vende a $${cat.precioCreditoClp}\n` +
        `       margen sobre el costo: ${margen == null ? "no medible (sin costo registrado)" : `${n(margen)}%`} (piso ${cat.gananciaMinimaPct}%)\n` +
        `       facturación con los precios aprobados: plan Base $${n(24990)} + ${n(recargas)} recarga(s) = $${n(24990 * (1 + recargas))}`,
    );
    if (margen != null && margen < cat.gananciaMinimaPct) {
      problemas++;
      console.log(`       ✖ POR DEBAJO DEL PISO de ganancia.`);
    }
  }
  console.log("");
}

let _pol = null;
async function politicaCache() {
  if (!_pol) _pol = (await politicaVigente()).policy;
  return _pol;
}

async function main() {
  const desde = new Date(Date.now() - DIAS * 86_400_000);
  const { policy, fuente } = await politicaVigente();
  const cat = precioDelCredito();

  console.log("══ AUDITORÍA DEL CONTADOR DE CRÉDITOS IA (solo lectura) ══");
  console.log(`   período: últimos ${DIAS} día(s) · desde ${desde.toISOString().slice(0, 16).replace("T", " ")} UTC`);
  console.log(`   política: ${fuente} · bloque ${n(policy.tokensPerCredit)} tokens · gracia ${policy.graceCredits}`);
  console.log(`   catálogo: 1 crédito se vende a $${cat.precioCreditoClp} (${cat.recarga}) y se supone que cuesta $${cat.costoSupuesto}\n`);

  // ───────────── qué se está vendiendo (antes de mirar un solo cobro) ─────────────
  // El catálogo es la fuente de verdad de los precios. Un pack activo que NO está en el
  // catálogo se le está vendiendo a alguien a un precio que el dueño ya descartó: los de la
  // primera calibración daban el crédito a $12,5–$19 contra los $59,5 aprobados. Es la
  // forma más silenciosa de perder margen, porque todo lo demás cuadra perfecto.
  const activos = await prisma.messagePackage.findMany({
    where: { brand: "conversia", type: "credit", active: true },
    select: { code: true, credits: true, priceClp: true },
    orderBy: { credits: "asc" },
  });
  const delCatalogo = new Set(cat.codigos);
  const intrusos = activos.filter((p) => !delCatalogo.has(p.code));
  console.log("── QUÉ SE ESTÁ VENDIENDO");
  if (activos.length === 0) {
    console.log("   ningún pack de créditos activo (el catálogo está apagado).");
  } else {
    for (const p of activos) {
      const porCredito = Math.round((p.priceClp / p.credits) * 10) / 10;
      console.log(
        `   ${delCatalogo.has(p.code) ? "✔" : "✖"} ${p.code.padEnd(22)} ${String(p.credits).padStart(6)} cr · $${n(p.priceClp)} · $${porCredito}/crédito`,
      );
    }
  }
  if (intrusos.length > 0) {
    problemas++;
    console.log(
      `   ✖ ${intrusos.length} pack(s) ACTIVO(S) que no están en el catálogo: ${intrusos.map((p) => p.code).join(", ")}\n` +
        `     Se están vendiendo a un precio que el catálogo ya no tiene. Apagalos con seed-conversia-catalog.mjs.`,
    );
  }
  console.log("");

  if (COMO_SI.length > 0) {
    const d = VENTANA_DESDE ? new Date(VENTANA_DESDE) : desde;
    const h = VENTANA_HASTA ? new Date(VENTANA_HASTA) : new Date();
    await comoSi(COMO_SI, d, h, cat);
  }

  const orgs = await orgsEnCreditos();
  if (orgs.length === 0) {
    console.log("No hay ninguna organización con un plan de Créditos IA vigente.");
    console.log("(Si el go-live todavía no corrió, esto es lo esperado: no hay nada que auditar.)");
    return;
  }

  const todos = [];
  let costoUsdTotal = 0;
  let creditosCobradosTotal = 0;
  const detalleMalos = [];
  const porOrg = [];

  for (const org of orgs) {
    const marca = await inicioCreditos(org.id);
    const recortada = marca != null;
    const desdeOrg = recortada ? new Date(Math.max(desde.getTime(), new Date(marca).getTime())) : desde;
    const turnos = await turnosDelPeriodo(org.id, desdeOrg);
    // Cuántos turnos del período quedaron FUERA del recorte. Una auditoría que no dice
    // cuánto se saltó puede dar verde habiendo mirado nada, que es peor que dar rojo.
    const enVentana = await prisma.aiRequest.count({
      where: { organizationId: org.id, purpose: "CHAT", createdAt: { gte: desde } },
    });
    const excluidos = enVentana - turnos.length;
    const debitos = await debitosDe(
      org.id,
      turnos.map((t) => t.id),
    );
    const aplicados = await pesosAplicados(org.id, desdeOrg);
    const auditados = turnos.map((t) =>
      auditarTurno(
        {
          turnId: t.id,
          organizationId: org.id,
          model: t.model,
          inputTokens: Number(t.inputTokens),
          outputTokens: Number(t.outputTokens),
          costUsd: num(t.costUsd),
          status: t.status,
        },
        { deltas: debitos.get(t.id) ?? [], aplicado: aplicados.get(t.id) ?? null },
        policy,
      ),
    );
    const resumen = resumirAuditoria(auditados);
    todos.push(...auditados);

    const huerfanos = await cobrosHuerfanos(org.id, desdeOrg);
    const { estado, asientos, sinMonedero } = await estadoMonedero(org.id, policy.graceCredits);
    const inv = verificarMonedero(estado);

    const costoUsd = turnos.reduce((a, t) => a + num(t.costUsd), 0);
    const creditos = auditados.reduce((a, t) => a + t.cobrado, 0);
    costoUsdTotal += costoUsd;
    creditosCobradosTotal += creditos;

    const sano = resumen.cuadra && inv.ok && huerfanos.length === 0;
    if (!sano) problemas++;
    // Respondió y no cobró NADA. No es un aviso cosmético: es el servicio regalado entero.
    if (resumen.esperado > 0 && resumen.cobrado === 0) {
      avisos.push(`${org.name}: ${n(resumen.turnos)} respuestas que debían cobrar ${n(resumen.esperado)} créditos y NI UN asiento en el libro.`);
    }
    if (excluidos > 0) {
      avisos.push(
        `${org.name}: ${n(excluidos)} respuesta(s) del período quedaron FUERA de la auditoría por ser anteriores a su paso a Créditos IA.`,
      );
    }
    if (sinMonedero && turnos.length > 0) {
      // El cerrojo que serializa los débitos es un FOR UPDATE sobre la fila del monedero:
      // sin fila no hay cerrojo, y dos turnos simultáneos pueden gastar el mismo lote.
      avisos.push(`${org.name}: tiene respuestas cobradas y NO tiene fila en conversation_wallets (el cerrojo del débito no agarra).`);
    }

    porOrg.push({
      id: org.id,
      org: org.name,
      slug: org.slug,
      turnos: turnos.length,
      resumen,
      inv,
      huerfanos: huerfanos.length,
      costoUsd,
      creditos,
      sano,
      excluidos,
    });

    console.log(
      `${sano ? "✔" : "✖"} ${org.name} (${org.slug})\n` +
        `    respuestas auditadas: ${n(turnos.length)}${excluidos > 0 ? ` (+${n(excluidos)} fuera del recorte)` : ""} · créditos esperados ${n(resumen.esperado)} / cobrados ${n(resumen.cobrado)}` +
        `${resumen.regalados ? ` · REGALADOS ${n(resumen.regalados)}` : ""}` +
        `${resumen.deMas ? ` · DE MÁS ${n(resumen.deMas)}` : ""}` +
        `${resumen.porVeredicto.doble_cobro ? ` · DOBLE COBRO ${n(resumen.porVeredicto.doble_cobro)}` : ""}\n` +
        `    saldo ${n(inv.saldo)} · libro ${inv.libroCuadra ? "cuadra" : `DESCUADRADO en ${n(inv.descuadre)}`}` +
        ` · último asiento ${inv.ultimoAsientoCuadra ? "ok" : "NO cuadra"} · gracia ${n(estado.graciaUsada)}/${policy.graceCredits}` +
        `${estado.lotesNegativos ? ` · LOTES NEGATIVOS ${estado.lotesNegativos}` : ""} · asientos ${n(asientos)}` +
        `${huerfanos.length ? `\n    ✖ ${huerfanos.length} cobro(s) sin respuesta detrás (asiento huérfano)` : ""}`,
    );

    if (DETALLE) {
      for (const t of auditados.filter((a) => a.veredicto !== "ok" && a.veredicto !== "no_cobrable")) {
        detalleMalos.push(
          `    ${t.veredicto.padEnd(16)} turno ${t.turnId} · ${t.model} · ${n(t.tokens)} tokens · esperado ${t.esperado} / cobrado ${t.cobrado}`,
        );
      }
    }
  }

  if (DETALLE && detalleMalos.length) {
    console.log("\n── turnos que no cuadran");
    console.log(detalleMalos.slice(0, 200).join("\n"));
    if (detalleMalos.length > 200) console.log(`    … y ${detalleMalos.length - 200} más`);
  }

  // ───────────────────────────────── totales ─────────────────────────────────
  const total = resumirAuditoria(todos);
  console.log("\n── TOTAL");
  console.log(`   organizaciones en Créditos IA: ${n(orgs.length)}`);
  console.log(`   respuestas auditadas: ${n(total.turnos)}`);
  console.log(
    `   veredictos: ok ${n(total.porVeredicto.ok)} · sin cobrar ${n(total.porVeredicto.sin_cobrar)} · de menos ${n(total.porVeredicto.cobrado_de_menos)}` +
      ` · de más ${n(total.porVeredicto.cobrado_de_mas)} · doble cobro ${n(total.porVeredicto.doble_cobro)} · no cobrables ${n(total.porVeredicto.no_cobrable)}` +
      ` · topeados por gracia ${n(total.porVeredicto.tope_gracia)}`,
  );
  console.log(`   créditos esperados ${n(total.esperado)} / cobrados ${n(total.cobrado)} → regalados ${n(total.regalados)} · de más ${n(total.deMas)}`);
  if (total.porTope > 0) {
    // Plata que no entró, pero por diseño: es la última respuesta del cliente sin saldo.
    console.log(
      `   ${n(total.porTope)} crédito(s) no se pudieron cobrar porque la cuenta llegó al tope del colchón ` +
        `(${n(total.porVeredicto.tope_gracia)} turno(s)). Es el regalo de la última respuesta, no un error.`,
    );
  }
  if (total.conPesoCambiado > 0) {
    // No es un problema: es lo que pasa cuando el dueño ajusta un peso. Se dice para que un
    // cambio de precios no se lea como un error de cobro, ni al revés.
    console.log(
      `   ${n(total.conPesoCambiado)} turno(s) se cobraron con un peso distinto del vigente (cambio de política, no error de cobro).`,
    );
  }

  // ───────────────────────────────── el costo ─────────────────────────────────
  const costoReal = costoPorCreditoClp({ costoIaUsd: costoUsdTotal, creditos: creditosCobradosTotal, clpPorUsd: CLP_POR_USD });
  const margenReal = margenSobreCostoPct({ precioCreditoClp: cat.precioCreditoClp, costoPorCreditoClp: costoReal });
  console.log("\n── COSTO Y MARGEN (lo que decide la rentabilidad)");
  console.log(`   costo real de IA del período: USD ${costoUsdTotal.toFixed(4)} a $${n(CLP_POR_USD)}/USD`);
  if (creditosCobradosTotal <= 0) {
    console.log("   todavía no hay créditos cobrados en el período: no se puede medir el costo por crédito.");
  } else if (costoUsdTotal <= 0) {
    // Pasa en el stack simulado (proveedores mock, costo 0) y pasaría en producción si el
    // orquestador dejara de guardar `cost_usd`. Decirlo es importante: un "$0 por crédito"
    // se leería como margen infinito, que es justo la conclusión que no hay que sacar.
    console.log(
      `   los proveedores del período no reportaron costo (USD 0 en ${n(total.turnos)} respuestas).\n` +
        "   El margen NO se puede medir con estos datos: en el stack simulado es lo normal, en producción sería un problema de telemetría.",
    );
    if (process.env.EXIGIR_COSTO === "1") {
      problemas++;
      console.log("   ✖ EXIGIR_COSTO=1: se esperaba costo real y no hay ninguno.");
    }
  } else {
    console.log(`   un crédito nos CUESTA $${costoReal} (el catálogo supone $${cat.costoSupuesto})`);
    console.log(`   un crédito se VENDE a $${cat.precioCreditoClp} → margen sobre el costo: ${margenReal}% (piso ${cat.gananciaMinimaPct}%)`);
    if (margenReal != null && margenReal < cat.gananciaMinimaPct) {
      problemas++;
      console.log(`   ✖ el margen quedó POR DEBAJO del piso: revisá los pesos de los modelos caros o el precio.`);
    } else if (costoReal > cat.costoSupuesto * 1.5) {
      avisos.push(
        `el costo real por crédito ($${costoReal}) está más de 50% arriba del supuesto del catálogo ($${cat.costoSupuesto}): el margen sigue en pie, pero el supuesto de precios quedó viejo.`,
      );
    }
  }

  if (avisos.length) {
    console.log("\n── AVISOS");
    for (const a of avisos) console.log(`   ⚠ ${a}`);
  }

  if (JSON_OUT) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      JSON_OUT,
      JSON.stringify({ desde, dias: DIAS, total, costoReal, margenReal, porOrg, avisos, problemas }, null, 2),
    );
    console.log(`\n   informe JSON: ${JSON_OUT}`);
  }

  console.log(
    problemas === 0
      ? `\n✔ EL CONTADOR CUADRA. ${n(total.turnos)} respuesta(s) auditada(s), ningún crédito regalado ni cobrado de más.`
      : `\n✖ ${problemas} problema(s) de cobro. Nada de esto se arregla solo: cada crédito descuadrado es plata.`,
  );
  process.exitCode = problemas === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
