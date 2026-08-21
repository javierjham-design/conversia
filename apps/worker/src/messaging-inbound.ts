import { fetchGraphWithProof, getEnv } from "@conversia/config";
import { getAdminPrisma, withTenant } from "@conversia/database";
import type { MessagingEvent } from "./messaging-events";
import { emitPlatformEvent } from "./platform-events";
import { notifyHumanAttendedMessage } from "./notifications/human-message";
import { cancelTimersOnReply, dispatchEvent, handlePendingObjective } from "./workflow-runtime";
import { runAgentTurn } from "./agent-turn";
import { pageToken } from "./messaging-send";

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

/**
 * Nombre del remitente vía Graph con token de PÁGINA (Messenger: first/last
 * name; Instagram: name/username). Best-effort: si Graph lo niega (permiso
 * pendiente de App Review, IG sin página vinculada) el contacto queda sin
 * nombre y se reintenta en su próximo mensaje.
 */
async function enrichContactName(
  organizationId: string,
  contactId: string,
  e: MessagingEvent,
  pageId: string,
): Promise<void> {
  try {
    const token = await pageToken(organizationId, pageId);
    const v = getEnv().META_GRAPH_VERSION;
    const fields = e.platform === "messenger" ? "first_name,last_name" : "name,username";
    const res = await fetchGraphWithProof(
      `https://graph.facebook.com/${v}/${encodeURIComponent(e.senderId)}?fields=${fields}&access_token=${encodeURIComponent(token)}`,
      token,
    );
    let json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Acceso estándar: Meta niega el perfil directo del PSID/IGSID. Plan B
      // permitido: el nombre viene en los PARTICIPANTES de la conversación de
      // la página (mismo endpoint que el diagnóstico valida en verde).
      const platformParam = e.platform === "instagram" ? "&platform=instagram" : "";
      const conv = await fetchGraphWithProof(
        `https://graph.facebook.com/${v}/${encodeURIComponent(pageId)}/conversations?user_id=${encodeURIComponent(e.senderId)}&fields=participants${platformParam}&access_token=${encodeURIComponent(token)}`,
        token,
      );
      const cjson: any = await conv.json().catch(() => ({}));
      const parts: any[] = cjson?.data?.[0]?.participants?.data ?? [];
      const p = parts.find((x) => String(x?.id ?? "") === e.senderId);
      if (!conv.ok || !p) {
        console.warn(`⚠ Perfil de ${e.platform} ${e.senderId} no disponible: ${json?.error?.message ?? res.status}`);
        return;
      }
      json = { name: p.name ?? p.username ?? null, username: p.username ?? null };
    }
    const name: string | null =
      [json.first_name, json.last_name].filter(Boolean).join(" ") || json.name || json.username || null;
    if (!name) return;
    const first = json.first_name ?? String(name).split(" ")[0];
    const last = json.last_name ?? (String(name).split(" ").slice(1).join(" ") || null);
    await withTenant(organizationId, async (tx) => {
      const c = await tx.contact.findUnique({ where: { id: contactId }, select: { firstName: true } });
      await tx.contact.update({
        where: { id: contactId },
        data: { profileName: name, ...(c?.firstName ? {} : { firstName: first, lastName: last }) },
      });
    });
  } catch (err) {
    console.warn(`⚠ Enriquecimiento de perfil ${e.platform} falló: ${(err as Error).message}`);
  }
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
    return {
      conversationId: conversation.id,
      contactId: contact.id,
      started,
      text: e.text ?? "",
      needsName: !contact.firstName && !contact.profileName,
      pageId: String((channel.config as any)?.pageId ?? e.channelExternalId),
    };
  });

  if (!result) return; // duplicado

  if (result.needsName) await enrichContactName(organizationId, result.contactId, e, result.pageId);

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
  await notifyHumanAttendedMessage(organizationId, result.conversationId, result.text);

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
