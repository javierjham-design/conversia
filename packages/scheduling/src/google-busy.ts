import type { BusyInterval } from "./availability";
import { offsetForZoneOnDate } from "./zona";

/**
 * HORAS OCUPADAS EN GOOGLE CALENDAR (Etapa 2).
 *
 * Brecha que cierra: si el barbero tenía algo en su Google Calendar, el bot ofrecía esa hora
 * igual. El dueño agendaba su vida en Google y TuBot la pisaba.
 *
 * Diseño: la conversión de eventos a intervalos ocupados es PURA y la parte de red recibe
 * sus dependencias (token, caché, fetch) por parámetro. Así el worker y la api comparten
 * EXACTAMENTE la misma lógica —una diferencia entre los dos haría que el panel y el bot
 * ofrezcan horas distintas— y se puede probar sin red y sin Redis.
 *
 * Regla de oro: **si Google falla, el bot NO se bloquea.** Devolvemos lista vacía y se calcula
 * con la agenda nativa. Perder una hora ocupada es molesto; dejar al bot mudo es perder al
 * cliente.
 */

/** Lo que nos interesa de un evento de `events.list`. */
export interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: { private?: Record<string, string> };
}

/**
 * "YYYY-MM-DD" + offset → instante ISO del comienzo de ese día local.
 *
 * Hace falta para los eventos de DÍA COMPLETO: Google los manda como fechas sin hora, y
 * "bloquea el 10 de noviembre" significa distinto en Santiago que en UTC. El offset sale de
 * `zona.ts`, que es quien sabe la hora oficial de cada día.
 */
function startOfDayISO(date: string, timeZone: string): string {
  return new Date(`${date}T00:00:00${offsetForZoneOnDate(timeZone, date)}`).toISOString();
}

/**
 * Eventos de Google → intervalos ocupados (PURO).
 *
 * Qué se IGNORA y por qué:
 * - `status: "cancelled"`: el evento ya no existe.
 * - `transparency: "transparent"`: es lo que Google llama "Disponible". El dueño marcó
 *   explícitamente que esa hora no lo ocupa.
 * - **Los eventos que creamos nosotros** (`extendedProperties.private.conversiaAppointmentId`):
 *   esa cita YA está en `busy` desde la base de datos. Contarla dos veces no cambia nada…
 *   salvo al REAGENDAR, donde la cita se bloquearía A SÍ MISMA y el bot diría que no hay
 *   horas justo en el hueco que acaba de liberar.
 * - Eventos sin horas utilizables (datos raros de la API).
 */
export function googleEventsToBusy(events: GoogleEvent[], opts: { timeZone: string }): BusyInterval[] {
  const out: BusyInterval[] = [];
  for (const ev of events ?? []) {
    if (!ev || ev.status === "cancelled") continue;
    if (ev.transparency === "transparent") continue;
    if (ev.extendedProperties?.private?.conversiaAppointmentId) continue;

    const sd = ev.start?.dateTime;
    const ed = ev.end?.dateTime;
    if (sd && ed) {
      const s = new Date(sd);
      const e = new Date(ed);
      if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime()) || e <= s) continue;
      out.push({ start: s.toISOString(), end: e.toISOString() });
      continue;
    }

    // Día completo: `end.date` es EXCLUSIVO en Google (un día suelto va de D a D+1).
    const sdate = ev.start?.date;
    const edate = ev.end?.date;
    if (sdate) {
      const zona = ev.start?.timeZone || opts.timeZone;
      const start = startOfDayISO(sdate, zona);
      const end = edate ? startOfDayISO(edate, zona) : new Date(new Date(start).getTime() + 24 * 3600 * 1000).toISOString();
      if (new Date(end) > new Date(start)) out.push({ start, end });
    }
  }
  return out;
}

/** Dependencias de la parte con red. Todo inyectable para poder probarlo sin Google. */
export interface GoogleBusyDeps {
  /** Access token vigente (lo refresca quien corresponda: api u worker). */
  token: () => Promise<string>;
  /** Caché compartida (Redis). Opcional: sin ella se consulta siempre. */
  cache?: { get(key: string): Promise<string | null>; set(key: string, value: string, ttlSec: number): Promise<void> };
  /** Prefijo de la caché: la cuenta, para no cruzar tenants. */
  cacheScope?: string;
  /** Se llama con el detalle cuando Google falla (para registrar el error en el panel). */
  onError?: (detail: string) => void;
  fetchImpl?: typeof fetch;
  /** Tope por llamada. 3 s: el bot no puede esperar más que eso por una hora ocupada. */
  timeoutMs?: number;
  cacheTtlSec?: number;
  /** TTL del marcador de error: durante una caída de Google no se reintenta en cada turno. */
  errorTtlSec?: number;
}

const MARCA_ERROR = "ERR";

/** Clave de caché por (cuenta, calendario, rango). */
export function busyCacheKey(scope: string, calendarId: string, timeMin: string, timeMax: string): string {
  return `conversia:gcal:busy:${scope}:${calendarId}:${timeMin}:${timeMax}`;
}

/**
 * Horas ocupadas de UN calendario en un rango. **Nunca lanza.**
 *
 * `noCache` lo usa la re-verificación de antes de confirmar: ahí no se puede contestar con
 * datos de hasta 90 s, porque justo en esos 90 s es cuando el dueño ocupó la hora.
 */
export async function fetchCalendarBusy(
  calendarId: string,
  range: { timeMin: string; timeMax: string },
  timeZone: string,
  deps: GoogleBusyDeps,
  opts?: { noCache?: boolean },
): Promise<BusyInterval[]> {
  const f = deps.fetchImpl ?? fetch;
  const key = busyCacheKey(deps.cacheScope ?? "org", calendarId, range.timeMin, range.timeMax);
  const usarCache = !opts?.noCache && deps.cache;

  if (usarCache) {
    try {
      const hit = await deps.cache!.get(key);
      if (hit === MARCA_ERROR) return []; // Google está caído: no insistir en cada turno
      if (hit) return JSON.parse(hit) as BusyInterval[];
    } catch {
      /* caché ilegible o Redis caído: se consulta a Google */
    }
  }

  const guardarError = async (detail: string) => {
    deps.onError?.(detail);
    if (deps.cache) {
      await deps.cache.set(key, MARCA_ERROR, deps.errorTtlSec ?? 30).catch(() => undefined);
    }
  };

  try {
    const url =
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events` +
      `?singleEvents=true&orderBy=startTime&maxResults=250` +
      `&timeMin=${encodeURIComponent(range.timeMin)}&timeMax=${encodeURIComponent(range.timeMax)}`;
    const token = await deps.token();
    const res = await f(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(deps.timeoutMs ?? 3_000) });
    if (!res.ok) {
      await guardarError(`Google Calendar respondió ${res.status} al leer ${calendarId}`);
      return [];
    }
    const data = (await res.json()) as { items?: GoogleEvent[] };
    const busy = googleEventsToBusy(data.items ?? [], { timeZone });
    if (deps.cache && !opts?.noCache) {
      await deps.cache.set(key, JSON.stringify(busy), deps.cacheTtlSec ?? 90).catch(() => undefined);
    }
    return busy;
  } catch (err) {
    // Timeout, red caída, token revocado: la agenda nativa sigue funcionando sola.
    await guardarError(`No se pudo leer ${calendarId}: ${(err as Error)?.message?.slice(0, 120) ?? "error"}`);
    return [];
  }
}

/** Varios calendarios en paralelo, con los resultados unidos. Nunca lanza. */
export async function fetchBusyForCalendars(
  calendarIds: string[],
  range: { timeMin: string; timeMax: string },
  timeZone: string,
  deps: GoogleBusyDeps,
  opts?: { noCache?: boolean },
): Promise<BusyInterval[]> {
  if (!calendarIds.length) return [];
  const listas = await Promise.all(calendarIds.map((id) => fetchCalendarBusy(id, range, timeZone, deps, opts)));
  return listas.flat();
}

/**
 * Arma el gancho `externalBusy` del proveedor nativo.
 *
 * Vive acá (y no en el worker ni en la api) para que los dos usen el MISMO camino: si el bot
 * y el panel calcularan las horas ocupadas distinto, el dueño vería huecos que el bot no
 * ofrece. Recibe `calendarsFor` como función —en vez del tipo de la config— para que este
 * paquete no tenga que depender de `@conversia/config`.
 */
export function makeExternalBusy(opts: {
  /** Qué calendarios respetar para un profesional (del propio + el del negocio). */
  calendarsFor: (professionalId: string) => string[];
  timeZone: string;
  deps: GoogleBusyDeps;
}): (q: { professionalId: string; from: string; to: string; noCache?: boolean }) => Promise<BusyInterval[]> {
  return async (q) => {
    const ids = opts.calendarsFor(q.professionalId);
    if (!ids.length) return [];
    const range = rangeForDates(q.from, q.to, opts.timeZone);
    return fetchBusyForCalendars(ids, range, opts.timeZone, opts.deps, { noCache: q.noCache });
  };
}

/** Rango que se le pide a Google desde un rango de fechas de la agenda ("YYYY-MM-DD"). */
export function rangeForDates(fromDate: string, toDate: string, timeZone: string): { timeMin: string; timeMax: string } {
  const timeMin = startOfDayISO(fromDate, timeZone);
  // `toDate` es inclusivo en la agenda, así que se pide hasta el final de ese día.
  const finDelDia = new Date(new Date(startOfDayISO(toDate, timeZone)).getTime() + 24 * 3600 * 1000);
  return { timeMin, timeMax: finDelDia.toISOString() };
}
