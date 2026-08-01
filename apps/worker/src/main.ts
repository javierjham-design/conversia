import { Worker } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getPrisma } from "@conversia/database";
import {
  QUEUE_NAMES,
  TRIGGER_TYPES,
  type CapiJob,
  type ContactImportJob,
  type EmailJob,
  type EventJob,
  type InboundJob,
  type OutboundJob,
  type SyncJob,
  type WebhookDeliveryJob,
} from "@conversia/types";
import { processCapiJob } from "./capi";
import { processClarivaWebhook, type ClarivaWebhookData } from "./clariva-webhook";
import { processContactImport } from "./contact-import";
import { processInbound } from "./inbound";
import { processEmailJob, startDailyDigests } from "./mailer";
import { processOutbound } from "./outbound";
import { emitPlatformEvent } from "./platform-events";
import { startScheduler } from "./scheduler";
import { processSyncJob } from "./sync-worker";
import { startTemplateSync } from "./template-sync";
import { processWebhookDelivery } from "./webhook-sender";
import { dispatchEvent, startWorkflowById } from "./workflow-runtime";

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
  // Imports CSV: concurrencia 1 para no saturar la BD con lotes paralelos.
  const importsWorker = new Worker<ContactImportJob>(
    QUEUE_NAMES.imports,
    async (job) => processContactImport(job),
    { connection, concurrency: 1 },
  );
  // Correos internos del tenant (escalamientos, resúmenes, alertas, workflows).
  const emailsWorker = new Worker<EmailJob>(
    QUEUE_NAMES.emails,
    async (job) => processEmailJob(job.data),
    { connection, concurrency: 2 },
  );
  // Sincronización hacia integraciones externas (GA4, Calendar, Sheets, HubSpot).
  const syncWorker = new Worker<SyncJob>(
    QUEUE_NAMES.sync,
    async (job) => processSyncJob(job.data),
    { connection, concurrency: 2 },
  );
  // Eventos emitidos por la API (p.ej. conversation.closed desde el panel):
  // 1) fan-out a webhooks/CAPI; 2) si el tipo mapea a un disparador de
  // workflow (conversation.closed → conversation_closed), inicia los flujos.
  const eventsWorker = new Worker<EventJob>(
    QUEUE_NAMES.events,
    async (job) => {
      // Webhook de Cláriva (firma ya verificada por la API): actualiza la
      // proyección local de la cita y dispara los triggers de agenda.
      if (job.data.type === "__clariva_webhook__") {
        await processClarivaWebhook(job.data.organizationId, job.data.data as unknown as ClarivaWebhookData, job.data.occurredAt);
        return;
      }
      // Atajo manual desde la bandeja: ejecutar un flujo específico por id.
      if (job.data.type === "__manual_run__") {
        const wfId = (job.data.data as any)?.workflowId as string | undefined;
        if (wfId) {
          await startWorkflowById(job.data.organizationId, wfId, {
            conversationId: job.data.conversationId,
            contactId: job.data.contactId,
          });
        }
        return;
      }
      await emitPlatformEvent(job.data.organizationId, job.data.type, job.data.data ?? {});
      const triggerType = job.data.type.replace(/\./g, "_");
      if ((TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
        await dispatchEvent({ ...job.data, type: triggerType });
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY },
  );

  for (const w of [inboundWorker, outboundWorker, webhookWorker, capiWorker, eventsWorker, importsWorker, emailsWorker, syncWorker]) {
    w.on("failed", (job, err) => console.error(`✖ Job ${w.name}/${job?.id} falló: ${err.message}`));
  }

  const stopScheduler = startScheduler();
  const stopTemplateSync = startTemplateSync();
  const stopDailyDigests = startDailyDigests();

  console.log(
    `✔ Worker Conversia activo — colas: ${QUEUE_NAMES.inbound}, ${QUEUE_NAMES.outbound} | IA: ${env.AI_PROVIDER} | WhatsApp: ${env.WHATSAPP_PROVIDER}`,
  );

  const shutdown = async () => {
    console.log("Cerrando worker…");
    stopScheduler();
    stopTemplateSync();
    stopDailyDigests();
    await Promise.all([
      inboundWorker.close(),
      outboundWorker.close(),
      webhookWorker.close(),
      capiWorker.close(),
      eventsWorker.close(),
      importsWorker.close(),
      emailsWorker.close(),
      syncWorker.close(),
    ]);
    await getPrisma().$disconnect();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
