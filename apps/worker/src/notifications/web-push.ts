import webpush from "web-push";
import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";
import type { ChannelResult, NotificationChannel } from "@conversia/notifications";

let configured: boolean | null = null;

/** Configura VAPID una sola vez. Sin claves → Web Push desactivado. */
function ensureConfigured(): boolean {
  if (configured !== null) return configured;
  const env = getEnv();
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    configured = false;
    return false;
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

/**
 * Canal WEB PUSH: envía a TODOS los dispositivos web activos del usuario. Los
 * endpoints que el navegador reporta como caducados (404/410) se devuelven en
 * expiredIdentifiers para que el despachador los desactive. Un dispositivo muerto
 * nunca bloquea a los demás.
 */
export const webPushChannel: NotificationChannel = {
  channel: "web_push",
  async send(input): Promise<ChannelResult> {
    if (!ensureConfigured()) return { status: "skipped", error: "VAPID no configurado" };

    const devices = await getAdminPrisma().pushDevice.findMany({
      where: { userId: input.userId, kind: "web_push", active: true },
    });
    if (devices.length === 0) return { status: "skipped", error: "sin dispositivos web" };

    const payload = JSON.stringify({
      title: input.title,
      body: input.body,
      link: input.link ?? "/",
      // tag por conversación → el SO agrupa/reemplaza (agrupación en el cliente).
      tag: (input.data.conversationId as string | undefined) ?? input.event.key,
      eventKey: input.event.key,
    });

    const expired: string[] = [];
    let anySent = false;
    let lastError: string | undefined;

    await Promise.all(
      devices.map(async (d) => {
        const keys = (d.keys ?? {}) as { p256dh?: string; auth?: string };
        if (!keys.p256dh || !keys.auth) return;
        try {
          await webpush.sendNotification(
            { endpoint: d.identifier, keys: { p256dh: keys.p256dh, auth: keys.auth } },
            payload,
            { TTL: 3600, urgency: input.event.urgency === "critical" ? "high" : "normal" },
          );
          anySent = true;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) expired.push(d.identifier);
          else lastError = (e as Error).message.slice(0, 200);
        }
      }),
    );

    if (anySent) return { status: "sent", expiredIdentifiers: expired.length ? expired : undefined };
    if (expired.length) return { status: "failed", error: "todos los dispositivos caducados", expiredIdentifiers: expired };
    return { status: "failed", error: lastError ?? "no se pudo enviar" };
  },
};
