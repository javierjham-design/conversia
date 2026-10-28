import { CREDIT_POLICY_SEED, parseCreditPolicy, weightOfModel, type CreditPolicy } from "@conversia/agents";
import { brandOf } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";

/**
 * CRE 1 — QUIÉN ELIGE EL MODELO DE IA (`docs/MODELO_COBRO_CREDITOS_IA.md` §4).
 *
 * Decisión del dueño (27-oct): en Conversia el modelo lo fija la PLATAFORMA, no el
 * cliente. Todo bot nace con el modelo estándar y uno más caro se activa solo desde el
 * super admin, con el cliente avisado y conforme.
 *
 * El motivo es económico y concreto: con Créditos IA, el modelo multiplica el consumo del
 * cliente (gpt-4o-mini cuesta 1 crédito por respuesta; claude-opus, 50). Si el cliente
 * pudiera cambiarlo desde su panel —o pedírselo al copiloto— se quedaría sin saldo en una
 * tarde sin entender por qué, y nos reclamaría con razón.
 *
 * Esta guarda es de SERVIDOR. Que el panel no muestre el selector no alcanza: `PUT
 * /agents/:id/draft` acepta el `config` completo, así que un cliente con el token de su
 * propia cuenta podía mandar `config.model = "claude-opus-4-8"` con curl.
 */

const POLICY_KEY = "aiCredits";
let cache: { at: number; policy: CreditPolicy } | null = null;
const TTL_MS = 60_000;

/** Política de modelos y créditos vigente (platform_settings.aiCredits). Cache 60 s. */
export async function readAiModelPolicy(): Promise<CreditPolicy> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.policy;
  let policy = CREDIT_POLICY_SEED;
  try {
    const row = await getAdminPrisma().platformSetting.findUnique({ where: { key: POLICY_KEY } });
    if (row) policy = parseCreditPolicy(JSON.parse(row.value));
  } catch {
    /* semilla */
  }
  cache = { at: Date.now(), policy };
  return policy;
}

/** Solo para los tests. */
export function resetAiModelPolicyCache(): void {
  cache = null;
}

/** Modelo con el que nace un bot nuevo. Sale de configuración, nunca de una constante. */
export async function defaultAgentModel(): Promise<string> {
  return (await readAiModelPolicy()).defaultModel;
}

/** ¿La organización es de marca Conversia? (el candado aplica solo ahí; TuBot sigue igual) */
export async function orgIsConversia(organizationId: string): Promise<boolean> {
  try {
    const org = await getAdminPrisma().organization.findUnique({ where: { id: organizationId }, select: { brand: true } });
    return brandOf(org).key === "conversia";
  } catch {
    // Ante la duda NO se bloquea: este candado no puede ser el motivo de que un cliente
    // no pueda guardar su bot. El cobro ya está protegido por su propia doble guarda.
    return false;
  }
}

export interface ModelLockResult {
  /** Config que hay que guardar (con el modelo que corresponde). */
  config: Record<string, unknown>;
  /** true si el pedido traía otro modelo y se ignoró (para auditar). */
  overridden: boolean;
  /** Modelo que pedía el cliente, cuando se ignoró. */
  requested?: string;
}

/**
 * Deja el `config` listo para guardar con el modelo que manda la plataforma.
 *
 * IGNORA en vez de rechazar, a propósito: el editor del panel manda el `config` completo
 * (incluido el modelo actual) en cada guardado. Si esto devolviera un error, un cliente
 * de Conversia no podría editar el prompt de su bot. Entonces se conserva el modelo
 * vigente —o el estándar si el agente es nuevo— y se sigue; el intento queda auditado.
 */
export async function applyModelLock(input: {
  organizationId: string;
  incoming: Record<string, unknown>;
  /** Config de la versión actual del agente (undefined si recién se crea). */
  current?: Record<string, unknown> | null;
}): Promise<ModelLockResult> {
  const incoming = { ...(input.incoming ?? {}) };
  if (!(await orgIsConversia(input.organizationId))) return { config: incoming, overridden: false };

  const actual = typeof input.current?.model === "string" ? (input.current.model as string) : null;
  const permitido = actual ?? (await defaultAgentModel());
  const pedido = typeof incoming.model === "string" ? incoming.model : null;
  incoming.model = permitido;
  if (pedido && pedido !== permitido) return { config: incoming, overridden: true, requested: pedido };
  return { config: incoming, overridden: false };
}

/**
 * Impacto de cambiar el modelo de un agente, en el lenguaje del cliente: cuántos créditos
 * consume cada respuesta y, con su saldo actual, para cuántas conversaciones le alcanza.
 * Lo usa el aviso que el cliente tiene que aceptar antes de que se active un modelo más
 * caro (§4) — "con el modelo Plus tus 1.000 créditos rinden ~60 conversaciones en vez de
 * ~240".
 */
export function modelChangeImpact(input: {
  from: string;
  to: string;
  remainingCredits: number;
  policy?: CreditPolicy;
  /** Créditos por conversación del cliente; por defecto el supuesto del §5. */
  creditsPerConversationAtStandard?: number;
}): {
  from: { model: string; creditsPerReply: number; level: string; conversations: number };
  to: { model: string; creditsPerReply: number; level: string; conversations: number };
  cheaper: boolean;
} {
  const policy = input.policy ?? CREDIT_POLICY_SEED;
  const base = Math.max(0.1, input.creditsPerConversationAtStandard ?? 4.2);
  const lado = (model: string) => {
    const w = weightOfModel(model, policy);
    // Una conversación con otro modelo cuesta lo mismo en tokens; lo que cambia es el peso.
    const porConversacion = base * w.credits;
    return {
      model,
      creditsPerReply: w.credits,
      level: w.level as string,
      conversations: Math.floor(Math.max(0, input.remainingCredits) / porConversacion),
    };
  };
  const from = lado(input.from);
  const to = lado(input.to);
  return { from, to, cheaper: to.creditsPerReply <= from.creditsPerReply };
}
