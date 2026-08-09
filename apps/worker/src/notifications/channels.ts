import { withTenant } from "@conversia/database";
import type { ChannelResult, NotificationChannel } from "@conversia/notifications";
import { sendTenantEmail } from "../mailer";

/**
 * Canal IN-APP: escribe en la tabla `notifications` (campana del panel). Agrupa:
 * si ya hay una notificación sin leer del mismo usuario y conversación en los
 * últimos 5 min, la ACTUALIZA en vez de crear otra (cinco mensajes = un aviso).
 */
export const inAppChannel: NotificationChannel = {
  channel: "in_app",
  async send(input): Promise<ChannelResult> {
    const conversationId = (input.data.conversationId as string | undefined) ?? undefined;
    try {
      await withTenant(input.organizationId, async (tx) => {
        if (conversationId) {
          const since = new Date(Date.now() - 5 * 60_000);
          const existing = await tx.notification.findFirst({
            where: {
              userId: input.userId,
              type: input.event.key,
              readAt: null,
              createdAt: { gte: since },
              meta: { path: ["conversationId"], equals: conversationId },
            },
            orderBy: { createdAt: "desc" },
          });
          if (existing) {
            await tx.notification.update({
              where: { id: existing.id },
              data: { title: input.title, body: input.body, createdAt: new Date() },
            });
            return;
          }
        }
        await tx.notification.create({
          data: {
            organizationId: input.organizationId,
            userId: input.userId,
            type: input.event.key,
            title: input.title,
            body: input.body,
            meta: { link: input.link ?? null, conversationId: conversationId ?? null } as object,
          },
        });
      });
      return { status: "sent" };
    } catch (e) {
      return { status: "failed", error: (e as Error).message.slice(0, 300) };
    }
  },
};

/** Canal EMAIL: correo al usuario destinatario (SMTP del tenant o plataforma). */
export const emailChannel: NotificationChannel = {
  channel: "email",
  async send(input): Promise<ChannelResult> {
    const to = input.data.userEmail as string | undefined;
    if (!to) return { status: "skipped", error: "usuario sin correo" };
    const link = input.link ? `${process.env.WEB_URL ?? ""}${input.link}` : (process.env.WEB_URL ?? "");
    const html = `<p><b>${escapeHtml(input.title)}</b></p><p>${escapeHtml(input.body)}</p>${
      input.link ? `<p><a href="${escapeHtml(link)}">Abrir en TuBot</a></p>` : ""
    }`;
    const res = await sendTenantEmail(input.organizationId, { to: [to], subject: input.title, html });
    return res.ok ? { status: "sent" } : { status: "failed", error: res.detail };
  },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
