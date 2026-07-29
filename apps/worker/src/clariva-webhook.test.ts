import { describe, expect, it } from "vitest";
import { mapClarivaEvent } from "./clariva-webhook";

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
});
