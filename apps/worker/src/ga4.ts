import { Queue } from "bullmq";
import IORedis from "ioredis";
import { createHash } from "node:crypto";
import { getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { QUEUE_NAMES, type SyncJob } from "@conversia/types";
import { decryptCredential } from "./credentials";

/**
 * Google Analytics 4 vía Measurement Protocol (sin OAuth): measurement_id +
 * api_secret (cifrado). Eventos del paso de workflow "Enviar evento GA4" y el
 * espejo opcional de los eventos CAPI. Reintentos vía la cola integration-sync.
 */

let connection: IORedis | undefined;
let syncQueue: Queue<SyncJob> | undefined;

export function getSyncQueue(): Queue<SyncJob> {
  if (!syncQueue) {
    connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    syncQueue = new Queue(QUEUE_NAMES.sync, { connection });
  }
  return syncQueue;
}

/** client_id estable y anónimo por contacto (GA4 lo exige; no expone el teléfono). */
export function ga4ClientId(organizationId: string, contactKey: string | null): string {
  const raw = `${organizationId}:${contactKey ?? "anon"}`;
  const h = createHash("sha256").update(raw).digest("hex");
  return `${parseInt(h.slice(0, 8), 16)}.${parseInt(h.slice(8, 16), 16)}`;
}

async function getGa4Config(organizationId: string): Promise<{ measurementId: string; apiSecret: string; mirrorCapi: boolean } | null> {
  return withTenant(organizationId, async (tx) => {
    const conn = await tx.integrationConnection.findFirst({ where: { provider: "ga4", status: { not: "inactive" } } });
    if (!conn) return null;
    const cfg = (conn.config as Record<string, any>) ?? {};
    if (!cfg.measurementId || !conn.credentialId) return null;
    const cred = await tx.integrationCredential.findUnique({ where: { id: conn.credentialId } });
    if (!cred) return null;
    try {
      return { measurementId: String(cfg.measurementId), apiSecret: decryptCredential(cred.ciphertext), mirrorCapi: Boolean(cfg.mirrorCapi) };
    } catch {
      return null;
    }
  });
}

/** Envía un evento a GA4 (Measurement Protocol). Lanza en error → BullMQ reintenta. */
export async function sendGa4Event(
  organizationId: string,
  event: { name: string; params?: Record<string, unknown>; clientId?: string },
): Promise<void> {
  const config = await getGa4Config(organizationId);
  const log = (status: "ok" | "error", message: string) =>
    withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: { organizationId, provider: "ga4", type: status === "ok" ? "ga4.sent" : "ga4.error", status, message },
      }),
    ).catch(() => undefined);

  if (!config) {
    await log("error", `Evento GA4 «${event.name}» no enviado: la integración no está configurada`);
    return; // sin config no hay nada que reintentar
  }
  const name = event.name.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 40) || "tubot_event";
  const res = await fetch(
    `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(config.measurementId)}&api_secret=${encodeURIComponent(config.apiSecret)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: event.clientId ?? ga4ClientId(organizationId, null),
        events: [{ name, params: { ...(event.params ?? {}), engagement_time_msec: 1 } }],
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  // MP responde 2xx aunque ignore el evento; 4xx/5xx = problema real.
  if (!res.ok) {
    await log("error", `GA4 respondió ${res.status} para «${name}»`);
    throw new Error(`GA4 ${res.status}`);
  }
  await log("ok", `Evento GA4 «${name}» enviado`);
}

/** Espejo de eventos CAPI → GA4 (si el tenant activó "enviar también a Analytics"). */
export async function mirrorCapiToGa4(
  organizationId: string,
  event: { name: string; value?: number | null; currency?: string | null; contactKey?: string | null },
): Promise<void> {
  try {
    const config = await getGa4Config(organizationId);
    if (!config?.mirrorCapi) return;
    await getSyncQueue().add(
      "ga4",
      {
        organizationId,
        kind: "ga4_event",
        payload: {
          name: event.name,
          clientId: ga4ClientId(organizationId, event.contactKey ?? null),
          params: {
            ...(event.value != null ? { value: event.value, currency: event.currency ?? "CLP" } : {}),
            source: "capi_mirror",
          },
        },
      },
      { attempts: 4, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000 },
    );
  } catch (err) {
    console.error("✖ mirrorCapiToGa4:", (err as Error).message);
  }
}
