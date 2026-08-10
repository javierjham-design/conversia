import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import {
  QUEUE_NAMES,
  type CapiJob,
  type ContactImportJob,
  type EmailJob,
  type EventJob,
  type InboundJob,
  type OutboundJob,
  type SyncJob,
  type WebhookDeliveryJob,
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
  readonly sync = new Queue<SyncJob>(QUEUE_NAMES.sync, { connection: this.connection });
  readonly emails = new Queue<EmailJob>(QUEUE_NAMES.emails, { connection: this.connection });
  readonly notifications = new Queue<NotifJob>(QUEUE_NAMES.notifications, { connection: this.connection });

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
    ]);
    this.connection.disconnect();
  }
}
