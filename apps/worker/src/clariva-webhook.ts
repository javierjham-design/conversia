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

export async function processClarivaWebhook(
  organizationId: string,
  data: ClarivaWebhookData,
  occurredAt: string,
): Promise<void> {
  const { event, payload } = data;
  const mapped = mapClarivaEvent(event, payload);

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
      const contact = await tx.contact.findFirst({ where: { phone, deletedAt: null } });
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
      let contact = await tx.contact.findFirst({ where: { phone, deletedAt: null } });
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
    const existing = await tx.appointment.findFirst({ where: { provider: "CLARIVA", externalId } });

    // Servicio / profesional / sede del payload (para filtros de trigger y variables).
    const apptMeta = {
      clinicId: payload.clinicId ?? null,
      clinicName: payload.clinicName ?? payload.clinic?.name ?? null,
      professionalId: payload.professionalId ?? null,
      professionalName: payload.professionalName ?? payload.professional?.name ?? null,
      serviceId: payload.serviceId ?? null,
      serviceName: payload.serviceName ?? payload.service?.name ?? null,
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
      if (mapped.status) upd.status = mapped.status;
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
    const phone = geoFromPhone(String(payload.patient?.phone ?? "")).phone;
    if (!phone) return null;
    let contact = await tx.contact.findFirst({ where: { phone, deletedAt: null } });
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
        status: (mapped.status ?? "PENDING") as any,
        startsAt: new Date(payload.start),
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
