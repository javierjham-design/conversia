/**
 * UN CALENDARIO POR PROFESIONAL (Etapa 1).
 *
 * Hasta ahora había UN calendario por cuenta: en una barbería con 3 barberos las citas de los
 * tres caían en el mismo calendario, así que ninguno podía ver "su" día en su teléfono y no
 * había forma de leer las horas ocupadas de cada uno (lo que necesita la Etapa 2).
 *
 * Forma en `integration_connections.config` del proveedor `google`:
 *
 *   {
 *     calendarId: "local@gmail.com",      // ← el de SIEMPRE: pasa a ser "calendario del negocio"
 *     calendarSync: true,                 // ← el de SIEMPRE: interruptor del espejo
 *     calendarReadBusy: true,             // ← nuevo: el del negocio bloquea a TODOS (feriados, cierre)
 *     calendars: {                        // ← nuevo: uno por profesional
 *       "<professionalId>": { calendarId: "barbero1@gmail.com", readBusy: true, writeEvents: true }
 *     }
 *   }
 *
 * ⚠️ REGRESIÓN: una config vieja (solo `calendarId` + `calendarSync`) tiene que seguir
 * comportándose EXACTAMENTE igual. Todo lo nuevo es opcional y, sin `calendars`, cada cita va
 * al calendario del negocio igual que antes. Las cuentas de TuBot que ya están andando no
 * reconectan ni reconfiguran nada.
 *
 * Todo acá es PURO: lo usan la api (validar y mostrar) y el worker (escribir), y una
 * diferencia entre los dos manda la cita al calendario equivocado.
 */

export interface ProfessionalCalendar {
  calendarId: string;
  /** Leer sus horas ocupadas para no ofrecerlas (lo consume la Etapa 2). */
  readBusy: boolean;
  /** Crear/actualizar en Google las citas de este profesional. */
  writeEvents: boolean;
}

export interface GoogleCalendarConfig {
  /** Calendario del NEGOCIO: respaldo de los profesionales sin calendario propio. */
  businessCalendarId: string;
  /** Interruptor general del espejo (el `calendarSync` de siempre). */
  calendarSync: boolean;
  /** El calendario del negocio bloquea a todos (feriados, cierre del local). */
  businessReadBusy: boolean;
  calendars: Record<string, ProfessionalCalendar>;
}

export const GOOGLE_CALENDAR_CONFIG_VACIA: GoogleCalendarConfig = {
  businessCalendarId: "",
  calendarSync: false,
  businessReadBusy: false,
  calendars: {},
};

/** Tope defensivo: un `calendars` gigante vendría de un cliente manipulado, no de la UI. */
const MAX_CALENDARIOS = 200;

/**
 * Lee la config sin confiar en ella. Tolerante a propósito: la escribe una pantalla y un
 * campo raro NO puede dejar al tenant sin espejo. Lo que no se reconoce se descarta.
 */
export function parseGoogleCalendarConfig(config: unknown): GoogleCalendarConfig {
  if (!config || typeof config !== "object") return GOOGLE_CALENDAR_CONFIG_VACIA;
  const o = config as Record<string, unknown>;
  const calendars: Record<string, ProfessionalCalendar> = {};
  const raw = o.calendars;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [proId, v] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_CALENDARIOS)) {
      if (!v || typeof v !== "object") continue;
      const e = v as Record<string, unknown>;
      const calendarId = typeof e.calendarId === "string" ? e.calendarId.trim() : "";
      if (!calendarId) continue; // sin calendario no hay vínculo que guardar
      calendars[proId] = {
        calendarId,
        // Por defecto SÍ: es lo que el dueño espera al vincular un calendario, y es lo que
        // deja activado el asistente de la Etapa 4.
        readBusy: e.readBusy !== false,
        writeEvents: e.writeEvents !== false,
      };
    }
  }
  return {
    businessCalendarId: typeof o.calendarId === "string" ? o.calendarId.trim() : "",
    calendarSync: Boolean(o.calendarSync),
    businessReadBusy: Boolean(o.calendarReadBusy),
    calendars,
  };
}

export type CalendarOrigen = "profesional" | "negocio" | "ninguno";

/**
 * A qué calendario va UNA cita. El del profesional manda; si no tiene, el del negocio
 * (comportamiento de siempre). `origen: "ninguno"` = no hay dónde escribir.
 *
 * `writeEvents: false` en el profesional significa "este barbero NO quiere que le creemos
 * citas en su calendario" — y entonces tampoco se cae al del negocio: eso sería escribirle
 * la cita en otro lado, que es justo lo que pidió que no hagamos.
 */
export function calendarForProfessional(
  cfg: GoogleCalendarConfig,
  professionalId: string | null | undefined,
): { calendarId: string; origen: CalendarOrigen } {
  const propio = professionalId ? cfg.calendars[professionalId] : undefined;
  if (propio) {
    return propio.writeEvents ? { calendarId: propio.calendarId, origen: "profesional" } : { calendarId: "", origen: "ninguno" };
  }
  return cfg.businessCalendarId ? { calendarId: cfg.businessCalendarId, origen: "negocio" } : { calendarId: "", origen: "ninguno" };
}

/**
 * Calendarios cuyas horas ocupadas hay que respetar para este profesional (lo consume la
 * Etapa 2): el suyo si lo marcó, más el del negocio si está marcado (feriados y cierre
 * bloquean a todos). Sin repetidos, porque un profesional puede apuntar al del negocio.
 */
export function calendarsToReadBusy(cfg: GoogleCalendarConfig, professionalId: string | null | undefined): string[] {
  const out: string[] = [];
  const propio = professionalId ? cfg.calendars[professionalId] : undefined;
  if (propio?.readBusy && propio.calendarId) out.push(propio.calendarId);
  if (cfg.businessReadBusy && cfg.businessCalendarId) out.push(cfg.businessCalendarId);
  return [...new Set(out)];
}

/** Todos los calendarios vinculados (del negocio + de cada profesional), sin repetidos. */
export function linkedCalendarIds(cfg: GoogleCalendarConfig): string[] {
  const ids = [cfg.businessCalendarId, ...Object.values(cfg.calendars).map((c) => c.calendarId)].filter(Boolean);
  return [...new Set(ids)];
}
