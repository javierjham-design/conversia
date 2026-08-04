import { describe, expect, it } from "vitest";
import { detectAppointmentResponse } from "./appointment-responses";

describe("detectAppointmentResponse", () => {
  it("detecta Confirmar (botón o texto)", () => {
    for (const t of ["Confirmar", "confirmar", "Confirmo", "Sí, confirmo", "sí confirmo", "confirmo mi cita"]) {
      expect(detectAppointmentResponse(t)).toBe("confirm");
    }
  });

  it("detecta Reagendar / reprogramar", () => {
    for (const t of ["Reagendar", "reagendar", "reprogramar", "cambiar la hora", "cambiar cita", "otro día"]) {
      expect(detectAppointmentResponse(t)).toBe("reschedule");
    }
  });

  it("ignora mensajes normales y vacíos", () => {
    for (const t of ["", "  ", "Hola, quiero saber los precios", "gracias", "¿tienen hora mañana?", null, undefined]) {
      expect(detectAppointmentResponse(t)).toBeNull();
    }
  });

  it("no captura frases largas (evita falsos positivos)", () => {
    expect(detectAppointmentResponse("confirmar mi correo electrónico para el registro, por favor")).toBeNull();
  });
});
