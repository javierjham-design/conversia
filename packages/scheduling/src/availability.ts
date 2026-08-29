/**
 * Motor de disponibilidad de la AGENDA NATIVA de TuBot. Puro y determinista (testeable):
 * dado el horario de trabajo de una persona (por día de semana, con múltiples bloques),
 * las citas ya ocupadas, la duración del servicio, la granularidad (bloque mínimo, ej 5
 * min), el buffer entre citas y la anticipación mínima, devuelve los SLOTS LIBRES.
 *
 * Todo configurable por cuenta/persona. La zona horaria se maneja con un offset fijo
 * (ej "-04:00") que arma los ISO 8601 locales; el calendario/DST fino queda para después.
 */

export interface WorkBlock {
  day: number; // 0=domingo … 6=sábado
  start: string; // "HH:MM" hora local
  end: string; // "HH:MM" hora local (exclusivo)
}
export interface BusyInterval {
  start: string; // ISO 8601
  end: string; // ISO 8601
}
export interface NativeSlot {
  start: string; // ISO 8601 con offset local
  end: string;
}
export interface NativeSlotInput {
  fromDate: string; // "YYYY-MM-DD" (inclusive)
  toDate: string; // "YYYY-MM-DD" (inclusive)
  workBlocks: WorkBlock[];
  busy?: BusyInterval[];
  durationMin: number; // duración del servicio
  slotStepMin?: number; // granularidad; mínimo 5
  bufferMin?: number; // separación entre citas
  offset?: string; // ej "-04:00" (default -04:00, zona de Chile)
  minAdvanceMin?: number; // no ofrecer slots antes de ahora + esto
  nowMs?: number; // inyectable para tests (default Date.now())
  maxSlots?: number; // tope defensivo (default 300)
}

const hm = (s: string): number => {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
const pad = (n: number) => String(n).padStart(2, "0");

/** Fecha "YYYY-MM-DD" + minutos locales + offset → ISO 8601 local (sin drift de zona). */
function localISO(date: string, minutes: number, offset: string): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${date}T${pad(h)}:${pad(m)}:00${offset}`;
}
/** Día de semana (0-6) de una fecha calendario, independiente del offset. */
function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}
function eachDate(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  const d = new Date(`${fromDate}T00:00:00Z`);
  const end = new Date(`${toDate}T00:00:00Z`);
  for (let i = 0; d <= end && i < 400; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export function computeNativeSlots(input: NativeSlotInput): NativeSlot[] {
  const step = Math.max(5, input.slotStepMin ?? 30); // mínimo 5 min
  const buffer = Math.max(0, input.bufferMin ?? 0);
  const dur = Math.max(1, input.durationMin);
  const offset = input.offset ?? "-04:00";
  const now = input.nowMs ?? Date.now();
  const minStartMs = now + (input.minAdvanceMin ?? 0) * 60000;
  const maxSlots = input.maxSlots ?? 300;
  const bufMs = buffer * 60000;

  const busy = (input.busy ?? []).map((b) => ({ s: new Date(b.start).getTime(), e: new Date(b.end).getTime() }));
  const slots: NativeSlot[] = [];

  for (const date of eachDate(input.fromDate, input.toDate)) {
    if (slots.length >= maxSlots) break;
    const wd = weekdayOf(date);
    const blocks = input.workBlocks.filter((b) => b.day === wd);
    for (const block of blocks) {
      const bStart = hm(block.start);
      const bEnd = hm(block.end);
      for (let t = bStart; t + dur <= bEnd && slots.length < maxSlots; t += step) {
        const startISO = localISO(date, t, offset);
        const startMs = new Date(startISO).getTime();
        const endMs = startMs + dur * 60000;
        if (startMs < minStartMs) continue; // respeta anticipación mínima
        // Conflicto si NO hay separación de buffer con alguna cita ocupada.
        const clash = busy.some((b) => startMs < b.e + bufMs && endMs + bufMs > b.s);
        if (clash) continue;
        slots.push({ start: startISO, end: new Date(endMs).toISOString() });
      }
    }
  }
  // Orden cronológico (varios bloques/días pueden intercalarse).
  slots.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return slots;
}
