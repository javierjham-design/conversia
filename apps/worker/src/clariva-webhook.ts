import { withTenant } from "@conversia/database";
import { emitPlatformEvent } from "./platform-events";
import { dispatchEvent } from "./workflow-runtime";
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

    // Eventos de cita: upsert de la proyección por (provider, externalId).
    const externalId = payload.id != null ? String(payload.id) : null;
    if (!externalId) return null;
    const existing = await tx.appointment.findFirst({ where: { provider: "CLARIVA", externalId } });

    if (existing) {
      const upd: Record<string, unknown> = {};
      if (mapped.status) upd.status = mapped.status;
      if (payload.start) upd.startsAt = new Date(payload.start);
      if (payload.end) upd.endsAt = new Date(payload.end);
      if (payload.notes !== undefined) upd.notes = payload.notes ?? null;
      const appt = await tx.appointment.update({ where: { id: existing.id }, data: upd });
      return { appointmentId: appt.id, contactId: appt.contactId, externalId };
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
        meta: { clinicId: payload.clinicId ?? null, professionalId: payload.professionalId ?? null, serviceId: payload.serviceId ?? null } as object,
      },
    });
    return { appointmentId: appt.id, contactId: appt.contactId, externalId };
  });

  if (!result) return;
  // Espejo a Google Calendar (si el tenant lo activó); cancelación borra el evento.
  const { enqueueCalendarSync } = await import("./google-calendar.js");
  await enqueueCalendarSync(organizationId, result.appointmentId, mapped.status === "CANCELLED" ? "cancel" : "upsert");
  const eventData = { appointmentId: result.appointmentId, externalId: result.externalId, contactId: result.contactId, source: "clariva" };
  if (mapped.publicEvent) await emitPlatformEvent(organizationId, mapped.publicEvent, eventData);
  if (mapped.trigger) {
    await dispatchEvent({ organizationId, type: mapped.trigger, contactId: result.contactId, data: eventData, occurredAt });
  }
}
