import { getAdminPrisma, withTenant } from "@conversia/database";
import { brandOf } from "@conversia/config";
import { resolvePeriodStart } from "./conversation-quota";

/**
 * V2-1 — BOLSA DE CONVERSACIONES (crédito-conversación). 1 crédito = 1 conversación
 * atendida por el bot en la ventana de 24 h. SEPARADA de MessageWallet (plantillas,
 * TuBot): solo aplica a planes con features.conversationDebitsWallet. Dinero: montos
 * enteros, débito idempotente (lo garantiza countConversationOnce.counted una vez por
 * conversación/período), rollover por lotes con expiración, gracia acotada y TODO
 * auditado en conversation_credit_ledger. El bot JAMÁS queda mudo por saldo: al agotar
 * la gracia el caller aplica frase de respaldo + derivación (no se calla).
 */

export const GRACE_LIMIT = 20; // conversaciones (créditos) en negativo antes de cortar el débito
const PLAN_ROLLOVER_MONTHS = 2; // los créditos del plan ruedan 2 meses
const PURCHASE_EXPIRY_MONTHS = 12; // los comprados, 12 meses

function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + n);
  return x;
}

/** Features del plan vigente (suscripción ACTIVE/TRIALING más reciente; free si no hay). */
export async function planFeatures(organizationId: string): Promise<Record<string, unknown>> {
  const prisma = getAdminPrisma();
  const sub = await prisma.subscription
    .findFirst({ where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } }, orderBy: { createdAt: "desc" }, select: { planId: true } })
    .catch(() => null);
  const plan = sub?.planId
    ? await prisma.plan.findUnique({ where: { id: sub.planId }, select: { features: true } }).catch(() => null)
    : await prisma.plan.findUnique({ where: { code: "free" }, select: { features: true } }).catch(() => null);
  return (plan?.features as Record<string, unknown> | undefined) ?? {};
}

/** ¿El plan vigente de la org debita la CONVERSACIÓN de la bolsa (modelo V2)? */
export async function planDebitsConversation(organizationId: string): Promise<boolean> {
  // §6.6 — DOBLE GUARDA: marca conversia Y feature del plan. El cobro por conversación es
  // el modelo V2 de Conversia; en TuBot no existe. Con la feature sola, un plan de TuBot
  // mal marcado (a mano, por un seed, o por un loop que recorra todos los planes — el
  // incidente de V2-7) les empezaría a debitar créditos a los clientes de TuBot. La marca
  // de la org no se toca desde la pantalla de planes, así que cierra ese camino.
  if (!(await isConversiaOrg(organizationId))) return false;
  const feats = await planFeatures(organizationId);
  // CRE 1 — UNA SOLA UNIDAD POR PLAN. Si el plan cobra Créditos IA (por respuesta), no
  // puede cobrar además por conversación: serían dos cargos por el mismo trabajo. El
  // catálogo nuevo no trae las dos features juntas, pero un plan editado a mano en el
  // super admin sí podría, y el cliente no tiene cómo darse cuenta. Gana la unidad nueva.
  if (feats.aiCreditsWallet === true) return false;
  return feats.conversationDebitsWallet === true;
}

/**
 * §6.6 — ¿La organización es de marca Conversia? Ante cualquier duda, NO (no se cobra).
 *
 * Exportada para que la use TAMBIÉN `planDebitsService` en messaging-guard: las dos
 * guardas hacen la misma pregunta, y si cada una la respondiera por su cuenta podrían
 * divergir. Una sola implementación, un solo test.
 */
export async function isConversiaOrg(organizationId: string): Promise<boolean> {
  try {
    const org = await getAdminPrisma().organization.findUnique({
      where: { id: organizationId },
      select: { brand: true },
    });
    return brandOf(org).key === "conversia";
  } catch {
    return false;
  }
}

/** Multiplicador de crédito por conversación: Asistente Plus (modelo premium) = x2. */
export async function conversationCreditMultiplier(organizationId: string): Promise<number> {
  return (await planFeatures(organizationId)).aiPlus === true ? 2 : 1;
}

export type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/**
 * CERROJO POR ORGANIZACIÓN para todo lo que toca su saldo. Primera sentencia de la
 * transacción, siempre.
 *
 * Antes era `SELECT grace_used FROM conversation_wallets … FOR UPDATE`, y eso tenía un
 * agujero silencioso: **si la fila del monedero no existe, `FOR UPDATE` no bloquea nada**
 * (en Postgres, un `FOR UPDATE` que no matchea filas sigue de largo). La fila la crea
 * `ensureWallet`, que corre DESPUÉS del cerrojo, así que justo en los primeros turnos de
 * una cuenta —o en cualquier cuenta creada por un seed, por el super admin o migrada, que
 * no la tienen— dos turnos simultáneos pasaban los dos: acreditaban el período dos veces y
 * consumían los lotes leyendo el mismo `remaining` (lost update). La auditoría lo detecta
 * después (avisa "tiene respuestas cobradas y NO tiene fila en conversation_wallets"),
 * pero detectar no es prevenir.
 *
 * Un cerrojo de aviso no depende de que exista ninguna fila: se toma sobre el id de la
 * organización y se suelta al cerrar la transacción. Y como es uno solo por org, no hay
 * orden de adquisición que pueda generar un abrazo mortal.
 */
export async function lockOrg(tx: Tx, organizationId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;
}

/** Saldo = suma de remaining de lotes VIGENTES (no expirados) menos la gracia usada. */
export async function balanceInTx(tx: Tx, organizationId: string, now: Date): Promise<{ lots: number; grace: number; net: number }> {
  const rows = await tx.conversationCreditLot.aggregate({
    _sum: { remaining: true },
    where: { organizationId, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
  });
  const lots = rows._sum.remaining ?? 0;
  const w = await tx.conversationWallet.findUnique({ where: { organizationId }, select: { graceUsed: true } });
  const grace = w?.graceUsed ?? 0;
  return { lots, grace, net: lots - grace };
}

export async function ensureWallet(tx: Tx, organizationId: string, _now: Date) {
  // periodStart guarda el último período ACREDITADO. Una wallet recién creada debe
  // nacer como "nunca acreditada" (época 0): si naciera con `now`, ensurePeriodAccrued
  // vería walletPeriod >= periodStart de la suscripción y el PRIMER período jamás
  // acreditaría los créditos del plan (bug cazado por la simulación del 2026-10-16:
  // todo cliente base nuevo operaba contra la gracia y cortaba en 20).
  return tx.conversationWallet.upsert({
    where: { organizationId },
    create: { organizationId, periodStart: new Date(0) },
    update: {},
  });
}

/**
 * Acredita (perezoso) los créditos del plan al abrir un período nuevo: si el período de
 * la bolsa quedó atrás respecto del período de facturación, crea un lote con los créditos
 * incluidos del plan (expira a 2 meses), paga primero la gracia y resetea los avisos.
 * Idempotente por período (no re-acredita el mismo período).
 *
 * CRE 1 — `includedKey` es lo ÚNICO que cambia entre unidades: el plan de conversaciones
 * incluye `conversationsIncluded` y el de Créditos IA `aiCreditsIncluded`. Los lotes, el
 * rollover, la gracia y el libro son los mismos (un crédito es un crédito); por eso esta
 * función se generaliza en vez de copiarse.
 */
export async function ensurePeriodAccrued(
  tx: Tx,
  organizationId: string,
  now: Date,
  opts: { includedKey?: "conversationsIncluded" | "aiCreditsIncluded" } = {},
): Promise<void> {
  const includedKey = opts.includedKey ?? "conversationsIncluded";
  const prisma = getAdminPrisma();
  const sub = await prisma.subscription
    .findFirst({ where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } }, orderBy: { createdAt: "desc" }, select: { periodStart: true, planId: true } })
    .catch(() => null);
  const periodStart = resolvePeriodStart(sub?.periodStart ?? null, now);
  const wallet = await ensureWallet(tx, organizationId, now);
  const walletPeriod = resolvePeriodStart(wallet.periodStart, now);

  const feats = await planFeatures(organizationId);
  const included = Number(feats[includedKey]) || 0;
  // Idempotencia por (PLAN, período) vía ledger, NO solo por fecha de la wallet: un
  // upgrade dentro del mismo período (trial→base el mismo día, el funnel normal) debe
  // acreditar el plan nuevo aunque la wallet ya haya "visto" el período con el plan
  // anterior (hallazgo sim 200 del 2026-10-17: el cliente pagaba y recibía 0 créditos
  // hasta el mes siguiente). El refId sella plan+período; reintentos no re-acreditan.
  if (included > 0 && sub?.planId) {
    // El sello de la unidad nueva lleva prefijo: si una org cambiara de unidad dentro del
    // mismo período, el lote de Créditos IA no debe darse por acreditado porque ya existía
    // el de conversaciones (mismo plan, misma fecha). El formato de conversaciones NO se
    // toca: cambiarlo re-acreditaría el período a TODOS los clientes V2 vigentes.
    const sello = `${sub.planId}:${periodStart.toISOString().slice(0, 10)}`;
    const refId = includedKey === "aiCreditsIncluded" ? `ai:${sello}` : sello;
    const done = await tx.conversationCreditLedger.findFirst({
      where: { organizationId, reason: "plan_renewal", refId },
      select: { id: true },
    });
    if (!done) {
      // SE ACREDITA LA DIFERENCIA, NO UN MES COMPLETO OTRA VEZ.
      //
      // El sello es por (plan, período) a propósito: un upgrade el mismo día tiene que
      // acreditar el plan nuevo, porque si no el cliente paga y recibe 0 créditos hasta el
      // mes siguiente. Pero por eso mismo, CADA plan distinto por el que pasara la cuenta en
      // el mes abría su propio mes completo: dos saltos de plan y el cliente se llevaba dos
      // meses de créditos pagando uno, y el que quisiera abusarlo solo tenía que ir saltando.
      // Neteando se conservan las dos cosas buenas: el plan nuevo acredita de inmediato, y
      // lo que ya recibió este mes no se le regala de nuevo. Un downgrade acredita 0 — no se
      // le quita nada de lo que ya tenía, tampoco se le suma.
      const yaRecibido = await creditosDelPlanEnElPeriodo(tx, organizationId, periodStart, includedKey);
      const aAcreditar = Math.max(0, included - yaRecibido);
      await creditLotInTx(tx, organizationId, { source: "plan", amount: aAcreditar, expiresAt: addMonths(periodStart, PLAN_ROLLOVER_MONTHS), refType: "subscription", refId, now });
      await tx.conversationWallet.update({ where: { organizationId }, data: { periodStart, lastNotifiedPct: 0 } });
      return;
    }
  }
  if (walletPeriod.getTime() >= periodStart.getTime()) return; // ya acreditado este período
  await tx.conversationWallet.update({ where: { organizationId }, data: { periodStart, lastNotifiedPct: 0 } });
}

/**
 * Créditos que el PLAN ya le dio a esta organización en ESTE período, en esta misma unidad.
 *
 * Es la cuenta que permite netear un cambio de plan dentro del mes. Se suman dos razones:
 * `plan_renewal` (lo que entró al lote) y `grace_repay` (lo que se fue a cubrir su deuda).
 * La segunda cuenta igual: ese crédito lo recibió, solo que no llegó a verlo como saldo. Sin
 * contarla, un cliente que cerró el mes en gracia —que es el fin de saldo normal— se llevaría
 * esa diferencia regalada en cada cambio de plan.
 *
 * Los sellos del período son `<planId>:<fecha>` para conversaciones y `ai:<planId>:<fecha>`
 * para Créditos IA, así que todos terminan en la fecha del período y el prefijo distingue la
 * unidad. La unidad importa: si una cuenta cambió de unidad dentro del mes, su mes de
 * conversaciones no puede descontarse de su mes de créditos — son bolsas que se cobran
 * distinto, y es justamente el caso que el prefijo del sello vino a resolver.
 */
async function creditosDelPlanEnElPeriodo(
  tx: Tx,
  organizationId: string,
  periodStart: Date,
  includedKey: "conversationsIncluded" | "aiCreditsIncluded",
): Promise<number> {
  const fecha = periodStart.toISOString().slice(0, 10);
  const asientos = await tx.conversationCreditLedger.findMany({
    where: {
      organizationId,
      refType: "subscription",
      refId: { endsWith: `:${fecha}` },
      reason: { in: ["plan_renewal", "grace_repay"] },
    },
    select: { delta: true, refId: true },
  });
  const esDeCreditos = includedKey === "aiCreditsIncluded";
  return asientos
    .filter((a) => (a.refId ?? "").startsWith("ai:") === esDeCreditos)
    .reduce((a, x) => a + Number(x.delta), 0);
}

/** Crea un lote de crédito; primero PAGA la gracia pendiente (los créditos nuevos cubren el negativo). */
export async function creditLotInTx(
  tx: Tx,
  organizationId: string,
  input: { source: string; amount: number; expiresAt: Date | null; refType?: string; refId?: string; now: Date },
): Promise<void> {
  const wallet = await ensureWallet(tx, organizationId, input.now);
  let credit = input.amount;
  // Pagar gracia pendiente primero (patrón "se descuenta de la próxima recarga").
  if (wallet.graceUsed > 0 && credit > 0) {
    const pay = Math.min(wallet.graceUsed, credit);
    await tx.conversationWallet.update({ where: { organizationId }, data: { graceUsed: wallet.graceUsed - pay } });
    credit -= pay;
    const after = await balanceInTx(tx, organizationId, input.now);
    await tx.conversationCreditLedger.create({
      data: { organizationId, delta: pay, reason: "grace_repay", balanceAfter: after.net, refType: input.refType, refId: input.refId },
    });
  }
  if (credit > 0) {
    await tx.conversationCreditLot.create({
      data: { organizationId, source: input.source, amount: credit, remaining: credit, expiresAt: input.expiresAt, refType: input.refType, refId: input.refId },
    });
  }
  // El asiento va por lo que ENTRÓ AL LOTE, no por el monto bruto.
  //
  // Antes se anotaba `input.amount` completo ADEMÁS del asiento de `grace_repay`, así que
  // el libro sumaba `amount + gracia_pagada` para un movimiento real de `amount`: la suma
  // de los asientos dejaba de explicar el saldo. Pasaba en cada renovación de un cliente
  // que terminó el mes en gracia —el estado normal de fin de saldo— y ponía en rojo la
  // invariante más importante de la auditoría por un descuadre que no era una fuga, con el
  // riesgo de que se aprendiera a ignorarla. Las dos filas juntas siguen contando la
  // historia completa: "+100 pagó tu deuda" y "+320 a tu saldo" para una compra de 420.
  //
  // El asiento se escribe SIEMPRE, incluso con delta 0 (la acreditación se fue entera a
  // pagar la deuda): no es solo contabilidad, es el SELLO de idempotencia del período.
  // `ensurePeriodAccrued` pregunta justamente por este asiento para no re-acreditar; sin
  // él, cada turno volvería a acreditar el plan completo.
  const after = await balanceInTx(tx, organizationId, input.now);
  await tx.conversationCreditLedger.create({
    data: {
      organizationId,
      delta: credit,
      reason: input.source === "purchase" ? "package_purchase" : input.source === "plan" ? "plan_renewal" : "admin_adjust",
      balanceAfter: after.net,
      refType: input.refType,
      refId: input.refId,
    },
  });
}

/** Acredita créditos COMPRADOS (pack/recarga): lote que expira a 12 meses. Idempotente por refId. */
export async function creditPurchasedConversations(
  organizationId: string,
  amount: number,
  ref: { refType: string; refId: string },
): Promise<void> {
  if (amount <= 0) return;
  await withTenant(organizationId, async (tx) => {
    const dup = await tx.conversationCreditLedger.findFirst({ where: { organizationId, refType: ref.refType, refId: ref.refId, reason: "package_purchase" }, select: { id: true } });
    if (dup) return; // idempotente: ya acreditado este pago
    await creditLotInTx(tx, organizationId, { source: "purchase", amount, expiresAt: addMonths(new Date(), PURCHASE_EXPIRY_MONTHS), refType: ref.refType, refId: ref.refId, now: new Date() });
  });
}

export type ConversationDebit =
  | { ok: true; balanceAfter: number; inGrace: boolean; graceUsed: number }
  | { ok: false; blocked: true; graceUsed: number }; // gracia agotada → fallback + derivación (bot NO mudo)

/**
 * CRE 1 — NÚCLEO del consumo, compartido por las dos unidades (conversación y Créditos
 * IA): consume `amount` de los lotes vigentes FIFO por expiración y, si no alcanzan, usa
 * gracia hasta `graceLimit`. Superado el límite NO consume nada y devuelve `ok: false`
 * para que el caller responda con la frase de respaldo y derive (el bot no queda mudo).
 *
 * Lo que NO hace, a propósito: tomar el cerrojo, acreditar el período y escribir el
 * asiento. Eso lo hace cada caller, porque el motivo y el detalle del asiento son
 * distintos en cada unidad; el cálculo del saldo, en cambio, tiene que ser idéntico.
 */
export async function consumeCreditsInTx(
  tx: Tx,
  organizationId: string,
  opts: { amount: number; graceLimit: number; now: Date },
): Promise<{ ok: true; graceUsed: number; consumido: number; alTope: boolean } | { ok: false; graceUsed: number }> {
  const pedido = Math.max(0, Math.round(opts.amount));

  // DECIDIR ANTES DE CONSUMIR, Y COBRAR TODO LO COBRABLE.
  //
  // El camino viejo consumía los lotes y recién después miraba la gracia: si el límite
  // quedaba corto devolvía "bloqueado" con los lotes YA vaciados y sin asiento, así que
  // esos créditos desaparecían del libro. Al arreglarlo pasó al otro extremo —todo o
  // nada— y eso abrió un agujero peor: **el servicio gratis permanente**.
  //
  // Cómo se llegaba: el gate de antes de responder solo pregunta "¿queda al menos un
  // crédito o colchón?" (`ai-credits.ts`), porque todavía no sabe cuántos tokens va a
  // gastar el turno. Un turno caro —peso 20 o 50— puede pedir mucho más que lo que queda.
  // Con el todo-o-nada ese turno NO se cobraba, la respuesta ya estaba generada y enviada,
  // y el estado quedaba IDÉNTICO para el turno siguiente: gate pasa, consumo rechaza, otra
  // respuesta gratis. Para siempre, con el saldo congelado y sin un asiento que lo delate.
  // Un cliente con 3 créditos y un agente Sonnet tenía respuestas ilimitadas gratis.
  //
  // Ahora se cobra `min(pedido, lotes + colchón que queda)`: el cliente paga todo lo que se
  // le puede cobrar, la gracia aterriza EXACTAMENTE en el tope y por eso el gate del turno
  // siguiente sí corta (`grace < graceLimit` deja de ser verdad). Lo que no se pudo cobrar
  // se informa (`alTope`) para que quede en el consumo y la auditoría lo pueda nombrar:
  // es el único regalo, el de la última respuesta, y es el precio de no dejar al bot mudo.
  const disponible = await balanceInTx(tx, organizationId, opts.now);
  const colchon = Math.max(0, opts.graceLimit - disponible.grace);
  const cobrable = disponible.lots + colchon;
  if (cobrable <= 0) {
    // Ni saldo ni colchón: acá sí se bloquea (y el gate ya lo había visto venir).
    return { ok: false as const, graceUsed: disponible.grace };
  }
  let need = Math.min(pedido, cobrable);
  const alTope = need < pedido;

  const lots = await tx.conversationCreditLot.findMany({
    where: { organizationId, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: opts.now } }] },
    orderBy: [{ expiresAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
  });
  for (const lot of lots) {
    if (need <= 0) break;
    const take = Math.min(lot.remaining, need);
    await tx.conversationCreditLot.update({ where: { id: lot.id }, data: { remaining: lot.remaining - take } });
    need -= take;
  }

  const wallet = await ensureWallet(tx, organizationId, opts.now);
  let graceUsed = wallet.graceUsed;
  if (need > 0) {
    graceUsed += need;
    await tx.conversationWallet.update({ where: { organizationId }, data: { graceUsed } });
  }
  return { ok: true as const, graceUsed, consumido: Math.min(pedido, cobrable), alTope };
}

/**
 * Debita `multiplier` créditos por UNA conversación. Consume lotes FIFO por expiración;
 * si no alcanzan, usa GRACIA hasta GRACE_LIMIT; superada la gracia, devuelve blocked
 * (el caller responde con la frase de respaldo + deriva, nunca se calla). Serializa por
 * org bloqueando la fila del wallet (withTenant = transacción). El caller lo invoca solo
 * cuando la conversación se contó por primera vez en el período (idempotente de origen).
 */
export async function debitConversation(
  organizationId: string,
  input: { conversationId: string; multiplier?: number; costUsd?: number },
): Promise<ConversationDebit> {
  const m = Math.max(1, Math.round(input.multiplier ?? 1));
  const now = new Date();
  return withTenant(organizationId, async (tx) => {
    // Serializa los débitos de la org (evita carreras sobre los lotes).
    await lockOrg(tx, organizationId);
    await ensurePeriodAccrued(tx, organizationId, now);

    // Lotes FIFO + gracia: mismo núcleo que los Créditos IA (una sola forma de calcular
    // el saldo). Gracia agotada → blocked: el caller manda la frase de respaldo y deriva.
    const consumo = await consumeCreditsInTx(tx, organizationId, { amount: m, graceLimit: GRACE_LIMIT, now });
    if (!consumo.ok) return { ok: false as const, blocked: true as const, graceUsed: consumo.graceUsed };
    const graceUsed = consumo.graceUsed;

    const after = await balanceInTx(tx, organizationId, now);
    await tx.conversationCreditLedger.create({
      data: {
        organizationId,
        // Lo que de verdad se consumió, no lo que se pidió: con el colchón al tope puede
        // ser menos, y un asiento por más de lo consumido descuadraría el libro.
        delta: -consumo.consumido,
        reason: "conversation_debit",
        balanceAfter: after.net,
        costUsd: input.costUsd != null ? input.costUsd : undefined,
        conversationId: input.conversationId,
      },
    });
    return { ok: true as const, balanceAfter: after.net, inGrace: graceUsed > 0, graceUsed };
  });
}

/** Medidor de la bolsa de conversaciones para GET /billing/wallet/summary (unidad conversación). */
export async function getConversationWalletSummary(organizationId: string): Promise<{
  unit: "conversation";
  included: number;
  used: number;
  remaining: number;
  graceUsed: number;
  graceLimit: number;
  expiringThisMonth: number;
}> {
  const now = new Date();
  return withTenant(organizationId, async (tx) => {
    const feats = await planFeatures(organizationId);
    const included = Number(feats.conversationsIncluded) || 0;
    // Acredita el período ANTES de leer (mismo lock que el débito): sin esto, una org
    // recién contratada vería "used = included / quedan 0" hasta su primer débito.
    await lockOrg(tx, organizationId);
    await ensurePeriodAccrued(tx, organizationId, now);
    const bal = await balanceInTx(tx, organizationId, now);
    const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const expiring = await tx.conversationCreditLot.aggregate({
      _sum: { remaining: true },
      where: { organizationId, remaining: { gt: 0 }, expiresAt: { gt: now, lt: endOfMonth } },
    });
    return {
      unit: "conversation" as const,
      included,
      used: Math.max(0, included - bal.lots),
      remaining: bal.net,
      graceUsed: bal.grace,
      graceLimit: GRACE_LIMIT,
      expiringThisMonth: expiring._sum.remaining ?? 0,
    };
  });
}

/**
 * Decide si disparar un aviso de crédito (una vez por umbral/período): 75%, 90% o gracia.
 * Actualiza lastNotifiedPct para no repetir (se resetea al acreditar un período nuevo).
 */
export async function creditsNotifyDecision(
  organizationId: string,
): Promise<{ fire: "low75" | "low90" | "grace" | null; used: number; included: number; grace: number }> {
  const s = await getConversationWalletSummary(organizationId);
  const pct = s.included > 0 ? Math.round((s.used / s.included) * 100) : 0;
  return withTenant(organizationId, async (tx) => {
    const w = await tx.conversationWallet.findUnique({ where: { organizationId }, select: { lastNotifiedPct: true } });
    const last = w?.lastNotifiedPct ?? 0;
    let fire: "low75" | "low90" | "grace" | null = null;
    let mark = last;
    if (s.graceUsed > 0 && last < 100) {
      fire = "grace";
      mark = 100;
    } else if (pct >= 90 && last < 90) {
      fire = "low90";
      mark = 90;
    } else if (pct >= 75 && last < 75) {
      fire = "low75";
      mark = 75;
    }
    if (fire) await tx.conversationWallet.update({ where: { organizationId }, data: { lastNotifiedPct: mark } }).catch(() => undefined);
    return { fire, used: s.used, included: s.included, grace: s.graceUsed };
  });
}

/**
 * Expira los lotes vencidos (remaining→0 + asiento "expiry"). El saldo ya los excluye por
 * fecha, así que esto es higiene contable/auditoría. Corre periódico (barrido por org).
 */
export async function expireConversationLots(): Promise<number> {
  const prisma = getAdminPrisma();
  const now = new Date();
  const due = await prisma.conversationCreditLot.findMany({
    where: { remaining: { gt: 0 }, expiresAt: { lt: now } },
    select: { id: true, organizationId: true, remaining: true },
    take: 1000,
  });
  const byOrg = new Map<string, { id: string; remaining: number }[]>();
  for (const l of due) (byOrg.get(l.organizationId) ?? byOrg.set(l.organizationId, []).get(l.organizationId)!).push(l);
  let expired = 0;
  for (const [organizationId, lots] of byOrg) {
    await withTenant(organizationId, async (tx) => {
      for (const l of lots) {
        await tx.conversationCreditLot.update({ where: { id: l.id }, data: { remaining: 0 } });
        const after = await balanceInTx(tx, organizationId, now);
        await tx.conversationCreditLedger.create({
          data: { organizationId, delta: -l.remaining, reason: "expiry", balanceAfter: after.net, refType: "lot", refId: l.id },
        });
        expired += l.remaining;
      }
    }).catch(() => undefined);
  }
  return expired;
}
