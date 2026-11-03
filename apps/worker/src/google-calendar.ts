import { withTenant } from "@conversia/database";
import {
  brandOf,
  calendarForProfessional,
  parseGoogleCalendarConfig,
  resolvePersonalization,
  type GoogleCalendarConfig,
} from "@conversia/config";
import { getFreshOAuthToken, NoConnectionError, ReauthorizeError } from "./oauth-tokens.js";

/**
 * Espejo Conversia → Google. Cada cita creada/actualizada en Conversia se refleja como evento
 * en Google, **en el calendario de SU profesional** (Etapa 1) o, si no tiene uno propio, en el
 * calendario del negocio — que es el comportamiento de siempre.
 *
 * En `appointment.meta` se guardan DOS cosas: `googleEventId` (para actualizar y cancelar sin
 * duplicar) y `googleCalendarId` (DÓNDE quedó). Sin lo segundo, cambiarle el profesional a una
 * cita dejaba el evento vivo en el calendario del barbero anterior.
 */

const GCAL = "https://www.googleapis.com/calendar/v3";

/**
 * Plan de escritura de UN evento (puro, testeable).
 *
 * El caso difícil es CAMBIAR el profesional de una cita: el evento vive en el calendario del
 * barbero anterior y hay que borrarlo de ahí y crearlo en el del nuevo. Si solo se hiciera
 * PATCH en el calendario nuevo, Google contestaría 404 (el evento no existe ahí) y la cita
 * quedaría duplicada: viva en el calendario viejo y recreada en el nuevo.
 */
export function planCalendarWrite(input: {
  eventId?: string;
  /** Calendario donde quedó el evento la última vez (meta.googleCalendarId). */
  previousCalendarId?: string;
  targetCalendarId: string;
}): { accion: "crear" | "actualizar" | "mover"; escribirEn: string; borrarDe?: string } {
  if (!input.eventId) return { accion: "crear", escribirEn: input.targetCalendarId };
  // Sin `previousCalendarId` (citas espejadas antes de la Etapa 1) se asume que está en el
  // calendario de destino: para esas cuentas había UN solo calendario, así que es cierto.
  const anterior = input.previousCalendarId || input.targetCalendarId;
  if (anterior === input.targetCalendarId) return { accion: "actualizar", escribirEn: input.targetCalendarId };
  return { accion: "mover", escribirEn: input.targetCalendarId, borrarDe: anterior };
}

/** Lo que hace falta para armar el evento. Pura a propósito: se prueba sin red ni BD. */
export interface CalendarEventInput {
  appointmentId: string;
  contactName: string | null;
  serviceName: string | null;
  notes: string | null;
  phone: string | null;
  /** Términos del rubro: `contact` ("Paciente"/"Cliente"…) y `appointment` ("Cita"/"Reserva"…). */
  vocabulary: { contact?: string; appointment?: string };
  /** Nombre de la MARCA de la org (TuBot / Conversia), no un literal. */
  brandName: string;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  cancelled: boolean;
}

/**
 * Texto del evento de Google Calendar.
 *
 * Antes estaba fijo: "Cita: {nombre}", con "Paciente" cuando no había nombre y "Creada por
 * TuBot" en la descripción. En una barbería no corresponde "Paciente" y en Conversia no
 * corresponde "TuBot" — el cliente final lee esto en su teléfono.
 *
 * `extendedProperties.private.conversiaAppointmentId` marca los eventos que creamos
 * nosotros. Es la pieza que habilita las etapas siguientes: permite NO contar nuestra propia
 * cita como hora ocupada (si no, al reagendar se bloquearía a sí misma) y distinguir, en el
 * sondeo de cambios, lo nuestro de los eventos personales del dueño.
 */
export function buildCalendarEvent(i: CalendarEventInput): Record<string, unknown> {
  const termCliente = (i.vocabulary.contact || "Cliente").trim();
  const termCita = (i.vocabulary.appointment || "Cita").trim();
  const nombre = (i.contactName || "").trim() || termCliente;
  const servicio = (i.serviceName || "").trim();
  return {
    summary: `${servicio || termCita} · ${nombre}`,
    description: [i.notes, i.phone ? `Tel: ${i.phone}` : null, `Agendada por ${i.brandName}`].filter(Boolean).join("\n"),
    start: { dateTime: i.startsAt.toISOString(), timeZone: i.timezone },
    end: { dateTime: i.endsAt.toISOString(), timeZone: i.timezone },
    extendedProperties: { private: { conversiaAppointmentId: i.appointmentId } },
    ...(i.cancelled ? { status: "cancelled" } : {}),
  };
}

/**
 * ¿Hay espejo que hacer? Sigue exigiendo `calendarSync`, pero ahora alcanza con tener ALGÚN
 * calendario: el del negocio (como siempre) o al menos uno por profesional. Una barbería
 * puede vincular el calendario de cada barbero y ninguno del negocio.
 */
export function hayDondeEscribir(cfg: GoogleCalendarConfig): boolean {
  return cfg.calendarSync && Boolean(cfg.businessCalendarId || Object.keys(cfg.calendars).length);
}

async function getCalendarConfig(organizationId: string): Promise<GoogleCalendarConfig | null> {
  return withTenant(organizationId, async (tx) => {
    const conn = await tx.integrationConnection.findFirst({ where: { organizationId, provider: "google" } });
    if (!conn) return null;
    const cfg = parseGoogleCalendarConfig(conn.config);
    return hayDondeEscribir(cfg) ? cfg : null;
  });
}

/** Encola el espejo a Google si el tenant lo tiene activo (barato: 1 query). */
export async function enqueueCalendarSync(organizationId: string, appointmentId: string, action: "upsert" | "cancel"): Promise<void> {
  try {
    const config = await getCalendarConfig(organizationId);
    if (!config) return;
    const { getSyncQueue } = await import("./ga4.js");
    await getSyncQueue().add(
      "calendar",
      { organizationId, kind: "calendar_sync", payload: { appointmentId, action } },
      { attempts: 5, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000 },
    );
  } catch (err) {
    console.error("✖ enqueueCalendarSync:", (err as Error).message);
  }
}

/** Procesa un job calendar_sync. Lanza en errores transitorios → BullMQ reintenta. */
export async function syncAppointmentToGoogle(
  organizationId: string,
  payload: { appointmentId: string; action: "upsert" | "cancel" },
): Promise<void> {
  const config = await getCalendarConfig(organizationId);
  if (!config) return; // desconectado o sync apagado entre encolar y procesar

  let token: string;
  try {
    token = await getFreshOAuthToken(organizationId, "google");
  } catch (err) {
    if (err instanceof NoConnectionError || err instanceof ReauthorizeError) return; // reintento inútil
    throw err;
  }

  const { appt, org, serviceName } = await withTenant(organizationId, async (tx) => {
    const appt = await tx.appointment.findUnique({ where: { id: payload.appointmentId }, include: { contact: true } });
    if (!appt) return { appt: null, org: null, serviceName: null };
    const [org, service] = await Promise.all([
      tx.organization.findUnique({ where: { id: organizationId }, select: { brand: true, settings: true } }),
      appt.serviceId ? tx.service.findUnique({ where: { id: appt.serviceId }, select: { name: true } }) : Promise.resolve(null),
    ]);
    return { appt, org, serviceName: service?.name ?? null };
  });
  if (!appt) return;
  const meta = (appt.meta as Record<string, any>) ?? {};
  const eventId: string | undefined = meta.googleEventId;
  const previousCalendarId: string | undefined = meta.googleCalendarId;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const eventsUrl = (calendarId: string) => `${GCAL}/calendars/${encodeURIComponent(calendarId)}/events`;

  const log = (status: "ok" | "error", message: string) =>
    withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: { organizationId, provider: "google", type: status === "ok" ? "calendar.synced" : "calendar.error", status, message },
      }),
    ).catch(() => undefined);

  /** DELETE de un evento. 404/410 = ya no está: objetivo cumplido. Devuelve si hay que reintentar. */
  const borrarEvento = async (calendarId: string, id: string): Promise<{ ok: boolean; status: number }> => {
    const res = await fetch(`${eventsUrl(calendarId)}/${encodeURIComponent(id)}`, { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) });
    return { ok: res.ok || res.status === 404 || res.status === 410, status: res.status };
  };

  if (payload.action === "cancel") {
    if (!eventId) return; // nunca llegó a Google
    // Se borra DONDE QUEDÓ, no donde iría hoy: si le cambiaron el profesional y después la
    // cancelaron, el evento vive en el calendario anterior.
    const donde = previousCalendarId || calendarForProfessional(config, appt.professionalId).calendarId;
    if (!donde) return;
    const r = await borrarEvento(donde, eventId);
    if (!r.ok) {
      await log("error", `Google Calendar respondió ${r.status} al cancelar`);
      throw new Error(`gcal delete ${r.status}`);
    }
    await log("ok", "Cita cancelada en Google Calendar");
    return;
  }

  // A qué calendario va esta cita: el de SU profesional o el del negocio.
  const destino = calendarForProfessional(config, appt.professionalId);
  if (!destino.calendarId) {
    // El profesional pidió que no le creemos citas (writeEvents: false) o no hay calendario
    // del negocio donde caer. No es un error: es la configuración del tenant.
    return;
  }
  const plan = planCalendarWrite({ eventId, previousCalendarId, targetCalendarId: destino.calendarId });
  const calendarBase = eventsUrl(plan.escribirEn);

  const { vocabulary } = resolvePersonalization((org?.settings as Record<string, any> | null) ?? null);
  const body = JSON.stringify(
    buildCalendarEvent({
      appointmentId: appt.id,
      contactName: [appt.contact?.firstName, appt.contact?.lastName].filter(Boolean).join(" ") || null,
      // El nombre del servicio sale de la tabla y, si la cita no lo tiene vinculado, de meta
      // (el bot y los webhooks no siempre escriben `serviceId`).
      serviceName: serviceName ?? ((meta.serviceName as string | undefined) ?? null),
      notes: appt.notes,
      phone: appt.contact?.phone ?? null,
      vocabulary,
      brandName: brandOf(org).name,
      startsAt: appt.startsAt,
      endsAt: appt.endsAt,
      timezone: appt.timezone,
      cancelled: appt.status === "CANCELLED",
    }),
  );

  // MOVER: le cambiaron el profesional, así que el evento vive en otro calendario. Se borra
  // de allá ANTES de crearlo acá; si el borrado falla de verdad (no 404/410) se corta y
  // BullMQ reintenta, porque crear primero dejaría la cita duplicada en dos calendarios.
  if (plan.accion === "mover" && plan.borrarDe && eventId) {
    const r = await borrarEvento(plan.borrarDe, eventId);
    if (!r.ok) {
      await log("error", `Google Calendar respondió ${r.status} al mover la cita de calendario`);
      throw new Error(`gcal move-delete ${r.status}`);
    }
  }

  // Tras un "mover" ya no hay evento que actualizar: se crea en el calendario nuevo.
  const idParaActualizar = plan.accion === "actualizar" ? eventId : undefined;
  const res = idParaActualizar
    ? await fetch(`${calendarBase}/${encodeURIComponent(idParaActualizar)}`, { method: "PATCH", headers, body, signal: AbortSignal.timeout(10_000) })
    : await fetch(calendarBase, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });

  if (res.status === 404 && idParaActualizar) {
    // El evento fue borrado a mano en Google: recrear.
    const retry = await fetch(calendarBase, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    if (!retry.ok) {
      await log("error", `Google Calendar respondió ${retry.status} al recrear`);
      throw new Error(`gcal recreate ${retry.status}`);
    }
    const created: any = await retry.json();
    await saveEventRef(organizationId, appt.id, meta, created.id, plan.escribirEn);
    await log("ok", "Cita recreada en Google Calendar");
    return;
  }
  if (!res.ok) {
    await log("error", `Google Calendar respondió ${res.status}`);
    throw new Error(`gcal ${res.status}`);
  }
  const event: any = await res.json();
  // Se guarda SIEMPRE la referencia (id + calendario), no solo al crear: una cita espejada
  // antes de la Etapa 1 no tiene `googleCalendarId` y sin esto nunca lo tendría, así que un
  // cambio de profesional posterior no sabría de dónde borrarla.
  if (event?.id) await saveEventRef(organizationId, appt.id, meta, event.id, plan.escribirEn);
  await withTenant(organizationId, (tx) =>
    tx.integrationConnection.updateMany({ where: { organizationId, provider: "google" }, data: { lastSyncAt: new Date() } }),
  ).catch(() => undefined);
  await log(
    "ok",
    plan.accion === "mover"
      ? `Cita movida al calendario ${destino.origen === "profesional" ? "del profesional" : "del negocio"}`
      : plan.accion === "actualizar"
        ? "Cita actualizada en Google Calendar"
        : "Cita creada en Google Calendar",
  );
}

/** Guarda DÓNDE quedó el evento: su id y su calendario. */
async function saveEventRef(
  organizationId: string,
  appointmentId: string,
  meta: Record<string, any>,
  googleEventId: string,
  googleCalendarId: string,
): Promise<void> {
  if (meta.googleEventId === googleEventId && meta.googleCalendarId === googleCalendarId) return; // nada que escribir
  await withTenant(organizationId, (tx) =>
    tx.appointment.update({ where: { id: appointmentId }, data: { meta: { ...meta, googleEventId, googleCalendarId } as object } }),
  );
}
