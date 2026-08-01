import { withTenant } from "@conversia/database";
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

async function getCalendarConfig(organizationId: string): Promise<CalendarConfig | null> {
  return withTenant(organizationId, async (tx) => {
    const conn = await tx.integrationConnection.findFirst({ where: { provider: "google" } });
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

  const appt = await withTenant(organizationId, (tx) =>
    tx.appointment.findUnique({ where: { id: payload.appointmentId }, include: { contact: true } }),
  );
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

  const contactName = [appt.contact?.firstName, appt.contact?.lastName].filter(Boolean).join(" ") || "Paciente";
  const body = JSON.stringify({
    summary: `Cita: ${contactName}`,
    description: [appt.notes, appt.contact?.phone ? `Tel: ${appt.contact.phone}` : null, "Creada por TuBot"].filter(Boolean).join("\n"),
    start: { dateTime: appt.startsAt.toISOString(), timeZone: appt.timezone },
    end: { dateTime: appt.endsAt.toISOString(), timeZone: appt.timezone },
    ...(appt.status === "CANCELLED" ? { status: "cancelled" } : {}),
  });

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
    tx.integrationConnection.updateMany({ where: { provider: "google" }, data: { lastSyncAt: new Date() } }),
  ).catch(() => undefined);
  await log("ok", eventId ? "Cita actualizada en Google Calendar" : "Cita creada en Google Calendar");
}

async function saveEventId(organizationId: string, appointmentId: string, meta: Record<string, any>, googleEventId: string): Promise<void> {
  await withTenant(organizationId, (tx) =>
    tx.appointment.update({ where: { id: appointmentId }, data: { meta: { ...meta, googleEventId } as object } }),
  );
}
