import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { aiDegradedRedisKey } from "@conversia/types";

/**
 * Detecta la DEGRADACIÓN SILENCIOSA del router de IA y la convierte en alerta.
 *
 * El router (`createAIRouter`) atiende `gpt-*` con OpenAI y `claude-*` con Anthropic,
 * pero si la llave del proveedor esperado no está/murió, responde con el OTRO proveedor
 * y su modelo seguro (p. ej. `gpt-4o-mini` → `claude-haiku-4-5`). El bot sigue
 * respondiendo —bien—, pero con un modelo distinto al configurado, a otro costo, y
 * NADIE se entera: así pasó con Digital-Dent ~5 días hasta mirar el consumo a mano.
 *
 * Aquí comparamos el proveedor que REALMENTE respondió (lo reporta la respuesta desde
 * #574) contra el que corresponde al modelo configurado. Si cayó en silencio:
 *   1. Marcamos `conversia:ai:degraded:<provider>` en Redis (lo lee /health/status →
 *      503 → el monitor externo llama/avisa al teléfono).
 *   2. Registramos UN aviso en integration_events (super-admin → página "Alertas"),
 *      con dedup por incidente (no una fila por turno).
 * Cuando el proveedor vuelve, limpiamos la marca (el monitor resuelve el incidente
 * solo) y lo registramos. Todo best-effort: NUNCA rompe el turno del cliente.
 */

/** Caduca sola si el tráfico cesa: no deja un 503 colgado tras una noche sin turnos. */
const TTL_SECONDS = 2 * 60 * 60;

/**
 * Proveedor que DEBERÍA atender el modelo configurado. Misma regla que
 * `RoutingAIProvider.route()` en packages/agents/src/providers.ts (mantener en
 * sintonía): si allí cambia el criterio de ruteo, cambiarlo también aquí.
 */
export function expectedProviderFor(model: string): "openai" | "anthropic" | null {
  if (/^(gpt-|o[1-9]|chatgpt|text-embedding)/i.test(model)) return "openai";
  if (/^claude/i.test(model)) return "anthropic";
  return null;
}

interface DegradedInfo {
  since: number;
  lastSeen: number;
  configuredModel: string;
  respondedModel?: string;
  actualProvider: string;
}

export interface TurnModelObservation {
  organizationId: string;
  /** Modelo configurado en el agente (lo que PEDIMOS). */
  configuredModel: string;
  /** Modelo que REALMENTE respondió (result.model). */
  respondedModel?: string;
  /** Proveedor que REALMENTE respondió (result.provider): openai | anthropic | mock. */
  respondedProvider?: string;
}

type RedisLike = Pick<IORedis, "get" | "set" | "del">;
type RecordAlert = (
  organizationId: string,
  status: string,
  type: string,
  message: string,
  payload: object,
) => Promise<void>;

export interface ObserveDeps {
  /** Inyectable para tests; por defecto, una conexión Redis propia. */
  redis?: RedisLike;
  /** Inyectable para tests; por defecto escribe en integration_events. */
  record?: RecordAlert;
  /** Por defecto solo en producción (en dev/test el proveedor Mock es lo normal). */
  enabled?: boolean;
}

let redis: IORedis | undefined;
function conn(): IORedis {
  if (!redis) redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redis;
}

async function recordAlert(
  organizationId: string,
  status: string,
  type: string,
  message: string,
  payload: object,
): Promise<void> {
  try {
    await withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({ data: { organizationId, provider: "ai", type, status, message, payload } }),
    );
  } catch (err) {
    console.error(`✖ recordAlert(${type}):`, (err as Error).message);
  }
}

async function enterDegraded(
  r: RedisLike,
  record: RecordAlert,
  expected: string,
  actual: string,
  obs: TurnModelObservation,
): Promise<void> {
  const key = aiDegradedRedisKey(expected);
  const now = Date.now();
  const info: DegradedInfo = {
    since: now,
    lastSeen: now,
    configuredModel: obs.configuredModel,
    respondedModel: obs.respondedModel,
    actualProvider: actual,
  };
  // NX: solo el PRIMER turno del incidente "gana" la marca y alerta; los demás turnos
  // degradados solo refrescan el TTL/lastSeen (sin duplicar el aviso).
  const claimed = await r.set(key, JSON.stringify(info), "EX", TTL_SECONDS, "NX");
  if (claimed !== "OK") {
    const prevRaw = await r.get(key);
    if (prevRaw) {
      const prev = JSON.parse(prevRaw) as DegradedInfo;
      prev.lastSeen = now;
      prev.respondedModel = obs.respondedModel;
      prev.actualProvider = actual;
      await r.set(key, JSON.stringify(prev), "EX", TTL_SECONDS);
    }
    return;
  }
  const up = expected.toUpperCase();
  const msg =
    `IA de ${up} caída: el bot responde con ${actual} (${obs.respondedModel ?? "?"}) en vez de ` +
    `${obs.configuredModel}. Afecta a TODA la plataforma; revisa ${up}_API_KEY en Railway. ` +
    `El bot sigue respondiendo con el modelo de respaldo.`;
  console.error(`🚨 ${msg}`);
  await record(obs.organizationId, "error", `ai.${expected}_down`, msg, info);
}

async function clearDegraded(
  r: RedisLike,
  record: RecordAlert,
  expected: string,
  actual: string,
  obs: TurnModelObservation,
): Promise<void> {
  const key = aiDegradedRedisKey(expected);
  const existed = await r.get(key);
  if (!existed) return; // caso normal: nunca estuvo degradado, nada que hacer.
  // DEL atómico: solo el turno que efectivamente borra la marca emite el aviso de
  // recuperación (si dos turnos sanos corren a la vez, uno obtiene 0 y no duplica).
  const removed = await r.del(key);
  if (removed !== 1) return;
  const info = JSON.parse(existed) as DegradedInfo;
  const downMin = Math.max(1, Math.round((Date.now() - info.since) / 60000));
  const up = expected.toUpperCase();
  const msg = `IA de ${up} restablecida: responde ${actual} (${obs.respondedModel ?? "?"}). Estuvo degradada ~${downMin} min.`;
  console.log(`✅ ${msg}`);
  await record(obs.organizationId, "ok", `ai.${expected}_restored`, msg, info);
}

/**
 * Observa el modelo/proveedor que respondió un turno y mantiene la marca de
 * "IA degradada". Llamar best-effort (sin await que bloquee el turno).
 */
export async function observeTurnModel(obs: TurnModelObservation, deps: ObserveDeps = {}): Promise<void> {
  const enabled = deps.enabled ?? getEnv().NODE_ENV === "production";
  if (!enabled) return;
  const expected = expectedProviderFor(obs.configuredModel);
  if (!expected) return; // modelo sin proveedor conocido: no lo juzgamos.
  const actual = obs.respondedProvider;
  // Solo juzgamos proveedores HOJA concretos; "router"/"resilient"/undefined = no sabemos.
  if (actual !== "openai" && actual !== "anthropic" && actual !== "mock") return;
  const r = deps.redis ?? conn();
  const record = deps.record ?? recordAlert;
  try {
    if (actual !== expected) await enterDegraded(r, record, expected, actual, obs);
    else await clearDegraded(r, record, expected, actual, obs);
  } catch (err) {
    console.error("✖ observeTurnModel:", (err as Error).message);
  }
}
