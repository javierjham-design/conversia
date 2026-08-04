import { withTenant } from "@conversia/database";

/**
 * Resuelve los valores REALES de los campos de una plantilla (mapeo
 * posición→campo guardado al crearla: contact.firstName, appointment.date, …).
 * Campos sin dato resuelven a "" — Meta acepta parámetros vacíos y es mejor
 * que inventar. Fechas en la zona horaria del tenant.
 */
export async function resolveTemplateParams(
  organizationId: string,
  contactId: string | null,
  fields: string[],
): Promise<string[]> {
  if (!fields.length) return [];
  return withTenant(organizationId, async (tx) => {
    const [contact, org] = await Promise.all([
      contactId ? tx.contact.findUnique({ where: { id: contactId } }) : Promise.resolve(null),
      tx.organization.findUnique({ where: { id: organizationId }, select: { name: true, timezone: true } }),
    ]);
    const needsAppointment = fields.some((f) => f.startsWith("appointment."));
    const appointment = needsAppointment && contactId
      ? await tx.appointment.findFirst({
          where: { contactId, startsAt: { gte: new Date() }, status: { in: ["PENDING", "CONFIRMED"] } },
          orderBy: { startsAt: "asc" },
        })
      : null;
    const [service, professional] = await Promise.all([
      appointment?.serviceId ? tx.service.findUnique({ where: { id: appointment.serviceId } }) : Promise.resolve(null),
      appointment?.professionalId ? tx.professional.findUnique({ where: { id: appointment.professionalId } }) : Promise.resolve(null),
    ]);

    const apptMeta = (appointment?.meta as Record<string, any> | null) ?? {};
    const tz = appointment?.timezone || org?.timezone || "America/Santiago";
    const fmtDate = (d: Date) =>
      d.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long", timeZone: tz });
    const fmtTime = (d: Date) => d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", timeZone: tz });

    const value = (field: string): string => {
      switch (field) {
        case "contact.firstName":
          return contact?.firstName ?? contact?.profileName ?? "";
        case "contact.lastName":
          return contact?.lastName ?? "";
        case "contact.fullName":
          return [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || (contact?.profileName ?? "");
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
          return professional?.name ?? "";
        case "organization.name":
          return org?.name ?? "";
        default:
          return "";
      }
    };
    return fields.map(value);
  });
}

/** Cuerpo de la plantilla con las variables {{n}} reemplazadas (preview/bandeja). */
export function renderTemplateBody(components: any[], params: string[]): string {
  const body = Array.isArray(components) ? components.find((c) => c?.type === "BODY")?.text ?? "" : "";
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (raw: string, n: string) => params[Number(n) - 1] ?? raw);
}
