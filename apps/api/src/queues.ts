import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import {
  QUEUE_NAMES,
  type AgentTurnJob,
  type CapiJob,
  type ContactImportJob,
  type EmailJob,
  type EventJob,
  type InboundJob,
  type MessageImportJob,
  type OutboundJob,
  type SyncJob,
  type WebhookDeliveryJob,
  type WorkflowRetryJob,
} from "@conversia/types";
import type { NotifJob } from "@conversia/notifications";

@Injectable()
export class QueueService implements OnModuleDestroy {
  // Expuesta para health checks (ping + lectura del latido del worker).
  readonly connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  readonly inbound = new Queue<InboundJob>(QUEUE_NAMES.inbound, { connection: this.connection });
  readonly outbound = new Queue<OutboundJob>(QUEUE_NAMES.outbound, { connection: this.connection });
  readonly events = new Queue<EventJob>(QUEUE_NAMES.events, { connection: this.connection });
  readonly webhooks = new Queue<WebhookDeliveryJob>(QUEUE_NAMES.webhooks, { connection: this.connection });
  readonly capi = new Queue<CapiJob>(QUEUE_NAMES.capi, { connection: this.connection });
  readonly imports = new Queue<ContactImportJob>(QUEUE_NAMES.imports, { connection: this.connection });
  readonly messageImports = new Queue<MessageImportJob>(QUEUE_NAMES.messageImports, { connection: this.connection });
  readonly sync = new Queue<SyncJob>(QUEUE_NAMES.sync, { connection: this.connection });
  readonly emails = new Queue<EmailJob>(QUEUE_NAMES.emails, { connection: this.connection });
  readonly notifications = new Queue<NotifJob>(QUEUE_NAMES.notifications, { connection: this.connection });
  readonly agentTurn = new Queue<AgentTurnJob>(QUEUE_NAMES.agentTurn, { connection: this.connection });
  readonly workflowRetry = new Queue<WorkflowRetryJob>(QUEUE_NAMES.workflow, { connection: this.connection });

  /** Reintenta una ejecución de flujo fallida desde el paso que falló (efectos reales). */
  async enqueueWorkflowRetry(job: WorkflowRetryJob): Promise<void> {
    await this.workflowRetry.add("retry", job, {
      jobId: `retry:${job.runId}`, // coalesce doble clic; se remueve al completar
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: 500,
    });
  }

  /** Corre un turno del agente de IA para una conversación (p. ej. tras una indicación). */
  async enqueueAgentTurn(job: AgentTurnJob): Promise<void> {
    // jobId por conversación EN VENTANA DE 5s: coalesce disparos casi simultáneos
    // (asignar + indicar) sin responder dos veces. OJO: el jobId fijo anterior
    // (`turn:<convId>`) se ENVENENABA — un turno fallido quedaba retenido en la
    // cola de fallidos con ese id y BullMQ ignoraba en silencio TODOS los
    // encolados futuros de esa conversación ("devolver a la IA" mudo en prod).
    const bucket = Math.floor(Date.now() / 5000);
    await this.agentTurn.add("turn", job, {
      jobId: `turn:${job.conversationId}:${bucket}`,
      attempts: 2,
      backoff: { type: "fixed", delay: 3000 },
      removeOnComplete: true,
      removeOnFail: 500,
    });
  }

  /** Emite un evento de notificación (la audiencia se resuelve en el worker). */
  async notify(job: NotifJob): Promise<void> {
    await this.notifications.add("notify", job, {
      attempts: 4,
      backoff: { type: "exponential", delay: 15_000 },
      removeOnComplete: 1000,
      removeOnFail: 2000,
    });
  }

  async onModuleDestroy() {
    await Promise.all([
      this.inbound.close(),
      this.outbound.close(),
      this.events.close(),
      this.webhooks.close(),
      this.capi.close(),
      this.imports.close(),
      this.sync.close(),
      this.emails.close(),
      this.notifications.close(),
      this.agentTurn.close(),
      this.workflowRetry.close(),
    ]);
    this.connection.disconnect();
  }
}
