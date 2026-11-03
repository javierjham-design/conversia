import { describe, expect, it } from "vitest";
import {
  GOOGLE_CALENDAR_CONFIG_VACIA,
  calendarForProfessional,
  calendarsToReadBusy,
  linkedCalendarIds,
  parseGoogleCalendarConfig,
} from "@conversia/config";

/**
 * ETAPA 1 — un calendario por profesional.
 *
 * Caso guía: barbería con 3 barberos, cada uno con su Gmail compartido con la cuenta
 * conectada. Antes había UN calendario por cuenta: las citas de los tres caían juntas y
 * ninguno podía ver su día en su teléfono.
 *
 * El bloque de REGRESIÓN es el que no se puede romper: una cuenta de TuBot con la config
 * vieja (`calendarId` + `calendarSync`) tiene que comportarse EXACTAMENTE igual que antes,
 * sin reconectar ni reconfigurar.
 */

/** Config real de una cuenta de TuBot con el espejo andando desde antes de esta etapa. */
const VIEJA = { accountEmail: "clinica@gmail.com", calendarId: "clinica@gmail.com", calendarSync: true };

const BARBERIA = {
  calendarId: "local@gmail.com",
  calendarSync: true,
  calendarReadBusy: true,
  calendars: {
    pro_a: { calendarId: "barberoA@gmail.com", readBusy: true, writeEvents: true },
    pro_b: { calendarId: "barberoB@gmail.com", readBusy: false, writeEvents: true },
    pro_c: { calendarId: "barberoC@gmail.com", readBusy: true, writeEvents: false },
  },
};

describe("REGRESIÓN TuBot — la config vieja se comporta igual que antes", () => {
  const cfg = parseGoogleCalendarConfig(VIEJA);

  it("el calendarId de siempre pasa a ser el calendario del negocio", () => {
    expect(cfg.businessCalendarId).toBe("clinica@gmail.com");
    expect(cfg.calendarSync).toBe(true);
    expect(cfg.calendars).toEqual({});
  });

  it("toda cita va al calendario del negocio, con o sin profesional", () => {
    expect(calendarForProfessional(cfg, "pro_x")).toEqual({ calendarId: "clinica@gmail.com", origen: "negocio" });
    expect(calendarForProfessional(cfg, null)).toEqual({ calendarId: "clinica@gmail.com", origen: "negocio" });
  });

  it("NO lee horas ocupadas de Google (nadie lo activó): el bot se comporta como hoy", () => {
    // `calendarReadBusy` ausente = false. Si esto devolviera el calendario, una cuenta que
    // nunca pidió la lectura empezaría a esconder horas de golpe tras el despliegue.
    expect(cfg.businessReadBusy).toBe(false);
    expect(calendarsToReadBusy(cfg, "pro_x")).toEqual([]);
  });
});

describe("parseGoogleCalendarConfig", () => {
  it("lee el mapa por profesional", () => {
    const cfg = parseGoogleCalendarConfig(BARBERIA);
    expect(Object.keys(cfg.calendars)).toEqual(["pro_a", "pro_b", "pro_c"]);
    expect(cfg.calendars.pro_b.readBusy).toBe(false);
    expect(cfg.calendars.pro_c.writeEvents).toBe(false);
    expect(cfg.businessReadBusy).toBe(true);
  });

  it("los dos interruptores vienen ACTIVADOS cuando no se dicen", () => {
    // Vincular un calendario sin decir nada más significa "usalo para las dos cosas": es lo
    // que espera el dueño y lo que deja marcado el asistente de la Etapa 4.
    const cfg = parseGoogleCalendarConfig({ calendars: { p1: { calendarId: "a@gmail.com" } } });
    expect(cfg.calendars.p1).toEqual({ calendarId: "a@gmail.com", readBusy: true, writeEvents: true });
  });

  it("descarta entradas sin calendario en vez de guardar basura", () => {
    const cfg = parseGoogleCalendarConfig({ calendars: { p1: { calendarId: "   " }, p2: { calendarId: "b@gmail.com" }, p3: null, p4: "x" } });
    expect(Object.keys(cfg.calendars)).toEqual(["p2"]);
  });

  it("aguanta cualquier cosa sin dejar al tenant sin config", () => {
    expect(parseGoogleCalendarConfig(null)).toEqual(GOOGLE_CALENDAR_CONFIG_VACIA);
    expect(parseGoogleCalendarConfig("texto")).toEqual(GOOGLE_CALENDAR_CONFIG_VACIA);
    expect(parseGoogleCalendarConfig({ calendars: [] }).calendars).toEqual({});
    expect(parseGoogleCalendarConfig({ calendars: "no" }).calendars).toEqual({});
  });

  it("recorta espacios en los ids", () => {
    const cfg = parseGoogleCalendarConfig({ calendarId: "  local@gmail.com ", calendars: { p1: { calendarId: " a@gmail.com " } } });
    expect(cfg.businessCalendarId).toBe("local@gmail.com");
    expect(cfg.calendars.p1.calendarId).toBe("a@gmail.com");
  });
});

describe("calendarForProfessional — a qué calendario va la cita", () => {
  const cfg = parseGoogleCalendarConfig(BARBERIA);

  it("el del profesional manda", () => {
    expect(calendarForProfessional(cfg, "pro_a")).toEqual({ calendarId: "barberoA@gmail.com", origen: "profesional" });
  });

  it("quien no tiene propio cae al del negocio", () => {
    expect(calendarForProfessional(cfg, "pro_z")).toEqual({ calendarId: "local@gmail.com", origen: "negocio" });
  });

  it("una cita sin profesional va al del negocio", () => {
    expect(calendarForProfessional(cfg, null)).toEqual({ calendarId: "local@gmail.com", origen: "negocio" });
  });

  it("con writeEvents apagado NO se escribe en ninguna parte (ni en el del negocio)", () => {
    // El barbero C pidió que no le creemos citas. Caer al calendario del negocio sería
    // escribirle la cita en otro lado: justo lo que pidió que no hagamos.
    expect(calendarForProfessional(cfg, "pro_c")).toEqual({ calendarId: "", origen: "ninguno" });
  });

  it("sin calendario del negocio y sin propio, no hay dónde escribir", () => {
    const solo = parseGoogleCalendarConfig({ calendarSync: true, calendars: { pro_a: { calendarId: "a@gmail.com" } } });
    expect(calendarForProfessional(solo, "pro_z")).toEqual({ calendarId: "", origen: "ninguno" });
    expect(calendarForProfessional(solo, "pro_a").calendarId).toBe("a@gmail.com");
  });
});

describe("calendarsToReadBusy — qué calendarios respetar (lo consume la Etapa 2)", () => {
  const cfg = parseGoogleCalendarConfig(BARBERIA);

  it("el del profesional + el del negocio", () => {
    expect(calendarsToReadBusy(cfg, "pro_a")).toEqual(["barberoA@gmail.com", "local@gmail.com"]);
  });

  it("si el profesional no quiere que lo leamos, solo el del negocio", () => {
    expect(calendarsToReadBusy(cfg, "pro_b")).toEqual(["local@gmail.com"]);
  });

  it("el calendario del negocio bloquea a TODOS, incluso a quien no tiene propio", () => {
    expect(calendarsToReadBusy(cfg, "pro_z")).toEqual(["local@gmail.com"]);
  });

  it("sin el toggle del negocio, solo el propio", () => {
    const sinNegocio = parseGoogleCalendarConfig({ ...BARBERIA, calendarReadBusy: false });
    expect(calendarsToReadBusy(sinNegocio, "pro_a")).toEqual(["barberoA@gmail.com"]);
  });

  it("no repite si el profesional apunta al mismo calendario del negocio", () => {
    const mismo = parseGoogleCalendarConfig({ calendarId: "local@gmail.com", calendarReadBusy: true, calendars: { p1: { calendarId: "local@gmail.com" } } });
    expect(calendarsToReadBusy(mismo, "p1")).toEqual(["local@gmail.com"]);
  });
});

describe("linkedCalendarIds — para el botón Probar", () => {
  it("junta el del negocio y los de cada profesional, sin repetidos", () => {
    expect(linkedCalendarIds(parseGoogleCalendarConfig(BARBERIA))).toEqual(["local@gmail.com", "barberoA@gmail.com", "barberoB@gmail.com", "barberoC@gmail.com"]);
  });
  it("vacío cuando no hay nada vinculado", () => {
    expect(linkedCalendarIds(GOOGLE_CALENDAR_CONFIG_VACIA)).toEqual([]);
  });
});
