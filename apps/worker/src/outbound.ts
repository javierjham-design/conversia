import { withTenant } from "@conversia/database";
import type { OutboundJob } from "@conversia/types";
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

    let phoneNumberId: string | null = null;
    if (conversation.channelConnectionId) {
      const number = await tx.whatsappPhoneNumber.findFirst({
        where: { channelConnectionId: conversation.channelConnectionId },
      });
      phoneNumberId = number?.phoneNumberId ?? null;
      if (!phoneNumberId) {
        const org = await tx.organization.findUnique({ where: { id: organizationId } });
        phoneNumberId = `mock:${org?.slug ?? organizationId}`;
      }
    }
    return { message, phone: conversation.contact.phone, phoneNumberId: phoneNumberId ?? "mock:unknown" };
  });

  if (!data) return;

  try {
    const sent = await getChannelProvider().send(data.phoneNumberId, {
      to: data.phone,
      type: "text",
      text: data.message.body ?? "",
    });
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
    throw err; // BullMQ reintenta según la política del worker
  }
}
