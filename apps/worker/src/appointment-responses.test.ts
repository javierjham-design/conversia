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

  it("detecta Cancelar (F4)", () => {
    for (const t of ["Cancelar", "cancelar", "cancelar mi cita", "anular", "quiero anular", "ya no puedo ir", "no podré asistir", "dar de baja"]) {
      expect(detectAppointmentResponse(t)).toBe("cancel");
    }
  });

  it("detecta confirmaciones en lenguaje natural", () => {
    for (const t of ["ahí estaré", "Ahí estoy", "estaré mañana", "estaré ahí", "estare mañana sin falta", "sí voy", "si iré", "ahí nos vemos"]) {
      expect(detectAppointmentResponse(t)).toBe("confirm");
    }
  });

  it("detecta 'no puedo asistir' como cancelar", () => {
    for (const t of ["no puedo asistir", "no puedo ir", "no podré llegar"]) {
      expect(detectAppointmentResponse(t)).toBe("cancel");
    }
  });

  it("NO confunde 'voy a ...' genérico con confirmar", () => {
    expect(detectAppointmentResponse("voy a preguntar algo")).toBeNull();
    expect(detectAppointmentResponse("voy a cancelar")).toBe("cancel");
  });

  it("'cancelar y reagendar' se interpreta como reagendar", () => {
    expect(detectAppointmentResponse("cancelar y reagendar")).toBe("reschedule");
    expect(detectAppointmentResponse("quiero cambiar de día")).toBe("reschedule");
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
