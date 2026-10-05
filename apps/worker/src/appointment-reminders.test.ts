import { describe, expect, it } from "vitest";
import { planAppointmentReminder, nextBusinessOpen, wallClockToUtc, sendAtDue, type BusinessHoursConfig } from "./appointment-reminders";

const allDay = (from: string, to: string): BusinessHoursConfig => ({
  hours: {
    mon: [{ from, to }], tue: [{ from, to }], wed: [{ from, to }], thu: [{ from, to }],
    fri: [{ from, to }], sat: [{ from, to }], sun: [{ from, to }],
  },
  holidays: [],
});

const D = (s: string) => new Date(s);

describe("nextBusinessOpen", () => {
  it("madrugada (03:00) con horario 09–18 → corre a las 09:00", () => {
    const r = nextBusinessOpen(D("2026-08-11T03:00:00Z"), allDay("09:00", "18:00"), "UTC");
    expect(r.toISOString()).toBe("2026-08-11T09:00:00.000Z");
  });
  it("dentro de horario → no lo mueve", () => {
    const r = nextBusinessOpen(D("2026-08-11T10:30:00Z"), allDay("09:00", "18:00"), "UTC");
    expect(r.toISOString()).toBe("2026-08-11T10:30:00.000Z");
  });
});

describe("planAppointmentReminder", () => {
  const tz = "UTC";
  const bh = allDay("08:00", "21:00");

  it("caso normal: cita en 48 h, recordatorio 24 h antes, en horario", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T10:00:00Z"), startsAt: D("2026-08-12T15:00:00Z"),
      hoursBefore: 24, businessHours: bh, timezone: tz,
    });
    expect(p.action).toBe("schedule");
    expect(p.dueAt?.toISOString()).toBe("2026-08-11T15:00:00.000Z");
  });

  it("ventana corta: cita en 3 h con recordatorio de 24 h → se envía de inmediato", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T12:00:00Z"), startsAt: D("2026-08-10T15:00:00Z"),
      hoursBefore: 24, businessHours: bh, timezone: tz,
    });
    expect(p.action).toBe("schedule");
    expect(p.dueAt?.toISOString()).toBe("2026-08-10T12:00:00.000Z");
    expect(p.reason).toMatch(/inmediato/);
  });

  it("cita en el pasado → no se recuerda (skip)", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T12:00:00Z"), startsAt: D("2026-08-10T09:00:00Z"),
      hoursBefore: 24, businessHours: bh, timezone: tz,
    });
    expect(p.action).toBe("skip");
  });

  it("cita en el pasado con job existente → cancela el huérfano", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T12:00:00Z"), startsAt: D("2026-08-10T09:00:00Z"),
      hoursBefore: 24, businessHours: bh, timezone: tz,
      existing: { status: "PENDING", dueAt: D("2026-08-09T09:00:00Z") },
    });
    expect(p.action).toBe("cancel");
  });

  it("cita cancelada con job pendiente → cancela el recordatorio", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T12:00:00Z"), startsAt: D("2026-08-12T15:00:00Z"),
      hoursBefore: 24, cancelled: true, businessHours: bh, timezone: tz,
      existing: { status: "PENDING", dueAt: D("2026-08-11T15:00:00Z") },
    });
    expect(p.action).toBe("cancel");
  });

  it("recordatorio de madrugada → se corre al inicio del horario", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T12:00:00Z"), startsAt: D("2026-08-11T20:00:00Z"),
      hoursBefore: 17, businessHours: allDay("09:00", "18:00"), timezone: tz,
    });
    expect(p.action).toBe("schedule");
    expect(p.dueAt?.toISOString()).toBe("2026-08-11T09:00:00.000Z"); // 03:00 → 09:00
    expect(p.reason).toMatch(/horario/);
  });

  it("si ajustar al horario caería DESPUÉS de la cita → se envía a la hora calculada", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-11T02:00:00Z"), startsAt: D("2026-08-11T05:00:00Z"),
      hoursBefore: 2, businessHours: allDay("09:00", "18:00"), timezone: tz,
    });
    expect(p.action).toBe("schedule");
    expect(p.dueAt?.toISOString()).toBe("2026-08-11T03:00:00.000Z"); // no lo empuja tras la cita
    expect(p.reason).toMatch(/inminente/);
  });

  it("sin horario configurado → evita la madrugada con el tramo por defecto 08–21", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T12:00:00Z"), startsAt: D("2026-08-11T14:00:00Z"),
      hoursBefore: 12, businessHours: null, timezone: tz, // due 02:00 → 08:00
    });
    expect(p.dueAt?.toISOString()).toBe("2026-08-11T08:00:00.000Z");
  });

  // Idempotencia
  it("job ya DONE → no se reenvía (skip)", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T10:00:00Z"), startsAt: D("2026-08-12T15:00:00Z"),
      hoursBefore: 24, businessHours: bh, timezone: tz,
      existing: { status: "DONE", dueAt: D("2026-08-11T15:00:00Z") },
    });
    expect(p.action).toBe("skip");
  });

  it("duplicado exacto (PENDING misma hora) → skip", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T10:00:00Z"), startsAt: D("2026-08-12T15:00:00Z"),
      hoursBefore: 24, businessHours: bh, timezone: tz,
      existing: { status: "PENDING", dueAt: D("2026-08-11T15:00:00Z") },
    });
    expect(p.action).toBe("skip");
  });

  it("reprogramación (PENDING con otra hora) → reprograma", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T10:00:00Z"), startsAt: D("2026-08-13T15:00:00Z"),
      hoursBefore: 24, businessHours: bh, timezone: tz,
      existing: { status: "PENDING", dueAt: D("2026-08-11T15:00:00Z") },
    });
    expect(p.action).toBe("schedule");
    expect(p.dueAt?.toISOString()).toBe("2026-08-12T15:00:00.000Z");
  });

  // remindersEnabled:false (Gestor de IA de Cláriva) → no programar.
  it("recordatorios desactivados, sin job → skip (no se programa)", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T10:00:00Z"), startsAt: D("2026-08-12T15:00:00Z"),
      hoursBefore: 24, remindersDisabled: true, businessHours: bh, timezone: tz,
    });
    expect(p.action).toBe("skip");
    expect(p.reason).toMatch(/desactivados/);
  });

  it("recordatorios desactivados con job PENDIENTE → cancela el huérfano", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T10:00:00Z"), startsAt: D("2026-08-12T15:00:00Z"),
      hoursBefore: 24, remindersDisabled: true, businessHours: bh, timezone: tz,
      existing: { status: "PENDING", dueAt: D("2026-08-11T15:00:00Z") },
    });
    expect(p.action).toBe("cancel");
  });

  it("remindersDisabled:false (o ausente) → comportamiento normal", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T10:00:00Z"), startsAt: D("2026-08-12T15:00:00Z"),
      hoursBefore: 24, remindersDisabled: false, businessHours: bh, timezone: tz,
    });
    expect(p.action).toBe("schedule");
    expect(p.dueAt?.toISOString()).toBe("2026-08-11T15:00:00.000Z");
  });

  // Hora fija (sendAt): 12:00 del día anterior, manda sobre hoursBefore.
  it("sendAt {1d, 12:00} UTC → día anterior a las 12:00, ignora hoursBefore", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-10T10:00:00Z"), startsAt: D("2026-08-12T09:00:00Z"),
      hoursBefore: 24, sendAt: { daysBefore: 1, time: "12:00" },
      businessHours: bh, timezone: tz,
    });
    expect(p.action).toBe("schedule");
    expect(p.dueAt?.toISOString()).toBe("2026-08-11T12:00:00.000Z"); // NO 2026-08-11T09:00 (hoursBefore)
    expect(p.reason).toMatch(/hora fija/);
  });

  it("sendAt {1d, 12:00} en Santiago (verano UTC-3) → 15:00 UTC del día anterior", () => {
    const p = planAppointmentReminder({
      now: D("2026-10-10T10:00:00Z"), startsAt: D("2026-10-15T18:00:00Z"),
      hoursBefore: 24, sendAt: { daysBefore: 1, time: "12:00" },
      businessHours: bh, timezone: "America/Santiago",
    });
    expect(p.action).toBe("schedule");
    expect(p.dueAt?.toISOString()).toBe("2026-10-14T15:00:00.000Z");
  });

  it("sendAt en el pasado (la hora fija ya pasó) → se envía de inmediato", () => {
    const p = planAppointmentReminder({
      now: D("2026-08-11T14:00:00Z"), startsAt: D("2026-08-12T09:00:00Z"),
      hoursBefore: 24, sendAt: { daysBefore: 1, time: "12:00" }, // 2026-08-11T12:00 < now
      businessHours: bh, timezone: tz,
    });
    expect(p.action).toBe("schedule");
    expect(p.dueAt?.toISOString()).toBe("2026-08-11T14:00:00.000Z");
    expect(p.reason).toMatch(/inmediato/);
  });
});

describe("wallClockToUtc / sendAtDue (DST-aware)", () => {
  it("12:00 en Santiago verano (UTC-3) = 15:00 UTC", () => {
    expect(wallClockToUtc("2026-10-14", "12:00", "America/Santiago").toISOString()).toBe("2026-10-14T15:00:00.000Z");
  });
  it("12:00 en Santiago invierno (UTC-4) = 16:00 UTC", () => {
    expect(wallClockToUtc("2026-07-14", "12:00", "America/Santiago").toISOString()).toBe("2026-07-14T16:00:00.000Z");
  });
  it("sendAtDue resta días sobre la FECHA local, no 24h exactas", () => {
    // Cita 2026-10-15 a las 00:30 UTC = 2026-10-14 21:30 Santiago → fecha local 14 → 1 día antes = 13
    const due = sendAtDue(D("2026-10-15T00:30:00Z"), 1, "12:00", "America/Santiago");
    expect(due.toISOString()).toBe("2026-10-13T15:00:00.000Z");
  });
});
