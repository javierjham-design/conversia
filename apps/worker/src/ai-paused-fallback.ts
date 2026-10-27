import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { QUEUE_NAMES, type OutboundJob } from "@conversia/types";

/**
 * La IA se detuvo a propósito (kill switch o tope diario de tokens agotado) — §8.6.
 *
 * Antes el turno hacía `return` y el bot quedaba MUDO: el cliente escribía y nadie
 * respondía, sin que el equipo se enterara. Ahora se replica el patrón `graceFallback` que
 * ya usa la gracia de créditos: frase de respaldo al cliente + la conversación pasa a manos
 * humanas (`aiEnabled = false`) + alerta `ai.escalation` al equipo.
 *
 * Todo es best-effort: si algo falla, se registra pero NO se relanza — este camino existe
 * justamente para que un corte no se transforme en silencio.
 */

const FALLBACK_TEXT = "¡Hola! En un momento te responde una persona del equipo. 🙌";

let connection: IORedis | undefined;
let outboundQueue: Queue<OutboundJob> | undefined;
function getOutboundQueue(): Queue<OutboundJob> {
  if (!outboundQueue) {
    connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    outboundQueue = new Queue(QUEUE_NAMES.outbound, {
      connection,
      defaultJobOptions: {
        removeOnComplete: { age: 86400, count: 5000 },
        removeOnFail: { age: 604800 },
        attempts: 3,
        backoff: { type: "exponential", delay: 3000 },
      },
    });
  }
  return outboundQueue;
}

/**
 * Manda la frase de respaldo, apaga la IA de la conversación y alerta al equipo.
 * `reason` es el texto que verá el equipo en la alerta (incluye el tope efectivo).
 */
export async function pauseAiWithFallback(
  organizationId: string,
  conversationId: string,
  reason: string,
): Promise<void> {
  try {
    const messageId = await withTenant(organizationId, async (tx) => {
      const m = await tx.message.create({
        data: {
          organizationId,
          conversationId,
          direction: "OUTBOUND",
          type: "TEXT",
          body: FALLBACK_TEXT,
          status: "PENDING",
          authorType: "AGENT",
          visibility: "PUBLIC",
        },
        select: { id: true },
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { aiEnabled: false } });
      return m.id;
    });
    // Se envía por la cola normal de salientes (con su claim anti-doble-envío).
    await getOutboundQueue().add("ai-paused-fallback", { organizationId, conversationId, messageId });
  } catch (err) {
    console.error(
      `✖ No se pudo enviar la frase de respaldo por IA pausada (${conversationId}):`,
      (err as Error).message,
    );
  }
  try {
    const { enqueueNotification } = await import("./notifications/queue.js");
    await enqueueNotification({
      eventKey: "ai.escalation",
      organizationId,
      data: { conversationId, contactName: "cliente", reason },
    });
  } catch (err) {
    console.error(`✖ No se pudo alertar la pausa de IA (${conversationId}):`, (err as Error).message);
  }
}
