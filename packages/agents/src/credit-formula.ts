/**
 * CRE 1 — FÓRMULA DE CRÉDITOS IA (pura, sin I/O).
 *
 * Unidad de cobro de Conversia: el cliente ve "respuestas de mi bot" y por dentro se
 * calcula con los tokens reales de la respuesta y el modelo que efectivamente la generó
 * (`docs/MODELO_COBRO_CREDITOS_IA.md` §4):
 *
 *     créditos = peso_del_modelo × máx(1, techo(tokens_del_turno / TOKENS_POR_CRÉDITO))
 *
 * `tokens_del_turno` son TODOS los tokens de la vuelta del agente: la llamada principal,
 * las rondas de herramientas y cualquier clasificación. El orquestador ya los acumula en
 * `result.usage`, así que acá llega una sola suma.
 *
 * POR QUÉ ES PURA: la debita el worker, la muestra el super admin (peso por agente) y la
 * usará el estimador del panel. Una sola implementación, un solo lugar donde equivocarse.
 *
 * LOS VALORES NO VIVEN ACÁ. `CREDIT_POLICY_SEED` es la SEMILLA que se escribe en
 * `platform_settings.aiCredits` (ver `packages/database/scripts/seed-ai-credits-policy.mjs`);
 * en caliente la política vigente SIEMPRE se lee de esa fila, así el dueño cambia pesos y
 * umbrales sin tocar código ni desplegar. La semilla queda en el repo solo para que un
 * entorno nuevo (o el sim) arranque con los valores calibrados del §4 en vez de con nada.
 */

/** Nivel de IA que ve el cliente. Es una ETIQUETA; lo que cobra es `credits`. */
export type AiLevel = "standard" | "plus" | "advanced" | "premium";

export interface ModelCreditWeight {
  level: AiLevel;
  /** Créditos por respuesta normal (un bloque de tokens) con este modelo. */
  credits: number;
}

export interface CreditPolicy {
  /** Tamaño del bloque: cada bloque de tokens del turno cuesta un peso completo. */
  tokensPerCredit: number;
  /** Peso por modelo exacto (el que respondió, no el configurado). */
  models: Record<string, ModelCreditWeight>;
  /** Modelo sin nivel conocido: se cobra como premium y se alerta al super admin (§4). */
  unknownModel: ModelCreditWeight;
  /** Créditos de gracia: el bot sigue respondiendo en negativo hasta acá (§6). */
  graceCredits: number;
  /**
   * Modelo con el que NACE todo bot de cliente (§4, "quién elige el modelo"). Vive acá y
   * no en el código para que el equipo de Conversia pueda cambiarlo sin desplegar; el
   * cliente no lo elige nunca.
   */
  defaultModel: string;
}

/**
 * Semilla calibrada con los costos REALES de producción del 25-jul al 26-oct-2026
 * (§7, medidos por el dueño) para que un crédito nos cueste ~$2 CLP con cualquier modelo:
 *
 *   | nivel     | modelo            | costo real por respuesta | créditos |
 *   | standard  | gpt-4o-mini       | ~$1,9 CLP                |        1 |
 *   | plus      | claude-haiku-4-5  | ~$7,8 CLP                |        4 |
 *   | advanced  | gpt-4o            | ~$24 CLP                 |       12 |
 *   | advanced  | claude-sonnet-4-6 | ~$42 CLP (estimado)      |       20 |
 *   | premium   | claude-opus-*     | ~$100 CLP                |       50 |
 *
 * `claude-fable-5` no estaba en la tabla del dueño: por precio de lista es ~2× Opus, así
 * que entra como premium con el mismo peso (a la mezcla de tokens mediana sale ~$1,9 por
 * crédito, dentro de la meta). Premium NO se ofrece en autoservicio.
 */
export const CREDIT_POLICY_SEED: CreditPolicy = {
  tokensPerCredit: 20_000,
  models: {
    "gpt-4o-mini": { level: "standard", credits: 1 },
    "claude-haiku-4-5": { level: "plus", credits: 4 },
    "gpt-4o": { level: "advanced", credits: 12 },
    "claude-sonnet-4-6": { level: "advanced", credits: 20 },
    "claude-opus-4-6": { level: "premium", credits: 50 },
    "claude-opus-4-7": { level: "premium", credits: 50 },
    "claude-opus-4-8": { level: "premium", credits: 50 },
    "claude-fable-5": { level: "premium", credits: 50 },
  },
  unknownModel: { level: "premium", credits: 50 },
  graceCredits: 100,
  defaultModel: "gpt-4o-mini",
};

/** El nivel premium no se puede elegir en planes de autoservicio (§4). */
export const SELF_SERVE_LEVELS: AiLevel[] = ["standard", "plus", "advanced"];

/**
 * Defaults de la RECARGA AUTOMÁTICA en Créditos IA (§6), editables por el cliente.
 *
 * Viven acá, en un solo lugar, porque los necesitan el api (para mostrar y guardar la
 * configuración) y el worker (para decidir el cobro). Estaban escritos a mano en los dos y
 * repetirlos una tercera vez es cómo aparecen las contradicciones: el 28-oct hubo que
 * arreglar una pantalla que prometía 238 conversaciones mientras el medidor decía 111,
 * exactamente por tener el mismo número en dos sitios.
 *
 * El tope son **10 recargas** al mes (28-oct-2026). Antes eran 3, y con el consumo real de
 * Digital-Dent en septiembre —que necesita 7— el tope viejo habría cortado el servicio a
 * mitad de mes justo al cliente que más paga. Si cambia el precio de la recarga en
 * `seeds/creditos-catalogo.json`, este número tiene que seguirlo; hay un test que lo exige.
 */
/**
 * Prefijo del `commerceOrder` de un cobro de RECARGA automática.
 *
 * Separa los cobros de recarga de los de la mensualidad, que viven en la misma tabla y van
 * a la misma tarjeta: el motor de suscripciones los excluye por este prefijo (si los viera,
 * al confirmarse una recarga le renovaría el mes GRATIS al cliente) y el webhook de la
 * pasarela los cierra por este prefijo (y solo esos: pisar un intento de suscripción le
 * robaría al motor la renovación del período).
 *
 * Vive acá porque lo necesitan el worker —que emite el cobro— y el api —que recibe la
 * confirmación—. Mientras estuvo escrito solo en el worker, el api no podía reconocerlos y
 * por eso ningún intento de recarga se cerraba nunca.
 */
export const PREFIJO_ORDEN_RECARGA = "rec-";

export const AUTO_RECARGA_DEFAULTS = {
  /** Dispara cuando quedan menos de estos créditos. */
  umbralCreditos: 50,
  /** Tope de gasto al mes: 10 recargas de $24.990. */
  topeMensualClp: 249_900,
  /** Para las cuentas que todavía cobran por conversación (unidad vieja). */
  conversaciones: { umbral: 20, topeMensualClp: 40_000 },
} as const;

export interface ModelWeightLookup extends ModelCreditWeight {
  /** false = el modelo no está en la política: se cobró como premium y hay que alertar. */
  known: boolean;
}

/** Peso del modelo que RESPONDIÓ. Desconocido → premium, y el caller alerta (§4). */
export function weightOfModel(model: string, policy: CreditPolicy = CREDIT_POLICY_SEED): ModelWeightLookup {
  const key = (model ?? "").trim();
  const hit = policy.models[key];
  if (hit) return { ...hit, known: true };
  return { ...policy.unknownModel, known: false };
}

export interface TurnCredits {
  /** Créditos a debitar por este turno. 0 = no hubo llamada a la IA (no se cobra). */
  credits: number;
  /** Bloques de tokens cobrados (1 en una respuesta normal). */
  blocks: number;
  level: AiLevel;
  /** Peso del modelo (créditos por bloque). */
  weight: number;
  /** false → alerta al super admin: modelo sin peso definido, cobrado como premium. */
  modelKnown: boolean;
}

/**
 * Créditos de UN turno del agente.
 *
 * CERO TOKENS = CERO CRÉDITOS: un turno que no llegó a llamar al modelo (proveedor caído,
 * modo degradado, respuesta escrita por una persona) no se cobra. El `máx(1, …)` de la
 * fórmula es el piso de una respuesta REAL, no un cargo mínimo por intentarlo; sin esta
 * guarda, cada caída del proveedor le cobraría créditos al cliente por respuestas que
 * nunca existieron.
 */
export function creditsForTurn(input: {
  model: string;
  tokens: number;
  policy?: CreditPolicy;
}): TurnCredits {
  const policy = input.policy ?? CREDIT_POLICY_SEED;
  const w = weightOfModel(input.model, policy);
  const tokens = Math.max(0, Math.floor(Number(input.tokens) || 0));
  if (tokens <= 0) {
    return { credits: 0, blocks: 0, level: w.level, weight: w.credits, modelKnown: w.known };
  }
  const per = Math.max(1, Math.floor(policy.tokensPerCredit) || CREDIT_POLICY_SEED.tokensPerCredit);
  const blocks = Math.max(1, Math.ceil(tokens / per));
  return { credits: w.credits * blocks, blocks, level: w.level, weight: w.credits, modelKnown: w.known };
}

function positiveInt(v: unknown, fallback: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseWeight(v: unknown, fallback: ModelCreditWeight): ModelCreditWeight {
  const o = (v ?? {}) as Record<string, unknown>;
  const level = typeof o.level === "string" && isLevel(o.level) ? o.level : fallback.level;
  return { level, credits: positiveInt(o.credits, fallback.credits) };
}

function isLevel(v: string): v is AiLevel {
  return v === "standard" || v === "plus" || v === "advanced" || v === "premium";
}

/**
 * Lee la política desde el JSON de `platform_settings.aiCredits`, campo por campo y
 * tolerante: cualquier valor ausente o corrupto cae a la semilla. Una fila mal editada a
 * mano no puede dejar el cobro en 0 (regalaríamos el servicio) ni en NaN (bloquearía a
 * todos los clientes); lo peor que pasa es que se cobre con los valores calibrados.
 */
export function parseCreditPolicy(raw: unknown): CreditPolicy {
  const o = (raw ?? {}) as Record<string, unknown>;
  const models: Record<string, ModelCreditWeight> = { ...CREDIT_POLICY_SEED.models };
  const rawModels = (o.models ?? {}) as Record<string, unknown>;
  if (rawModels && typeof rawModels === "object") {
    for (const [model, v] of Object.entries(rawModels)) {
      if (!model.trim()) continue;
      models[model] = parseWeight(v, models[model] ?? CREDIT_POLICY_SEED.unknownModel);
    }
  }
  const defaultModel = typeof o.defaultModel === "string" && o.defaultModel.trim() ? o.defaultModel.trim() : CREDIT_POLICY_SEED.defaultModel;
  return {
    tokensPerCredit: positiveInt(o.tokensPerCredit, CREDIT_POLICY_SEED.tokensPerCredit),
    models,
    unknownModel: parseWeight(o.unknownModel, CREDIT_POLICY_SEED.unknownModel),
    graceCredits: positiveInt(o.graceCredits, CREDIT_POLICY_SEED.graceCredits),
    defaultModel,
  };
}
