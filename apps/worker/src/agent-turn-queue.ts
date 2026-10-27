import { Queue, type DefaultJobOptions } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { QUEUE_NAMES, type AgentTurnJob } from "@conversia/types";

/**
 * RETENCIÓN de jobs (auditoría §8.2): completados 24 h o 5.000, fallidos 7 días —
 * sin esto Redis guarda cada job para siempre. SOLO retención: no define
 * `attempts`/`backoff`, y lo que declara cada `add()` le gana.
 */
const JOB_RETENTION: DefaultJobOptions = {
  removeOnComplete: { age: 86400, count: 5000 },
  removeOnFail: { age: 604800 },
};

let connection: IORedis | undefined;
let queue: Queue<AgentTurnJob> | undefined;

function getQueue(): Queue<AgentTurnJob> {
  if (!queue) {
    connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAMES.agentTurn, { connection, defaultJobOptions: { ...JOB_RETENTION } });
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
/**
 * Reencola un turno con un retraso corto porque la conversación está TOMADA por otro turno
 * en curso (cerrojo de §8.1). Usa un jobId PROPIO (no el bucket del debounce) para no chocar
 * con el coalesce de ráfagas: acá no queremos agrupar, queremos volver a intentar.
 */
export async function requeueAgentTurn(job: AgentTurnJob, delayMs = 3000): Promise<void> {
  await getQueue().add("retry-turn", job, {
    jobId: `turn-retry:${job.conversationId}:${Date.now()}`,
    delay: delayMs,
    attempts: 2,
    backoff: { type: "fixed", delay: 3000 },
    removeOnComplete: true,
    removeOnFail: 500,
  });
}

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
