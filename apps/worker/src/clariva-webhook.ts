import { withTenant } from "@conversia/database";
import { emitPlatformEvent } from "./platform-events";
import { cancelAppointmentReminders, dispatchEvent, scheduleAppointmentReminders } from "./workflow-runtime";
import { geoFromPhone } from "./phone-geo";

// Webhooks Cláriva → Conversia (docs/CLARIVA.md). La API ya verificó la firma
// y resolvió el tenant por la conexión; acá se actualiza la PROYECCIÓN local
// (la verdad de agenda vive en Cláriva) y se disparan los workflows.

export interface ClarivaWebhookData {
  connectionId: string;
  event: string;
  payload: Record<string, any>;
}

/** Mapeo puro evento Cláriva → estado local + evento público + trigger. */
export function mapClarivaEvent(
  event: string,
  payload: Record<string, any>,
): { status: string | null; publicEvent: string | null; trigger: string | null } {
  switch (event) {
    case "appointment.created":
      return { status: "PENDING", publicEvent: "appointment.created", trigger: "appointment_created" };
    case "appointment.updated":
      return { status: null, publicEvent: "appointment.updated", trigger: null };
    case "appointment.confirmed":
      return { status: "CONFIRMED", publicEvent: "appointment.updated", trigger: "appointment_confirmed" };
    case "appointment.cancelled":
      return { status: "CANCELLED", publicEvent: "appointment.cancelled", trigger: "appointment_cancelled" };
    case "appointment.rescheduled":
      return { status: "RESCHEDULED", publicEvent: "appointment.updated", trigger: "appointment_rescheduled" };
    case "appointment.attendance":
      return payload.attended === false
        ? { status: "NO_SHOW", publicEvent: "appointment.updated", trigger: "no_show" }
        : { status: "COMPLETED", publicEvent: "appointment.updated", trigger: null };
    case "patient.updated":
      return { status: null, publicEvent: null, trigger: null };
    case "patient.treatment_pending":
      // Asistió a la evaluación pero no inició el tratamiento. No es un evento de
      // cita (no trae appointment.id): apunta a un CONTACTO por teléfono. Lo procesa
      // una rama propia (como patient.updated); aquí solo se nombra el trigger.
      return { status: null, publicEvent: null, trigger: "treatment_pending" };
    default:
      return { status: null, publicEvent: null, trigger: null };
  }
}

/** Margen para tolerar el marcado de asistencia justo al inicio de la cita / desfase de reloj:
 *  solo se protege una cita que esté AL MENOS esto en el futuro. */
export const FUTURE_TERMINAL_GRACE_MS = 2 * 60 * 60 * 1000; // 2 h

/**
 * Guard de estado: una cita AÚN futura no puede estar "atendida"/"no asistió" — es imposible
 * haber asistido (o faltado) a algo que todavía no ocurre. Cláriva puede emitir un
 * `appointment.attendance` (o un `appointment.updated` que mueve la cita al futuro) que dejaría la
 * proyección local en un estado terminal-pasado (COMPLETED/NO_SHOW) con `startsAt` en el futuro.
 * Esa cita "fantasma-completada" se cae de TODAS las vistas de citas activas (el recordatorio la
 * recuerda igual, pero `listContactAppointments` y el fast-path de confirmación filtran
 * CANCELLED/COMPLETED) → el paciente recibe "confirma tu hora" y al confirmar el bot responde
 * "no encuentro una cita a tu nombre" (caso Marcia Aninat, 16-nov-2026).
 *
 * Si el estado entrante es COMPLETED/NO_SHOW pero la cita es CLARAMENTE futura, NO se aplica
 * (`status: null` = no cambiar el estado; se mantiene activa) y se marca `anomaly` para dejar
 * rastro. Cuando la cita realmente pase, un `appointment.attendance` posterior sí la cerrará.
 * Puro y determinista.
 */
export function guardFutureTerminalStatus(
  status: string | null,
  startsAt: Date | null,
  now: Date,
): { status: string | null; anomaly: boolean } {
  if (
    (status === "COMPLETED" || status === "NO_SHOW") &&
    startsAt &&
    startsAt.getTime() > now.getTime() + FUTURE_TERMINAL_GRACE_MS
  ) {
    return { status: null, anomaly: true };
  }
  return { status, anomaly: false };
}

export async function processClarivaWebhook(
  organizationId: string,
  data: ClarivaWebhookData,
  occurredAt: string,
): Promise<void> {
  const { event, payload } = data;
  const mapped = mapClarivaEvent(event, payload);
  const now = new Date();

  const result = await withTenant(organizationId, async (tx) => {
    await tx.integrationEvent.create({
      data: {
        organizationId,
        provider: "clariva",
        type: `clariva.${event}`,
        status: "ok",
        message: `Webhook ${event} (conexión ${data.connectionId})`,
        payload: { externalId: payload.id ?? null, event } as object,
      },
    });

    if (event === "patient.updated") {
      // Solo rellena huecos: Cláriva no pisa datos ya capturados en Conversia.
      const phone = geoFromPhone(String(payload.phone ?? "")).phone;
      if (!phone) return null;
      // Búsqueda por teléfono SIEMPRE acotada al tenant del webhook: el mismo
      // número puede existir en otro cliente (defensa sobre RLS).
      const contact = await tx.contact.findFirst({ where: { organizationId, phone, deletedAt: null } });
      if (!contact) return null;
      const upd: Record<string, unknown> = {};
      if (payload.firstName && !contact.firstName) upd.firstName = payload.firstName;
      if (payload.lastName && !contact.lastName) upd.lastName = payload.lastName;
      if (payload.email && !contact.email) upd.email = payload.email;
      if (Object.keys(upd).length) await tx.contact.update({ where: { id: contact.id }, data: upd });
      return null;
    }

    if (event === "patient.treatment_pending") {
      // Recaptura de tratamiento: NO es una cita. Resuelve/crea el contacto por
      // teléfono y marca el resultado para despachar el trigger fuera del tx.
      const phone = geoFromPhone(String(payload.patient?.phone ?? payload.phone ?? "")).phone;
      if (!phone) return null;
      let contact = await tx.contact.findFirst({ where: { organizationId, phone, deletedAt: null } });
      if (!contact) {
        contact = await tx.contact.create({
          data: {
            organizationId,
            phone,
            firstName: payload.patient?.firstName ?? null,
            lastName: payload.patient?.lastName ?? null,
            source: "clariva",
            createdVia: "integration",
            acquisitionSource: "organic",
          },
        });
      }
      return {
        treatmentPending: true as const,
        contactId: contact.id,
        data: {
          source: "clariva",
          planId: payload.planId ?? null,
          planValue: payload.planValue ?? null,
          serviceName: payload.serviceName ?? null,
          // C(b): plantilla de recaptura de tratamiento elegida en el Gestor de IA.
          templateName: typeof payload.templateName === "string" ? payload.templateName : null,
        },
      };
    }

    // Eventos de cita: upsert de la proyección por (provider, externalId).
    const externalId = payload.id != null ? String(payload.id) : null;
    if (!externalId) return null;
    // Lock de transacción por (org, externalId): Cláriva puede entregar el MISMO
    // appointment.created dos veces casi a la vez (reintento/reenvío). Sin esto, los dos
    // `findFirst` de abajo devuelven null antes de que cualquiera confirme → ambos `create`
    // → cita DUPLICADA (misma hora, mismo externalId; caso Amalia/Cesar: 2 filas creadas en
    // el mismo segundo). El lock serializa: el 2º espera, ve la fila del 1º y hace UPDATE.
    // Se libera solo al cerrar la transacción. Es de asesoría (no bloquea otras filas).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}), hashtext(${externalId}))`;
    // El externalId de Cláriva es por clínica (puede repetirse entre tenants):
    // la proyección se busca acotada a la org, igual que el lock de arriba.
    const existing = await tx.appointment.findFirst({ where: { organizationId, provider: "CLARIVA", externalId } });

    // Servicio / profesional / sede / PACIENTE del payload (para filtros de trigger y
    // variables de plantilla). El nombre del paciente de Cláriva se guarda en la cita
    // para que el recordatorio use ESE nombre (no el de perfil de WhatsApp del contacto).
    const apptMeta = {
      clinicId: payload.clinicId ?? null,
      clinicName: payload.clinicName ?? payload.clinic?.name ?? null,
      professionalId: payload.professionalId ?? null,
      professionalName: payload.professionalName ?? payload.professional?.name ?? null,
      serviceId: payload.serviceId ?? null,
      serviceName: payload.serviceName ?? payload.service?.name ?? null,
      patientFirstName: payload.patient?.firstName ?? null,
      patientLastName: payload.patient?.lastName ?? null,
    };
    const metaForEvent = (m: Record<string, any> | null | undefined) => ({
      serviceId: m?.serviceId ?? null,
      serviceName: m?.serviceName ?? null,
      professionalId: m?.professionalId ?? null,
      professionalName: m?.professionalName ?? null,
      clinicId: m?.clinicId ?? null,
      clinicName: m?.clinicName ?? null,
    });
    // `remindersEnabled` (§1.3) + `reminders` (§1.4 horarios/toggle/plantillas + F sendNow):
    // se propagan en AMBAS ramas (cita nueva y existente) — el reenvío manual "por el bot"
    // llega como appointment.created de una cita YA existente.
    const remindersEnabled = typeof payload.remindersEnabled === "boolean" ? payload.remindersEnabled : null;
    const reminders = payload.reminders && typeof payload.reminders === "object" ? payload.reminders : null;

    if (existing) {
      const upd: Record<string, unknown> = {};
      // Guard: no cerrar (COMPLETED/NO_SHOW) una cita AÚN futura. `startsAt` efectivo = el entrante
      // (si el evento lo trae) o el ya guardado. Si se descarta el cierre, se deja rastro.
      const effStart = payload.start ? new Date(payload.start) : existing.startsAt;
      const guarded = guardFutureTerminalStatus(mapped.status, effStart, now);
      if (guarded.anomaly) {
        await tx.integrationEvent.create({
          data: {
            organizationId, provider: "clariva", type: "clariva.future_terminal_ignored", status: "warn",
            message: `Ignorado ${mapped.status} sobre cita FUTURA (${effStart.toISOString()}): se mantiene activa`,
            payload: { externalId, event, incomingStatus: mapped.status, startsAt: effStart.toISOString() } as object,
          },
        });
      }
      // No DEGRADAR el estado: un appointment.created RE-ENVIADO por Cláriva (sync o reenvío manual
      // "por el bot") trae status PENDING. Si la cita ya está resuelta (CONFIRMED/COMPLETED/CANCELLED/
      // NO_SHOW) — p. ej. el paciente confirmó por WhatsApp — volver a PENDING borraría esa decisión.
      // Por eso solo aplicamos el status entrante si NO es un downgrade a PENDING de un estado resuelto.
      const resolved = new Set(["CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"]);
      if (guarded.status && !(guarded.status === "PENDING" && resolved.has(String(existing.status)))) upd.status = guarded.status;
      if (payload.start) upd.startsAt = new Date(payload.start);
      if (payload.end) upd.endsAt = new Date(payload.end);
      if (payload.notes !== undefined) upd.notes = payload.notes ?? null;
      // Rellena la proyección con servicio/profesional/sede si el payload los trae
      // (sin pisar lo ya guardado): habilita filtros aunque el evento inicial fuera pobre.
      const prevMeta = (existing.meta as Record<string, any> | null) ?? {};
      const mergedMeta = { ...prevMeta };
      for (const [k, v] of Object.entries(apptMeta)) if (v != null && prevMeta[k] == null) mergedMeta[k] = v;
      upd.meta = mergedMeta as object;
      const appt = await tx.appointment.update({ where: { id: existing.id }, data: upd });
      return { appointmentId: appt.id, contactId: appt.contactId, externalId, startsAt: appt.startsAt.toISOString(), meta: metaForEvent(mergedMeta), remindersEnabled, reminders };
    }

    // Cita nueva (o desconocida): necesita horario y un contacto (por teléfono).
    if (!payload.start || !payload.end) return null;
    // Mismo guard que arriba: una cita NUEVA que llegara ya "atendida"/"no asistió" pero con hora
    // futura no se crea en estado terminal (quedaría invisible para el bot). Se crea activa.
    const newStart = new Date(payload.start);
    const guardedNew = guardFutureTerminalStatus(mapped.status, newStart, now);
    if (guardedNew.anomaly) {
      await tx.integrationEvent.create({
        data: {
          organizationId, provider: "clariva", type: "clariva.future_terminal_ignored", status: "warn",
          message: `Ignorado ${mapped.status} sobre cita FUTURA nueva (${newStart.toISOString()}): se crea activa`,
          payload: { externalId, event, incomingStatus: mapped.status, startsAt: newStart.toISOString() } as object,
        },
      });
    }
    const phone = geoFromPhone(String(payload.patient?.phone ?? "")).phone;
    if (!phone) return null;
    let contact = await tx.contact.findFirst({ where: { organizationId, phone, deletedAt: null } });
    if (!contact) {
      contact = await tx.contact.create({
        data: {
          organizationId,
          firstName: payload.patient?.firstName || null,
          lastName: payload.patient?.lastName || null,
          phone,
          email: payload.patient?.email || null,
          source: "clariva",
          createdVia: "integration",
          acquisitionSource: "organic",
        },
      });
    }
    const appt = await tx.appointment.create({
      data: {
        organizationId,
        contactId: contact.id,
        provider: "CLARIVA",
        externalId,
        status: (guardedNew.status ?? "PENDING") as any,
        startsAt: newStart,
        endsAt: new Date(payload.end),
        notes: payload.notes ?? null,
        meta: apptMeta as object,
      },
    });
    return { appointmentId: appt.id, contactId: appt.contactId, externalId, startsAt: appt.startsAt.toISOString(), meta: metaForEvent(apptMeta), remindersEnabled, reminders };
  });

  if (!result) return;

  // Recaptura de tratamiento: dispara el trigger sobre el contacto (sin cita ni
  // sync de calendario). El workflow C lo escucha.
  if ("treatmentPending" in result) {
    const { enqueueHubspotContact } = await import("./hubspot.js");
    await enqueueHubspotContact(organizationId, result.contactId);
    await dispatchEvent({
      organizationId,
      type: "treatment_pending",
      contactId: result.contactId,
      data: result.data,
      occurredAt,
    });
    return;
  }

  // Espejo a Google Calendar (si el tenant lo activó); cancelación borra el evento.
  const { enqueueCalendarSync } = await import("./google-calendar.js");
  await enqueueCalendarSync(organizationId, result.appointmentId, mapped.status === "CANCELLED" ? "cancel" : "upsert");
  const { enqueueHubspotContact } = await import("./hubspot.js");
  await enqueueHubspotContact(organizationId, result.contactId);
  const eventData = {
    appointmentId: result.appointmentId, externalId: result.externalId, contactId: result.contactId, source: "clariva",
    // C(b): plantilla de recaptura no-show elegida en el Gestor de IA (si vino en el payload).
    recapturaTemplate: typeof payload.recapturaTemplate === "string" ? payload.recapturaTemplate : null,
    ...(result.meta ?? {}),
  };
  if (mapped.publicEvent) await emitPlatformEvent(organizationId, mapped.publicEvent, eventData);
  if (mapped.trigger) {
    await dispatchEvent({ organizationId, type: mapped.trigger, contactId: result.contactId, data: eventData, occurredAt });
  }
  // Recordatorios de cita: programar al crear/reprogramar, cancelar al cancelar.
  if (mapped.trigger === "appointment_created" || mapped.trigger === "appointment_rescheduled") {
    await scheduleAppointmentReminders(
      organizationId,
      { id: result.externalId, start: result.startsAt, serviceId: result.meta?.serviceId, professionalId: result.meta?.professionalId, clinicId: result.meta?.clinicId, remindersEnabled: result.remindersEnabled, reminders: result.reminders },
      { contactId: result.contactId },
    );
  } else if (mapped.trigger === "appointment_cancelled" || mapped.trigger === "appointment_confirmed") {
    // Resuelta por otro medio (recepción confirmó, o se canceló) → cancelar R1/R2
    // pendientes y el run WAITING: no se insiste a quien ya quedó confirmado/cancelado.
    await cancelAppointmentReminders(organizationId, result.externalId);
  }
}
