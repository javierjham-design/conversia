import { getAdminPrisma, leerMuestraConsumoCreditos, leerPromedioDelRubro, raiseException, withTenant } from "@conversia/database";
import {
  CREDIT_POLICY_SEED,
  creditsForTurn,
  estimarAlcance,
  explicarBase,
  frasePorSaldo,
  parseCreditPolicy,
  type CreditPolicy,
  type Estimacion,
  type TurnCredits,
} from "@conversia/agents";
import {
  balanceInTx,
  consumeCreditsInTx,
  ensurePeriodAccrued,
  isConversiaOrg,
  planFeatures,
} from "./conversation-credits";

/**
 * CRE 1 — MOTOR DE CRÉDITOS IA. Cobra POR RESPUESTA DEL BOT, ajustada por los tokens
 * reales del turno y el peso del modelo que efectivamente respondió
 * (`docs/MODELO_COBRO_CREDITOS_IA.md` §4). Reemplaza al cobro por conversación, que se
 * quedaba corto justamente donde dolía: una sola conversación con Opus costó USD 13 y
 * habría consumido 1 crédito (§7).
 *
 * REUTILIZA el monedero que ya existe —lotes con vencimiento, consumo FIFO, gracia y
 * libro contable de `conversation-credits.ts`—; lo único distinto es CUÁNTO se debita y
 * CUÁNDO. No hay un segundo sistema de saldo.
 *
 * DOBLE GUARDA, como el resto del dinero: marca `conversia` Y feature del plan. TuBot no
 * puede entrar acá ni por un plan mal marcado a mano.
 *
 * EL BOT NUNCA QUEDA MUDO: al agotarse la gracia, el turno NO llama al modelo y el caller
 * manda la frase de respaldo del tenant y deriva a una persona.
 */

const POLICY_KEY = "aiCredits";
let policyCache: { at: number; policy: CreditPolicy } | null = null;
const POLICY_TTL_MS = 60_000;

/**
 * Política vigente desde `platform_settings.aiCredits` (pesos, tamaño del bloque y
 * gracia). Cacheada 60 s como el resto de la configuración de cobro: el dueño cambia un
 * peso y entra solo, sin desplegar. Si la fila no está o está corrupta, se usa la semilla
 * calibrada — nunca "cobro 0", que sería regalar el servicio.
 */
export async function readCreditPolicy(): Promise<CreditPolicy> {
  if (policyCache && Date.now() - policyCache.at < POLICY_TTL_MS) return policyCache.policy;
  let policy = CREDIT_POLICY_SEED;
  try {
    const row = await getAdminPrisma().platformSetting.findUnique({ where: { key: POLICY_KEY } });
    if (row) policy = parseCreditPolicy(JSON.parse(row.value));
  } catch {
    /* semilla */
  }
  policyCache = { at: Date.now(), policy };
  return policy;
}

/** Solo para los tests: olvida la política cacheada. */
export function resetCreditPolicyCache(): void {
  policyCache = null;
}

/** ¿El plan vigente de la org cobra Créditos IA (unidad nueva)? Doble guarda. */
export async function planDebitsAiCredits(organizationId: string): Promise<boolean> {
  if (!(await isConversiaOrg(organizationId))) return false;
  return (await planFeatures(organizationId)).aiCreditsWallet === true;
}

export type AiCreditsGate =
  | { charges: false }
  | { charges: true; blocked: false; remaining: number; graceUsed: number }
  | { charges: true; blocked: true; remaining: number; graceUsed: number };

/**
 * Verificación ANTES de generar la respuesta: ¿queda saldo o gracia?
 *
 * Es una consulta, no un débito: lo que se cobra son los tokens reales al terminar el
 * turno (§Etapa 1). Se mira antes para no gastar una llamada al modelo que después no
 * vamos a poder cobrar, y para que el cliente sin saldo reciba la frase de respaldo en
 * vez de una respuesta que ya costó plata.
 *
 * El criterio es "¿puede pagar UNA respuesta más?": alcanza con que quede 1 crédito o
 * gracia disponible. No se exige el costo del turno completo porque todavía no se sabe
 * cuántos tokens va a usar, y negarse por un turno que podría costar 1 crédito dejaría
 * al bot callado con saldo en mano.
 */
export async function aiCreditsGate(organizationId: string): Promise<AiCreditsGate> {
  if (!(await planDebitsAiCredits(organizationId))) return { charges: false };
  const policy = await readCreditPolicy();
  const now = new Date();
  try {
    return await withTenant(organizationId, async (tx) => {
      await ensurePeriodAccrued(tx, organizationId, now, { includedKey: "aiCreditsIncluded" });
      const bal = await balanceInTx(tx, organizationId, now);
      const puedeUnaMas = bal.lots > 0 || bal.grace < policy.graceCredits;
      return {
        charges: true as const,
        blocked: !puedeUnaMas,
        remaining: bal.net,
        graceUsed: bal.grace,
      };
    });
  } catch {
    // FALLA ABIERTO. Una caída de la base no puede callar al bot de un cliente que SÍ
    // tiene saldo; el débito posterior igual se intenta y, si no hay con qué, el próximo
    // turno sí bloquea. Un error de infraestructura nuestro no se le cobra al cliente
    // en silencio ni se le corta el servicio.
    return { charges: true as const, blocked: false, remaining: 0, graceUsed: 0 };
  }
}

export type AiCreditsDebit =
  | { charged: false; reason: "no_aplica" | "sin_tokens" | "ya_debitado" }
  | { charged: true; credits: number; balanceAfter: number; inGrace: boolean; graceUsed: number; detail: TurnCredits }
  | { charged: false; reason: "sin_saldo"; credits: number; graceUsed: number };

export interface TurnUsage {
  conversationId: string;
  /** Id del turno: el `ai_requests.id` de ESTE turno. Sella la idempotencia del débito. */
  turnId: string;
  /** Modelo que RESPONDIÓ (si el router cambió de proveedor, el que terminó respondiendo). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Costo real en USD del turno, para el reporte de margen (Etapa 4). */
  costUsd?: number;
  agentId?: string;
}

/**
 * Debita los Créditos IA de UN turno del agente, con los tokens reales.
 *
 * IDEMPOTENTE POR TURNO: el asiento se sella con `refType: "turn"` + `refId: turnId`
 * (el id del `ai_requests` del turno). Si el job se reintenta después de haber debitado,
 * no se cobra dos veces. Sin esto, cada reintento de la cola le costaría plata al cliente.
 *
 * El detalle que explica el cargo —tokens de entrada y salida, modelo, nivel, bloques y
 * costo USD— queda en `usage_events` (tipo `ai_credits`), que es la tabla de consumo que
 * ya alimenta los medidores. El asiento del libro guarda los créditos, el costo y la
 * conversación, igual que el resto del dinero.
 */
export async function debitAiCreditsForTurn(organizationId: string, usage: TurnUsage): Promise<AiCreditsDebit> {
  if (!(await planDebitsAiCredits(organizationId))) return { charged: false, reason: "no_aplica" };

  const policy = await readCreditPolicy();
  const tokens = Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens);
  const detail = creditsForTurn({ model: usage.model, tokens, policy });
  // Turno sin llamada a la IA (proveedor caído, modo degradado): no se cobra nada.
  if (detail.credits <= 0) return { charged: false, reason: "sin_tokens" };

  // Modelo sin peso definido: se cobró como premium y el super admin tiene que enterarse
  // (§4). Dedupe por modelo: una excepción por modelo nuevo, no una por respuesta.
  if (!detail.modelKnown) {
    await raiseException(getAdminPrisma(), {
      organizationId,
      type: "modelo_sin_peso_de_credito",
      severity: "warning",
      title: `Modelo sin peso de créditos: ${usage.model}`,
      detail:
        `El agente respondió con "${usage.model}", que no está en la política de Créditos IA ` +
        `(platform_settings.${POLICY_KEY}). Se cobró como premium (${detail.weight} créditos por bloque). ` +
        `Definí su peso o cambiá el modelo del agente.`,
      dedupeKey: usage.model,
    }).catch(() => undefined);
  }

  const now = new Date();
  return withTenant(organizationId, async (tx) => {
    // Serializa los débitos de la org: dos turnos a la vez no pueden gastar el mismo lote.
    await tx.$executeRaw`SELECT grace_used FROM conversation_wallets WHERE organization_id = ${organizationId} FOR UPDATE`;

    const yaEsta = await tx.conversationCreditLedger.findFirst({
      where: { organizationId, reason: "ai_credit_debit", refType: "turn", refId: usage.turnId },
      select: { id: true },
    });
    if (yaEsta) return { charged: false as const, reason: "ya_debitado" as const };

    await ensurePeriodAccrued(tx, organizationId, now, { includedKey: "aiCreditsIncluded" });

    const consumo = await consumeCreditsInTx(tx, organizationId, {
      amount: detail.credits,
      graceLimit: policy.graceCredits,
      now,
    });
    if (!consumo.ok) {
      return { charged: false as const, reason: "sin_saldo" as const, credits: detail.credits, graceUsed: consumo.graceUsed };
    }

    const after = await balanceInTx(tx, organizationId, now);
    await tx.conversationCreditLedger.create({
      data: {
        organizationId,
        delta: -detail.credits,
        reason: "ai_credit_debit",
        balanceAfter: after.net,
        costUsd: usage.costUsd != null ? usage.costUsd : undefined,
        conversationId: usage.conversationId,
        refType: "turn",
        refId: usage.turnId,
      },
    });
    await tx.usageEvent.create({
      data: {
        organizationId,
        type: "ai_credits",
        quantity: detail.credits,
        costUsd: usage.costUsd != null ? usage.costUsd : undefined,
        meta: {
          conversationId: usage.conversationId,
          turnId: usage.turnId,
          agentId: usage.agentId ?? null,
          model: usage.model,
          level: detail.level,
          weight: detail.weight,
          blocks: detail.blocks,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          tokensPerCredit: policy.tokensPerCredit,
        },
      },
    });

    return {
      charged: true as const,
      credits: detail.credits,
      balanceAfter: after.net,
      inGrace: consumo.graceUsed > 0,
      graceUsed: consumo.graceUsed,
      detail,
    };
  });
}

/** Medidor de Créditos IA (lo consume el panel en la Etapa 3; acá lo usan los tests y el gate). */
export async function getAiCreditsSummary(organizationId: string): Promise<{
  unit: "credit";
  included: number;
  used: number;
  remaining: number;
  graceUsed: number;
  graceLimit: number;
}> {
  const policy = await readCreditPolicy();
  const now = new Date();
  return withTenant(organizationId, async (tx) => {
    const feats = await planFeatures(organizationId);
    const included = Number(feats.aiCreditsIncluded) || 0;
    await tx.$executeRaw`SELECT grace_used FROM conversation_wallets WHERE organization_id = ${organizationId} FOR UPDATE`;
    await ensurePeriodAccrued(tx, organizationId, now, { includedKey: "aiCreditsIncluded" });
    const bal = await balanceInTx(tx, organizationId, now);
    return {
      unit: "credit" as const,
      included,
      used: Math.max(0, included - bal.lots),
      remaining: bal.net,
      graceUsed: bal.grace,
      graceLimit: policy.graceCredits,
    };
  });
}

/**
 * CRE 3 — AVISOS POR UMBRAL para la unidad de Créditos IA (75%, 90% y gracia).
 *
 * AGUJERO QUE CIERRA: los avisos de saldo vivían SOLO en el camino del cobro por
 * conversación (`creditsNotifyDecision`, que dispara dentro de
 * `planDebitsConversation`). CRE 1 hizo que `planDebitsConversation` devuelva false cuando
 * el plan cobra Créditos IA —correcto, para no cobrar dos veces—, y con eso un cliente de
 * créditos dejó de recibir CUALQUIER aviso: el bot se le paraba sin una sola advertencia
 * previa. Es el peor momento posible para enterarse.
 *
 * Reutiliza `conversation_wallets.lastNotifiedPct` (mismo campo, mismo monedero, se
 * reinicia al acreditar el período nuevo), así que no hay estado nuevo ni migración. La
 * decisión es idéntica a la de conversaciones: una vez por umbral y por período.
 */
export async function aiCreditsNotifyDecision(
  organizationId: string,
): Promise<{ fire: "low75" | "low90" | "grace" | null; used: number; included: number; remaining: number; graceUsed: number }> {
  const s = await getAiCreditsSummary(organizationId);
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
    return { fire, used: s.used, included: s.included, remaining: s.remaining, graceUsed: s.graceUsed };
  });
}

/**
 * CRE 3 — EL MEDIDOR: saldo + la traducción a conversaciones y días.
 *
 * Es la MISMA función que alimenta el panel (vía el endpoint del API), el copiloto y los
 * avisos: un solo cálculo para que las tres superficies no digan números distintos del
 * mismo saldo. La aritmética es pura (`estimarAlcance`, en `@conversia/agents`) y acá va
 * solo la lectura de datos.
 */
export async function getAiCreditsMeter(organizationId: string): Promise<{
  summary: Awaited<ReturnType<typeof getAiCreditsSummary>>;
  estimate: Estimacion;
  frase: string;
  explicacion: string;
}> {
  const summary = await getAiCreditsSummary(organizationId);
  const admin = getAdminPrisma();
  const org = await admin.organization
    .findUnique({ where: { id: organizationId }, select: { settings: true } })
    .catch(() => null);
  const rubro = String((((org?.settings ?? {}) as Record<string, any>).general ?? {}).industry ?? "");
  // Cada lectura accesoria degrada a su valor neutro: una muestra que no se pudo leer da
  // una estimación con el promedio del rubro o el general, nunca un error en pantalla.
  const propio = await withTenant(organizationId, (tx) => leerMuestraConsumoCreditos(tx, organizationId)).catch(
    () => ({ conversaciones: 0, creditos: 0, dias: 0 }),
  );
  const promedioDelRubro = await leerPromedioDelRubro(admin, rubro).catch(() => null);
  const estimate = estimarAlcance({ restantes: summary.remaining, propio, promedioDelRubro });
  return { summary, estimate, frase: frasePorSaldo(estimate), explicacion: explicarBase(estimate) };
}
