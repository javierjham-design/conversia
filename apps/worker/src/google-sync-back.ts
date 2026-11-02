import { canUseFeature, parseGoogleCalendarConfig, type GoogleCalendarConfig } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { getFreshOAuthToken, NoConnectionError, ReauthorizeError } from "./oauth-tokens.js";

/**
 * ETAPA 3 — los cambios hechos EN GOOGLE vuelven a Conversia.
 *
 * Qué resuelve: el dueño mueve una cita desde su teléfono y en el panel seguía la hora
 * vieja, así que el recordatorio salía con la hora equivocada y el cliente llegaba a otra
 * hora.
 *
 * POR QUÉ SONDEO Y NO `events.watch`: watch exige verificar el dominio del webhook ante
 * Google y renovar los canales antes de que caduquen; un canal vencido deja de avisar EN
 * SILENCIO y nadie se entera hasta que un cliente reclama. Un job cada 5 minutos con
 * `syncToken` trae lo mismo, se arregla solo si se cae y no depende de que Google pueda
 * alcanzarnos. ADR en docs/DECISIONS.md.
 *
 * SOLO SE PROCESA LO NUESTRO (eventos con `conversiaAppointmentId`). Los eventos personales
 * nuevos del dueño no se tocan: esos ya los cubre la lectura de horas ocupadas de la Etapa 2.
 *
 * ⚠️ ALCANCE: solo corre para orgs de la marca **conversia**. Las cuentas de TuBot que hoy
 * espejan a Google tienen que seguir funcionando EXACTAMENTE igual, y traer cambios desde
 * Google sería un comportamiento nuevo que nadie les pidió.
 */

const GCAL = "https://www.googleapis.com/calendar/v3";

export interface PulledEvent {
  id?: string;
  status?: string;
  updated?: string;
  etag?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  extendedProperties?: { private?: Record<string, string> };
}

/** Lo que sabemos de la cita antes de aplicar el cambio. */
export interface CitaConocida {
  id: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  /** `meta.googleUpdated`: el `updated` que devolvió Google en NUESTRA última escritura. */
  googleUpdated?: string;
}

export type Cambio =
  | { tipo: "ajeno" }
  | { tipo: "eco" }
  | { tipo: "sin-cambio" }
  | { tipo: "movida"; startsAt: Date; endsAt: Date }
  | { tipo: "eliminada" };

/**
 * Qué hacer con un evento que trajo el sondeo (PURO, testeable).
 *
 * - `ajeno`: no es nuestro (sin `conversiaAppointmentId`) o es de otra cita.
 * - `eco`: **es el rebote de nuestra propia escritura.** Sin esto se arma un bucle: nosotros
 *   escribimos en Google → el sondeo lo ve como "cambio" → actualiza la cita → el espejo
 *   vuelve a escribir en Google → y así. Se detecta comparando el `updated` que Google nos
 *   devolvió cuando escribimos.
 * - `movida` / `eliminada` / `sin-cambio`: lo demás.
 */
export function clasificarCambio(ev: PulledEvent, cita: CitaConocida | null, appointmentId?: string): Cambio {
  const marcado = ev.extendedProperties?.private?.conversiaAppointmentId;
  if (!marcado) return { tipo: "ajeno" };
  if (!cita || (appointmentId && appointmentId !== cita.id)) return { tipo: "ajeno" };

  if (ev.status === "cancelled") {
    // Ya la tenemos cancelada de nuestro lado: nada que avisar.
    return cita.status === "CANCELLED" ? { tipo: "sin-cambio" } : { tipo: "eliminada" };
  }

  // Eco de nuestra última escritura: el `updated` es exactamente el que guardamos.
  if (ev.updated && cita.googleUpdated && ev.updated === cita.googleUpdated) return { tipo: "eco" };

  const s = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
  const e = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
  if (!s || !e || !Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime()) || e <= s) return { tipo: "sin-cambio" };
  // Un evento nuestro convertido a día completo no se interpreta como hora: sin horas no se
  // puede mover una cita a ciegas.
  if (ev.start?.date && !ev.start?.dateTime) return { tipo: "sin-cambio" };

  const mismoInicio = Math.abs(s.getTime() - cita.startsAt.getTime()) < 60_000;
  const mismoFin = Math.abs(e.getTime() - cita.endsAt.getTime()) < 60_000;
  if (mismoInicio && mismoFin) return { tipo: "sin-cambio" };
  return { tipo: "movida", startsAt: s, endsAt: e };
}

/** Calendarios donde PUEDE haber citas nuestras (los que escribimos). */
export function calendariosConCitasNuestras(cfg: GoogleCalendarConfig): string[] {
  const ids = Object.values(cfg.calendars)
    .filter((c) => c.writeEvents && c.calendarId)
    .map((c) => c.calendarId);
  if (cfg.businessCalendarId) ids.push(cfg.businessCalendarId);
  return [...new Set(ids)];
}

/** Ventana inicial (y de recuperación tras un 410): de hoy a +60 días. */
export function ventanaInicial(now = new Date()): { timeMin: string; timeMax: string } {
  const timeMin = new Date(now.getTime() - 24 * 3600 * 1000); // un día atrás: citas de hoy ya pasadas
  return { timeMin: timeMin.toISOString(), timeMax: new Date(now.getTime() + 60 * 24 * 3600 * 1000).toISOString() };
}

export interface PullResult {
  calendarId: string;
  revisados: number;
  movidas: number;
  eliminadas: number;
  reinicioPorToken: boolean;
  error?: string;
  nextSyncToken?: string;
}

/**
 * Trae los cambios de UN calendario y los aplica. Nunca lanza: un calendario roto no puede
 * frenar a los demás ni dejar el job en rojo para siempre.
 */
export async function pullCalendar(
  organizationId: string,
  calendarId: string,
  syncToken: string | undefined,
  deps: { token: () => Promise<string>; fetchImpl?: typeof fetch; now?: () => Date },
): Promise<PullResult> {
  const f = deps.fetchImpl ?? fetch;
  const out: PullResult = { calendarId, revisados: 0, movidas: 0, eliminadas: 0, reinicioPorToken: false };
  let token: string;
  try {
    token = await deps.token();
  } catch (err) {
    out.error = err instanceof NoConnectionError || err instanceof ReauthorizeError ? "conexión no disponible" : (err as Error).message?.slice(0, 160);
    return out;
  }

  const pedir = async (conToken?: string): Promise<Response> => {
    const qs = new URLSearchParams({ singleEvents: "true", maxResults: "250", showDeleted: "true" });
    if (conToken) qs.set("syncToken", conToken);
    else {
      const v = ventanaInicial(deps.now?.() ?? new Date());
      qs.set("timeMin", v.timeMin);
      qs.set("timeMax", v.timeMax);
    }
    return f(`${GCAL}/calendars/${encodeURIComponent(calendarId)}/events?${qs.toString()}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  };

  try {
    let res = await pedir(syncToken);
    if (res.status === 410 && syncToken) {
      // Token caducado: Google exige empezar de nuevo con una ventana.
      out.reinicioPorToken = true;
      res = await pedir(undefined);
    }
    if (!res.ok) {
      out.error = `Google respondió ${res.status}`;
      return out;
    }
    const data = (await res.json()) as { items?: PulledEvent[]; nextSyncToken?: string };
    out.nextSyncToken = data.nextSyncToken;
    for (const ev of data.items ?? []) {
      const appointmentId = ev.extendedProperties?.private?.conversiaAppointmentId;
      if (!appointmentId) continue; // evento personal del dueño: lo cubre la Etapa 2
      out.revisados++;
      const aplicado = await aplicarCambio(organizationId, appointmentId, ev);
      if (aplicado === "movida") out.movidas++;
      if (aplicado === "eliminada") out.eliminadas++;
    }
    return out;
  } catch (err) {
    out.error = (err as Error).message?.slice(0, 160) ?? "error";
    return out;
  }
}

/** Aplica UN cambio en la base. Devuelve qué se hizo. */
async function aplicarCambio(organizationId: string, appointmentId: string, ev: PulledEvent): Promise<Cambio["tipo"]> {
  const cita = await withTenant(organizationId, (tx) => tx.appointment.findUnique({ where: { id: appointmentId } }));
  if (!cita || cita.organizationId !== organizationId) return "ajeno";
  const meta = (cita.meta as Record<string, any>) ?? {};
  const cambio = clasificarCambio(ev, { id: cita.id, startsAt: cita.startsAt, endsAt: cita.endsAt, status: String(cita.status), googleUpdated: meta.googleUpdated }, appointmentId);

  if (cambio.tipo === "movida") {
    await withTenant(organizationId, async (tx) => {
      await tx.appointment.update({
        where: { id: cita.id },
        data: {
          startsAt: cambio.startsAt,
          endsAt: cambio.endsAt,
          // Se guarda el `updated` de ESTE cambio: así el espejo que sale a continuación no
          // se vuelve a interpretar como cambio de Google.
          meta: { ...meta, googleUpdated: ev.updated ?? null, googleChange: null } as object,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId,
          actorType: "system",
          action: "appointment.moved_in_google",
          entityType: "appointment",
          entityId: cita.id,
          before: { startsAt: cita.startsAt, endsAt: cita.endsAt } as object,
          after: { startsAt: cambio.startsAt, endsAt: cambio.endsAt, origen: "Google Calendar" } as object,
        },
      });
    });
    await avisarEnElPanel(organizationId, cita.id, "Cita movida desde Google Calendar", `La cita cambió a ${cambio.startsAt.toISOString()} porque se movió en Google Calendar.`);
    await reprogramarRecordatorios(organizationId, cita.externalId, cambio.startsAt, cita.contactId);
    return "movida";
  }

  if (cambio.tipo === "eliminada") {
    // NO se cancela la cita. Un borrado por error en Google no puede dejar a un cliente sin
    // su hora y sin aviso; queda marcada para que una persona decida.
    await withTenant(organizationId, async (tx) => {
      await tx.appointment.update({
        where: { id: cita.id },
        data: { meta: { ...meta, googleChange: { tipo: "eliminada_en_google", cuando: new Date().toISOString() } } as object },
      });
      await tx.auditLog.create({
        data: { organizationId, actorType: "system", action: "appointment.deleted_in_google", entityType: "appointment", entityId: cita.id, after: { origen: "Google Calendar" } as object },
      });
    });
    await avisarEnElPanel(organizationId, cita.id, "Revisar: cita eliminada en Google Calendar", "El evento se borró en Google pero la cita NO se canceló. Revísala en la Agenda y decide si cancelarla o volver a crearla en Google.");
    return "eliminada";
  }

  return cambio.tipo;
}

/** Aviso en la campana del panel para quienes administran la agenda. */
async function avisarEnElPanel(organizationId: string, appointmentId: string, title: string, body: string): Promise<void> {
  try {
    await withTenant(organizationId, async (tx) => {
      const users = await tx.organizationUser.findMany({ where: { organizationId, active: true }, select: { userId: true }, take: 20 });
      if (!users.length) return;
      await tx.notification.createMany({
        data: users.map((u: { userId: string }) => ({ organizationId, userId: u.userId, type: "agenda.google", title, body, meta: { appointmentId } as object })),
      });
    });
  } catch {
    /* el aviso no puede frenar el sondeo */
  }
}

/**
 * Los recordatorios se re-arman con la hora nueva. Sin esto, al mover la cita en Google el
 * paciente recibía el recordatorio con la hora VIEJA — el peor resultado posible: peor que
 * no avisar, porque lo manda a la hora equivocada.
 */
async function reprogramarRecordatorios(organizationId: string, externalId: string | null, nuevaHora: Date, contactId: string | null): Promise<void> {
  if (!externalId) return;
  try {
    const { cancelAppointmentReminders, scheduleAppointmentReminders, dispatchEvent } = await import("./workflow-runtime.js");
    await cancelAppointmentReminders(organizationId, externalId);
    await scheduleAppointmentReminders(organizationId, { id: externalId, start: nuevaHora.toISOString() }, { contactId: contactId ?? undefined });
    if (contactId) {
      await dispatchEvent({ organizationId, type: "appointment_rescheduled", contactId, data: { appointmentExternalId: externalId, origen: "google_calendar" }, occurredAt: new Date().toISOString() });
    }
  } catch (err) {
    console.warn("⚠ [gcal] no se pudieron reprogramar los recordatorios:", (err as Error).message);
  }
}

/** Sondea todos los calendarios de UNA org y guarda los syncTokens. */
export async function pullOrgCalendars(organizationId: string, overrides?: { fetchImpl?: typeof fetch }): Promise<PullResult[]> {
  const conn = await withTenant(organizationId, (tx) =>
    tx.integrationConnection.findFirst({ where: { organizationId, provider: "google" }, select: { id: true, config: true, status: true } }),
  );
  if (!conn || conn.status === "reauthorize" || !canUseFeature(conn.config, "calendar")) return [];
  const cfg = parseGoogleCalendarConfig(conn.config);
  if (!cfg.calendarSync) return [];
  const ids = calendariosConCitasNuestras(cfg);
  if (!ids.length) return [];

  const guardados = (((conn.config as Record<string, unknown>)?.syncTokens as Record<string, string> | undefined) ?? {});
  const resultados: PullResult[] = [];
  for (const calendarId of ids) {
    const r = await pullCalendar(organizationId, calendarId, guardados[calendarId], {
      token: () => getFreshOAuthToken(organizationId, "google"),
      fetchImpl: overrides?.fetchImpl,
    });
    resultados.push(r);
  }

  // Guardar los tokens nuevos (los que fallaron conservan el anterior) y el RESUMEN del
  // sondeo: es lo que el botón "sincronizado hace X min" de la Agenda muestra al apretarlo
  // ("3 cambios traídos de Google"). Sin guardarlo, la api no tendría de dónde sacar el dato.
  const siguientes = { ...guardados };
  for (const r of resultados) if (r.nextSyncToken) siguientes[r.calendarId] = r.nextSyncToken;
  const lastPull = {
    at: new Date().toISOString(),
    movidas: resultados.reduce((a, r) => a + r.movidas, 0),
    eliminadas: resultados.reduce((a, r) => a + r.eliminadas, 0),
    calendarios: resultados.length,
    errores: resultados.filter((r) => r.error).map((r) => `${r.calendarId}: ${r.error}`).slice(0, 3),
  };
  await withTenant(organizationId, (tx) =>
    tx.integrationConnection.update({
      where: { id: conn.id },
      data: { config: { ...((conn.config as object) ?? {}), syncTokens: siguientes, lastPull } as object, lastSyncAt: new Date() },
    }),
  ).catch(() => undefined);

  const conCambios = resultados.filter((r) => r.movidas || r.eliminadas);
  if (conCambios.length) {
    console.log(`[gcal] ${organizationId}: ${conCambios.reduce((a, r) => a + r.movidas, 0)} movida(s), ${conCambios.reduce((a, r) => a + r.eliminadas, 0)} eliminada(s)`);
  }
  return resultados;
}

/**
 * Abanica el sondeo por organización. **Gateado a la marca `conversia`**: TuBot no cambia de
 * comportamiento (ver la nota de alcance arriba), y es la misma lección de los loops del
 * worker que iteran todas las orgs.
 */
export async function fanOutGoogleSyncBack(): Promise<void> {
  const { getAdminPrisma } = await import("@conversia/database");
  const admin = getAdminPrisma();
  // `integration_connections` no tiene relación con `organizations`, así que la marca se
  // filtra en dos pasos (y no por el id, que sería acoplar la consulta a datos del tenant).
  const orgs = await admin.organization.findMany({ where: { brand: "conversia", deletedAt: null }, select: { id: true }, take: 2000 });
  if (!orgs.length) return;
  const conns = await admin.integrationConnection.findMany({
    where: { provider: "google", status: { not: "reauthorize" }, organizationId: { in: orgs.map((o: { id: string }) => o.id) } },
    select: { organizationId: true },
    take: 500,
  });
  for (const c of conns) {
    try {
      await pullOrgCalendars(c.organizationId);
    } catch (err) {
      console.warn(`⚠ [gcal] sondeo falló para ${c.organizationId}:`, (err as Error).message);
    }
  }
}
