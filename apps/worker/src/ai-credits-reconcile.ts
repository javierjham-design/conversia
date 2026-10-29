import { getEnv } from "@conversia/config";
import { getAdminPrisma, raiseException } from "@conversia/database";
import { debitAiCreditsForTurn, planDebitsAiCredits } from "./ai-credits";

/**
 * CRE — COBRAR LAS RESPUESTAS QUE QUEDARON SIN COBRAR.
 *
 * El cobro de un turno NO frena la respuesta, a propósito: si el débito falla, el cliente
 * igual recibe su mensaje (`agent-turn.ts` lo envuelve en un `catch`). Esa decisión está
 * bien —el bot no se calla por un problema nuestro— pero tal como estaba, la respuesta se
 * iba y el cargo se perdía para siempre, sin deuda registrada y sin aviso.
 *
 * No es teórico: la prueba de carga mató el worker a mitad del trabajo y de 30 respuestas
 * quedaron 29 cobradas. Una respuesta enviada, cero créditos, y nada en el sistema que lo
 * dijera. Con despliegues, reinicios y timeouts de base, eso es una fuga constante y
 * silenciosa — y cae justo sobre los turnos más caros, que son los que más tardan.
 *
 * Esto lo cierra por el otro lado: cada tanto se buscan los turnos que el bot RESPONDIÓ y
 * que no tienen asiento, y se cobran. Es seguro por construcción:
 *
 *  - Cobra con `debitAiCreditsForTurn`, el MISMO camino que el cobro en vivo, con los
 *    tokens y el modelo que quedaron guardados en `ai_requests`. No hay una segunda forma
 *    de calcular el precio que pueda quedar desfasada.
 *  - Es IDEMPOTENTE por el sello del turno (`refType:'turn'`, `refId: ai_requests.id`): si
 *    el cobro en vivo ya pasó, el segundo intento no cobra nada. Por eso puede correr en
 *    paralelo con el tráfico sin riesgo de cobrar dos veces.
 *  - Deja un margen de gracia temporal (`MINUTOS_DE_GRACIA`) para no pisarse con el cobro
 *    en vivo de un turno que acaba de responder.
 *  - Si encuentra MUCHOS, levanta una excepción: un puñado es un reinicio; cientos son un
 *    problema sistémico del cobro y alguien tiene que mirarlo.
 */

/** Un turno recién respondido todavía puede estar cobrándose en vivo. */
export const MINUTOS_DE_GRACIA = 3;

/** El valor vigente (el simulador lo baja para poder verificar la recuperación). */
function minutosDeGracia(): number {
  const v = Number(getEnv().AI_CREDITS_RECONCILE_GRACIA_MIN);
  return Number.isFinite(v) && v >= 0 ? v : MINUTOS_DE_GRACIA;
}

/** Cuántos turnos sin cobrar son "raro" y merecen una excepción para el super admin. */
export const SOSPECHOSO = 25;

export interface ResultadoReconciliacion {
  /** Turnos sin asiento que se encontraron. */
  encontrados: number;
  /** Turnos que este pase llegó a cobrar. */
  cobrados: number;
  /** Créditos recuperados. */
  creditos: number;
  /** Turnos que no se pudieron cobrar (sin saldo, o la org ya no cobra créditos). */
  sinCobrar: number;
}

export async function cobrarTurnosSinCobrar(
  opts: { horas?: number; tope?: number; now?: Date } = {},
): Promise<ResultadoReconciliacion> {
  const admin = getAdminPrisma();
  const now = opts.now ?? new Date();
  const desde = new Date(now.getTime() - (opts.horas ?? 48) * 3_600_000);
  const hasta = new Date(now.getTime() - minutosDeGracia() * 60_000);
  const tope = opts.tope ?? 500;

  // Turnos CHAT sin asiento de cobro. El LEFT JOIN es por el sello del turno, que es
  // exactamente la clave de idempotencia del débito.
  const huerfanos = await admin.$queryRaw<
    Array<{
      id: string;
      organizationId: string;
      conversationId: string | null;
      model: string;
      configuredModel: string | null;
      inputTokens: number;
      outputTokens: number;
      costUsd: unknown;
      agentId: string | null;
    }>
  >`
    SELECT r.id, r.organization_id AS "organizationId", r.conversation_id AS "conversationId",
           r.model, r.configured_model AS "configuredModel",
           r.input_tokens AS "inputTokens", r.output_tokens AS "outputTokens",
           r.cost_usd AS "costUsd", r.agent_id AS "agentId"
    FROM ai_requests r
    LEFT JOIN conversation_credit_ledger l
      ON l.ref_type = 'turn' AND l.ref_id = r.id AND l.reason = 'ai_credit_debit'
    WHERE r.purpose = 'CHAT'
      AND r.created_at >= ${desde}
      AND r.created_at <= ${hasta}
      AND (r.input_tokens + r.output_tokens) > 0
      AND l.id IS NULL
    ORDER BY r.created_at
    LIMIT ${tope}`;

  let cobrados = 0;
  let creditos = 0;
  let sinCobrar = 0;
  // Se consulta UNA vez por organización si su plan cobra créditos: un turno viejo de una
  // cuenta que todavía cobraba por conversación no se cobra acá (ya se cobró en la otra
  // unidad), y preguntarlo por turno serían cientos de consultas iguales.
  const cobraCreditos = new Map<string, boolean>();
  const porOrg = new Map<string, number>();
  let aplicables = 0;

  for (const t of huerfanos) {
    let cobra = cobraCreditos.get(t.organizationId);
    if (cobra === undefined) {
      cobra = await planDebitsAiCredits(t.organizationId).catch(() => false);
      cobraCreditos.set(t.organizationId, cobra);
    }
    if (!cobra) continue;
    aplicables++;
    porOrg.set(t.organizationId, (porOrg.get(t.organizationId) ?? 0) + 1);
    const r = await debitAiCreditsForTurn(t.organizationId, {
      conversationId: t.conversationId ?? "",
      turnId: t.id,
      model: t.model,
      // Nulo en las filas anteriores a la columna: ahí se cobra el que respondió, que es el
      // comportamiento que tenían cuando se emitieron.
      configuredModel: t.configuredModel,
      inputTokens: Number(t.inputTokens),
      outputTokens: Number(t.outputTokens),
      costUsd: t.costUsd == null ? undefined : Number(t.costUsd),
      agentId: t.agentId ?? undefined,
    }).catch(() => null);
    if (r?.charged) {
      cobrados++;
      creditos += r.credits;
    } else {
      sinCobrar++;
    }
  }

  // La excepción va POR ORGANIZACIÓN, no una global: una excepción sin cuenta no se puede
  // accionar, y la consola de operación trabaja por cliente. Un puñado de turnos es un
  // reinicio normal; esta cantidad en UNA cuenta apunta a que su cobro falla siempre.
  for (const [orgId, cuantos] of porOrg) {
    if (cuantos < SOSPECHOSO) continue;
    await raiseException(admin, {
      organizationId: orgId,
      type: "cobros_de_ia_sin_asiento",
      severity: "critical",
      title: `${cuantos} respuestas del bot quedaron sin cobrar`,
      detail:
        `La reconciliación encontró ${cuantos} turnos respondidos sin asiento de cobro en las últimas ` +
        `${opts.horas ?? 48} h. Un puñado es un reinicio del worker; esta cantidad apunta a que el cobro de ` +
        `esta cuenta está fallando de forma sistemática (revisá los errores del débito en el worker).`,
      dedupeKey: `reconciliacion:${orgId}:${desde.toISOString().slice(0, 10)}`,
    }).catch(() => undefined);
  }

  return { encontrados: aplicables, cobrados, creditos, sinCobrar };
}

/** Cada cuánto se pasa a buscar respuestas sin cobrar (por defecto 10 min). */
export const TICK_MS = 10 * 60 * 1000;

/**
 * Arranca el pase periódico. Va APARTE del tick de cobro recurrente a propósito: ese
 * depende de `RECURRING_BILLING_ENABLED`, y si estuviera apagado se perderían igual los
 * cargos de los turnos. Esto tiene que correr siempre que se esté cobrando por crédito.
 */
export function startAiCreditsReconcile(): () => void {
  const run = async () => {
    try {
      const r = await cobrarTurnosSinCobrar();
      if (r.encontrados > 0) {
        console.log(
          `• Cobros de IA recuperados: ${r.cobrados}/${r.encontrados} turnos (${r.creditos} créditos)` +
            `${r.sinCobrar > 0 ? ` · ${r.sinCobrar} sin saldo para cobrar` : ""}.`,
        );
      }
    } catch (err) {
      console.error("✖ reconciliación de cobros de IA:", (err as Error).message);
    }
  };
  void run();
  const cada = Number(getEnv().AI_CREDITS_RECONCILE_MS) || TICK_MS;
  const interval = setInterval(run, cada);
  interval.unref?.();
  return () => clearInterval(interval);
}
