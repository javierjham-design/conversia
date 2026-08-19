import { Worker } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getPrisma } from "@conversia/database";
import {
  QUEUE_NAMES,
  TRIGGER_TYPES,
  type AgentTurnJob,
  type CapiJob,
  type ContactImportJob,
  type EmailJob,
  type EventJob,
  type InboundJob,
  type OutboundJob,
  type SyncJob,
  type WebhookDeliveryJob,
  type WorkflowRetryJob,
} from "@conversia/types";
import { processCapiJob } from "./capi";
import { processClarivaWebhook, type ClarivaWebhookData } from "./clariva-webhook";
import { processContactImport } from "./contact-import";
import { processInbound } from "./inbound";
import { processEmailJob, startDailyDigests } from "./mailer";
import { runAgentTurn } from "./agent-turn";
import { processNotificationJob, registerChannel } from "./notifications/dispatch";
import { webPushChannel } from "./notifications/web-push";
import { processWhatsappEscalation, type WaEscalationJob } from "./notifications/whatsapp-escalation";
import type { NotifJob } from "@conversia/notifications";
import { processOutbound } from "./outbound";
import { emitPlatformEvent } from "./platform-events";
import { startScheduler } from "./scheduler";
import { processSyncJob } from "./sync-worker";
import { getSyncQueue } from "./ga4";
import { startTemplateSync } from "./template-sync";
import { processWebhookDelivery } from "./webhook-sender";
import { dispatchEvent, retryRun, startWorkflowById } from "./workflow-runtime";
import { startInboxRules } from "./inbox-rules";
import { startBillingDunning } from "./billing-dunning";
import { startSubscriptionBilling } from "./subscription-billing/start";
import { startTrialLifecycle } from "./trial-lifecycle";
import { startAnnualWalletRefill } from "./annual-wallet-refill";
import { startRetentionPurge } from "./retention-purge";
import { startCatalogSync } from "./catalog/scheduler";
import { startOrphanWabaCheck } from "./orphan-waba-check";

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
  // Canal Web Push (VAPID). El stub nativo se registra el día de Capacitor.
  registerChannel(webPushChannel);
  // Notificaciones: despacha cada evento a los canales habilitados por usuario.
  const notificationsWorker = new Worker<NotifJob>(
    QUEUE_NAMES.notifications,
    async (job) => processNotificationJob(job.data),
    { connection, concurrency: 4 },
  );
  // Turno del agente a demanda (p. ej. tras agregar una indicación en la bandeja).
  const agentTurnWorker = new Worker<AgentTurnJob>(
    QUEUE_NAMES.agentTurn,
    async (job) => runAgentTurn(job.data),
    { connection, concurrency: 4 },
  );
  // Reintento manual de una ejecución fallida desde el paso que falló (Observabilidad).
  const workflowRetryWorker = new Worker<WorkflowRetryJob>(
    QUEUE_NAMES.workflow,
    async (job) => retryRun(job.data.organizationId, job.data.runId),
    { connection, concurrency: 2 },
  );
  // Escalera de WhatsApp: avisos con retraso que se cancelan solos si se atiende.
  const waEscalationWorker = new Worker<WaEscalationJob>(
    QUEUE_NAMES.whatsappEscalation,
    async (job) => processWhatsappEscalation(job.data),
    { connection, concurrency: 2 },
  );
  // Sincronización diaria (05:00) del catálogo de anuncios de Meta: un job
  // repetible que abanica un sync por cada tenant con Meta conectado.
  void getSyncQueue()
    .add(
      "meta_ads_daily",
      { organizationId: "__all__", kind: "meta_ads_sync", payload: { all: true } },
      { repeat: { pattern: "0 5 * * *" }, jobId: "meta_ads_daily", removeOnComplete: true, removeOnFail: 50 },
    )
    .catch((e) => console.error("No se pudo registrar el sync diario de anuncios:", (e as Error).message));
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

  for (const w of [inboundWorker, outboundWorker, webhookWorker, capiWorker, eventsWorker, importsWorker, emailsWorker, syncWorker, notificationsWorker, waEscalationWorker, agentTurnWorker, workflowRetryWorker]) {
    w.on("failed", (job, err) => console.error(`✖ Job ${w.name}/${job?.id} falló: ${err.message}`));
  }

  const stopScheduler = startScheduler();
  const stopTemplateSync = startTemplateSync();
  const stopDailyDigests = startDailyDigests();
  startInboxRules(); // auto-cierre + retoma del bot + purga de exports
  const stopBillingDunning = startBillingDunning(); // gracia 7d legacy (se apaga si el recurrente está ON)
  const stopSubscriptionBilling = startSubscriptionBilling(); // cobro recurrente 48h (gateado por env)
  const stopTrialLifecycle = startTrialLifecycle(); // prueba 7+7: avisos + deshabilitar (solo lectura)
  const stopAnnualRefill = startAnnualWalletRefill(); // anual: acredita el cupo mes a mes (no 12 de una)
  const stopRetentionPurge = startRetentionPurge(); // purga por política de retención
  const stopCatalogSync = startCatalogSync(); // sync incremental del catálogo cada 6 h
  const stopOrphanWaba = startOrphanWabaCheck(); // alerta WABA huérfana tras baja de tenant

  // Latido para monitoreo: el worker escribe su timestamp cada 15 s con TTL 60 s.
  // La API lo lee en /health/status; si envejece, el worker está caído/atascado.
  const HEARTBEAT_KEY = "conversia:health:worker";
  const writeHeartbeat = () =>
    connection.set(HEARTBEAT_KEY, JSON.stringify({ ts: Date.now(), pid: process.pid }), "EX", 60).catch(() => undefined);
  void writeHeartbeat();
  const heartbeat = setInterval(() => void writeHeartbeat(), 15_000);
  heartbeat.unref?.();

  console.log(
    `✔ Worker Conversia activo — colas: ${QUEUE_NAMES.inbound}, ${QUEUE_NAMES.outbound} | IA: ${env.AI_PROVIDER} | WhatsApp: ${env.WHATSAPP_PROVIDER}`,
  );

  const shutdown = async () => {
    console.log("Cerrando worker…");
    clearInterval(heartbeat);
    stopBillingDunning();
    stopSubscriptionBilling();
    stopTrialLifecycle();
    stopAnnualRefill();
    stopRetentionPurge();
    stopCatalogSync();
    stopOrphanWaba();
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
      notificationsWorker.close(),
      waEscalationWorker.close(),
      agentTurnWorker.close(),
      workflowRetryWorker.close(),
    ]);
    await getPrisma().$disconnect();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
