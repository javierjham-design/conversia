import { describe, expect, it } from "vitest";
import { parseGoogleCalendarConfig } from "@conversia/config";
import { calendariosConCitasNuestras, clasificarCambio, ventanaInicial, type PulledEvent } from "./google-sync-back.js";

/**
 * ETAPA 3 — los cambios hechos EN Google vuelven a Conversia.
 *
 * Los dos invariantes que no se pueden romper:
 *
 * 1. **El eco de nuestra propia escritura no se interpreta como cambio.** Sin eso se arma un
 *    bucle: escribimos en Google → el sondeo lo ve como cambio → actualiza la cita → el
 *    espejo vuelve a escribir → y así, gastando cuota y moviendo la cita sola.
 * 2. **Borrar el evento en Google NO cancela la cita.** Un borrado por error dejaría a un
 *    cliente sin su hora y sin aviso; la cita queda marcada para que una persona decida.
 */

const CITA = {
  id: "appt_1",
  startsAt: new Date("2026-11-10T18:00:00.000Z"),
  endsAt: new Date("2026-11-10T18:30:00.000Z"),
  status: "CONFIRMED",
  googleUpdated: "2026-11-02T10:00:00.000Z",
};

const nuestro = (p: Partial<PulledEvent> = {}): PulledEvent => ({
  id: "ev1",
  status: "confirmed",
  updated: "2026-11-02T11:00:00.000Z",
  start: { dateTime: "2026-11-10T18:00:00.000Z" },
  end: { dateTime: "2026-11-10T18:30:00.000Z" },
  extendedProperties: { private: { conversiaAppointmentId: "appt_1" } },
  ...p,
});

describe("clasificarCambio — solo se procesa lo NUESTRO", () => {
  it("un evento personal del dueño se ignora", () => {
    // Los eventos personales nuevos no se procesan: ya los cubre la lectura de horas
    // ocupadas de la Etapa 2.
    expect(clasificarCambio({ ...nuestro(), extendedProperties: {} }, CITA)).toEqual({ tipo: "ajeno" });
    expect(clasificarCambio({ ...nuestro(), extendedProperties: { private: {} } }, CITA)).toEqual({ tipo: "ajeno" });
  });

  it("un evento nuestro cuya cita ya no existe se ignora", () => {
    expect(clasificarCambio(nuestro(), null)).toEqual({ tipo: "ajeno" });
  });

  it("un evento que apunta a OTRA cita se ignora", () => {
    expect(clasificarCambio(nuestro(), CITA, "appt_999")).toEqual({ tipo: "ajeno" });
  });
});

describe("ANTI-BUCLE: el rebote de nuestra escritura", () => {
  it("si el `updated` es el que guardamos al escribir, es ECO (no cambio)", () => {
    expect(clasificarCambio(nuestro({ updated: CITA.googleUpdated, start: { dateTime: "2026-11-10T20:00:00.000Z" }, end: { dateTime: "2026-11-10T20:30:00.000Z" } }), CITA)).toEqual({ tipo: "eco" });
  });

  it("con un `updated` distinto SÍ es un cambio real del dueño", () => {
    const r = clasificarCambio(nuestro({ updated: "2026-11-02T12:00:00.000Z", start: { dateTime: "2026-11-10T20:00:00.000Z" }, end: { dateTime: "2026-11-10T20:30:00.000Z" } }), CITA);
    expect(r.tipo).toBe("movida");
  });

  it("una cita que nunca se espejó (sin googleUpdated) no se trata como eco", () => {
    const sinMarca = { ...CITA, googleUpdated: undefined };
    expect(clasificarCambio(nuestro({ start: { dateTime: "2026-11-10T20:00:00.000Z" }, end: { dateTime: "2026-11-10T20:30:00.000Z" } }), sinMarca).tipo).toBe("movida");
  });
});

describe("MOVIDA en Google", () => {
  it("devuelve las horas nuevas", () => {
    const r = clasificarCambio(nuestro({ start: { dateTime: "2026-11-11T14:00:00.000Z" }, end: { dateTime: "2026-11-11T14:45:00.000Z" } }), CITA);
    expect(r).toEqual({ tipo: "movida", startsAt: new Date("2026-11-11T14:00:00.000Z"), endsAt: new Date("2026-11-11T14:45:00.000Z") });
  });

  it("la misma hora NO es un cambio", () => {
    expect(clasificarCambio(nuestro(), CITA)).toEqual({ tipo: "sin-cambio" });
  });

  it("una diferencia de segundos tampoco (tolerancia de un minuto)", () => {
    // Google devuelve las horas con su propio redondeo; medio minuto de diferencia no es
    // que el dueño haya movido nada, y tratarlo como cambio dispararía recordatorios.
    expect(clasificarCambio(nuestro({ start: { dateTime: "2026-11-10T18:00:30.000Z" } }), CITA)).toEqual({ tipo: "sin-cambio" });
  });

  it("datos imposibles no mueven nada", () => {
    expect(clasificarCambio(nuestro({ start: {}, end: {} }), CITA)).toEqual({ tipo: "sin-cambio" });
    expect(clasificarCambio(nuestro({ end: { dateTime: "2026-11-10T17:00:00.000Z" } }), CITA)).toEqual({ tipo: "sin-cambio" });
  });

  it("una cita nuestra convertida a DÍA COMPLETO en Google no se mueve a ciegas", () => {
    // Sin horas no se puede decidir a qué hora queda; mejor dejarla como está que inventar.
    expect(clasificarCambio({ ...nuestro(), start: { date: "2026-11-11" }, end: { date: "2026-11-12" } }, CITA)).toEqual({ tipo: "sin-cambio" });
  });
});

describe("ELIMINADA en Google — NO se cancela sola", () => {
  it("un evento cancelado marca la cita para revisar", () => {
    expect(clasificarCambio(nuestro({ status: "cancelled" }), CITA)).toEqual({ tipo: "eliminada" });
  });

  it("si la cita YA estaba cancelada de nuestro lado, no hay nada que avisar", () => {
    expect(clasificarCambio(nuestro({ status: "cancelled" }), { ...CITA, status: "CANCELLED" })).toEqual({ tipo: "sin-cambio" });
  });

  it("un borrado NUNCA devuelve una acción de cancelación", () => {
    // El tipo del resultado es la garantía: `eliminada` solo marca; cancelar es una decisión
    // que toma una persona desde el panel (`POST appointments/:id/google-revision`).
    const r = clasificarCambio(nuestro({ status: "cancelled" }), CITA);
    expect(r.tipo).not.toBe("movida");
    expect(Object.keys(r)).toEqual(["tipo"]);
  });
});

describe("qué calendarios se sondean", () => {
  it("los que escribimos: los de cada profesional con writeEvents + el del negocio", () => {
    const cfg = parseGoogleCalendarConfig({
      calendarId: "local@gmail.com",
      calendarSync: true,
      calendars: {
        p1: { calendarId: "a@gmail.com", writeEvents: true },
        p2: { calendarId: "b@gmail.com", writeEvents: false }, // no le escribimos → no hay citas nuestras
      },
    });
    expect(calendariosConCitasNuestras(cfg)).toEqual(["a@gmail.com", "local@gmail.com"]);
  });

  it("sin calendarios no se sondea nada", () => {
    expect(calendariosConCitasNuestras(parseGoogleCalendarConfig({ calendarSync: true }))).toEqual([]);
  });

  it("no repite si un profesional apunta al del negocio", () => {
    const cfg = parseGoogleCalendarConfig({ calendarId: "local@gmail.com", calendars: { p1: { calendarId: "local@gmail.com" } } });
    expect(calendariosConCitasNuestras(cfg)).toEqual(["local@gmail.com"]);
  });
});

describe("ventana inicial (y de recuperación tras un 410)", () => {
  it("de ayer a +60 días", () => {
    const v = ventanaInicial(new Date("2026-11-02T12:00:00.000Z"));
    expect(v.timeMin).toBe("2026-11-01T12:00:00.000Z");
    expect(v.timeMax).toBe("2027-01-01T12:00:00.000Z");
  });

  it("empieza un día antes para no perder las citas de hoy ya pasadas", () => {
    const v = ventanaInicial(new Date("2026-11-02T23:00:00.000Z"));
    expect(new Date(v.timeMin).getTime()).toBeLessThan(new Date("2026-11-02T00:00:00.000Z").getTime());
  });
});
