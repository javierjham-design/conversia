import { getAdminPrisma } from "@conversia/database";
import { enqueueNotification } from "./queue";

/**
 * Aviso por mensaje entrante SOLO cuando la conversación está atendida por un
 * humano (aiEnabled=false: la IA no va a responder sola). Va al usuario/equipo
 * asignado; sin asignación, a los admins/owner del tenant. El despachador ya
 * evita el push si el usuario está mirando esa conversación (presencia) y
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
    if (!convo || convo.aiEnabled) return; // la IA responde: no molestar

    const contact = await prisma.contact.findUnique({
      where: { id: convo.contactId },
      select: { firstName: true, lastName: true, profileName: true, phone: true },
    });
    const contactName =
      [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") ||
      contact?.profileName ||
      contact?.phone ||
      "Un cliente";

    // Sin asignación no hay audiencia resoluble (assigned_user/team): fallback
    // explícito a admins/owner para que el mensaje nunca quede sin aviso.
    let userIds: string[] | undefined;
    if (!convo.assignedUserId && !convo.assignedTeamId) {
      const roles = await prisma.role.findMany({
        where: { organizationId, code: { in: ["owner", "admin"] } },
        select: { id: true },
      });
      const members = await prisma.organizationUser.findMany({
        where: { organizationId, active: true, roleId: { in: roles.map((r) => r.id) } },
        select: { userId: true },
      });
      userIds = members.map((m) => m.userId);
      if (userIds.length === 0) return;
    }

    await enqueueNotification({
      eventKey: "message.received_human",
      organizationId,
      conversationId,
      userIds,
      context: { assignedUserId: convo.assignedUserId, teamId: convo.assignedTeamId, conversationId },
      data: {
        contactName,
        excerpt: (text || "[adjunto]").slice(0, 140),
        conversationId,
      },
    });
  } catch (err) {
    console.warn(`⚠ Aviso de mensaje humano falló (${conversationId}): ${(err as Error).message}`);
  }
}
