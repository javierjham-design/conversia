import { describe, expect, it } from "vitest";
import {
  busyCacheKey,
  fetchBusyForCalendars,
  fetchCalendarBusy,
  googleEventsToBusy,
  makeExternalBusy,
  offsetForZoneOnDate,
  rangeForDates,
  type GoogleEvent,
} from "./google-busy";
import { NativeSchedulingProvider } from "./index";

/**
 * ETAPA 2 — el bot respeta las horas ocupadas en Google.
 *
 * Brecha que cierra: si el barbero tenía algo agendado en su Google Calendar, el bot ofrecía
 * esa hora igual. El dueño manejaba su vida en Google y TuBot la pisaba.
 *
 * Todo se prueba sin red: la conversión es pura y la parte con fetch recibe un doble.
 */

const CAL = "barbero@gmail.com";
const TZ = "America/Santiago";
const RANGO = { timeMin: "2026-11-10T03:00:00.000Z", timeMax: "2026-11-11T03:00:00.000Z" };

const evento = (p: Partial<GoogleEvent>): GoogleEvent => ({
  id: "ev",
  status: "confirmed",
  start: { dateTime: "2026-11-10T15:00:00-03:00" },
  end: { dateTime: "2026-11-10T16:00:00-03:00" },
  ...p,
});

describe("googleEventsToBusy — qué cuenta como hora ocupada", () => {
  it("un evento normal ocupa su rango", () => {
    expect(googleEventsToBusy([evento({})], { timeZone: TZ })).toEqual([
      { start: "2026-11-10T18:00:00.000Z", end: "2026-11-10T19:00:00.000Z" },
    ]);
  });

  it("une varios eventos", () => {
    const busy = googleEventsToBusy(
      [
        evento({}),
        evento({ id: "ev2", start: { dateTime: "2026-11-10T17:00:00-03:00" }, end: { dateTime: "2026-11-10T17:30:00-03:00" } }),
      ],
      { timeZone: TZ },
    );
    expect(busy).toHaveLength(2);
    expect(busy[1]).toEqual({ start: "2026-11-10T20:00:00.000Z", end: "2026-11-10T20:30:00.000Z" });
  });

  it('IGNORA los marcados como "Disponible" (transparency: transparent)', () => {
    expect(googleEventsToBusy([evento({ transparency: "transparent" })], { timeZone: TZ })).toEqual([]);
    // `opaque` es el valor normal y SÍ ocupa.
    expect(googleEventsToBusy([evento({ transparency: "opaque" })], { timeZone: TZ })).toHaveLength(1);
  });

  it("IGNORA los cancelados", () => {
    expect(googleEventsToBusy([evento({ status: "cancelled" })], { timeZone: TZ })).toEqual([]);
  });

  it("IGNORA los eventos que creamos NOSOTROS", () => {
    // Esa cita ya está en `busy` desde la base de datos. Lo importante no es evitar el
    // duplicado: es que al REAGENDAR la cita se bloquearía A SÍ MISMA y el bot diría que no
    // hay horas justo en el hueco que acaba de liberar.
    const propio = evento({ extendedProperties: { private: { conversiaAppointmentId: "appt_1" } } });
    expect(googleEventsToBusy([propio], { timeZone: TZ })).toEqual([]);
  });

  it("un evento ajeno con otras extendedProperties SÍ ocupa", () => {
    const ajeno = evento({ extendedProperties: { private: { otraCosa: "x" } } });
    expect(googleEventsToBusy([ajeno], { timeZone: TZ })).toHaveLength(1);
  });

  it("descarta datos imposibles sin romperse", () => {
    expect(googleEventsToBusy([evento({ start: {}, end: {} })], { timeZone: TZ })).toEqual([]);
    expect(googleEventsToBusy([evento({ end: { dateTime: "2026-11-10T14:00:00-03:00" } })], { timeZone: TZ })).toEqual([]); // fin antes del inicio
    expect(googleEventsToBusy([evento({ start: { dateTime: "no-es-fecha" } })], { timeZone: TZ })).toEqual([]);
    expect(googleEventsToBusy([null as unknown as GoogleEvent], { timeZone: TZ })).toEqual([]);
    expect(googleEventsToBusy(undefined as unknown as GoogleEvent[], { timeZone: TZ })).toEqual([]);
  });
});

describe("googleEventsToBusy — eventos de DÍA COMPLETO", () => {
  it("bloquean el día entero en la zona de la cuenta", () => {
    // Google manda `end.date` EXCLUSIVO: un día suelto va del 10 al 11.
    const busy = googleEventsToBusy([evento({ start: { date: "2026-11-10" }, end: { date: "2026-11-11" } })], { timeZone: TZ });
    // Noviembre en Santiago = UTC−3 → el día local arranca a las 03:00Z.
    expect(busy).toEqual([{ start: "2026-11-10T03:00:00.000Z", end: "2026-11-11T03:00:00.000Z" }]);
  });

  it("varios días seguidos bloquean todo el tramo (vacaciones)", () => {
    const busy = googleEventsToBusy([evento({ start: { date: "2026-11-10" }, end: { date: "2026-11-15" } })], { timeZone: TZ });
    expect(busy[0].start).toBe("2026-11-10T03:00:00.000Z");
    expect(busy[0].end).toBe("2026-11-15T03:00:00.000Z");
  });

  it("sin end.date asume un día", () => {
    const busy = googleEventsToBusy([evento({ start: { date: "2026-11-10" }, end: {} })], { timeZone: TZ });
    expect(busy[0].end).toBe("2026-11-11T03:00:00.000Z");
  });

  it("respeta la zona propia del evento si viene", () => {
    const busy = googleEventsToBusy([evento({ start: { date: "2026-11-10", timeZone: "UTC" }, end: { date: "2026-11-11" } })], { timeZone: TZ });
    expect(busy[0].start).toBe("2026-11-10T00:00:00.000Z");
  });

  it("un día completo marcado Disponible no bloquea", () => {
    expect(googleEventsToBusy([evento({ transparency: "transparent", start: { date: "2026-11-10" }, end: { date: "2026-11-11" } })], { timeZone: TZ })).toEqual([]);
  });
});

describe("offsetForZoneOnDate", () => {
  it("Chile cambia de hora: −03:00 en noviembre y −04:00 en julio", () => {
    expect(offsetForZoneOnDate(TZ, "2026-11-10")).toBe("-03:00");
    expect(offsetForZoneOnDate(TZ, "2026-07-10")).toBe("-04:00");
  });
  it("una zona desconocida cae a UTC en vez de reventar", () => {
    expect(offsetForZoneOnDate("Marte/Olympus", "2026-11-10")).toBe("+00:00");
  });
});

describe("rangeForDates", () => {
  it("cubre desde el inicio del primer día hasta el final del último (inclusive)", () => {
    expect(rangeForDates("2026-11-10", "2026-11-10", TZ)).toEqual(RANGO);
    expect(rangeForDates("2026-11-10", "2026-11-12", TZ).timeMax).toBe("2026-11-13T03:00:00.000Z");
  });
});

/** fetch falso: devuelve lo que se le diga y cuenta las llamadas. */
function fetchFalso(respuesta: { ok?: boolean; status?: number; items?: GoogleEvent[] } | Error) {
  const llamadas: string[] = [];
  const impl = (async (url: string) => {
    llamadas.push(String(url));
    if (respuesta instanceof Error) throw respuesta;
    return {
      ok: respuesta.ok ?? true,
      status: respuesta.status ?? 200,
      json: async () => ({ items: respuesta.items ?? [] }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, llamadas };
}

function cacheFalsa(inicial: Record<string, string> = {}) {
  const store = { ...inicial };
  return {
    store,
    cache: {
      get: async (k: string) => store[k] ?? null,
      set: async (k: string, v: string) => {
        store[k] = v;
      },
    },
  };
}

describe("fetchCalendarBusy", () => {
  it("consulta Google y devuelve las horas ocupadas", async () => {
    const { impl, llamadas } = fetchFalso({ items: [evento({})] });
    const busy = await fetchCalendarBusy(CAL, RANGO, TZ, { token: async () => "tok", fetchImpl: impl });
    expect(busy).toHaveLength(1);
    expect(llamadas[0]).toContain("singleEvents=true");
    expect(llamadas[0]).toContain(encodeURIComponent(RANGO.timeMin));
  });

  it("guarda el resultado en caché y la segunda vez NO llama a Google", async () => {
    const { cache, store } = cacheFalsa();
    const primero = fetchFalso({ items: [evento({})] });
    await fetchCalendarBusy(CAL, RANGO, TZ, { token: async () => "tok", fetchImpl: primero.impl, cache, cacheScope: "org_1" });
    expect(Object.keys(store)).toEqual([busyCacheKey("org_1", CAL, RANGO.timeMin, RANGO.timeMax)]);

    const segundo = fetchFalso({ items: [] });
    const busy = await fetchCalendarBusy(CAL, RANGO, TZ, { token: async () => "tok", fetchImpl: segundo.impl, cache, cacheScope: "org_1" });
    expect(segundo.llamadas).toHaveLength(0);
    expect(busy).toHaveLength(1);
  });

  it("noCache se SALTA la caché (es la re-verificación antes de confirmar)", async () => {
    const { cache } = cacheFalsa();
    const a = fetchFalso({ items: [evento({})] });
    await fetchCalendarBusy(CAL, RANGO, TZ, { token: async () => "tok", fetchImpl: a.impl, cache, cacheScope: "org_1" });
    const b = fetchFalso({ items: [] });
    const busy = await fetchCalendarBusy(CAL, RANGO, TZ, { token: async () => "tok", fetchImpl: b.impl, cache, cacheScope: "org_1" }, { noCache: true });
    expect(b.llamadas).toHaveLength(1);
    expect(busy).toEqual([]); // vio el estado nuevo, no el de la caché
  });

  it("RESPALDO: si Google contesta error, devuelve vacío y avisa (no lanza)", async () => {
    const { impl } = fetchFalso({ ok: false, status: 503 });
    const errores: string[] = [];
    const busy = await fetchCalendarBusy(CAL, RANGO, TZ, { token: async () => "tok", fetchImpl: impl, onError: (d) => errores.push(d) });
    expect(busy).toEqual([]);
    expect(errores[0]).toContain("503");
  });

  it("RESPALDO: si la llamada se cae o expira, devuelve vacío", async () => {
    const { impl } = fetchFalso(new Error("The operation was aborted due to timeout"));
    const errores: string[] = [];
    const busy = await fetchCalendarBusy(CAL, RANGO, TZ, { token: async () => "tok", fetchImpl: impl, onError: (d) => errores.push(d) });
    expect(busy).toEqual([]);
    expect(errores[0]).toContain("timeout");
  });

  it("RESPALDO: si no se puede obtener el token, devuelve vacío", async () => {
    const { impl, llamadas } = fetchFalso({ items: [] });
    const busy = await fetchCalendarBusy(CAL, RANGO, TZ, {
      token: async () => {
        throw new Error("El acceso fue revocado");
      },
      fetchImpl: impl,
    });
    expect(busy).toEqual([]);
    expect(llamadas).toHaveLength(0);
  });

  it("durante una caída NO se reintenta en cada turno: queda una marca de error en caché", async () => {
    // Sin esto, con Google caído cada turno del bot pagaría el timeout de 3 s.
    const { cache, store } = cacheFalsa();
    const a = fetchFalso({ ok: false, status: 500 });
    await fetchCalendarBusy(CAL, RANGO, TZ, { token: async () => "tok", fetchImpl: a.impl, cache, cacheScope: "org_1" });
    expect(Object.values(store)).toEqual(["ERR"]);

    const b = fetchFalso({ items: [evento({})] });
    const busy = await fetchCalendarBusy(CAL, RANGO, TZ, { token: async () => "tok", fetchImpl: b.impl, cache, cacheScope: "org_1" });
    expect(b.llamadas).toHaveLength(0);
    expect(busy).toEqual([]);
  });

  it("una caché ilegible no rompe: se consulta a Google", async () => {
    const cache = { get: async () => "{no es json", set: async () => undefined };
    const { impl } = fetchFalso({ items: [evento({})] });
    const busy = await fetchCalendarBusy(CAL, RANGO, TZ, { token: async () => "tok", fetchImpl: impl, cache });
    expect(busy).toHaveLength(1);
  });

  it("si Redis se cae al escribir, igual devuelve lo que leyó", async () => {
    const cache = {
      get: async () => null,
      set: async () => {
        throw new Error("redis caído");
      },
    };
    const { impl } = fetchFalso({ items: [evento({})] });
    await expect(fetchCalendarBusy(CAL, RANGO, TZ, { token: async () => "tok", fetchImpl: impl, cache })).resolves.toHaveLength(1);
  });
});

describe("fetchBusyForCalendars", () => {
  it("une los resultados de varios calendarios", async () => {
    const { impl, llamadas } = fetchFalso({ items: [evento({})] });
    const busy = await fetchBusyForCalendars([CAL, "local@gmail.com"], RANGO, TZ, { token: async () => "tok", fetchImpl: impl });
    expect(llamadas).toHaveLength(2);
    expect(busy).toHaveLength(2);
  });
  it("sin calendarios no llama a Google", async () => {
    const { impl, llamadas } = fetchFalso({ items: [] });
    expect(await fetchBusyForCalendars([], RANGO, TZ, { token: async () => "tok", fetchImpl: impl })).toEqual([]);
    expect(llamadas).toHaveLength(0);
  });
});

describe("makeExternalBusy", () => {
  it("no consulta nada para un profesional sin calendarios que respetar", async () => {
    const { impl, llamadas } = fetchFalso({ items: [evento({})] });
    const hook = makeExternalBusy({ calendarsFor: () => [], timeZone: TZ, deps: { token: async () => "tok", fetchImpl: impl } });
    expect(await hook({ professionalId: "p1", from: "2026-11-10", to: "2026-11-10" })).toEqual([]);
    expect(llamadas).toHaveLength(0);
  });

  it("pide el rango completo de los días consultados", async () => {
    const { impl, llamadas } = fetchFalso({ items: [] });
    const hook = makeExternalBusy({ calendarsFor: () => [CAL], timeZone: TZ, deps: { token: async () => "tok", fetchImpl: impl } });
    await hook({ professionalId: "p1", from: "2026-11-10", to: "2026-11-11" });
    expect(llamadas[0]).toContain(encodeURIComponent("2026-11-10T03:00:00.000Z"));
    expect(llamadas[0]).toContain(encodeURIComponent("2026-11-12T03:00:00.000Z"));
  });
});

// ---------------------------------------------------------------------------
// Integración con la agenda nativa: lo que termina viendo el cliente.
// ---------------------------------------------------------------------------

const PRO = { id: "p1", name: "Barbero A", workingHours: [{ day: 2, start: "09:00", end: "13:00" }] }; // martes
const DATOS = {
  clinics: [{ id: "c1", name: "Local", timezone: TZ }],
  professionals: [PRO],
  services: [{ id: "corte", name: "Corte", durationMin: 30 }],
  busy: [] as Array<{ professionalId: string; start: string; end: string }>,
  // nowMs no se puede inyectar desde acá: el rango es futuro para que `minAdvanceMin` no filtre.
  config: { slotStepMin: 30, bufferMin: 0, minAdvanceMin: 0, offset: "-03:00" },
};
// 2026-11-10 es MARTES.
const CONSULTA = { from: "2026-11-10", to: "2026-11-10", serviceId: "corte" };

describe("el bot NO ofrece una hora ocupada en Google", () => {
  it("sin Google, ofrece todo su horario", async () => {
    const p = new NativeSchedulingProvider(DATOS);
    const slots = await p.getAvailableSlots(CONSULTA);
    expect(slots.map((s) => s.start)).toContain("2026-11-10T11:00:00-03:00");
  });

  it("con un evento de Google de 11:00 a 12:00, esas horas desaparecen", async () => {
    const p = new NativeSchedulingProvider({
      ...DATOS,
      externalBusy: async () => [{ start: "2026-11-10T11:00:00-03:00", end: "2026-11-10T12:00:00-03:00" }],
    });
    const horas = (await p.getAvailableSlots(CONSULTA)).map((s) => s.start);
    expect(horas).not.toContain("2026-11-10T11:00:00-03:00");
    expect(horas).not.toContain("2026-11-10T11:30:00-03:00");
    expect(horas).toContain("2026-11-10T10:30:00-03:00");
    expect(horas).toContain("2026-11-10T12:00:00-03:00");
  });

  it("une lo de Google con las citas de la base de datos", async () => {
    const p = new NativeSchedulingProvider({
      ...DATOS,
      busy: [{ professionalId: "p1", start: "2026-11-10T09:00:00-03:00", end: "2026-11-10T09:30:00-03:00" }],
      externalBusy: async () => [{ start: "2026-11-10T11:00:00-03:00", end: "2026-11-10T11:30:00-03:00" }],
    });
    const horas = (await p.getAvailableSlots(CONSULTA)).map((s) => s.start);
    expect(horas).not.toContain("2026-11-10T09:00:00-03:00"); // cita de la BD
    expect(horas).not.toContain("2026-11-10T11:00:00-03:00"); // evento de Google
    expect(horas).toContain("2026-11-10T09:30:00-03:00");
  });

  it("RESPALDO: si Google falla (lista vacía), sigue ofreciendo la agenda nativa", async () => {
    const p = new NativeSchedulingProvider({ ...DATOS, externalBusy: async () => [] });
    expect((await p.getAvailableSlots(CONSULTA)).length).toBeGreaterThan(0);
  });

  it("pasa el rango consultado al gancho, por profesional", async () => {
    const vistos: unknown[] = [];
    const p = new NativeSchedulingProvider({
      ...DATOS,
      externalBusy: async (q) => {
        vistos.push(q);
        return [];
      },
    });
    await p.getAvailableSlots(CONSULTA);
    expect(vistos).toEqual([{ professionalId: "p1", from: "2026-11-10", to: "2026-11-10" }]);
  });
});

describe("RE-VERIFICACIÓN antes de confirmar (anti doble reserva)", () => {
  const cita = { clinicId: "c1", professionalId: "p1", serviceId: "corte", patient: { firstName: "Juan", phone: "+56911111111" }, start: "2026-11-10T11:00:00-03:00", end: "2026-11-10T11:30:00-03:00" };

  it("si la hora se ocupó en Google mientras el cliente contestaba, NO se agenda", async () => {
    const p = new NativeSchedulingProvider({
      ...DATOS,
      externalBusy: async () => [{ start: "2026-11-10T11:00:00-03:00", end: "2026-11-10T12:00:00-03:00" }],
    });
    await expect(p.createAppointment(cita)).rejects.toThrow(/ya no está disponible/i);
  });

  it("la re-verificación va SIN caché", async () => {
    // Con datos de hasta 90 s se confirmaría una hora ya tomada: justo en esos segundos es
    // cuando el dueño la ocupó desde su teléfono.
    const vistos: Array<{ noCache?: boolean }> = [];
    const p = new NativeSchedulingProvider({
      ...DATOS,
      externalBusy: async (q) => {
        vistos.push(q);
        return [];
      },
    });
    await p.createAppointment(cita);
    expect(vistos.at(-1)?.noCache).toBe(true);
  });

  it("si la hora sigue libre, agenda normal", async () => {
    const p = new NativeSchedulingProvider({ ...DATOS, externalBusy: async () => [{ start: "2026-11-10T15:00:00-03:00", end: "2026-11-10T16:00:00-03:00" }] });
    const appt = await p.createAppointment(cita);
    expect(appt.start).toBe(cita.start);
  });

  it("RESPALDO: con Google caído (lista vacía) se agenda igual", async () => {
    const p = new NativeSchedulingProvider({ ...DATOS, externalBusy: async () => [] });
    await expect(p.createAppointment(cita)).resolves.toBeTruthy();
  });

  it("sin el gancho, el comportamiento es el de antes", async () => {
    const p = new NativeSchedulingProvider(DATOS);
    await expect(p.createAppointment(cita)).resolves.toBeTruthy();
  });

  it("la cita propia en Google NO se bloquea a sí misma al reagendar", async () => {
    // Caso completo: el evento que vive en Google es el de ESTA cita. `googleEventsToBusy` lo
    // descarta, así que la re-verificación no encuentra choque y el reagendamiento procede.
    const propio = evento({ extendedProperties: { private: { conversiaAppointmentId: "appt_1" } }, start: { dateTime: cita.start }, end: { dateTime: cita.end } });
    const p = new NativeSchedulingProvider({ ...DATOS, externalBusy: async () => googleEventsToBusy([propio], { timeZone: TZ }) });
    await expect(p.createAppointment(cita)).resolves.toBeTruthy();
  });
});

describe("rendimiento: un tenant sin Google no paga nada", () => {
  it("sin el gancho no se intenta ninguna lectura", async () => {
    // Se prueba con un gancho que LANZA: si el proveedor lo llamara, el test se caería. Así
    // queda demostrado que `externalBusy: undefined` no cuesta ni una llamada — que es el
    // caso de todos los tenants de hoy.
    const explota = async () => {
      throw new Error("no debería llamarse");
    };
    const conGancho = new NativeSchedulingProvider({ ...DATOS, externalBusy: explota });
    await expect(conGancho.getAvailableSlots(CONSULTA)).rejects.toThrow("no debería llamarse");

    const sinGancho = new NativeSchedulingProvider(DATOS);
    await expect(sinGancho.getAvailableSlots(CONSULTA)).resolves.toBeTruthy();
    await expect(
      sinGancho.createAppointment({ clinicId: "c1", professionalId: "p1", patient: { firstName: "x", phone: "+5691" }, start: "2026-11-10T12:00:00-03:00", end: "2026-11-10T12:30:00-03:00" }),
    ).resolves.toBeTruthy();
  });
});
