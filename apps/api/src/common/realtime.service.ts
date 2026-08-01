import { Injectable, OnModuleDestroy } from "@nestjs/common";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { realtimeChannel, type RealtimeEvent } from "@conversia/types";

/**
 * Pub/sub Redis para la Bandeja en tiempo real. Un canal POR TENANT
 * (`rt:{orgId}`): cada suscripción SSE nace de un request autenticado y solo
 * escucha el canal de SU organización — cero fuga entre tenants.
 * El worker publica con el mismo helper (apps/worker/src/realtime.ts).
 */
@Injectable()
export class RealtimeService implements OnModuleDestroy {
  private pub = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  private sub = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  private listeners = new Map<string, Set<(event: RealtimeEvent) => void>>();
  private subscribed = new Set<string>();

  constructor() {
    this.sub.on("message", (channel: string, raw: string) => {
      const handlers = this.listeners.get(channel);
      if (!handlers?.size) return;
      try {
        const event = JSON.parse(raw) as RealtimeEvent;
        for (const fn of handlers) fn(event);
      } catch {
        /* payload corrupto: se ignora */
      }
    });
  }

  async publish(organizationId: string, event: Omit<RealtimeEvent, "at">): Promise<void> {
    try {
      await this.pub.publish(realtimeChannel(organizationId), JSON.stringify({ ...event, at: new Date().toISOString() }));
    } catch {
      /* el tiempo real es best-effort: el fallback de sondeo cubre */
    }
  }

  /** Suscribe un handler al canal del tenant. Devuelve el unsubscribe. */
  async subscribe(organizationId: string, handler: (event: RealtimeEvent) => void): Promise<() => void> {
    const channel = realtimeChannel(organizationId);
    let handlers = this.listeners.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(channel, handlers);
    }
    handlers.add(handler);
    if (!this.subscribed.has(channel)) {
      this.subscribed.add(channel);
      await this.sub.subscribe(channel);
    }
    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.listeners.delete(channel);
        this.subscribed.delete(channel);
        void this.sub.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  async onModuleDestroy() {
    this.pub.disconnect();
    this.sub.disconnect();
  }
}
