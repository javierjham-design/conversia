import { describe, expect, it } from "vitest";
import { computeNativeSlots, type WorkBlock } from "./availability";

// Bloques para TODOS los días (evita depender del día de semana del test).
const allDays = (start: string, end: string): WorkBlock[] =>
  [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start, end }));

const DATE = "2026-09-01";
const PAST = new Date("2020-01-01T00:00:00Z").getTime(); // "ahora" en el pasado → todo futuro

describe("motor de disponibilidad (agenda nativa)", () => {
  it("genera slots según horario, duración y paso", () => {
    const slots = computeNativeSlots({
      fromDate: DATE, toDate: DATE,
      workBlocks: allDays("09:00", "12:00"),
      durationMin: 30, slotStepMin: 30, bufferMin: 0, offset: "-04:00", nowMs: PAST,
    });
    expect(slots.map((s) => s.start.slice(11, 16))).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]);
  });

  it("respeta el bloque mínimo de 5 minutos (paso menor se eleva a 5)", () => {
    const slots = computeNativeSlots({
      fromDate: DATE, toDate: DATE,
      workBlocks: allDays("09:00", "09:20"),
      durationMin: 5, slotStepMin: 3, bufferMin: 0, offset: "-04:00", nowMs: PAST,
    });
    // paso forzado a 5: 09:00, 09:05, 09:10, 09:15 (09:15+5=09:20 cabe)
    expect(slots.map((s) => s.start.slice(11, 16))).toEqual(["09:00", "09:05", "09:10", "09:15"]);
  });

  it("elimina el slot en conflicto con una cita ocupada", () => {
    const slots = computeNativeSlots({
      fromDate: DATE, toDate: DATE,
      workBlocks: allDays("09:00", "11:00"),
      busy: [{ start: `${DATE}T10:00:00-04:00`, end: `${DATE}T10:30:00-04:00` }],
      durationMin: 30, slotStepMin: 30, bufferMin: 0, offset: "-04:00", nowMs: PAST,
    });
    const times = slots.map((s) => s.start.slice(11, 16));
    expect(times).toContain("09:30"); // termina 10:00, no choca con buffer 0
    expect(times).not.toContain("10:00"); // choca
    expect(times).toContain("10:30"); // arranca al terminar la cita
  });

  it("el buffer ensancha el conflicto", () => {
    const slots = computeNativeSlots({
      fromDate: DATE, toDate: DATE,
      workBlocks: allDays("09:00", "11:00"),
      busy: [{ start: `${DATE}T10:00:00-04:00`, end: `${DATE}T10:30:00-04:00` }],
      durationMin: 30, slotStepMin: 30, bufferMin: 15, offset: "-04:00", nowMs: PAST,
    });
    const times = slots.map((s) => s.start.slice(11, 16));
    expect(times).not.toContain("09:30"); // termina 10:00 pero el buffer de 15 choca
    expect(times).not.toContain("10:30"); // arranca 10:30, sin 15 min de separación
  });

  it("no ofrece slots antes de la anticipación mínima", () => {
    const now = new Date(`${DATE}T09:40:00-04:00`).getTime();
    const slots = computeNativeSlots({
      fromDate: DATE, toDate: DATE,
      workBlocks: allDays("09:00", "11:30"),
      durationMin: 30, slotStepMin: 30, bufferMin: 0, offset: "-04:00",
      nowMs: now, minAdvanceMin: 60, // no antes de 10:40
    });
    // Slots 09:00/09:30/10:00/10:30 quedan fuera; solo 11:00 (≥ 10:40, termina 11:30).
    expect(slots.map((s) => s.start.slice(11, 16))).toEqual(["11:00"]);
  });
});
