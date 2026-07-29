import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";
import { resumeRun, startWorkflowById } from "./workflow-runtime";

/**
 * Sondea scheduled_jobs (timers persistentes en Postgres) y ejecuta los
 * vencidos. Claim optimista: updateMany PENDING→PROCESSING evita que dos
 * workers tomen el mismo job.
 */
export function startScheduler(): () => void {
  const prisma = getAdminPrisma();
  const intervalMs = getEnv().SCHEDULER_POLL_MS;

  const tick = async () => {
    const due = await prisma.scheduledJob.findMany({
      where: { status: "PENDING", dueAt: { lte: new Date() } },
      take: 20,
      orderBy: { dueAt: "asc" },
    });
    for (const job of due) {
      const claimed = await prisma.scheduledJob.updateMany({
        where: { id: job.id, status: "PENDING" },
        data: { status: "PROCESSING" },
      });
      if (claimed.count === 0) continue;

      try {
        if (job.kind === "workflow_timer" && job.runId) {
          const payload = job.payload as Record<string, unknown>;
          await resumeRun(job.organizationId, job.runId, String(payload.nodeId));
        } else if (job.kind === "appointment_reminder") {
          // Recordatorio de cita: ejecuta el workflow appointment_upcoming.
          const p = job.payload as Record<string, unknown>;
          await startWorkflowById(job.organizationId, String(p.workflowId), {
            conversationId: p.conversationId ? String(p.conversationId) : undefined,
            contactId: p.contactId ? String(p.contactId) : undefined,
          });
        }
        await prisma.scheduledJob.update({
          where: { id: job.id },
          data: { status: "DONE", processedAt: new Date() },
        });
      } catch (err) {
        console.error(`✖ Timer ${job.id} falló:`, (err as Error).message);
        await prisma.scheduledJob.update({
          where: { id: job.id },
          data: { status: "FAILED", processedAt: new Date() },
        });
      }
    }
  };

  const handle = setInterval(() => void tick().catch((e) => console.error("scheduler:", e)), intervalMs);
  console.log(`✔ Scheduler de timers activo (cada ${intervalMs}ms)`);
  return () => clearInterval(handle);
}
