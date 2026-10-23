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
