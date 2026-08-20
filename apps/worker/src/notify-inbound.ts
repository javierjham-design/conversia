import { withTenant } from "@conversia/database";
import { enqueueNotification } from "./notifications/queue";

/**
 * Aviso al humano a cargo cuando entra un mensaje del contacto y la IA está APAGADA
 * (un humano lleva la conversación). Con la IA encendida NO notifica: el bot responde
 * solo. El despachador de notificaciones omite el push de la conversación que el usuario
 * está mirando en ese momento (reportViewing). Best-effort: no rompe el flujo de entrada.
 * Sirve para todos los canales (WhatsApp, Messenger, Instagram).
 */
export async function notifyHumanOnPausedInbound(
  organizationId: string,
  conversationId: string,
  text: string | null | undefined,
): Promise<void> {
  try {
    const conv = await withTenant(organizationId, (tx) =>
      tx.conversation.findUnique({
        where: { id: conversationId },
        select: {
          aiEnabled: true,
          assignedUserId: true,
          assignedTeamId: true,
          contact: { select: { firstName: true, lastName: true, profileName: true, phone: true } },
        },
      }),
    );
    if (!conv || conv.aiEnabled) return; // IA encendida → el bot responde, no notificamos
    const c = conv.contact;
    const contactName = [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.profileName || c?.phone || "Un contacto";
    await enqueueNotification({
      eventKey: "message.received",
      organizationId,
      context: { assignedUserId: conv.assignedUserId ?? null, teamId: conv.assignedTeamId ?? null, conversationId },
      conversationId,
      data: { contactName, preview: (text ?? "").slice(0, 80) || "(adjunto)", conversationId },
    });
  } catch (err) {
    console.error(`✖ Aviso de mensaje entrante (${conversationId}):`, (err as Error).message);
  }
}
