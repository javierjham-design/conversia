/**
 * Ciclo de vida de la PRUEBA (7 + 7) — lógica PURA + tick.
 *
 * Un tenant nuevo parte en TRIAL. Ciclo:
 *   día 0 → PRUEBA (7 días, opera; avisos día 3/5/6) → (día 7 sin pago) →
 *   DESHABILITADA (solo lectura, IA + flujos detenidos; NADA se borra; 7 días más)
 *   → (día 14 sin pago) → PURGA (los datos se eliminan) .
 *   En cualquier momento de esa ventana: paga → ACTIVA (reactiva tal cual estaba).
 *
 * El estado vive en `org.settings.trial` (sin migración), igual que dunning usa
 * `settings.billing`. Deshabilitar = `status=SUSPENDED` (reusa el guard de solo
 * lectura + halt de IA/flujos), distinguido de la suspensión por impago por
 * `settings.trial.state`. Al pagar, el flujo de billing pone `status=ACTIVE`
 * (reactiva) — este ciclo deja de actuar porque ya no es una prueba disabled.
 *
 * SEGURIDAD: la PURGA (destructiva) NO va en este módulo — se decide aquí (para
 * testear la regla) pero la ejecuta un job aparte, con guardas fuertes (jamás a
 * un cliente que pagó). Este tick solo hace init/avisos/deshabilitar (reversible).
 */
export const TRIAL_DAYS = 7;
export const TRIAL_PURGE_GRACE_DAYS = 7; // total 14 días antes de purgar
const DAY_MS = 86_400_000;

/** Días en los que se envía un recordatorio de prueba (idempotente por día). */
export const TRIAL_WARN_DAYS = [3, 5, 6] as const;

export type TrialAction = "none" | "init" | "warn" | "disable" | "purge";

export interface TrialState {
  startedAt?: string;
  endsAt?: string;
  purgeAt?: string;
  state?: "active" | "disabled" | "converted";
  warnedDays?: number[];
}

export interface TrialInput {
  now: Date;
  createdAt: Date;
  orgStatus: string; // TRIAL | ACTIVE | SUSPENDED | CANCELLED
  trial: TrialState | null;
  hasPaid: boolean; // ¿alguna vez pagó? (nunca se purga ni deshabilita a quien pagó)
  trialDays?: number;
  purgeGraceDays?: number;
}

export interface TrialDecision {
  action: TrialAction;
  endsAt: Date;
  purgeAt: Date;
  /** Día de prueba a avisar (cuando action = "warn"). */
  warnDay?: number;
}

/**
 * Decide la transición de la prueba. Pura y determinista.
 * - Quien PAGÓ nunca entra a este ciclo (hasPaid → none).
 * - `init`: es una prueba y aún no tiene fechas → inicializarlas + aviso de reglas.
 * - `warn`: día 3/5/6 y aún no se avisó ese día.
 * - `disable`: pasó el día 7 y sigue en prueba → solo lectura.
 * - `purge`: está deshabilitada y pasó el día 14 → eliminar datos (lo ejecuta el
 *   job destructivo, no este tick).
 * - `none`: al día / ya convertida / ya purgada / pagó.
 */
export function planTrialAction(input: TrialInput): TrialDecision {
  const trialDays = input.trialDays ?? TRIAL_DAYS;
  const graceDays = input.purgeGraceDays ?? TRIAL_PURGE_GRACE_DAYS;
  const started = input.trial?.startedAt ? new Date(input.trial.startedAt) : input.createdAt;
  const endsAt = input.trial?.endsAt ? new Date(input.trial.endsAt) : new Date(started.getTime() + trialDays * DAY_MS);
  const purgeAt = input.trial?.purgeAt ? new Date(input.trial.purgeAt) : new Date(endsAt.getTime() + graceDays * DAY_MS);
  const base = { endsAt, purgeAt };

  // Pagó, cancelada, o ya convertida → fuera del ciclo de prueba.
  if (input.hasPaid || input.orgStatus === "CANCELLED" || input.trial?.state === "converted") {
    return { action: "none", ...base };
  }

  // Deshabilitada (día 7 cumplido): ¿toca purgar?
  if (input.trial?.state === "disabled") {
    if (input.now.getTime() >= purgeAt.getTime()) return { action: "purge", ...base };
    return { action: "none", ...base };
  }

  // Prueba en curso.
  if (!input.trial || !input.trial.state) return { action: "init", ...base };

  if (input.now.getTime() >= endsAt.getTime()) return { action: "disable", ...base };

  // Recordatorios día 3/5/6 (idempotente por día).
  const dayNumber = Math.floor((input.now.getTime() - started.getTime()) / DAY_MS);
  const warned = new Set(input.trial.warnedDays ?? []);
  const due = TRIAL_WARN_DAYS.find((d) => dayNumber >= d && !warned.has(d));
  if (due !== undefined) return { action: "warn", ...base, warnDay: due };

  return { action: "none", ...base };
}

// --------------------------- Tick de aplicación ---------------------------
// Solo init / avisos / deshabilitar (reversible). La PURGA la hace otro job.

const ONE_HOUR = 60 * 60 * 1000;

async function hasEverPaid(prisma: any, organizationId: string): Promise<boolean> {
  const paid = await prisma.invoice.findFirst({ where: { organizationId, status: "PAID" }, select: { id: true } });
  if (paid) return true;
  const activeSub = await prisma.subscription.findFirst({ where: { organizationId, status: { in: ["ACTIVE", "PAST_DUE"] } }, select: { id: true } });
  return Boolean(activeSub);
}

/** Escanea pruebas y aplica init/avisos/deshabilitación. Cross-tenant (admin). */
export function startTrialLifecycle(): () => void {
  const run = async () => {
    try {
      const { getAdminPrisma, withTenant } = await import("@conversia/database");
      const prisma = getAdminPrisma();
      const now = new Date();
      // Candidatas: pruebas en curso (TRIAL) o deshabilitadas por prueba (SUSPENDED
      // con settings.trial.state=disabled). No tocamos ACTIVE/CANCELLED.
      const orgs = await prisma.organization.findMany({
        where: { status: { in: ["TRIAL", "SUSPENDED"] }, deletedAt: null },
        select: { id: true, status: true, settings: true, createdAt: true },
      });
      for (const org of orgs) {
        const settings = { ...((org.settings as Record<string, unknown>) ?? {}) };
        const trial = (settings.trial as TrialState | undefined) ?? null;
        // Un SUSPENDED que no es prueba (impago) no nos incumbe.
        if (org.status === "SUSPENDED" && trial?.state !== "disabled") continue;
        const hasPaid = await hasEverPaid(prisma, org.id);
        const decision = planTrialAction({ now, createdAt: org.createdAt, orgStatus: org.status, trial, hasPaid });

        if (decision.action === "none" || decision.action === "purge") continue; // purge lo hace otro job

        if (decision.action === "init") {
          const nextTrial: TrialState = {
            startedAt: org.createdAt.toISOString(),
            endsAt: decision.endsAt.toISOString(),
            purgeAt: decision.purgeAt.toISOString(),
            state: "active",
            warnedDays: [],
          };
          settings.trial = nextTrial;
          await withTenant(org.id, async (tx) => {
            await tx.organization.update({ where: { id: org.id }, data: { settings: settings as object } });
            await tx.integrationEvent.create({
              data: { organizationId: org.id, provider: "trial", type: "trial.started", status: "ok", message: `Tu prueba está activa hasta el ${decision.endsAt.toLocaleDateString("es-CL")}. Es un entorno para armar y probar tu bot con tus datos; para atender clientes reales hay que activarlo. Lo que montes queda guardado 14 días.` },
            });
          });
        } else if (decision.action === "warn") {
          const warnedDays = [...new Set([...(trial?.warnedDays ?? []), decision.warnDay!])];
          settings.trial = { ...(trial ?? {}), warnedDays } as object;
          const daysLeft = Math.max(0, Math.ceil((decision.endsAt.getTime() - now.getTime()) / DAY_MS));
          await withTenant(org.id, async (tx) => {
            await tx.organization.update({ where: { id: org.id }, data: { settings: settings as object } });
            await tx.integrationEvent.create({
              data: { organizationId: org.id, provider: "trial", type: "trial.reminder", status: "warning", message: `Te quedan ${daysLeft} día(s) de prueba. Si ya lo probaste, actívalo para que opere en serio y no se corte a mitad de una conversación con un cliente.` },
            });
          });
        } else if (decision.action === "disable") {
          settings.trial = { ...(trial ?? {}), state: "disabled", disabledAt: now.toISOString() } as object;
          await withTenant(org.id, async (tx) => {
            // Deshabilitar NO borra: solo lectura + IA/flujos detenidos. Al pagar, ACTIVE lo revierte.
            await tx.organization.update({ where: { id: org.id }, data: { status: "SUSPENDED", settings: settings as object } });
            await tx.integrationEvent.create({
              data: { organizationId: org.id, provider: "trial", type: "trial.disabled", status: "error", message: `Tu prueba terminó y quedó en pausa (solo lectura). NADA se borró: lo que montaste se guarda 7 días más. Actívalo y sigue tal cual; después de eso, los datos se eliminan.` },
            });
            await tx.auditLog.create({ data: { organizationId: org.id, actorType: "system", actorId: "trial", action: "trial.disable", entityType: "organization", entityId: org.id, after: { purgeAt: decision.purgeAt } } });
          });
        }
      }
    } catch (err) {
      console.error("✖ trial-lifecycle tick:", (err as Error).message);
    }
  };
  void run();
  const interval = setInterval(run, ONE_HOUR);
  interval.unref?.();
  return () => clearInterval(interval);
}
