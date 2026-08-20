import { fetchGraphWithProof, getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { resolveMetaLeadToken } from "./meta-token";

// Envío saliente a Messenger / Instagram Direct (ambos via POST {pageId}/messages
// con token de PÁGINA). Regla dura de Meta: ventana de 24 h desde el último
// mensaje del contacto; fuera de ella NO hay plantillas (a diferencia de
// WhatsApp) → el mensaje falla con un error claro.

const pageTokenCache = new Map<string, { token: string; at: number }>();
const PAGE_TOKEN_TTL = 60 * 60 * 1000;

/** Token de página derivado del token del tenant (CRM primero), con caché 1 h. */
export async function pageToken(organizationId: string, pageId: string): Promise<string> {
  const cached = pageTokenCache.get(pageId);
  if (cached && Date.now() - cached.at < PAGE_TOKEN_TTL) return cached.token;
  const userToken = await resolveMetaLeadToken(organizationId);
  if (!userToken) throw new Error("Sin token de Meta: conecta Meta CRM en Integraciones");
  const v = getEnv().META_GRAPH_VERSION;
  const res = await fetchGraphWithProof(
    `https://graph.facebook.com/${v}/${encodeURIComponent(pageId)}?fields=access_token&access_token=${encodeURIComponent(userToken)}`,
    userToken,
  );
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`Sin acceso de administración a la página ${pageId}: ${json?.error?.message ?? res.status}`);
  }
  pageTokenCache.set(pageId, { token: json.access_token, at: Date.now() });
  return json.access_token;
}

export interface MessagingChannelInfo {
  channelType: "MESSENGER" | "INSTAGRAM";
  pageId: string;
}

/** ¿Es un canal de mensajería de redes? Devuelve pageId de su config. */
export function messagingChannelInfo(channel: { type: string; config: unknown } | null): MessagingChannelInfo | null {
  if (!channel) return null;
  const cfg = (channel.config as Record<string, any>) ?? {};
  if (channel.type === "MESSENGER" && cfg.pageId) return { channelType: "MESSENGER", pageId: String(cfg.pageId) };
  // Instagram: los envíos van por la PÁGINA vinculada (config.pageId), no por el IG id.
  if (channel.type === "INSTAGRAM" && (cfg.pageId || cfg.igId)) {
    return { channelType: "INSTAGRAM", pageId: String(cfg.pageId ?? cfg.igId) };
  }
  return null;
}

/**
 * Envía texto a un contacto de Messenger/IG y actualiza el estado del mensaje.
 * Devuelve true si el canal ERA de mensajería (haya salido bien o mal).
 */
export async function trySendMessagingReply(
  organizationId: string,
  conversationId: string,
  messageId: string,
  text: string,
): Promise<boolean> {
  const info = await withTenant(organizationId, async (tx) => {
    const conversation = await tx.conversation.findUnique({ where: { id: conversationId } });
    if (!conversation?.channelConnectionId) return null;
    const channel = await tx.channelConnection.findUnique({ where: { id: conversation.channelConnectionId } });
    const mi = messagingChannelInfo(channel);
    if (!mi) return null;
    const identity = await tx.contactIdentity.findFirst({
      where: { contactId: conversation.contactId, channelType: mi.channelType as any },
      select: { externalId: true },
    });
    const lastInbound = await tx.message.findFirst({
      where: { conversationId, direction: "INBOUND", type: { notIn: ["SYSTEM", "NOTE"] } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return { mi, recipientId: identity?.externalId ?? null, lastInboundAt: lastInbound?.createdAt ?? null };
  });
  if (!info) return false; // no es un canal de mensajería de redes

  const fail = (error: string) =>
    withTenant(organizationId, (tx) => tx.message.update({ where: { id: messageId }, data: { status: "FAILED", error: error.slice(0, 500) } }));

  if (!info.recipientId) {
    await fail("Contacto sin identidad de la red (PSID/IGSID) — no se puede responder");
    return true;
  }
  // Ventana de 24 h (sin plantillas en IG/Messenger: fuera de ventana no hay envío)
  if (!info.lastInboundAt || Date.now() - info.lastInboundAt.getTime() > 24 * 3600 * 1000) {
    await fail("Fuera de la ventana de 24 h de Meta: el contacto debe escribir primero para poder responderle");
    return true;
  }

  try {
    const token = await pageToken(organizationId, info.mi.pageId);
    const v = getEnv().META_GRAPH_VERSION;
    const res = await fetchGraphWithProof(
      `https://graph.facebook.com/${v}/${encodeURIComponent(info.mi.pageId)}/messages?access_token=${encodeURIComponent(token)}`,
      token,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipient: { id: info.recipientId }, messaging_type: "RESPONSE", message: { text } }),
      },
    );
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message ?? `Graph ${res.status}`);
    await withTenant(organizationId, (tx) =>
      tx.message.update({ where: { id: messageId }, data: { status: "SENT", externalId: json.message_id ?? null, sentAt: new Date() } }),
    );
  } catch (err) {
    await fail((err as Error).message);
  }
  return true;
}
