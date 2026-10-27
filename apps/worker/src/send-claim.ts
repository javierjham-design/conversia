import IORedis from "ioredis";
import { getEnv } from "@conversia/config";

/**
 * DOBLE ENVÍO al reintentar (auditoría §4.5 y §8.4).
 *
 * El caso real: el envío a Meta SALE bien pero falla el `update` del estado del mensaje.
 * El mensaje queda en `PENDING`, BullMQ reintenta el job y el cliente recibe el mensaje
 * DOS VECES.
 *
 * El claim ideal sería `updateMany({ where: { id, status: "PENDING" }, data: { status:
 * "SENDING" } })`, pero **`SENDING` no existe en el enum `MessageStatus`** y esta etapa no
 * admite migraciones. Mientras tanto el claim vive en Redis (`send:<messageId>`, TTL 24 h).
 * **Migración pendiente (requiere OK del dueño):** agregar `SENDING` al enum y mover el
 * claim a la base, que es donde corresponde.
 *
 * Si Redis no responde, se deja ENVIAR igual (fail-open): es peor dejar a todos los tenants
 * sin poder mandar mensajes que arriesgar un duplicado puntual.
 */

let connection: IORedis | undefined;
function redis(): IORedis {
  if (!connection) connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

const TTL_SECONDS = 86_400; // 24 h: cubre de sobra la vida de los reintentos de BullMQ
const key = (messageId: string) => `send:${messageId}`;
const IN_FLIGHT = "sending";

export type SendClaim =
  /** Podemos despachar. */
  | { ok: true }
  /** Ya se despachó antes: NO reenviar, solo reconciliar el estado. */
  | { ok: false; alreadySent: true; externalId: string | null }
  /** Otro intento lo está despachando AHORA: no hacer nada. */
  | { ok: false; alreadySent: false };

/** Reserva el derecho a despachar este mensaje. */
export async function claimSend(messageId: string): Promise<SendClaim> {
  try {
    const got = await redis().set(key(messageId), IN_FLIGHT, "EX", TTL_SECONDS, "NX");
    if (got === "OK") return { ok: true };
    const current = await redis().get(key(messageId));
    if (current && current !== IN_FLIGHT) {
      return { ok: false, alreadySent: true, externalId: current === "sent" ? null : current };
    }
    return { ok: false, alreadySent: false };
  } catch {
    return { ok: true }; // fail-open: Redis caído no puede dejar a los tenants sin enviar
  }
}

/** Marca el mensaje como YA despachado (se llama apenas Meta acepta, antes del update). */
export async function markSent(messageId: string, externalId: string | null): Promise<void> {
  try {
    await redis().set(key(messageId), externalId ?? "sent", "EX", TTL_SECONDS);
  } catch {
    /* best-effort */
  }
}

/** Libera el claim cuando el despacho NO llegó a salir, para que el reintento pueda enviar. */
export async function releaseSend(messageId: string): Promise<void> {
  try {
    await redis().del(key(messageId));
  } catch {
    /* best-effort */
  }
}
