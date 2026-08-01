import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { realtimeChannel, type RealtimeEvent } from "@conversia/types";

/**
 * Publicador de eventos en vivo hacia la Bandeja (canal Redis por tenant).
 * Best-effort: si Redis pub falla, el panel cae a su sondeo de respaldo.
 */
let pub: IORedis | undefined;

export async function publishRealtime(organizationId: string, event: Omit<RealtimeEvent, "at">): Promise<void> {
  try {
    if (!pub) pub = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
    await pub.publish(realtimeChannel(organizationId), JSON.stringify({ ...event, at: new Date().toISOString() }));
  } catch (err) {
    console.error("✖ publishRealtime:", (err as Error).message);
  }
}
