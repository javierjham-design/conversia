/**
 * Lógica PURA de los recordatorios de cita (trigger "appointment_upcoming").
 * Separada del acceso a datos para poder testear los bordes sin infraestructura.
 *
 * Decisiones de producto (documentadas en docs/PROGRESS.md):
 *  - Idempotencia: la identidad del recordatorio es el id EXTERNO de la cita
 *    (id del proveedor de agenda). El mismo evento reenviado por Cláriva no
 *    reprograma ni reenvía: un job DONE/PROCESSING nunca vuelve a PENDING.
 *  - Ciclo de vida: reprogramar re-apunta el recordatorio PENDIENTE a la fecha
 *    nueva; cancelar la cita cancela el recordatorio pendiente (sin huérfanos).
 *  - Bordes de tiempo:
 *      · cita en el pasado → no se recuerda (y si había job, se cancela);
 *      · ventana más corta que `hoursBefore` (p. ej. recordatorio 24 h y la cita
 *        es en 3 h) → se envía cuanto antes (dueAt = ahora), nunca después de la
 *        cita;
 *      · si el recordatorio caería fuera del horario de atención o de madrugada,
 *        se corre al inicio del siguiente tramo hábil (configurable con
 *        `avoidOffHours`, por defecto true). Sin horario configurado se usa un
 *        tramo por defecto 08:00–21:00 para no escribir de madrugada. Si el
 *        único hueco hábil cae DESPUÉS de la cita, se envía a la hora calculada
 *        aunque sea fuera de horario (un recordatorio inminente vale más que el
 *        silencio).
 */
import { evalBusinessHours } from "@conversia/workflows";

export interface BusinessHoursConfig {
  timezone?: string;
  hours?: Record<string, { from?: string; to?: string }[]>;
  holidays?: string[];
}

/** Tramo por defecto cuando el tenant no configuró horario: evita la madrugada. */
export const DEFAULT_QUIET_SAFE_HOURS: BusinessHoursConfig = {
  hours: {
    mon: [{ from: "08:00", to: "21:00" }], tue: [{ from: "08:00", to: "21:00" }],
    wed: [{ from: "08:00", to: "21:00" }], thu: [{ from: "08:00", to: "21:00" }],
    fri: [{ from: "08:00", to: "21:00" }], sat: [{ from: "08:00", to: "21:00" }],
    sun: [{ from: "08:00", to: "21:00" }],
  },
  holidays: [],
};

/**
 * Primer instante ≥ `from` que cae dentro del horario hábil. Avanza en pasos de
 * 5 min hasta 8 días; si no encuentra tramo (horario totalmente vacío) devuelve
 * `from` sin cambiar (no bloquear). Puro y determinista (usa la zona horaria).
 */
export function nextBusinessOpen(from: Date, bh: BusinessHoursConfig, tz: string): Date {
  const config = { timezone: tz, hours: bh.hours ?? {}, holidays: bh.holidays ?? [] };
  const STEP_MS = 5 * 60 * 1000;
  const MAX_STEPS = (8 * 24 * 60) / 5; // 8 días
  let t = from.getTime();
  for (let i = 0; i < MAX_STEPS; i++) {
    if (evalBusinessHours(config, new Date(t))) return new Date(t);
    t += STEP_MS;
  }
  return from;
}

export type ReminderAction = "schedule" | "cancel" | "skip";
export interface ReminderPlan {
  action: ReminderAction;
  dueAt?: Date;
  reason: string;
}

export interface PlanReminderInput {
  now: Date;
  startsAt: Date;
  hoursBefore: number;
  /** La cita quedó cancelada (o en el pasado ya se maneja aparte). */
  cancelled?: boolean;
  /** Job existente para esta (cita, workflow), si lo hay. */
  existing?: { status: string; dueAt: Date } | null;
  businessHours?: BusinessHoursConfig | null;
  timezone: string;
  avoidOffHours?: boolean;
}

/** Estados de job que NO se deben resucitar (idempotencia / anti-doble-envío). */
const TERMINAL = new Set(["DONE", "PROCESSING", "FAILED"]);

/** Decide qué hacer con el recordatorio de una cita. Función pura. */
export function planAppointmentReminder(input: PlanReminderInput): ReminderPlan {
  const { now, startsAt, hoursBefore, existing, timezone } = input;
  const avoidOffHours = input.avoidOffHours ?? true;

  // 1) Cita cancelada → cancelar el recordatorio pendiente (si existe).
  if (input.cancelled) {
    return { action: existing ? "cancel" : "skip", reason: "cita cancelada" };
  }
  // 2) Cita en el pasado → no recordar; cancelar job huérfano si lo hubiera.
  if (startsAt.getTime() <= now.getTime()) {
    return { action: existing ? "cancel" : "skip", reason: "cita en el pasado" };
  }

  // 3) Momento base del recordatorio.
  let due = new Date(startsAt.getTime() - Math.max(0, hoursBefore) * 3_600_000);
  let reason = "programado";
  if (due.getTime() < now.getTime()) {
    due = new Date(now.getTime()); // ventana corta: enviar cuanto antes
    reason = "ventana corta: se envía de inmediato";
  }

  // 4) Evitar madrugada / fuera de horario: correr al siguiente tramo hábil,
  //    salvo que eso empuje el recordatorio después de la cita.
  if (avoidOffHours) {
    const bh = input.businessHours?.hours ? input.businessHours : DEFAULT_QUIET_SAFE_HOURS;
    const shifted = nextBusinessOpen(due, bh, timezone);
    if (shifted.getTime() > due.getTime()) {
      if (shifted.getTime() <= startsAt.getTime()) {
        due = shifted;
        reason = "ajustado al horario de atención";
      } else {
        reason = "fuera de horario pero inminente: se envía a la hora calculada";
      }
    }
  }

  // 5) Idempotencia frente al job existente.
  if (existing) {
    if (TERMINAL.has(existing.status)) {
      return { action: "skip", reason: `ya ${existing.status.toLowerCase()} (no se reenvía)` };
    }
    if (existing.status === "PENDING" && Math.abs(existing.dueAt.getTime() - due.getTime()) < 60_000) {
      return { action: "skip", reason: "duplicado (misma hora)" };
    }
    // PENDING con otra hora → reprogramar; CANCELLED → volver a programar.
  }
  return { action: "schedule", dueAt: due, reason };
}
