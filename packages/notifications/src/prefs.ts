import type { NotifChannel, NotifEventDef } from "./types.js";

/** Preferencias de notificación de UN usuario (persistidas en org.settings). */
export interface UserNotifPrefs {
  /** Override por evento y canal: matrix[eventKey][channel] = true|false. */
  matrix?: Record<string, Partial<Record<NotifChannel, boolean>>>;
  /** Horario silencioso: silencia canales intrusivos salvo eventos críticos. */
  quietHours?: { enabled: boolean; start: string; end: string }; // "HH:MM"
  /** Escalera de WhatsApp (opt-in, apagada por defecto). */
  whatsapp?: { enabled: boolean; throttlePerHour: number };
}

/** Canales que interrumpen (los silencia el horario silencioso si no es crítico). */
const INTRUSIVE: NotifChannel[] = ["web_push", "native_push", "whatsapp"];

/** ¿Está habilitado un canal para este evento y usuario? Los bloqueados van sí o sí. */
export function isChannelEnabled(event: NotifEventDef, channel: NotifChannel, prefs: UserNotifPrefs): boolean {
  if (!event.channels.includes(channel)) return false;
  if (event.lockedChannels?.includes(channel)) return true;
  const override = prefs.matrix?.[event.key]?.[channel];
  if (override !== undefined) return override;
  return event.defaultChannels.includes(channel);
}

/** Canales efectivos para (evento, usuario), antes del horario silencioso. */
export function resolveEnabledChannels(event: NotifEventDef, prefs: UserNotifPrefs): NotifChannel[] {
  return event.channels.filter((c) => isChannelEnabled(event, c, prefs));
}

/** Minutos del día (0..1439) de una fecha en una zona horaria. */
export function minutesOfDay(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h % 24) * 60 + (m || 0);
}

/** ¿La hora actual (en la zona) cae dentro del horario silencioso del usuario? */
export function inQuietHours(prefs: UserNotifPrefs, now: Date, timeZone: string): boolean {
  const q = prefs.quietHours;
  if (!q?.enabled) return false;
  const cur = minutesOfDay(now, timeZone);
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  // Rango que cruza medianoche (p. ej. 22:00 → 08:00).
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}

/**
 * Aplica el horario silencioso: si está activo y el evento NO es crítico, quita
 * los canales intrusivos (push/whatsapp). in_app y email siempre pasan.
 */
export function applyQuietHours(
  channels: NotifChannel[],
  event: NotifEventDef,
  prefs: UserNotifPrefs,
  now: Date,
  timeZone: string,
): NotifChannel[] {
  if (event.urgency === "critical") return channels;
  if (!inQuietHours(prefs, now, timeZone)) return channels;
  return channels.filter((c) => !INTRUSIVE.includes(c));
}
