import { withTenant } from "@conversia/database";
import { brandOf, resolvePersonalization } from "@conversia/config";
import { getFreshOAuthToken, NoConnectionError, ReauthorizeError } from "./oauth-tokens.js";

/**
 * Google Calendar v1: espejo Conversia → Google. Cada cita creada/actualizada
 * en Conversia se refleja como evento en el calendario elegido por el tenant
 * (config.calendarId). El id del evento se guarda en appointment.meta.googleEventId
 * para actualizar/cancelar sin duplicar. La dirección Google → Conversia queda
 * detrás de un flag (config.bidirectional) aún sin implementación.
 */

const GCAL = "https://www.googleapis.com/calendar/v3";

interface CalendarConfig {
  calendarId: string;
  calendarSync: boolean;
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

async function getCalendarConfig(organizationId: string): Promise<CalendarConfig | null> {
  return withTenant(organizationId, async (tx) => {
    const conn = await tx.integrationConnection.findFirst({ where: { organizationId, provider: "google" } });
    if (!conn) return null;
    const cfg = (conn.config as Record<string, any>) ?? {};
    if (!cfg.calendarSync || !cfg.calendarId) return null;
    return { calendarId: String(cfg.calendarId), calendarSync: true };
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
  const calendarBase = `${GCAL}/calendars/${encodeURIComponent(config.calendarId)}/events`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const log = (status: "ok" | "error", message: string) =>
    withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: { organizationId, provider: "google", type: status === "ok" ? "calendar.synced" : "calendar.error", status, message },
      }),
    ).catch(() => undefined);

  if (payload.action === "cancel") {
    if (!eventId) return; // nunca llegó a Google
    const res = await fetch(`${calendarBase}/${encodeURIComponent(eventId)}`, { method: "DELETE", headers, signal: AbortSignal.timeout(10_000) });
    // 404/410: ya no existe en Google — objetivo cumplido.
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      await log("error", `Google Calendar respondió ${res.status} al cancelar`);
      throw new Error(`gcal delete ${res.status}`);
    }
    await log("ok", "Cita cancelada en Google Calendar");
    return;
  }

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

  const res = eventId
    ? await fetch(`${calendarBase}/${encodeURIComponent(eventId)}`, { method: "PATCH", headers, body, signal: AbortSignal.timeout(10_000) })
    : await fetch(calendarBase, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });

  if (res.status === 404 && eventId) {
    // El evento fue borrado a mano en Google: recrear.
    const retry = await fetch(calendarBase, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    if (!retry.ok) {
      await log("error", `Google Calendar respondió ${retry.status} al recrear`);
      throw new Error(`gcal recreate ${retry.status}`);
    }
    const created: any = await retry.json();
    await saveEventId(organizationId, appt.id, meta, created.id);
    await log("ok", "Cita recreada en Google Calendar");
    return;
  }
  if (!res.ok) {
    await log("error", `Google Calendar respondió ${res.status}`);
    throw new Error(`gcal ${res.status}`);
  }
  const event: any = await res.json();
  if (!eventId && event?.id) await saveEventId(organizationId, appt.id, meta, event.id);
  await withTenant(organizationId, (tx) =>
    tx.integrationConnection.updateMany({ where: { organizationId, provider: "google" }, data: { lastSyncAt: new Date() } }),
  ).catch(() => undefined);
  await log("ok", eventId ? "Cita actualizada en Google Calendar" : "Cita creada en Google Calendar");
}

async function saveEventId(organizationId: string, appointmentId: string, meta: Record<string, any>, googleEventId: string): Promise<void> {
  await withTenant(organizationId, (tx) =>
    tx.appointment.update({ where: { id: appointmentId }, data: { meta: { ...meta, googleEventId } as object } }),
  );
}
