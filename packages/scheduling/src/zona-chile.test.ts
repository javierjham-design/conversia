import { describe, expect, it } from "vitest";
import { computeNativeSlots } from "./availability";
import { mapDentalinkCita } from "./dentalink";
import { MockSchedulingProvider, NativeSchedulingProvider } from "./index";
import { ZONA_POR_DEFECTO, fechaDesplazada, fechaEnZona, inicioDelDiaEnZona, offsetForZoneOnDate } from "./zona";

/**
 * LA AGENDA SE RIGE POR LA HORA OFICIAL DE CHILE.
 *
 * El bug que fijan estos tests: la agenda armaba las horas con un offset FIJO "-04:00".
 * Chile está en -03:00 de septiembre a abril, así que durante medio año un negocio abierto
 * de 09:00 a 19:00 recibía ofertas de 10:00 a 20:00 —una hora en la que está cerrado— y
 * perdía la primera de la mañana. En invierno el error desaparecía solo, y por eso vivió
 * meses sin que nadie lo viera.
 *
 * Todo lo que se afirma acá se mide en el RELOJ DE PARED de Chile (con `Intl`), no en el
 * texto del offset: es lo que lee el cliente en el WhatsApp, y es lo único que importa.
 * Comprobar el offset además es útil, pero por sí solo no distingue un "-03:00" correcto de
 * un "-03:00" que corrió la hora.
 */

/** La hora que ve el cliente en Chile, venga el ISO en el offset que venga. */
const horaEnChile = (iso: string): string =>
  new Intl.DateTimeFormat("es-CL", { timeZone: ZONA_POR_DEFECTO, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

/** Un negocio de lunes a domingo, 09:00 a 19:00 (el caso del dueño). */
const JORNADA = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: "09:00", end: "19:00" }));
const UNA_HORA = { workBlocks: JORNADA, durationMin: 60, slotStepMin: 60 };
/** "Ahora" muy anterior a las fechas probadas: `minAdvanceMin` no debe filtrar nada. */
const ANTES = new Date("2026-01-01T00:00:00Z").getTime();

describe("el bot ofrece la jornada real del negocio (09:00-19:00), no corrida", () => {
  it("en VERANO (noviembre, -03:00) la primera oferta es 09:00 y la última termina 19:00", () => {
    const slots = computeNativeSlots({ ...UNA_HORA, fromDate: "2026-11-10", toDate: "2026-11-10", nowMs: ANTES });
    expect(slots).toHaveLength(10); // 09:00 … 18:00
    expect(horaEnChile(slots[0].start)).toBe("09:00");
    expect(horaEnChile(slots[9].start)).toBe("18:00");
    expect(horaEnChile(slots[9].end)).toBe("19:00");
    // Lo que el dueño veía: ofertas a las 20:00, con el local cerrado.
    expect(slots.map((s) => horaEnChile(s.start))).not.toContain("20:00");
    expect(slots[0].start).toBe("2026-11-10T09:00:00-03:00");
  });

  it("en INVIERNO (julio, -04:00) ofrece exactamente la misma jornada", () => {
    const slots = computeNativeSlots({ ...UNA_HORA, fromDate: "2026-07-10", toDate: "2026-07-10", nowMs: ANTES });
    expect(slots).toHaveLength(10);
    expect(horaEnChile(slots[0].start)).toBe("09:00");
    expect(horaEnChile(slots[9].end)).toBe("19:00");
    expect(slots[0].start).toBe("2026-07-10T09:00:00-04:00");
  });

  it("sin zona declarada rige Chile (no UTC ni un offset fijo)", () => {
    const slots = computeNativeSlots({ ...UNA_HORA, fromDate: "2026-11-10", toDate: "2026-11-10", nowMs: ANTES });
    const conZona = computeNativeSlots({ ...UNA_HORA, timeZone: ZONA_POR_DEFECTO, fromDate: "2026-11-10", toDate: "2026-11-10", nowMs: ANTES });
    expect(slots).toEqual(conZona);
  });

  it("respeta la zona de una cuenta que NO está en Chile", () => {
    const slots = computeNativeSlots({ ...UNA_HORA, timeZone: "Europe/Madrid", fromDate: "2026-11-10", toDate: "2026-11-10", nowMs: ANTES });
    expect(slots[0].start).toBe("2026-11-10T09:00:00+01:00"); // Madrid en invierno
  });
});

describe("un rango que CRUZA el cambio de hora: cada día con su offset", () => {
  // Esto es lo que un offset por consulta no puede hacer bien: el bot ofrece una semana
  // de corrido, y si el cambio de hora cae en medio, la mitad de la semana sale corrida.
  const casos: Array<[string, string, string]> = [
    ["el fin del horario de verano (domingo 5-abr-2026)", "2026-04-03", "2026-04-07"],
    ["el inicio del horario de verano (domingo 6-sep-2026)", "2026-09-04", "2026-09-08"],
  ];

  it.each(casos)("%s está de verdad dentro del rango probado", (_n, desde, hasta) => {
    // Si esto falla, el rango dejó de cruzar el cambio y los tests de abajo pasarían solos.
    expect(offsetForZoneOnDate(ZONA_POR_DEFECTO, desde)).not.toBe(offsetForZoneOnDate(ZONA_POR_DEFECTO, hasta));
  });

  it.each(casos)("cruzando %s, TODOS los días abren a las 09:00 en Chile", (_n, desde, hasta) => {
    const slots = computeNativeSlots({ ...UNA_HORA, fromDate: desde, toDate: hasta, nowMs: ANTES });
    const primeraDeCadaDia = new Map<string, string>();
    for (const s of slots) if (!primeraDeCadaDia.has(s.start.slice(0, 10))) primeraDeCadaDia.set(s.start.slice(0, 10), s.start);
    expect(primeraDeCadaDia.size).toBe(5);
    for (const [dia, iso] of primeraDeCadaDia) expect(horaEnChile(iso), `el ${dia} abrió a otra hora`).toBe("09:00");
    // Y las horas ofrecidas llevan los DOS offsets, porque el rango cruza el cambio.
    const offsets = new Set(slots.map((s) => s.start.slice(-6)));
    expect([...offsets].sort()).toEqual(["-03:00", "-04:00"]);
  });

  it("ninguna hora ofrecida se repite ni se desordena al cruzar el cambio", () => {
    const slots = computeNativeSlots({ ...UNA_HORA, fromDate: "2026-04-03", toDate: "2026-04-07", nowMs: ANTES });
    const instantes = slots.map((s) => new Date(s.start).getTime());
    expect(new Set(instantes).size).toBe(instantes.length);
    expect([...instantes].sort((a, b) => a - b)).toEqual(instantes);
  });
});

describe("el día local del negocio no es el día en UTC", () => {
  // A las 23:30 de Chile, en UTC ya es mañana: un rango que arranque "hoy" calculado en UTC
  // se salta las citas de esta tarde, que es justo lo que el dueño abre a mirar.
  const casiMedianoche = new Date("2026-11-09T02:30:00Z"); // = 23:30 del 8-nov en Chile

  it("fechaEnZona devuelve el día de Chile, no el de UTC", () => {
    expect(fechaEnZona(ZONA_POR_DEFECTO, casiMedianoche)).toBe("2026-11-08");
    expect(casiMedianoche.toISOString().slice(0, 10)).toBe("2026-11-09"); // el que NO hay que usar
  });

  it("inicioDelDiaEnZona es la medianoche local, con el offset de ese día", () => {
    expect(inicioDelDiaEnZona(ZONA_POR_DEFECTO, casiMedianoche).toISOString()).toBe("2026-11-08T03:00:00.000Z");
    // En invierno la misma medianoche cae en otro instante UTC.
    expect(inicioDelDiaEnZona(ZONA_POR_DEFECTO, new Date("2026-07-08T12:00:00Z")).toISOString()).toBe("2026-07-08T04:00:00.000Z");
  });

  it("fechaDesplazada suma días de CALENDARIO, incluso sobre el cambio de hora", () => {
    // Por eso se calcula al mediodía UTC: sumarle 24 h a una medianoche local puede caer en
    // el día anterior o en el siguiente justo cuando el reloj se mueve.
    expect(fechaDesplazada("2026-04-04", 1)).toBe("2026-04-05"); // termina el horario de verano
    expect(fechaDesplazada("2026-09-05", 1)).toBe("2026-09-06"); // empieza el horario de verano
    expect(fechaDesplazada("2026-11-15", -6)).toBe("2026-11-09");
    expect(fechaDesplazada("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("una zona inexistente no revienta: el camino del bot no se puede caer por esto", () => {
    expect(offsetForZoneOnDate("Marte/Olympus", "2026-11-10")).toBe("+00:00");
    expect(() => inicioDelDiaEnZona("Marte/Olympus")).not.toThrow();
  });
});

describe("los proveedores de agenda heredan la zona", () => {
  it("la agenda NATIVA pasa la zona al motor", async () => {
    const p = new NativeSchedulingProvider({
      clinics: [{ id: "c1", name: "Local", timezone: ZONA_POR_DEFECTO }],
      professionals: [{ id: "p1", name: "Barbero", workingHours: [{ day: 2, start: "09:00", end: "11:00" }] }],
      services: [{ id: "corte", name: "Corte", durationMin: 60 }],
      busy: [],
      config: { slotStepMin: 60, minAdvanceMin: 0, timeZone: ZONA_POR_DEFECTO },
    });
    // 2027-11-09 es MARTES y está en el futuro (el motor filtra lo pasado).
    const slots = await p.getAvailableSlots({ from: "2027-11-09", to: "2027-11-09", serviceId: "corte" });
    expect(slots.length).toBeGreaterThan(0);
    expect(horaEnChile(slots[0].start)).toBe("09:00");
    expect(slots[0].start.slice(-6)).toBe("-03:00");
  });

  it("el MOCK (probador de agentes y demos) también muestra la hora de Chile", async () => {
    const p = new MockSchedulingProvider({
      clinics: [{ id: "c1", name: "Local", timezone: ZONA_POR_DEFECTO }],
      professionals: [{ id: "p1", name: "Barbero" }],
      services: [{ id: "corte", name: "Corte", durationMin: 30 }],
      dayStartHour: 10,
      dayEndHour: 11,
      slotMinutes: 60,
      timeZone: ZONA_POR_DEFECTO,
    });
    const verano = await p.getAvailableSlots({ from: "2026-12-10", to: "2026-12-10" });
    expect(horaEnChile(verano[0].start)).toBe("10:00");
    expect(verano[0].start.slice(-6)).toBe("-03:00");
    const invierno = await p.getAvailableSlots({ from: "2027-07-10", to: "2027-07-10" });
    expect(horaEnChile(invierno[0].start)).toBe("10:00");
    expect(invierno[0].start.slice(-6)).toBe("-04:00");
  });

  it("Dentalink manda horas SIN zona: el offset sale de la fecha de la cita", () => {
    const cita = { id: 1, id_dentista: 7, id_sucursal: 3, hora_inicio: "09:00", duracion: 30 };
    expect(mapDentalinkCita({ ...cita, fecha: "2026-12-10" }).start).toBe("2026-12-10T09:00:00-03:00");
    expect(mapDentalinkCita({ ...cita, fecha: "2026-07-10" }).start).toBe("2026-07-10T09:00:00-04:00");
    expect(horaEnChile(mapDentalinkCita({ ...cita, fecha: "2026-12-10" }).start)).toBe("09:00");
  });
});
