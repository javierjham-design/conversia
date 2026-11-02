import { getAdminPrisma } from "@conversia/database";

/**
 * CONFIGURACIÓN DE CONVI (proveedor + modelo), editable desde el Super Admin.
 *
 * Por qué existe. Hasta ahora el proveedor y el modelo del copiloto vivían SOLO en variables
 * de entorno del servicio `api`, y eso costó una caída de días: Convi quedó pidiéndole a
 * Anthropic un modelo que el código traía escrito a mano, nadie podía verlo desde ninguna
 * pantalla, y para cambiarlo había que entrar a Railway y reiniciar el servicio. El dueño,
 * con las llaves perfectamente cargadas, no tenía forma de mirar ni de corregir.
 *
 * Qué cambia: la decisión pasa a `platform_settings.assistant`, igual que la política de
 * créditos (`platform_settings.aiCredits`, ver agents/model-policy.ts). El entorno queda
 * como RESPALDO, no como única fuente: si la fila no existe, todo sigue funcionando como
 * antes. Así el cambio se puede desplegar sin tocar Railway y sin un paso previo obligatorio.
 *
 * Qué NO entra acá: **las API keys**. Siguen siendo variables de entorno del servicio y nunca
 * se guardan en la base. Un secreto en una tabla queda en los respaldos, en las réplicas y a
 * la vista de cualquiera que pueda leer la BD, y acá no hace falta: el panel solo necesita
 * saber QUÉ proveedores tienen llave, nunca cuál es.
 */

const SETTING_KEY = "assistant";
const TTL_MS = 60_000;

export type AssistantProvider = "anthropic" | "openai" | "mock";

export interface AssistantConfig {
  /** Proveedor elegido en la consola. `null` = usar `AI_PROVIDER` del entorno. */
  provider: AssistantProvider | null;
  /** Modelo elegido. `""` = el que traiga el entorno (y si no, el default de la familia). */
  model: string;
  /** Modelo de respaldo. `""` = `AI_FALLBACK_MODEL` del entorno. */
  fallbackModel: string;
}

/** Sin fila guardada: todo sale del entorno, exactamente como antes de este configurador. */
export const ASSISTANT_CONFIG_VACIA: AssistantConfig = { provider: null, model: "", fallbackModel: "" };

const PROVEEDORES: AssistantProvider[] = ["anthropic", "openai", "mock"];

/**
 * Lee la fila guardada sin confiar en ella (pura, testeable).
 *
 * Tolerante a propósito: esta fila la escribe una pantalla, y un campo raro NO puede dejar a
 * Convi sin proveedor. Cualquier valor que no reconozcamos se descarta y ese campo cae al
 * entorno, que es el comportamiento anterior y conocido.
 */
export function parseAssistantConfig(raw: unknown): AssistantConfig {
  if (!raw || typeof raw !== "object") return ASSISTANT_CONFIG_VACIA;
  const o = raw as Record<string, unknown>;
  const provider = typeof o.provider === "string" && (PROVEEDORES as string[]).includes(o.provider) ? (o.provider as AssistantProvider) : null;
  return {
    provider,
    model: typeof o.model === "string" ? o.model.trim() : "",
    fallbackModel: typeof o.fallbackModel === "string" ? o.fallbackModel.trim() : "",
  };
}

/**
 * Qué proveedores tienen su llave cargada EN ESTE servicio (pura, testeable).
 *
 * **Nunca devuelve la llave, solo si está.** Es lo que necesita el selector del Super Admin
 * para no ofrecer un proveedor que va a fallar con un 401 — el agujero exacto por el que se
 * podía elegir OpenAI teniendo solo la llave de Anthropic.
 *
 * `mock` queda fuera: no necesita llave, pero ofrecerlo desde la consola sería dejar que
 * Convi conteste frases de simulación como si fueran reales. Sigue alcanzable por entorno
 * para el simulador y los tests.
 */
export function proveedoresConLlave(env: { ANTHROPIC_API_KEY?: string; OPENAI_API_KEY?: string }): AssistantProvider[] {
  const out: AssistantProvider[] = [];
  if (env.ANTHROPIC_API_KEY) out.push("anthropic");
  if (env.OPENAI_API_KEY) out.push("openai");
  return out;
}

/**
 * Elige un modelo COMPATIBLE con el proveedor (pura, testeable). Hallazgo prod 26-oct:
 * `AI_DEFAULT_MODEL` trae un default de OpenAI ("gpt-4o-mini") en la config; si el proveedor
 * es Anthropic, mandar ESE modelo a Anthropic da 404 → el asistente caía al fallback.
 * Respetamos el modelo pedido solo si pertenece a la familia del proveedor; si no, usamos el
 * default propio del proveedor. Así el asistente nunca manda un gpt-* a Anthropic (ni al revés).
 */
export function resolveAssistantModel(provider: string, configuredModel: string): string {
  const isClaude = /^claude/i.test(configuredModel);
  const isOpenai = /^(gpt-|o[1-9]|chatgpt)/i.test(configuredModel);
  if (provider === "anthropic") return isClaude ? configuredModel : "claude-sonnet-4-6";
  if (provider === "openai") return isOpenai ? configuredModel : "gpt-4o-mini";
  return configuredModel; // mock u otro: el MockAIProvider ignora el modelo
}

/**
 * Modelo de RESPALDO del copiloto (pura, testeable).
 *
 * Hallazgo 1-nov: Convi caído con las llaves habilitadas y los bots de los clientes
 * respondiendo normal. La diferencia no estaba en las llaves sino en el camino: los bots
 * pasan por `ResilientAIProvider` (reintentos + modelo de respaldo + timeout) y Convi
 * llamaba al proveedor A PELO, un intento y nada más. Así, un 429 pasajero lo tumbaba, y un
 * modelo que el proveedor dejó de servir lo tumbaba SIEMPRE, sin reintento ni respaldo, con
 * las llaves perfectas.
 *
 * El respaldo pasa por `resolveAssistantModel` a propósito: `AI_FALLBACK_MODEL` trae un
 * `claude-*` por default y mandárselo a OpenAI es exactamente el bug del 26-oct, solo que
 * esta vez en el camino de respaldo, que es el que nadie prueba. `undefined` cuando no hay a
 * dónde caer: reintentar el MISMO modelo no es un respaldo, y decirle lo contrario a la capa
 * resiliente solo gasta intentos.
 */
export function modeloDeRespaldoDelAsistente(
  provider: string,
  fallbackModel: string,
  modeloPrincipal: string,
): string | undefined {
  if (!fallbackModel) return undefined;
  const compatible = resolveAssistantModel(provider, fallbackModel);
  return compatible === modeloPrincipal ? undefined : compatible;
}

/**
 * ¿El modelo que pidió el dueño quedó DESCARTADO por no ser de la familia del proveedor?
 *
 * `resolveAssistantModel` hace bien en reescribirlo (un `gpt-*` a Anthropic da 404), pero lo
 * hacía EN SILENCIO. El caso real: poner `ASSISTANT_MODEL=gpt-4o-mini` con
 * `AI_PROVIDER=anthropic` no cambia nada, y el dueño queda convencido de que sí. Esto no
 * cambia la decisión —sigue mandando un modelo compatible— solo deja de ocultarla.
 *
 * Sin modelo pedido no hay nada que avisar: el default no es una decisión de nadie.
 */
export function modeloIgnorado(configurado: string, resuelto: string): boolean {
  return Boolean(configurado) && configurado !== resuelto;
}

export interface EnvDelAsistente {
  AI_PROVIDER: string;
  ASSISTANT_MODEL: string;
  AI_DEFAULT_MODEL: string;
  AI_FALLBACK_MODEL: string;
}

export interface ConfigEfectiva {
  /** Proveedor que se va a usar. */
  provider: string;
  /** Modelo que se va a mandar, ya compatible con el proveedor. */
  model: string;
  /** Modelo que se PIDIÓ (consola o entorno), antes de forzar la familia. */
  modelPedido: string;
  /** Respaldo ya resuelto, o `undefined` si no hay a dónde caer. */
  fallbackModel?: string;
  /** De dónde salió cada decisión, para que la consola lo muestre sin mentir. */
  origen: { provider: "consola" | "entorno"; model: "consola" | "entorno" };
}

/**
 * Compone la decisión final: lo guardado en la consola MANDA, el entorno es el respaldo
 * (pura, testeable).
 *
 * El orden importa y es deliberado: que la consola gane permite corregir una caída sin
 * desplegar, que es justo lo que no se pudo hacer esta vez. Y que el entorno siga sirviendo
 * de respaldo permite desplegar esto sin un paso previo obligatorio: sin fila, el
 * comportamiento es idéntico al anterior.
 */
export function configEfectiva(guardada: AssistantConfig, env: EnvDelAsistente): ConfigEfectiva {
  const provider = guardada.provider ?? env.AI_PROVIDER;
  const modelPedido = guardada.model || env.ASSISTANT_MODEL || env.AI_DEFAULT_MODEL;
  const model = resolveAssistantModel(provider, modelPedido);
  return {
    provider,
    model,
    modelPedido,
    fallbackModel: modeloDeRespaldoDelAsistente(provider, guardada.fallbackModel || env.AI_FALLBACK_MODEL, model),
    origen: {
      provider: guardada.provider ? "consola" : "entorno",
      model: guardada.model ? "consola" : "entorno",
    },
  };
}

let cache: { at: number; config: AssistantConfig } | null = null;

/** Configuración guardada (`platform_settings.assistant`). Cache 60 s, igual que la de créditos. */
export async function readAssistantConfig(): Promise<AssistantConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.config;
  let config = ASSISTANT_CONFIG_VACIA;
  try {
    const row = await getAdminPrisma().platformSetting.findUnique({ where: { key: SETTING_KEY } });
    if (row) config = parseAssistantConfig(JSON.parse(row.value));
  } catch {
    /* sin fila, fila ilegible o BD no disponible → entorno, como antes */
  }
  cache = { at: Date.now(), config };
  return config;
}

/** Guarda la configuración y limpia la cache de ESTE proceso (la consola necesita verlo ya). */
export async function writeAssistantConfig(config: AssistantConfig): Promise<void> {
  const value = JSON.stringify(config);
  await getAdminPrisma().platformSetting.upsert({
    where: { key: SETTING_KEY },
    update: { value },
    create: { key: SETTING_KEY, value },
  });
  cache = null;
}

/** Solo para los tests. */
export function resetAssistantConfigCache(): void {
  cache = null;
}
