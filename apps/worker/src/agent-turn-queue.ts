import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { QUEUE_NAMES, type AgentTurnJob } from "@conversia/types";

let connection: IORedis | undefined;
let queue: Queue<AgentTurnJob> | undefined;

function getQueue(): Queue<AgentTurnJob> {
  if (!queue) {
    connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAMES.agentTurn, { connection });
  }
  return queue;
}

/**
 * Encola el turno del agente para un mensaje ENTRANTE, con DEBOUNCE de ráfagas: cuando el
 * contacto manda varios mensajes seguidos, se agrupan en UNA sola respuesta (mejor UX +
 * menos costo de IA, porque cada turno reenvía todo el contexto).
 *
 * Cómo funciona:
 *  - jobId con BUCKET de tiempo (`turn:<conv>:<bucket>`): todos los mensajes de una misma
 *    ventana comparten jobId → BullMQ coalesce en UN solo job (el 2.º..N son no-op).
 *  - `delay` = la ventana: el job espera antes de correr, dando tiempo a que llegue el resto
 *    de la ráfaga (ya persistida) para que el turno la lea completa y responda una vez.
 *  - Un mensaje que llega mientras el turno anterior ya está corriendo cae en el bucket
 *    SIGUIENTE → se agenda su propio turno; nunca se pierde (cero silencios).
 *
 * El bucket de tiempo es DELIBERADO: un jobId FIJO (`turn:<conv>`) se ENVENENABA — un turno
 * fallido quedaba retenido con ese id en la cola de fallidos y BullMQ ignoraba en silencio
 * TODO lo encolado después para esa conversación (la IA quedaba muda). El id con bucket
 * caduca solo y evita ese bloqueo.
 *
 * `AI_INBOUND_DEBOUNCE_MS = 0` desactiva el debounce (responde por cada mensaje).
 */
export async function enqueueDebouncedAgentTurn(job: AgentTurnJob): Promise<void> {
  const debounceMs = getEnv().AI_INBOUND_DEBOUNCE_MS;
  const windowMs = debounceMs > 0 ? debounceMs : 5000; // ventana del bucket (anti-veneno)
  const bucket = Math.floor(Date.now() / windowMs);
  await getQueue().add(
    "inbound-turn",
    job,
    {
      jobId: `turn:${job.conversationId}:${bucket}`,
      delay: debounceMs > 0 ? debounceMs : 0,
      attempts: 2,
      backoff: { type: "fixed", delay: 3000 },
      removeOnComplete: true,
      removeOnFail: 500,
    },
  );
}
