import { getAdminPrisma, withTenant } from "@conversia/database";
import type { MessagingEvent } from "./messaging-events";
import { emitPlatformEvent } from "./platform-events";
import { cancelTimersOnReply, dispatchEvent, handlePendingObjective } from "./workflow-runtime";
import { runAgentTurn } from "./agent-turn";

// Ingesta de Messenger / Instagram Direct: mismo pipeline que WhatsApp
// (identidad → conversación → mensaje idempotente → triggers → turno del
// agente). El tenant se resuelve por el asset de página/IG registrado al
// conectar la página en Meta CRM (docs/OMNICHANNEL.md).

async function resolveMessagingTenant(e: MessagingEvent): Promise<string | null> {
  const prisma = getAdminPrisma();
  const kind = e.platform === "messenger" ? "page" : "instagram";
  const asset = await prisma.metaAsset.findFirst({ where: { kind, externalId: e.channelExternalId } });
  if (asset) return asset.organizationId;
  // Fallback IG: si la cuenta IG no está registrada aún, intenta por página.
  if (e.platform === "instagram") {
    const byPage = await prisma.metaAsset.findFirst({ where: { kind: "page", externalId: e.channelExternalId } });
    if (byPage) return byPage.organizationId;
  }
  return null;
}

export async function processMessagingEvent(e: MessagingEvent): Promise<void> {
  const organizationId = await resolveMessagingTenant(e);
  if (!organizationId) {
    console.warn(`⚠ Mensaje de ${e.platform} para activo desconocido ${e.channelExternalId} — descartado`);
    return;
  }
  const channelType = e.platform === "messenger" ? "MESSENGER" : "INSTAGRAM";

  const result = await withTenant(organizationId, async (tx) => {
    // Idempotencia por mid
    const dup = await tx.message.findUnique({
      where: { organizationId_externalId: { organizationId, externalId: e.externalId } },
    });
    if (dup) return null;

    // Canal auto-creado por página/cuenta (config.pageId rutea el envío)
    const candidates = await tx.channelConnection.findMany({ where: { type: channelType as any } });
    let channel =
      candidates.find((c) => {
        const cfg = (c.config as any) ?? {};
        return String(cfg.pageId ?? "") === e.channelExternalId || String(cfg.igId ?? "") === e.channelExternalId;
      }) ?? null;
    if (!channel) {
      channel = await tx.channelConnection.create({
        data: {
          organizationId,
          type: channelType as any,
          name: e.platform === "messenger" ? `Messenger · página ${e.channelExternalId}` : `Instagram · ${e.channelExternalId}`,
          status: "active",
          config: { pageId: e.channelExternalId } as object,
        },
      });
    }

    // Identidad de la red (PSID/IGSID) — el contacto puede no tener teléfono
    let identity = await tx.contactIdentity.findUnique({
      where: { organizationId_channelType_externalId: { organizationId, channelType: channelType as any, externalId: e.senderId } },
      include: { contact: true },
    });
    let contact = identity?.contact ?? null;
    if (!contact) {
      contact = await tx.contact.create({
        data: { organizationId, source: e.platform, createdVia: "webhook", firstContactAt: new Date(), lastContactAt: new Date() },
      });
      await tx.contactIdentity.create({
        data: { organizationId, contactId: contact.id, channelType: channelType as any, externalId: e.senderId },
      });
    } else {
      await tx.contact.update({ where: { id: contact.id }, data: { lastContactAt: new Date() } });
    }

    let conversation = await tx.conversation.findFirst({
      where: { contactId: contact.id, channelConnectionId: channel.id, status: { in: ["OPEN", "PENDING"] } },
      orderBy: { createdAt: "desc" },
    });
    let started = false;
    if (!conversation) {
      conversation = await tx.conversation.create({
        data: { organizationId, contactId: contact.id, channelConnectionId: channel.id, activeAgentId: channel.defaultAgentId ?? null, status: "OPEN" },
      });
      started = true;
    }

    const body = e.text ?? `[${e.attachmentType ?? "adjunto"}]`;
    await tx.message.create({
      data: {
        organizationId,
        conversationId: conversation.id,
        direction: "INBOUND",
        type: e.attachmentType === "image" ? "IMAGE" : e.attachmentType === "audio" ? "AUDIO" : "TEXT",
        body,
        payload: { platform: e.platform, senderId: e.senderId } as object,
        externalId: e.externalId,
        status: "DELIVERED",
        authorType: "CONTACT",
        sentAt: new Date(e.timestamp),
      },
    });
    await tx.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date(), lastMessagePreview: body.slice(0, 120), unreadCount: { increment: 1 } },
    });
    return { conversationId: conversation.id, contactId: contact.id, started, text: e.text ?? "" };
  });

  if (!result) return; // duplicado

  await cancelTimersOnReply(organizationId, result.conversationId);

  const base = {
    organizationId,
    conversationId: result.conversationId,
    contactId: result.contactId,
    data: { text: result.text, isFirstMessage: result.started, channel: e.platform },
    occurredAt: new Date().toISOString(),
  };
  if (result.started) {
    await dispatchEvent({ ...base, type: "conversation_started" });
    await emitPlatformEvent(organizationId, "conversation.started", { conversationId: result.conversationId, contactId: result.contactId, channel: e.platform });
  }
  await dispatchEvent({ ...base, type: "message_received" });
  await emitPlatformEvent(organizationId, "message.received", { conversationId: result.conversationId, text: result.text.slice(0, 200), channel: e.platform });

  // Turno del agente (objetivo pendiente primero, igual que WhatsApp)
  const objectiveHandled = await handlePendingObjective(organizationId, result.conversationId).catch(() => false);
  if (!objectiveHandled) {
    try {
      await runAgentTurn({ organizationId, conversationId: result.conversationId });
    } catch (err) {
      console.error(`✖ Turno de agente (${e.platform} ${result.conversationId}):`, (err as Error).message);
    }
  }
}
