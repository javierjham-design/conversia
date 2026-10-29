import { Worker } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getPrisma } from "@conversia/database";
import {
  QUEUE_NAMES,
  TRIGGER_TYPES,
  type AgentTurnJob,
  type BroadcastJob,
  type CapiJob,
  type ContactImportJob,
  type MessageImportJob,
  type EmailJob,
  type EventJob,
  type InboundJob,
  type OutboundJob,
  type SyncJob,
  type WebhookDeliveryJob,
  type WorkflowRetryJob,
} from "@conversia/types";
import { processCapiJob } from "./capi";
import { MetaRateLimitError } from "./channel-auth";
import { processClarivaWebhook, type ClarivaWebhookData } from "./clariva-webhook";
import { processContactImport } from "./contact-import";
import { processBroadcast } from "./broadcast";
import { processMessageImport } from "./respond-import";
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
import { startAiCreditsReconcile } from "./ai-credits-reconcile";
import { startTrialLifecycle } from "./trial-lifecycle";
import { startV2TrialLifecycle } from "./v2-trial-lifecycle";
import { startAnnualWalletRefill } from "./annual-wallet-refill";
import { startRetentionPurge } from "./retention-purge";
import { startCatalogSync } from "./catalog/scheduler";
import { startOrphanWabaCheck } from "./orphan-waba-check";
import { startReliabilityMonitor } from "./reliability-monitor";
import { startWhatsappTokenHealth, runWhatsappTokenHealth } from "./whatsapp-token-health";
import { startContactOverageMeter } from "./contact-overage";

async function main() {
  const env = getEnv();

  // Guarda contra el "mock silencioso en producción": si no hay NINGUNA llave de IA
  // real, el router respondería con texto de MOCK a clientes reales. Lo hacemos
  // RUIDOSO para enterarnos en el deploy, no cuando un prospecto ve una respuesta falsa.
  if (env.NODE_ENV === "production" && env.AI_PROVIDER !== "mock" && !env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    console.error(
      "‼ CRÍTICO: sin ANTHROPIC_API_KEY ni OPENAI_API_KEY en producción — el bot respondería con texto de MOCK. Carga una llave de IA YA.",
    );
  }

  const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

  // lockDuration 120 s (§8.4/§8.6): un turno de IA con herramientas pasa de los
  // 30 s por defecto, BullMQ daba el job por perdido y lo re-procesaba en
  // paralelo → el cliente recibía respuesta doble.
  const AI_LOCK_DURATION_MS = 120_000;

  const inboundWorker = new Worker<InboundJob>(
    QUEUE_NAMES.inbound,
    async (job) => processInbound(job.data),
    { connection, concurrency: env.WORKER_CONCURRENCY, lockDuration: AI_LOCK_DURATION_MS },
  );
  /**
   * §4.5 — Tope de RITMO de envío + respuesta al rate limit de Meta.
   *
   * `limiter` pone un techo de mensajes por segundo para toda la cola: antes no había
   * ninguno, así que una difusión o una ráfaga salía tan rápido como podía y lo que
   * frenaba era el 130429 de Meta (que además castiga la calidad de la cuenta). El
   * default (60/s) está por ENCIMA del techo real medido del worker (~50 msg/s, ver
   * docs de la tanda de carga), así que no cambia nada en la práctica: es un cinturón.
   *
   * Y cuando Meta igual nos limita, se frena la COLA el tiempo que haga falta en vez de
   * reintentar ese mensaje enseguida — `rateLimit()` + `RateLimitError` le dice a BullMQ
   * que esto no gasta un intento.
   */
  const outboundWorker: Worker<OutboundJob> = new Worker<OutboundJob>(
    QUEUE_NAMES.outbound,
    async (job) => {
      try {
        await processOutbound(job.data, { attemptsMade: job.attemptsMade, maxAttempts: job.opts.attempts ?? 1 });
      } catch (err) {
        if (err instanceof MetaRateLimitError) {
          console.warn(`⏳ Meta nos está limitando: pauso la cola de envío ${Math.round(err.retryAfterMs / 1000)}s — ${err.message}`);
          await outboundWorker.rateLimit(err.retryAfterMs);
          throw Worker.RateLimitError();
        }
        throw err;
      }
    },
    {
      connection,
      concurrency: env.WORKER_CONCURRENCY,
      limiter: { max: env.WA_SEND_MAX_PER_SECOND, duration: 1000 },
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
  // Difusiones (envío masivo por plantilla): resuelve destinatarios y encola en
  // `outbound` (que aplica el gating por mensaje). Concurrencia 1: una difusión a
  // la vez para no inundar la cola de salida.
  const broadcastWorker = new Worker<BroadcastJob>(
    QUEUE_NAMES.broadcast,
    async (job) => processBroadcast(job),
    { connection, concurrency: 1 },
  );
  // Historial de mensajes (migración Respond.io): escritura pura, sin triggers.
  const messageImportsWorker = new Worker<MessageImportJob>(
    QUEUE_NAMES.messageImports,
    async (job) => processMessageImport(job),
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
    async (job) => {
      // Re-chequeo de tokens de WhatsApp a demanda (botón "Revisar de nuevo" del super admin):
      // corre el mismo barrido que el timer de 15 min, así la recuperación se detecta al instante.
      if (job.data.kind === "whatsapp_token_health") return void (await runWhatsappTokenHealth(connection));
      return processSyncJob(job.data);
    },
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
    { connection, concurrency: 4, lockDuration: AI_LOCK_DURATION_MS },
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
      await emitPlatformEvent(job.data.organizationId, job.data.type, job.data.data ?? {}, {
        contactId: job.data.contactId ?? null,
      });
      const triggerType = job.data.type.replace(/\./g, "_");
      if ((TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
        await dispatchEvent({ ...job.data, type: triggerType });
      }
    },
    { connection, concurrency: env.WORKER_CONCURRENCY },
  );

  // Lista ÚNICA de workers: la usan el log de fallos y el apagado, así ninguno
  // queda fuera del cierre (messageImports se nos había quedado afuera, §8.6).
  const allWorkers = [
    inboundWorker,
    outboundWorker,
    webhookWorker,
    capiWorker,
    eventsWorker,
    importsWorker,
    messageImportsWorker,
    broadcastWorker,
    emailsWorker,
    syncWorker,
    notificationsWorker,
    waEscalationWorker,
    agentTurnWorker,
    workflowRetryWorker,
  ];
  for (const w of allWorkers) {
    w.on("failed", (job, err) => console.error(`✖ Job ${w.name}/${job?.id} falló: ${err.message}`));
  }

  const stopScheduler = startScheduler();
  const stopTemplateSync = startTemplateSync();
  const stopDailyDigests = startDailyDigests();
  startInboxRules(); // auto-cierre + retoma del bot + purga de exports
  const stopBillingDunning = startBillingDunning(); // gracia 7d legacy (se apaga si el recurrente está ON)
  const stopSubscriptionBilling = startSubscriptionBilling(); // cobro recurrente 48h (gateado por env)
  // Cobra las respuestas que quedaron sin asiento (reinicio, timeout de base). Va aparte
  // del cobro recurrente: ese está gateado por env y, apagado, se perderían los cargos.
  const stopCreditsReconcile = startAiCreditsReconcile();
  const stopTrialLifecycle = startTrialLifecycle(); // prueba 7+7: avisos + deshabilitar (solo lectura)
  const stopV2TrialLifecycle = startV2TrialLifecycle(); // V2: 30 gratis → copiloto 7d → pausa (sin purga)
  const stopAnnualRefill = startAnnualWalletRefill(); // anual: acredita el cupo mes a mes (no 12 de una)
  const stopRetentionPurge = startRetentionPurge(); // purga por política de retención
  const stopCatalogSync = startCatalogSync(); // sync incremental del catálogo cada 6 h
  const stopOrphanWaba = startOrphanWabaCheck(); // alerta WABA huérfana tras baja de tenant
  const stopReliability = startReliabilityMonitor(connection); // canario TuBot + scan sin-responder
  const stopWaTokenHealth = startWhatsappTokenHealth(connection); // chequeo activo de tokens de WhatsApp (190)
  const stopOverageMeter = startContactOverageMeter(); // excedente de contactos → billable post-pago

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

  // Apagado ordenado (§8.6): un worker trabado (turno de IA largo, Meta sin
  // responder) no puede colgar el cierre. Se espera a lo sumo 25 s por cierre,
  // se avisa y se sigue; los jobs que no terminaron vuelven a la cola y los
  // retoma la instancia nueva.
  const CLOSE_TIMEOUT_MS = 25_000;
  const closeWithTimeout = async (name: string, closing: Promise<unknown>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        closing.then(() => "closed" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), CLOSE_TIMEOUT_MS);
        }),
      ]);
      if (result === "timeout") console.error(`⚠ ${name} no cerró en ${CLOSE_TIMEOUT_MS} ms; se continúa con el apagado`);
    } catch (e) {
      console.error(`⚠ Error cerrando ${name}:`, (e as Error).message);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const shutdown = async () => {
    console.log("Cerrando worker…");
    clearInterval(heartbeat);
    stopBillingDunning();
    stopSubscriptionBilling();
    stopCreditsReconcile();
    stopTrialLifecycle();
    stopV2TrialLifecycle();
    stopAnnualRefill();
    stopRetentionPurge();
    stopCatalogSync();
    stopOrphanWaba();
    stopReliability();
    stopWaTokenHealth();
    stopOverageMeter();
    stopTemplateSync();
    stopDailyDigests();
    // El scheduler espera su tick en curso (no corta un recordatorio a medias),
    // acotado por el mismo techo de 25 s para no quedarnos colgados.
    await closeWithTimeout("scheduler", stopScheduler());
    await Promise.all(allWorkers.map((w) => closeWithTimeout(w.name, w.close())));
    await getPrisma().$disconnect();
    connection.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
