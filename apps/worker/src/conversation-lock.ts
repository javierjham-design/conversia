import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { randomUUID } from "node:crypto";

/**
 * CERROJO POR CONVERSACIÓN (auditoría §8.1).
 *
 * Dos turnos del agente corriendo a la vez sobre la MISMA conversación producían respuestas
 * duplicadas o entremezcladas (el segundo turno lee el historial sin la respuesta que el
 * primero todavía no escribió). El cerrojo serializa los turnos por conversación.
 *
 * Vive en Redis y NO en la base: un turno puede tardar decenas de segundos y no queremos
 * una transacción abierta todo ese rato. El TTL (120 s) garantiza que un worker que muere a
 * mitad no deje la conversación bloqueada para siempre.
 *
 * Si Redis no responde se deja PASAR el turno (fail-open): es peor dejar al bot mudo —el
 * problema que esta etapa viene a resolver— que arriesgar una respuesta duplicada puntual.
 */

let connection: IORedis | undefined;
function redis(): IORedis {
  if (!connection) connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

/** 120 s: cubre de sobra un turno lento (modelo + tools) sin colgar la conversación. */
const LOCK_MS = 120_000;
const key = (conversationId: string) => `conv:lock:${conversationId}`;

/** Valor único del cerrojo: solo quien lo tomó puede soltarlo. */
export function newLockToken(): string {
  return `${process.pid}:${randomUUID()}`;
}

/** Toma el cerrojo. `false` = ya lo tiene otro turno en curso. */
export async function acquireConversationLock(conversationId: string, token: string): Promise<boolean> {
  try {
    const got = await redis().set(key(conversationId), token, "PX", LOCK_MS, "NX");
    return got === "OK";
  } catch {
    return true; // fail-open
  }
}

/**
 * Libera el cerrojo SOLO si sigue siendo nuestro. Sin esta comparación, un turno que se pasó
 * del TTL borraría el cerrojo del turno siguiente y volveríamos a tener dos en paralelo.
 */
export async function releaseConversationLock(conversationId: string, token: string): Promise<void> {
  try {
    await redis().eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key(conversationId),
      token,
    );
  } catch {
    /* best-effort: si falla, el TTL lo libera solo */
  }
}
