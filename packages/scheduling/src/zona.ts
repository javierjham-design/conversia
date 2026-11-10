/**
 * HORA OFICIAL DE CHILE — una sola fuente para "qué offset rige tal día".
 *
 * Brecha que cierra: la agenda armaba las horas con un offset FIJO "-04:00". Chile cambia
 * de hora —rige -04:00 en invierno y -03:00 desde septiembre hasta abril—, así que durante
 * medio año un negocio abierto de 09:00 a 19:00 recibía ofertas de 10:00 a 20:00: el bot
 * ofrecía una hora en la que el local está cerrado y no ofrecía la primera del día. En
 * invierno el error desaparecía solo, y por eso nadie lo vio.
 *
 * La regla: el offset NO es un ajuste de la cuenta, es una CONSECUENCIA de la zona horaria
 * y de la fecha. Por eso se calcula por DÍA y nunca por consulta: un rango de una semana
 * puede cruzar el cambio de hora, y entonces cada día tiene el suyo.
 *
 * Quien manda es `organizations.timezone` (zona IANA, "America/Santiago" por defecto). Las
 * reglas del cambio de hora las mantiene la zona del sistema vía `Intl` —el mismo que el
 * repo ya usa en producción para escribirle la hora al cliente—, no una tabla nuestra: si
 * Chile vuelve a mover la fecha del cambio por decreto, esto sigue correcto sin tocar código.
 */

/** Zona por defecto: la de todas las cuentas de hoy. `organizations.timezone` manda sobre esto. */
export const ZONA_POR_DEFECTO = "America/Santiago";

/**
 * Offset real de una zona IANA en una fecha ("America/Santiago", "2026-11-10" → "-03:00").
 *
 * Si la zona no se reconoce cae a UTC en vez de tirar una excepción: este cálculo está en el
 * camino del bot, y quedarse MUDO es peor que ofrecer una hora corrida.
 */
export function offsetForZoneOnDate(timeZone: string, date: string): string {
  try {
    const d = new Date(`${date}T12:00:00Z`);
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(d);
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    const m = /GMT([+-]\d{2}:\d{2})/.exec(name);
    if (m) return m[1];
    if (/^GMT$/.test(name)) return "+00:00"; // Londres en invierno
    return "+00:00";
  } catch {
    return "+00:00";
  }
}

/**
 * Qué día es HOY en esa zona ("YYYY-MM-DD").
 *
 * No es lo mismo que el día en UTC: a las 22:30 de Chile en UTC ya es mañana, y un rango
 * que arranque "hoy" calculado en UTC se salta las citas de esta tarde.
 */
export function fechaEnZona(timeZone: string, when: Date | number = Date.now()): string {
  const d = typeof when === "number" ? new Date(when) : when;
  try {
    // "en-CA" entrega YYYY-MM-DD, que es justo el formato que se necesita.
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** Instante en que empieza esa fecha local ("YYYY-MM-DD") en esa zona. */
export function inicioDeFechaEnZona(timeZone: string, fecha: string): Date {
  return new Date(`${fecha}T00:00:00${offsetForZoneOnDate(timeZone, fecha)}`);
}

/** Instante en que empezó el día local del negocio (medianoche de hoy en esa zona). */
export function inicioDelDiaEnZona(timeZone: string, when: Date | number = Date.now()): Date {
  return inicioDeFechaEnZona(timeZone, fechaEnZona(timeZone, when));
}

/**
 * Fecha local corrida N días ("2026-04-05" + 1 = "2026-04-06").
 *
 * Suma días de CALENDARIO, no 24 horas: el día del cambio de hora dura 23 o 25, y sumarle
 * 86.400.000 ms a la medianoche cae una hora antes o después del día siguiente.
 */
export function fechaDesplazada(fecha: string, dias: number): string {
  return new Date(Date.parse(`${fecha}T12:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
}
