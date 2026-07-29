import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import {
  QUEUE_NAMES,
  type CapiJob,
  type ContactImportJob,
  type EventJob,
  type InboundJob,
  type OutboundJob,
  type WebhookDeliveryJob,
} from "@conversia/types";

@Injectable()
export class QueueService implements OnModuleDestroy {
  private connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  readonly inbound = new Queue<InboundJob>(QUEUE_NAMES.inbound, { connection: this.connection });
  readonly outbound = new Queue<OutboundJob>(QUEUE_NAMES.outbound, { connection: this.connection });
  readonly events = new Queue<EventJob>(QUEUE_NAMES.events, { connection: this.connection });
  readonly webhooks = new Queue<WebhookDeliveryJob>(QUEUE_NAMES.webhooks, { connection: this.connection });
  readonly capi = new Queue<CapiJob>(QUEUE_NAMES.capi, { connection: this.connection });
  readonly imports = new Queue<ContactImportJob>(QUEUE_NAMES.imports, { connection: this.connection });

  async onModuleDestroy() {
    await Promise.all([
      this.inbound.close(),
      this.outbound.close(),
      this.events.close(),
      this.webhooks.close(),
      this.capi.close(),
      this.imports.close(),
    ]);
    this.connection.disconnect();
  }
}
