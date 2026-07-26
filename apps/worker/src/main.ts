import { Worker } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getPrisma } from "@conversia/database";
import {
  QUEUE_NAMES,
  type CapiJob,
  type EventJob,
  type InboundJob,
  type OutboundJob,
  type WebhookDeliveryJob,
} from "@conversia/types";
import { processCapiJob } from "./capi";
import { processInbound } from "./inbound";
import { processOutbound } from "./outbound";
import { emitPlatformEvent } from "./platform-events";
import { startScheduler } from "./scheduler";
import { processWebhookDelivery } from "./webhook-sender";

async function main() {
  const env = getEnv();
  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  const inboundWorker = new Worker<InboundJob>(
    QUEUE_NAMES.inbound,
    async (job) => processInbound(job.data),
    { connection, concurrency: env.WORKER_CONCURRENCY },
  );
  const outboundWorker = new Worker<OutboundJob>(
    QUEUE_NAMES.outbound,
    async (job) => processOutbound(job.data),
    {
      connection,
      concurrency: env.WORKER_CONCURRENCY,
    },
  );
  const webhookWorker = new Worker<WebhookDeliveryJob>(
    QUEUE_NAMES.webhooks,
    async (job) => processWebhookDelivery(job.data),
    { connection, concurrency: env.WORKER_CONCURRENCY },
  );
  const capiWorker = new Worker<CapiJob>(
    QUEUE_NAMES.capi,
    async (job) => processCapiJob(job.data),
    { connection, concurrency: 2 },
  );
  // Eventos emitidos por la API (p.ej. conversation.closed desde el panel)
  const eventsWorker = new Worker<EventJob>(
    QUEUE_NAMES.events,
    async (job) => emitPlatformEvent(job.data.organizationId, job.data.type, job.data.data ?? {}),
    { connection, concurrency: env.WORKER_CONCURRENCY },
  );

  for (const w of [inboundWorker, outboundWorker, webhookWorker, capiWorker, eventsWorker]) {
    w.on("failed", (job, err) => console.error(`✖ Job ${w.name}/${job?.id} falló: ${err.message}`));
  }

  const stopScheduler = startScheduler();

  console.log(
    `✔ Worker Conversia activo — colas: ${QUEUE_NAMES.inbound}, ${QUEUE_NAMES.outbound} | IA: ${env.AI_PROVIDER} | WhatsApp: ${env.WHATSAPP_PROVIDER}`,
  );

  const shutdown = async () => {
    console.log("Cerrando worker…");
    stopScheduler();
    await Promise.all([
      inboundWorker.close(),
      outboundWorker.close(),
      webhookWorker.close(),
      capiWorker.close(),
      eventsWorker.close(),
    ]);
    await getPrisma().$disconnect();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
