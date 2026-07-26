import { Queue } from "bullmq";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { QUEUE_NAMES, type CapiJob, type WebhookDeliveryJob } from "@conversia/types";

let connection: IORedis | undefined;
let webhookQueue: Queue<WebhookDeliveryJob> | undefined;
let capiQueue: Queue<CapiJob> | undefined;

function queues() {
  if (!connection) {
    connection = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    webhookQueue = new Queue(QUEUE_NAMES.webhooks, { connection });
    capiQueue = new Queue(QUEUE_NAMES.capi, { connection });
  }
  return { webhookQueue: webhookQueue!, capiQueue: capiQueue! };
}

/** Elimina claves con pinta de secreto/token del payload publicado. */
function sanitize(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (/token|secret|password|api[_-]?key|authorization/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Emite un evento público de la plataforma:
 * 1. Lo registra en integration_events (actividad).
 * 2. Crea entregas para los webhooks salientes suscritos y las encola.
 * 3. Si hay reglas CAPI activas que matcheen, encola el envío a Meta.
 *
 * `type` usa nombres públicos ("lead.status_changed"); para CAPI se evalúa
 * también la variante con sufijo ("lead.status_changed:agenda").
 */
export async function emitPlatformEvent(
  organizationId: string,
  type: string,
  data: Record<string, unknown> = {},
  opts: { contactPhone?: string | null; leadId?: string | null } = {},
): Promise<void> {
  const clean = sanitize(data);
  try {
    const { webhookQueue, capiQueue } = queues();

    const result = await withTenant(organizationId, async (tx) => {
      await tx.integrationEvent.create({
        data: { organizationId, provider: "events", type, payload: clean as object },
      });

      const endpoints = await tx.webhookEndpoint.findMany({ where: { active: true } });
      const subscribed = endpoints.filter((e) => Array.isArray(e.events) && (e.events as string[]).includes(type));
      const deliveries = [] as { id: string }[];
      for (const endpoint of subscribed) {
        const delivery = await tx.webhookDelivery.create({
          data: {
            organizationId,
            endpointId: endpoint.id,
            event: type,
            payload: { event: type, occurredAt: new Date().toISOString(), data: clean } as object,
            status: "PENDING",
          },
          select: { id: true },
        });
        deliveries.push(delivery);
      }

      const mapping = await tx.metaEventMapping.findUnique({ where: { organizationId } });
      const sources = [type, ...(typeof clean.statusCode === "string" ? [`${type}:${clean.statusCode}`] : [])];
      const capiMatch = Boolean(
        mapping?.active &&
          mapping.datasetId &&
          Array.isArray(mapping.rules) &&
          (mapping.rules as any[]).some((r) => r?.active && sources.includes(r?.source)),
      );
      return { deliveries, capiMatch };
    });

    for (const d of result.deliveries) {
      await webhookQueue.add("deliver", { organizationId, deliveryId: d.id });
    }
    if (result.capiMatch) {
      const source = typeof clean.statusCode === "string" ? `${type}:${clean.statusCode}` : type;
      await capiQueue.add("send", {
        organizationId,
        source,
        contactPhone: opts.contactPhone ?? null,
        leadId: opts.leadId ?? null,
        occurredAt: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error(`✖ emitPlatformEvent(${type}):`, (err as Error).message);
  }
}
