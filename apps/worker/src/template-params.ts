import { withTenant } from "@conversia/database";

/**
 * Resuelve los valores REALES de los campos de una plantilla (mapeo
 * posición→campo guardado al crearla: contact.firstName, appointment.date, …).
 * Fechas en la zona horaria del tenant.
 *
 * IMPORTANTE: Meta RECHAZA los parámetros de cuerpo vacíos (#131008 "Required
 * parameter is missing"). Por eso cualquier campo sin dato se envía como un
 * espacio (" ") en vez de "" — así el recordatorio NUNCA se cae por un dato
 * faltante (mejor un hueco mínimo que no entregar nada).
 */
export async function resolveTemplateParams(
  organizationId: string,
  contactId: string | null,
  fields: string[],
  // `appointmentExternalId`: ata appointment.* a ESA cita exacta (p.ej. el
  // recordatorio de UNA sesión), no a la más próxima del contacto. Sin él (o si
  // esa cita ya no está en la proyección) cae al comportamiento previo: la
  // próxima cita PENDING/CONFIRMED — así nunca sale vacío.
  opts?: { appointmentExternalId?: string | null },
): Promise<string[]> {
  if (!fields.length) return [];
  return withTenant(organizationId, async (tx) => {
    const [contact, org] = await Promise.all([
      contactId ? tx.contact.findUnique({ where: { id: contactId } }) : Promise.resolve(null),
      tx.organization.findUnique({ where: { id: organizationId }, select: { name: true, timezone: true } }),
    ]);
    const needsAppointment = fields.some((f) => f.startsWith("appointment."));
    let appointment = null;
    if (needsAppointment && contactId) {
      if (opts?.appointmentExternalId) {
        appointment = await tx.appointment.findFirst({
          where: { contactId, externalId: opts.appointmentExternalId },
        });
      }
      // Fallback: si no vino la cita exacta (o no está en la proyección), la próxima.
      if (!appointment) {
        appointment = await tx.appointment.findFirst({
          where: { contactId, startsAt: { gte: new Date() }, status: { in: ["PENDING", "CONFIRMED"] } },
          orderBy: { startsAt: "asc" },
        });
      }
    }
    const [service, professional] = await Promise.all([
      appointment?.serviceId ? tx.service.findUnique({ where: { id: appointment.serviceId } }) : Promise.resolve(null),
      appointment?.professionalId ? tx.professional.findUnique({ where: { id: appointment.professionalId } }) : Promise.resolve(null),
    ]);

    const apptMeta = (appointment?.meta as Record<string, any> | null) ?? {};
    const tz = appointment?.timezone || org?.timezone || "America/Santiago";
    const fmtDate = (d: Date) =>
      d.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long", timeZone: tz });
    const fmtTime = (d: Date) => d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", timeZone: tz });

    // Nombre del paciente de Cláriva (guardado en la cita): en un recordatorio se usa
    // ESE nombre, no el de perfil de WhatsApp del contacto. Solo aplica si hay cita
    // con ese dato; si no, cae al nombre del contacto.
    const apptFirst = typeof apptMeta.patientFirstName === "string" ? apptMeta.patientFirstName.trim() : "";
    const apptLast = typeof apptMeta.patientLastName === "string" ? apptMeta.patientLastName.trim() : "";
    const apptFull = [apptFirst, apptLast].filter(Boolean).join(" ");
    const value = (field: string): string => {
      switch (field) {
        case "contact.firstName":
          return apptFirst || contact?.firstName || contact?.profileName || "";
        case "contact.lastName":
          return apptLast || contact?.lastName || "";
        case "contact.fullName":
          return apptFull || [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || (contact?.profileName ?? "");
        case "contact.phone":
          return contact?.phone ?? "";
        case "appointment.date":
          return appointment ? fmtDate(appointment.startsAt) : "";
        case "appointment.time":
          return appointment ? fmtTime(appointment.startsAt) : "";
        case "appointment.service":
          // Nombre del servicio: tabla Service local (agente) o, para citas de
          // Cláriva, el nombre que vino en el webhook (meta.serviceName).
          return service?.name ?? (typeof apptMeta.serviceName === "string" ? apptMeta.serviceName : "");
        case "appointment.serviceName":
          return typeof apptMeta.serviceName === "string" ? apptMeta.serviceName : "";
        case "appointment.professional":
          // Citas de Cláriva: professionalId (columna) va nulo; el nombre vive en
          // meta.professionalName (igual que serviceName). Sin este fallback, {{n}}
          // salía vacío y Meta rechazaba el envío con #131008.
          return professional?.name ?? (typeof apptMeta.professionalName === "string" ? apptMeta.professionalName : "");
        case "organization.name":
          return org?.name ?? "";
        default:
          return "";
      }
    };
    // Red de seguridad: Meta no acepta parámetros vacíos → el vacío va como " ".
    return fields.map((f) => value(f) || " ");
  });
}

/** Cuerpo de la plantilla con las variables {{n}} reemplazadas (preview/bandeja). */
export function renderTemplateBody(components: any[], params: string[]): string {
  const body = Array.isArray(components) ? components.find((c) => c?.type === "BODY")?.text ?? "" : "";
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (raw: string, n: string) => params[Number(n) - 1] ?? raw);
}
