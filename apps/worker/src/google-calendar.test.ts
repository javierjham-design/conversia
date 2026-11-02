import { describe, expect, it } from "vitest";
import { BASE_VOCAB, INDUSTRIES, parseGoogleCalendarConfig, resolvePersonalization } from "@conversia/config";
import { buildCalendarEvent, hayDondeEscribir, planCalendarWrite } from "./google-calendar.js";

/**
 * ETAPA 0 (d) — el texto del evento de Google Calendar.
 *
 * Lo que estaba mal: el título era `Cita: {nombre}`, el nombre por defecto "Paciente" y la
 * descripción decía "Creada por TuBot". Eso lo lee el DUEÑO en su teléfono: en una barbería
 * no corresponde "Paciente", y a un cliente de Conversia no se le puede nombrar TuBot.
 */

const vocabDe = (industry: string) => resolvePersonalization({ general: { industry } }).vocabulary;

const base = {
  appointmentId: "appt_1",
  contactName: "Juan Pérez",
  serviceName: "Corte y barba",
  notes: null as string | null,
  phone: null as string | null,
  vocabulary: vocabDe("barberia"),
  brandName: "Conversia",
  startsAt: new Date("2026-11-10T18:00:00.000Z"),
  endsAt: new Date("2026-11-10T18:30:00.000Z"),
  timezone: "America/Santiago",
  cancelled: false,
};

describe("buildCalendarEvent — título", () => {
  it("usa {servicio} · {cliente}", () => {
    expect(buildCalendarEvent(base).summary).toBe("Corte y barba · Juan Pérez");
  });

  it("sin servicio usa el término de CITA del rubro (barbería = Reserva)", () => {
    expect(buildCalendarEvent({ ...base, serviceName: null }).summary).toBe("Reserva · Juan Pérez");
  });

  it("sin servicio en dental dice Cita", () => {
    expect(buildCalendarEvent({ ...base, serviceName: null, vocabulary: vocabDe("dental") }).summary).toBe("Cita · Juan Pérez");
  });

  it("sin vocabulario cae a 'Cita' (y nunca a 'Paciente')", () => {
    const ev = buildCalendarEvent({ ...base, serviceName: null, contactName: null, vocabulary: {} });
    expect(ev.summary).toBe("Cita · Cliente");
    expect(JSON.stringify(ev)).not.toContain("Paciente");
  });

  it("un servicio en blanco no deja el título empezando con ' · '", () => {
    expect(buildCalendarEvent({ ...base, serviceName: "   " }).summary).toBe("Reserva · Juan Pérez");
  });
});

describe("buildCalendarEvent — nombre del cliente", () => {
  it("sin nombre usa el término del rubro: barbería = Cliente", () => {
    expect(buildCalendarEvent({ ...base, contactName: null }).summary).toBe("Corte y barba · Cliente");
  });

  it("sin nombre en salud sí dice Paciente (ahí corresponde)", () => {
    expect(buildCalendarEvent({ ...base, contactName: null, vocabulary: vocabDe("salud") }).summary).toBe("Corte y barba · Paciente");
  });

  it("un nombre en blanco se trata como ausente", () => {
    expect(buildCalendarEvent({ ...base, contactName: "  " }).summary).toBe("Corte y barba · Cliente");
  });
});

describe("buildCalendarEvent — descripción", () => {
  it("lleva notas, teléfono y la MARCA (no 'TuBot' fijo)", () => {
    const ev = buildCalendarEvent({ ...base, notes: "Viene con su hijo", phone: "+56912345678" });
    expect(ev.description).toBe("Viene con su hijo\nTel: +56912345678\nAgendada por Conversia");
  });

  it("sin notas ni teléfono deja solo la firma de la marca", () => {
    expect(buildCalendarEvent(base).description).toBe("Agendada por Conversia");
  });

  it("en una org de TuBot dice TuBot", () => {
    expect(buildCalendarEvent({ ...base, brandName: "TuBot" }).description).toContain("Agendada por TuBot");
  });
});

describe("buildCalendarEvent — marca de evento propio", () => {
  it("escribe conversiaAppointmentId en extendedProperties.private", () => {
    const ev = buildCalendarEvent(base) as { extendedProperties: { private: Record<string, string> } };
    expect(ev.extendedProperties.private.conversiaAppointmentId).toBe("appt_1");
  });

  it("es lo que permitirá NO bloquearse a sí misma al leer horas ocupadas (Etapa 2)", () => {
    const ev = buildCalendarEvent({ ...base, appointmentId: "appt_xyz" }) as { extendedProperties: { private: Record<string, string> } };
    // Si esta clave cambia de nombre, la Etapa 2 vuelve a contar nuestras propias citas como
    // horas ocupadas y el reagendamiento se autobloquea.
    expect(Object.keys(ev.extendedProperties.private)).toEqual(["conversiaAppointmentId"]);
  });
});

describe("buildCalendarEvent — horas y cancelación", () => {
  it("manda las horas en ISO con la zona de la cita", () => {
    const ev = buildCalendarEvent(base) as { start: { dateTime: string; timeZone: string }; end: { dateTime: string } };
    expect(ev.start.dateTime).toBe("2026-11-10T18:00:00.000Z");
    expect(ev.start.timeZone).toBe("America/Santiago");
    expect(ev.end.dateTime).toBe("2026-11-10T18:30:00.000Z");
  });

  it("una cita CANCELLED va con status cancelled", () => {
    expect(buildCalendarEvent({ ...base, cancelled: true }).status).toBe("cancelled");
    expect(buildCalendarEvent(base).status).toBeUndefined();
  });
});

/**
 * ETAPA 1 — escribir en el calendario de CADA profesional.
 *
 * El caso difícil es cambiarle el profesional a una cita: el evento vive en el calendario del
 * barbero anterior. Si solo se hiciera PATCH en el calendario nuevo, Google contesta 404 y el
 * código lo recrea → la cita queda DUPLICADA: viva en el calendario viejo y nueva en el otro.
 */
describe("planCalendarWrite", () => {
  it("sin evento previo: crear", () => {
    expect(planCalendarWrite({ targetCalendarId: "a@gmail.com" })).toEqual({ accion: "crear", escribirEn: "a@gmail.com" });
  });

  it("mismo calendario: actualizar en su lugar", () => {
    expect(planCalendarWrite({ eventId: "ev1", previousCalendarId: "a@gmail.com", targetCalendarId: "a@gmail.com" })).toEqual({
      accion: "actualizar",
      escribirEn: "a@gmail.com",
    });
  });

  it("cambió de calendario: MOVER, con el borrado del anterior explícito", () => {
    expect(planCalendarWrite({ eventId: "ev1", previousCalendarId: "barberoA@gmail.com", targetCalendarId: "barberoB@gmail.com" })).toEqual({
      accion: "mover",
      escribirEn: "barberoB@gmail.com",
      borrarDe: "barberoA@gmail.com",
    });
  });

  it("una cita espejada ANTES de esta etapa (sin googleCalendarId) se actualiza, no se duplica", () => {
    // Esas cuentas tenían UN solo calendario, así que asumir que el evento está en el de
    // destino es correcto. Tratarlo como "mover" borraría un evento que sí hay que conservar.
    expect(planCalendarWrite({ eventId: "ev1", targetCalendarId: "clinica@gmail.com" })).toEqual({
      accion: "actualizar",
      escribirEn: "clinica@gmail.com",
    });
  });
});

describe("hayDondeEscribir", () => {
  it("con el espejo apagado, no", () => {
    expect(hayDondeEscribir(parseGoogleCalendarConfig({ calendarId: "a@gmail.com", calendarSync: false }))).toBe(false);
  });
  it("config vieja de TuBot: sí (calendario del negocio)", () => {
    expect(hayDondeEscribir(parseGoogleCalendarConfig({ calendarId: "a@gmail.com", calendarSync: true }))).toBe(true);
  });
  it("solo calendarios por profesional, sin uno del negocio: TAMBIÉN sí", () => {
    // Una barbería puede vincular el calendario de cada barbero y ninguno del negocio. Antes
    // el guardia exigía `calendarId` y ese caso quedaba sin espejo, en silencio.
    expect(hayDondeEscribir(parseGoogleCalendarConfig({ calendarSync: true, calendars: { p1: { calendarId: "b@gmail.com" } } }))).toBe(true);
  });
  it("sin ningún calendario, no", () => {
    expect(hayDondeEscribir(parseGoogleCalendarConfig({ calendarSync: true }))).toBe(false);
  });
});

describe("el vocabulario compartido sigue resolviendo igual tras moverlo a @conversia/config", () => {
  it("el catálogo de rubros llegó completo al paquete", () => {
    expect(INDUSTRIES.length).toBeGreaterThan(25);
    expect(INDUSTRIES.map((i) => i.code)).toContain("barberia");
  });

  it("base ← rubro ← override del tenant", () => {
    expect(BASE_VOCAB.contact).toBe("Contacto");
    expect(vocabDe("dental").contact).toBe("Paciente");
    expect(resolvePersonalization({ general: { industry: "dental" }, vocabulary: { contact: "Consultante" } }).vocabulary.contact).toBe("Consultante");
  });
});
