import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { QUEUE_NAMES, type InboundJob, type OutboundJob, type EventJob } from "@conversia/types";

@Injectable()
export class QueueService implements OnModuleDestroy {
  private connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  readonly inbound = new Queue<InboundJob>(QUEUE_NAMES.inbound, { connection: this.connection });
  readonly outbound = new Queue<OutboundJob>(QUEUE_NAMES.outbound, { connection: this.connection });
  readonly events = new Queue<EventJob>(QUEUE_NAMES.events, { connection: this.connection });

  async onModuleDestroy() {
    await Promise.all([this.inbound.close(), this.outbound.close(), this.events.close()]);
    this.connection.disconnect();
  }
}
