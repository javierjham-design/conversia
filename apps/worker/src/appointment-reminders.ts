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

/** Offset (ms) entre UTC y `tz` en el instante `date` (positivo al este de UTC). */
function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +(p.hour === "24" ? 0 : p.hour), +p.minute, +p.second);
  return asIfUtc - date.getTime();
}

/** Instante UTC de una hora de pared (YYYY-MM-DD + HH:MM) en una zona horaria. */
export function wallClockToUtc(ymd: string, hhmm: string, tz: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0);
  // Corrige por el offset del tz en ese instante (DST incluido).
  return new Date(guess - tzOffsetMs(new Date(guess), tz));
}

/** Momento de envío a hora fija: `daysBefore` días antes de la FECHA de la cita
 *  (en su zona), a las `time` (HH:MM) de esa zona. Puro y DST-aware. */
export function sendAtDue(startsAt: Date, daysBefore: number, time: string, tz: string): Date {
  const startYmd = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(startsAt); // YYYY-MM-DD de la cita en el tz
  const [sy, sm, sd] = startYmd.split("-").map(Number);
  const target = new Date(Date.UTC(sy, sm - 1, sd) - Math.max(0, daysBefore) * 86_400_000);
  const ymd = `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, "0")}-${String(target.getUTCDate()).padStart(2, "0")}`;
  return wallClockToUtc(ymd, time, tz);
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
  /** Hora FIJA del recordatorio: `daysBefore` días antes a las `time` (HH:MM) en la
   *  zona del negocio. Si viene, MANDA sobre `hoursBefore`. */
  sendAt?: { daysBefore: number; time: string } | null;
  /** La cita quedó cancelada (o en el pasado ya se maneja aparte). */
  cancelled?: boolean;
  /** Confirmaciones apagadas desde el Gestor de IA de Cláriva (`remindersEnabled:false`
   *  en el payload): no se programa recordatorio y se limpia cualquier job pendiente. */
  remindersDisabled?: boolean;
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
  // 1-bis) Confirmaciones apagadas en Cláriva → no programar; limpiar job huérfano
  //        (p. ej. si se apagaron tras haber programado y llega un reschedule).
  if (input.remindersDisabled) {
    return { action: existing ? "cancel" : "skip", reason: "recordatorios desactivados (Gestor de IA)" };
  }
  // 2) Cita en el pasado → no recordar; cancelar job huérfano si lo hubiera.
  if (startsAt.getTime() <= now.getTime()) {
    return { action: existing ? "cancel" : "skip", reason: "cita en el pasado" };
  }

  // 3) Momento base del recordatorio: hora FIJA (sendAt) o N horas antes (hoursBefore).
  let due: Date;
  let reason: string;
  if (input.sendAt && typeof input.sendAt.time === "string" && /^\d{1,2}:\d{2}$/.test(input.sendAt.time)) {
    due = sendAtDue(startsAt, Number(input.sendAt.daysBefore ?? 1), input.sendAt.time, timezone);
    reason = `hora fija (${input.sendAt.daysBefore}d antes ${input.sendAt.time})`;
  } else {
    due = new Date(startsAt.getTime() - Math.max(0, hoursBefore) * 3_600_000);
    reason = "programado";
  }
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
