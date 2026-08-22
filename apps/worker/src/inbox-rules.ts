import { getAdminPrisma, withTenant } from "@conversia/database";
import { publishRealtime } from "./realtime.js";
import { purgeExpiredExports } from "./exports.js";

/**
 * Reglas de la bandeja (/settings/conversations), aplicadas por un tick cada
 * 10 minutos por organización:
 *  - Auto-cierre por inactividad (autoCloseDays > 0), con nota interna.
 *  - El bot retoma tras intervención humana (botResumeMinutes > 0).
 * También purga el contenido de exports expirados (7 días).
 */
export function startInboxRules(): () => void {
  const run = async () => {
    try {
      await purgeExpiredExports();
      const prisma = getAdminPrisma();
      const orgs = await prisma.organization.findMany({ select: { id: true, settings: true } });
      for (const org of orgs) {
        const inbox = (((org.settings ?? {}) as Record<string, any>).inbox ?? {}) as Record<string, any>;
        const autoCloseDays = Number(inbox.autoCloseDays ?? 0);
        const botResumeMinutes = Number(inbox.botResumeMinutes ?? 0);
        if (autoCloseDays > 0) await autoClose(org.id, autoCloseDays, String(inbox.autoCloseNote ?? "")).catch(() => undefined);
        if (botResumeMinutes > 0) await botResume(org.id, botResumeMinutes).catch(() => undefined);
      }
    } catch (err) {
      console.error("✖ inbox-rules tick:", (err as Error).message);
    }
  };
  void run();
  const interval = setInterval(run, 10 * 60 * 1000);
  return () => clearInterval(interval);
}

/** Cierra conversaciones abiertas sin actividad hace más de N días. */
async function autoClose(organizationId: string, days: number, note: string): Promise<void> {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
  const stale = await withTenant(organizationId, (tx) =>
    tx.conversation.findMany({
      where: { status: { in: ["OPEN", "PENDING"] }, lastMessageAt: { lt: cutoff } },
      select: { id: true, contactId: true },
      take: 100, // por tick, para no bloquear
    }),
  );
  if (!stale.length) return;
  await withTenant(organizationId, async (tx) => {
    for (const c of stale) {
      await tx.conversation.update({ where: { id: c.id }, data: { status: "CLOSED" } });
      await tx.message.create({
        data: {
          organizationId,
          conversationId: c.id,
          direction: "OUTBOUND",
          type: "SYSTEM",
          visibility: "INTERNAL",
          body: `✔ Cerrada automáticamente por inactividad (${days} día(s))${note ? ` — ${note}` : ""}`,
          authorType: "SYSTEM",
          status: "DELIVERED",
        },
      });
    }
    await tx.auditLog.create({
      data: { organizationId, actorType: "system", action: "conversation.auto_close", entityType: "conversation", after: { count: stale.length, days } },
    });
  });
  // Resumen automático de las cerradas (best-effort, en segundo plano). La función
  // gatea por contenido (salta las triviales), así que el costo de IA solo cae en
  // conversaciones con engagement real.
  void (async () => {
    const { summarizeConversationToMemory } = await import("./contact-memory.js");
    for (const c of stale) {
      if (c.contactId) await summarizeConversationToMemory(organizationId, c.id, c.contactId).catch(() => undefined);
    }
  })().catch(() => undefined);
  await publishRealtime(organizationId, { type: "counters.dirty" });
}

/** Devuelve el control al bot N minutos después de una toma de control humana. */
async function botResume(organizationId: string, minutes: number): Promise<void> {
  const cutoff = new Date(Date.now() - minutes * 60 * 1000);
  const handoffs = await withTenant(organizationId, (tx) =>
    tx.humanHandoff.findMany({
      where: { status: "ACTIVE", takenAt: { lt: cutoff } },
      select: { id: true, conversationId: true },
      take: 100,
    }),
  );
  for (const h of handoffs) {
    await withTenant(organizationId, async (tx) => {
      const conv = await tx.conversation.findUnique({ where: { id: h.conversationId }, select: { aiEnabled: true, status: true } });
      if (!conv || conv.aiEnabled || conv.status === "CLOSED") {
        await tx.humanHandoff.update({ where: { id: h.id }, data: { status: "RETURNED_TO_AI", resolvedAt: new Date() } });
        return;
      }
      await tx.conversation.update({ where: { id: h.conversationId }, data: { aiEnabled: true } });
      await tx.humanHandoff.update({ where: { id: h.id }, data: { status: "RETURNED_TO_AI", resolvedAt: new Date() } });
      await tx.message.create({
        data: {
          organizationId,
          conversationId: h.conversationId,
          direction: "OUTBOUND",
          type: "SYSTEM",
          visibility: "INTERNAL",
          body: `🤖 El bot retomó la conversación (${minutes} min sin actividad humana — regla de la bandeja)`,
          authorType: "SYSTEM",
          status: "DELIVERED",
        },
      });
    });
    await publishRealtime(organizationId, { type: "conversation.updated", conversationId: h.conversationId });
  }
}
