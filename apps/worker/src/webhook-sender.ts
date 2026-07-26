import { createHmac } from "node:crypto";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { QUEUE_NAMES, validateOutboundUrl, type WebhookDeliveryJob } from "@conversia/types";

/** Backoff de reintentos: 1m, 5m, 30m, 2h, 6h… */
const BACKOFF_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000];

let retryQueue: Queue<WebhookDeliveryJob> | undefined;
function getRetryQueue(): Queue<WebhookDeliveryJob> {
  if (!retryQueue) {
    const connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    retryQueue = new Queue(QUEUE_NAMES.webhooks, { connection });
  }
  return retryQueue;
}

/**
 * Entrega una fila de webhook_deliveries: POST firmado HMAC-SHA256
 * (X-Conversia-Signature) con headers personalizados, timeout y reintentos
 * con backoff. Registra código, error y próxima ejecución.
 */
export async function processWebhookDelivery(job: WebhookDeliveryJob): Promise<void> {
  const { organizationId, deliveryId } = job;

  const data = await withTenant(organizationId, async (tx) => {
    const delivery = await tx.webhookDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery || delivery.status === "DELIVERED") return null;
    const endpoint = await tx.webhookEndpoint.findUnique({ where: { id: delivery.endpointId } });
    if (!endpoint || !endpoint.active) {
      await tx.webhookDelivery.update({ where: { id: deliveryId }, data: { status: "DEAD", lastError: "Endpoint inactivo" } });
      return null;
    }
    return { delivery, endpoint };
  });
  if (!data) return;

  const { delivery, endpoint } = data;
  const env = getEnv();
  const urlCheck = validateOutboundUrl(endpoint.url, { allowLocalhost: env.NODE_ENV !== "production" });
  if (!urlCheck.ok) {
    await withTenant(organizationId, (tx) =>
      tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "DEAD", lastError: `URL rechazada: ${urlCheck.reason}` },
      }),
    );
    return;
  }

  const body = JSON.stringify({ id: delivery.id, ...(delivery.payload as object) });
  const signature = createHmac("sha256", endpoint.secret).update(body).digest("hex");
  const attempt = delivery.attempts + 1;
  const started = Date.now();

  let responseCode: number | null = null;
  let error: string | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs);
    const res = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Conversia-Webhooks/1.0",
        "x-conversia-signature": `sha256=${signature}`,
        "x-conversia-event": delivery.event,
        "x-conversia-delivery": delivery.id,
        ...((endpoint.headers as Record<string, string>) ?? {}),
      },
      body,
      signal: controller.signal,
      redirect: "error",
    });
    clearTimeout(timer);
    responseCode = res.status;
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = (err as Error).name === "AbortError" ? `Timeout ${endpoint.timeoutMs}ms` : (err as Error).message.slice(0, 200);
  }
  const durationMs = Date.now() - started;

  if (!error) {
    await withTenant(organizationId, (tx) =>
      tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: { status: "DELIVERED", attempts: attempt, responseCode, lastError: null, nextRetryAt: null },
      }),
    );
    return;
  }

  const willRetry = attempt <= endpoint.maxRetries;
  const delay = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)];
  const nextRetryAt = willRetry ? new Date(Date.now() + delay) : null;

  await withTenant(organizationId, async (tx) => {
    await tx.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: willRetry ? "FAILED" : "DEAD",
        attempts: attempt,
        responseCode,
        lastError: `${error} (${durationMs}ms)`,
        nextRetryAt,
      },
    });
    if (!willRetry) {
      await tx.integrationEvent.create({
        data: {
          organizationId,
          provider: "webhook",
          type: "webhook.dead",
          status: "error",
          message: `${endpoint.name}: agotados ${attempt} intentos — ${error}`,
        },
      });
    }
  });

  if (willRetry) {
    await getRetryQueue().add("deliver", { organizationId, deliveryId }, { delay });
  }
}
