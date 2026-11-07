import { describe, expect, it } from "vitest";
import { withAppointmentDuration } from "./index";
import type { AvailabilityQuery, SchedSlot, SchedulingProvider } from "@conversia/types";

// withAppointmentDuration debe hacer que una cita de duración D encuentre cupo
// aunque la agenda del proveedor exponga la grilla en pasos MÁS CORTOS que D:
// combina slots consecutivos (sin hueco) del mismo profesional hasta cubrir D.
// Regresión del caso real: cita de 60 min con agenda de 30 → "no hay horas"
// pese a haber pares de huecos seguidos que sí forman una ventana de 60.

function providerWith(slots: SchedSlot[]): SchedulingProvider {
  const base = {
    async getAvailableSlots(_q: AvailabilityQuery): Promise<SchedSlot[]> {
      return slots;
    },
  };
  return base as unknown as SchedulingProvider;
}

const q: AvailabilityQuery = { from: "2026-10-23", to: "2026-10-24" };

// Grilla nativa de 30 min de un profesional (end = start + 30).
function slot(start: string, min = 30): SchedSlot {
  const s = new Date(start).getTime();
  return { start, end: new Date(s + min * 60000).toISOString(), professionalId: "aedo", clinicId: "c1" };
}

describe("withAppointmentDuration — combinar y subdividir", () => {
  it("combina dos slots de 30 consecutivos en una ventana de 60", async () => {
    const base = providerWith([slot("2026-10-23T12:15:00.000Z"), slot("2026-10-23T12:45:00.000Z")]);
    const out = await withAppointmentDuration(base, 60).getAvailableSlots(q);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe("2026-10-23T12:15:00.000Z");
    expect(out[0].end).toBe("2026-10-23T13:15:00.000Z");
  });

  it("NO ofrece un slot de 30 aislado cuando la cita es de 60", async () => {
    const base = providerWith([slot("2026-10-23T12:15:00.000Z"), slot("2026-10-23T15:15:00.000Z")]);
    const out = await withAppointmentDuration(base, 60).getAvailableSlots(q);
    expect(out).toHaveLength(0);
  });

  it("tres slots seguidos dan DOS ventanas de 60 (solapadas por inicio)", async () => {
    const base = providerWith([
      slot("2026-10-23T12:15:00.000Z"),
      slot("2026-10-23T12:45:00.000Z"),
      slot("2026-10-23T13:15:00.000Z"),
    ]);
    const out = await withAppointmentDuration(base, 60).getAvailableSlots(q);
    expect(out.map((s) => s.start)).toEqual([
      "2026-10-23T12:15:00.000Z", // 12:15–13:15
      "2026-10-23T12:45:00.000Z", // 12:45–13:45
    ]);
  });

  it("combina tres slots de 30 para una cita de 90", async () => {
    const base = providerWith([
      slot("2026-10-23T09:00:00.000Z"),
      slot("2026-10-23T09:30:00.000Z"),
      slot("2026-10-23T10:00:00.000Z"),
    ]);
    const out = await withAppointmentDuration(base, 90).getAvailableSlots(q);
    expect(out).toHaveLength(1);
    expect(out[0].start).toBe("2026-10-23T09:00:00.000Z");
    expect(out[0].end).toBe("2026-10-23T10:30:00.000Z");
  });

  it("subdivide un bloque largo de 60 en cupos de 15", async () => {
    const base = providerWith([slot("2026-10-23T09:00:00.000Z", 60)]);
    const out = await withAppointmentDuration(base, 15).getAvailableSlots(q);
    expect(out.map((s) => s.start)).toEqual([
      "2026-10-23T09:00:00.000Z",
      "2026-10-23T09:15:00.000Z",
      "2026-10-23T09:30:00.000Z",
      "2026-10-23T09:45:00.000Z",
    ]);
    expect(out[0].end).toBe("2026-10-23T09:15:00.000Z");
  });

  it("no combina entre profesionales distintos (cada uno agrupa aparte)", async () => {
    const a = slot("2026-10-23T12:15:00.000Z");
    const b = { ...slot("2026-10-23T12:45:00.000Z"), professionalId: "otro" };
    const out = await withAppointmentDuration(providerWith([a, b]), 60).getAvailableSlots(q);
    expect(out).toHaveLength(0); // ninguno tiene un consecutivo propio
  });
});

// Regresión del caso REAL (Dr. Aedo, lunes 9-nov-2026): la agenda es de bloques de 15 min con citas
// de 20 min. Un proveedor tipo Cláriva arma la grilla en pasos = la duración que se le pide (desde el
// inicio de la ventana) y descarta el cupo si choca con una cita. Si el envoltorio le pide la grilla
// SIN duración, Cláriva usa su paso por defecto de 30 → cada celda de 30 choca con una cita de 20 y
// devuelve CERO, aunque haya >1 h libre. El fix: el envoltorio pide la grilla a 15 → aparecen los
// huecos reales. (Horas en UTC para aislar la lógica de grilla de la zona horaria.)
function clarivaLike(windows: [number, number][], busyMin: [number, number][], day = "2026-11-09"): SchedulingProvider {
  const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const now = new Date("2026-11-07T00:00:00.000Z").getTime(); // antes del día consultado
  const base = {
    async getAvailableSlots(query: AvailabilityQuery): Promise<SchedSlot[]> {
      const dur = query.durationMin ?? 30; // Cláriva: paso = duración pedida, default 30
      const out: SchedSlot[] = [];
      for (const [wi, wf] of windows) {
        for (let m = wi; m + dur <= wf; m += dur) {
          const startMs = Date.parse(`${day}T${fromMin(m)}:00.000Z`);
          if (startMs < now) continue;
          if (busyMin.some(([bs, be]) => m < be && bs < m + dur)) continue;
          out.push({ start: new Date(startMs).toISOString(), end: new Date(startMs + dur * 60000).toISOString(), professionalId: "aedo", clinicId: "c1" });
        }
      }
      return out;
    },
  };
  return base as unknown as SchedulingProvider;
}

describe("withAppointmentDuration — granularidad fina evita el 'no hay horas' (caso Aedo lunes 9)", () => {
  // Ventanas reales del Dr. Aedo (09:45–14:00 y 15:00–19:00) + sus 11 citas activas de 20 min ese día.
  const windows: [number, number][] = [[585, 840], [900, 1140]];
  const busy: [number, number][] = [[570, 590], [630, 660], [690, 705], [720, 735], [750, 765], [780, 810], [915, 945], [945, 1020], [1020, 1070], [1080, 1110], [1110, 1140]];
  const day9: AvailabilityQuery = { from: "2026-11-09", to: "2026-11-09" };
  const horasDe = (out: SchedSlot[]) => out.map((s) => s.start.slice(11, 16));

  it("a paso 30 (lo que daba 'sin duración') Cláriva devuelve CERO cupos — el bug", async () => {
    const out = await clarivaLike(windows, busy).getAvailableSlots({ ...day9, durationMin: 30 });
    expect(out).toHaveLength(0);
  });

  it("el envoltorio de 15 min pide la grilla a 15 y recupera los 10 huecos reales — el fix", async () => {
    const out = await withAppointmentDuration(clarivaLike(windows, busy), 15).getAvailableSlots(day9);
    expect(horasDe(out)).toEqual(["10:00", "10:15", "11:00", "11:15", "11:45", "12:15", "12:45", "13:30", "13:45", "15:00"]);
  });

  it("una cita de 30 min combina pares de bloques de 15 y nunca pisa una cita", async () => {
    const out = await withAppointmentDuration(clarivaLike(windows, busy), 30).getAvailableSlots(day9);
    expect(horasDe(out)).toEqual(["10:00", "11:00", "13:30"]); // únicos tramos de 30 min seguidos libres
    for (const s of out) {
      const mi = (iso: string) => { const d = new Date(iso); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
      expect(mi(s.end) - mi(s.start)).toBe(30);
      expect(busy.some(([bs, be]) => mi(s.start) < be && bs < mi(s.end))).toBe(false);
    }
  });
});
