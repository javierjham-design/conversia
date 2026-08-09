import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { QUEUE_NAMES } from "@conversia/types";
import type { NotifJob } from "@conversia/notifications";

let connection: IORedis | undefined;
let queue: Queue<NotifJob> | undefined;

export function getNotificationsQueue(): Queue<NotifJob> {
  if (!queue) {
    connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE_NAMES.notifications, { connection });
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
