import { Queue, type DefaultJobOptions } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { QUEUE_NAMES } from "@conversia/types";
import type { NotifJob } from "@conversia/notifications";

/**
 * RETENCIÓN de jobs (auditoría §8.2): completados 24 h o 5.000, fallidos 7 días —
 * sin esto Redis guarda cada job para siempre. SOLO retención: no define
 * `attempts`/`backoff`, y lo que declara cada `add()` le gana (abajo, los límites
 * por cantidad del `enqueueNotification` siguen mandando).
 */
const JOB_RETENTION: DefaultJobOptions = {
  removeOnComplete: { age: 86400, count: 5000 },
  removeOnFail: { age: 604800 },
};

let connection: IORedis | undefined;
let queue: Queue<NotifJob> | undefined;

export function getNotificationsQueue(): Queue<NotifJob> {
  if (!queue) {
    connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAMES.notifications, { connection, defaultJobOptions: { ...JOB_RETENTION } });
  }
  return queue;
}

/** Encola una notificación (desde el worker). La API usa su propio QueueService. */
export async function enqueueNotification(job: NotifJob): Promise<void> {
  await getNotificationsQueue().add("notify", job, {
    attempts: 4,
    backoff: { type: "exponential", delay: 15_000 },
    removeOnComplete: 1000,
    removeOnFail: 2000,
  });
}
