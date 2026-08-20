import { getAdminPrisma } from "@conversia/database";
import { enqueueNotification } from "./queue";

/** Usuarios owner/admin del tenant (fallback de audiencia y monitoreo del seteo). */
async function ownerAdminUserIds(prisma: ReturnType<typeof getAdminPrisma>, organizationId: string): Promise<string[]> {
  const roles = await prisma.role.findMany({
    where: { organizationId, code: { in: ["owner", "admin"] } },
    select: { id: true },
  });
  const members = await prisma.organizationUser.findMany({
    where: { organizationId, active: true, roleId: { in: roles.map((r) => r.id) } },
    select: { userId: true },
  });
  return members.map((m) => m.userId);
}

/**
 * Aviso por mensaje entrante. Corre en CADA mensaje del contacto y elige el evento:
 *  - IA APAGADA (aiEnabled=false, la lleva un humano) → `message.received_human` al
 *    usuario/equipo asignado (o admins/owner si no hay asignación). ON por defecto.
 *  - IA ENCENDIDA (aiEnabled=true, responde el bot) → `message.received_ai` a admins/owner.
 *    OPT-IN (apagado por defecto): útil al SETEAR la IA para ver cómo responde. El despachador
 *    no lo envía a nadie que no lo haya activado, así que no satura.
 * En ambos casos, el despachador evita el push de la conversación que el usuario está mirando y
 * respeta la matriz de preferencias y el horario silencioso.
 */
export async function notifyHumanAttendedMessage(
  organizationId: string,
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    const prisma = getAdminPrisma();
    const convo = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { aiEnabled: true, assignedUserId: true, assignedTeamId: true, contactId: true },
    });
    if (!convo) return;

    const contact = await prisma.contact.findUnique({
      where: { id: convo.contactId },
      select: { firstName: true, lastName: true, profileName: true, phone: true },
    });
    const contactName =
      [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") ||
      contact?.profileName ||
      contact?.phone ||
      "Un cliente";
    const excerpt = (text || "[adjunto]").slice(0, 140);

    if (convo.aiEnabled) {
      // La IA responde: aviso OPT-IN a quien monitorea el arranque (admins/owner).
      const userIds = await ownerAdminUserIds(prisma, organizationId);
      if (userIds.length === 0) return;
      await enqueueNotification({
        eventKey: "message.received_ai",
        organizationId,
        conversationId,
        userIds,
        context: { conversationId },
        data: { contactName, excerpt, conversationId },
      });
      return;
    }

    // Humano a cargo: sin asignación no hay audiencia resoluble → fallback a admins/owner.
    let userIds: string[] | undefined;
    if (!convo.assignedUserId && !convo.assignedTeamId) {
      userIds = await ownerAdminUserIds(prisma, organizationId);
      if (userIds.length === 0) return;
    }

    await enqueueNotification({
      eventKey: "message.received_human",
      organizationId,
      conversationId,
      userIds,
      context: { assignedUserId: convo.assignedUserId, teamId: convo.assignedTeamId, conversationId },
      data: { contactName, excerpt, conversationId },
    });
  } catch (err) {
    console.warn(`⚠ Aviso de mensaje falló (${conversationId}): ${(err as Error).message}`);
  }
}
