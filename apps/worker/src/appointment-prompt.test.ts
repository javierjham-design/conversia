import { describe, expect, it } from "vitest";
import { buildUpcomingAppointmentBlock } from "./appointment-prompt.js";

describe("buildUpcomingAppointmentBlock", () => {
  it("manda reagendar con el MISMO profesional (pasa su professionalId a getAvailability)", () => {
    const block = buildUpcomingAppointmentBlock({
      cuando: "viernes, 30 de octubre, 16:45",
      professionalName: "Dr. Javier Aedo",
      professionalId: "prof_123",
      status: "PENDING",
    });
    expect(block).toContain("YA tiene una hora agendada");
    expect(block).toContain("Dr. Javier Aedo");
    // El punto del arreglo: reagendar consultando a SU mismo profesional (no ofrecer otros).
    expect(block).toContain("professionalId=prof_123");
    expect(block).toContain("su MISMO profesional");
    // Y que createAppointment MOVERÁ la cita (no duplicar / no pedir cancelar la anterior).
    expect(block).toMatch(/MOVER/i);
    // La cita adicional es la EXCEPCIÓN explícita (con su flag).
    expect(block).toContain("esCitaAdicional=true");
  });

  it("sin professionalId cae a 'su MISMO profesional' sin romper el texto", () => {
    const block = buildUpcomingAppointmentBlock({ cuando: "lunes 3, 15:00", status: "CONFIRMED" });
    expect(block).not.toContain("professionalId=");
    expect(block).toContain("su MISMO profesional");
    expect(block).toContain("estado: confirmed");
  });
});
