import { describe, expect, it } from "vitest";
import { FUTURE_TERMINAL_GRACE_MS, guardFutureTerminalStatus, mapClarivaEvent } from "./clariva-webhook";

describe("mapClarivaEvent", () => {
  it("appointment.created → PENDING + trigger appointment_created", () => {
    expect(mapClarivaEvent("appointment.created", {})).toEqual({
      status: "PENDING",
      publicEvent: "appointment.created",
      trigger: "appointment_created",
    });
  });

  it("appointment.confirmed → CONFIRMED + trigger appointment_confirmed", () => {
    expect(mapClarivaEvent("appointment.confirmed", {})).toEqual({
      status: "CONFIRMED",
      publicEvent: "appointment.updated",
      trigger: "appointment_confirmed",
    });
  });

  it("appointment.cancelled → CANCELLED + trigger appointment_cancelled", () => {
    expect(mapClarivaEvent("appointment.cancelled", {})).toEqual({
      status: "CANCELLED",
      publicEvent: "appointment.cancelled",
      trigger: "appointment_cancelled",
    });
  });

  it("appointment.rescheduled → RESCHEDULED + trigger appointment_rescheduled", () => {
    expect(mapClarivaEvent("appointment.rescheduled", {})).toEqual({
      status: "RESCHEDULED",
      publicEvent: "appointment.updated",
      trigger: "appointment_rescheduled",
    });
  });

  it("appointment.updated → solo actualiza campos, sin trigger", () => {
    expect(mapClarivaEvent("appointment.updated", {})).toEqual({
      status: null,
      publicEvent: "appointment.updated",
      trigger: null,
    });
  });

  it("attendance: attended=false → NO_SHOW + trigger no_show; attended=true → COMPLETED sin trigger", () => {
    expect(mapClarivaEvent("appointment.attendance", { attended: false })).toEqual({
      status: "NO_SHOW",
      publicEvent: "appointment.updated",
      trigger: "no_show",
    });
    expect(mapClarivaEvent("appointment.attendance", { attended: true })).toEqual({
      status: "COMPLETED",
      publicEvent: "appointment.updated",
      trigger: null,
    });
  });

  it("patient.updated y eventos desconocidos no tocan citas ni disparan", () => {
    expect(mapClarivaEvent("patient.updated", {})).toEqual({ status: null, publicEvent: null, trigger: null });
    expect(mapClarivaEvent("otro.evento", {})).toEqual({ status: null, publicEvent: null, trigger: null });
  });

  it("patient.treatment_pending → sin status/publicEvent, trigger treatment_pending", () => {
    expect(mapClarivaEvent("patient.treatment_pending", {})).toEqual({
      status: null,
      publicEvent: null,
      trigger: "treatment_pending",
    });
  });
});

describe("guardFutureTerminalStatus", () => {
  const now = new Date("2026-11-16T12:00:00Z");
  const future = (ms: number) => new Date(now.getTime() + ms);

  it("ignora COMPLETED sobre una cita claramente futura (no se puede haber asistido aún)", () => {
    // Caso Marcia: asistencia 16-nov sobre cita del 17-nov.
    expect(guardFutureTerminalStatus("COMPLETED", future(24 * 60 * 60 * 1000), now)).toEqual({
      status: null,
      anomaly: true,
    });
  });

  it("ignora NO_SHOW sobre una cita claramente futura", () => {
    expect(guardFutureTerminalStatus("NO_SHOW", future(5 * 24 * 60 * 60 * 1000), now)).toEqual({
      status: null,
      anomaly: true,
    });
  });

  it("SÍ aplica COMPLETED en una cita pasada (lo normal)", () => {
    expect(guardFutureTerminalStatus("COMPLETED", future(-60 * 60 * 1000), now)).toEqual({
      status: "COMPLETED",
      anomaly: false,
    });
  });

  it("SÍ aplica COMPLETED dentro del margen (marcado al inicio de la cita / desfase de reloj)", () => {
    expect(guardFutureTerminalStatus("COMPLETED", future(FUTURE_TERMINAL_GRACE_MS - 1), now)).toEqual({
      status: "COMPLETED",
      anomaly: false,
    });
  });

  it("no toca estados NO terminales aunque la cita sea futura (CONFIRMED/PENDING/RESCHEDULED pasan)", () => {
    expect(guardFutureTerminalStatus("CONFIRMED", future(24 * 60 * 60 * 1000), now)).toEqual({
      status: "CONFIRMED",
      anomaly: false,
    });
    expect(guardFutureTerminalStatus(null, future(24 * 60 * 60 * 1000), now)).toEqual({
      status: null,
      anomaly: false,
    });
  });

  it("sin startsAt no rompe: devuelve el estado tal cual", () => {
    expect(guardFutureTerminalStatus("COMPLETED", null, now)).toEqual({ status: "COMPLETED", anomaly: false });
  });
});
