import { withTenant } from "@conversia/database";
import type { OutboundJob } from "@conversia/types";
import { ChannelAuthError, markChannelAuthError, resolveChannelAuth } from "./channel-auth";
import { getChannelProvider } from "./channel-providers";

/** Envía mensajes salientes creados desde el panel (autor humano). */
export async function processOutbound(job: OutboundJob): Promise<void> {
  const { organizationId, messageId } = job;

  const data = await withTenant(organizationId, async (tx) => {
    const message = await tx.message.findUnique({ where: { id: messageId } });
    if (!message || message.status !== "PENDING") return null;
    const conversation = await tx.conversation.findUnique({
      where: { id: message.conversationId },
      include: { contact: true },
    });
    if (!conversation?.contact.phone) return null;
    return { message, phone: conversation.contact.phone, channelConnectionId: conversation.channelConnectionId };
  });

  if (!data) return;
  const auth = await resolveChannelAuth(organizationId, { channelConnectionId: data.channelConnectionId });

  try {
    const sent = await getChannelProvider().send(auth.phoneNumberId, {
      to: data.phone,
      type: "text",
      text: data.message.body ?? "",
    }, { accessToken: auth.accessToken });
    await withTenant(organizationId, (tx) =>
      tx.message.update({
        where: { id: data.message.id },
        data: { status: "SENT", externalId: sent.externalId, sentAt: new Date() },
      }),
    );
  } catch (err) {
    await withTenant(organizationId, (tx) =>
      tx.message.update({
        where: { id: data.message.id },
        data: { status: "FAILED", error: (err as Error).message.slice(0, 500) },
      }),
    );
    // Error de auth: marcar el canal (banner Reautorizar) y NO reintentar en
    // bucle — el token no se arregla solo. Otros errores sí reintentan.
    if (err instanceof ChannelAuthError) {
      await markChannelAuthError(organizationId, auth.channelConnectionId, err.message);
      return;
    }
    throw err; // BullMQ reintenta según la política del worker
  }
}
