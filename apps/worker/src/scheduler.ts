import { getEnv } from "@conversia/config";
import { getAdminPrisma, Prisma } from "@conversia/database";
import { resumeRun, startWorkflowById } from "./workflow-runtime";

/** Tiempo sin avance tras el cual un job PROCESSING se considera colgado (§8.6). */
const STUCK_AFTER_MS = 5 * 60_000;
/** Recuperaciones máximas por job antes de darlo por perdido (FAILED). */
const MAX_RECOVERIES = 3;
/**
 * Techo de antigüedad del `dueAt`: un job que quedó en PROCESSING hace días
 * (redeploys viejos) NO se resucita — disparar hoy el recordatorio de una cita
 * de la semana pasada le escribe de verdad a un cliente real. Va a FAILED.
 */
const TOO_LATE_MS = 24 * 60 * 60_000;

/** Payload JSON como objeto plano; null si no lo es (no lo pisamos). */
function plainPayload(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export type JobRecoveryPlan =
  | { action: "wait" }
  | { action: "requeue"; recoveries: number }
  | { action: "fail"; recoveries: number; reason: "max_recoveries" | "too_late" };

/**
 * Decide qué hacer con un job que quedó en PROCESSING (proceso muerto en un
 * redeploy). No hay columna `updatedAt` en scheduled_jobs y NO se crea migración:
 * el claim sella `payload.__processingAt` y el contador vive en
 * `payload.__recoveries` (atado a `__recoveryFor` = el `dueAt` del ciclo, para que
 * un recordatorio re-armado con otro `dueAt` empiece de cero). Para los jobs
 * claimeados por la versión anterior (sin sello) se usa `dueAt` como referencia.
 */
export function planJobRecovery(job: { payload: unknown; dueAt: Date }, now: Date = new Date()): JobRecoveryPlan {
  const p = plainPayload(job.payload) ?? {};
  const stamped = typeof p.__processingAt === "string" ? Date.parse(p.__processingAt) : NaN;
  const since = Number.isFinite(stamped) ? stamped : job.dueAt.getTime();
  if (now.getTime() - since < STUCK_AFTER_MS) return { action: "wait" };
  const sameCycle = p.__recoveryFor === job.dueAt.toISOString();
  const prior = sameCycle ? Number(p.__recoveries ?? 0) : 0;
  const done = Number.isFinite(prior) && prior > 0 ? Math.floor(prior) : 0;
  if (done >= MAX_RECOVERIES) return { action: "fail", recoveries: done, reason: "max_recoveries" };
  if (now.getTime() - job.dueAt.getTime() > TOO_LATE_MS) return { action: "fail", recoveries: done, reason: "too_late" };
  return { action: "requeue", recoveries: done + 1 };
}

/**
 * Sondea scheduled_jobs (timers persistentes en Postgres) y ejecuta los
 * vencidos. Claim optimista: updateMany PENDING→PROCESSING evita que dos
 * workers tomen el mismo job.
 *
 * El `stop` que devuelve ESPERA el tick en curso: un recordatorio a medio
 * disparar no se corta por un SIGTERM.
 */
export function startScheduler(): () => Promise<void> {
  const prisma = getAdminPrisma();
  const intervalMs = getEnv().SCHEDULER_POLL_MS;
  /** Ids que ESTE proceso está corriendo ahora: la recuperación no los toca. */
  const inFlight = new Set<string>();

  /**
   * Devuelve a PENDING los jobs colgados en PROCESSING (máx. 3 veces); pasadas
   * las 3, FAILED con log ruidoso. El `where` exige PROCESSING, así que entre
   * réplicas solo una gana el cambio de estado (sin trabajo duplicado).
   */
  const recoverStuck = async () => {
    const stuck = await prisma.scheduledJob.findMany({
      where: { status: "PROCESSING" },
      take: 50,
      orderBy: { dueAt: "asc" },
    });
    for (const job of stuck) {
      if (inFlight.has(job.id)) continue;
      const plan = planJobRecovery(job);
      if (plan.action === "wait") continue;
      const payload = {
        ...(plainPayload(job.payload) ?? {}),
        __processingAt: null,
        __recoveries: plan.recoveries,
        __recoveryFor: job.dueAt.toISOString(),
      } as Prisma.InputJsonObject;
      if (plan.action === "fail") {
        const failed = await prisma.scheduledJob.updateMany({
          where: { id: job.id, status: "PROCESSING" },
          data: { status: "FAILED", processedAt: new Date(), payload },
        });
        if (failed.count === 0) continue;
        const why =
          plan.reason === "max_recoveries"
            ? `tras ${MAX_RECOVERIES} recuperaciones`
            : "con dueAt de hace más de 24 h (no se resucita para no escribirle tarde a un cliente)";
        console.error(
          `✖ Timer ${job.id} (${job.kind}, org ${job.organizationId}, dueAt ${job.dueAt.toISOString()}) colgado en PROCESSING ${why} → FAILED, no se reintenta más`,
        );
        continue;
      }
      const requeued = await prisma.scheduledJob.updateMany({
        where: { id: job.id, status: "PROCESSING" },
        data: { status: "PENDING", payload },
      });
      if (requeued.count === 0) continue;
      console.warn(
        `⟳ Timer ${job.id} (${job.kind}, org ${job.organizationId}) colgado en PROCESSING >5 min → PENDING (recuperación ${plan.recoveries}/${MAX_RECOVERIES})`,
      );
    }
  };

  const tick = async () => {
    await recoverStuck();
    const due = await prisma.scheduledJob.findMany({
      where: { status: "PENDING", dueAt: { lte: new Date() } },
      take: 20,
      orderBy: { dueAt: "asc" },
    });
    for (const job of due) {
      // El claim sella la hora en el payload: es el "updatedAt" que la tabla no tiene.
      const base = plainPayload(job.payload);
      const claimed = await prisma.scheduledJob.updateMany({
        where: { id: job.id, status: "PENDING" },
        data: base
          ? { status: "PROCESSING", payload: { ...base, __processingAt: new Date().toISOString() } as Prisma.InputJsonObject }
          : { status: "PROCESSING" },
      });
      if (claimed.count === 0) continue;

      inFlight.add(job.id);
      try {
        if (job.kind === "workflow_timer" && job.runId) {
          const payload = job.payload as Record<string, unknown>;
          await resumeRun(job.organizationId, job.runId, String(payload.nodeId));
        } else if (job.kind === "appointment_reminder") {
          // Recordatorio de cita: ejecuta el workflow appointment_upcoming.
          const p = job.payload as Record<string, unknown>;
          // Toggle/horario de la 2ª reconfirmación (§1.4): el run los recibe como
          // variables (__r2Enabled para la condición "flag", __r2DelayHours para el
          // timeout del wait_reply entre R1 y R2). Solo se incluyen si el payload los trae.
          const reminderVars: Record<string, string> = {};
          if (p.r2Enabled != null) reminderVars.__r2Enabled = String(p.r2Enabled);
          if (p.r2DelayHours != null) reminderVars.__r2DelayHours = String(p.r2DelayHours);
          if (p.r1TemplateName != null) reminderVars.__r1TemplateName = String(p.r1TemplateName);
          if (p.r2TemplateName != null) reminderVars.__r2TemplateName = String(p.r2TemplateName);
          await startWorkflowById(job.organizationId, String(p.workflowId), {
            conversationId: p.conversationId ? String(p.conversationId) : undefined,
            contactId: p.contactId ? String(p.contactId) : undefined,
            // Ata el recordatorio a la cita EXACTA que lo programó (no a la más próxima).
            appointmentExternalId: p.appointmentExternalId ? String(p.appointmentExternalId) : undefined,
            variables: Object.keys(reminderVars).length ? reminderVars : undefined,
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
      } finally {
        inFlight.delete(job.id);
      }
    }
  };

  let stopped = false;
  let running: Promise<void> | null = null;
  const runTick = () => {
    // Ni ticks solapados (un tick lento no apila otro) ni ticks nuevos durante el apagado.
    if (stopped || running) return;
    running = tick()
      .catch((e) => console.error("scheduler:", e))
      .finally(() => {
        running = null;
      });
  };
  const handle = setInterval(runTick, intervalMs);
  console.log(`✔ Scheduler de timers activo (cada ${intervalMs}ms)`);
  return async () => {
    stopped = true;
    clearInterval(handle);
    if (running) await running; // espera el tick en curso: no se corta un timer a medias
  };
}
