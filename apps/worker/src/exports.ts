import { getAdminPrisma, withTenant } from "@conversia/database";
import { filterRecipientsByPref, getEmailQueue } from "./mailer.js";

/**
 * Exports de datos en background (/settings/export). Genera el CSV, lo guarda
 * en export_jobs.content con expiración a 7 días y deja el resultado listo
 * para descargar (la descarga queda auditada en la API).
 */

const MAX_ROWS = 50_000;

/** Escapa un valor para CSV (comillas, saltos de línea, separador). */
export function csvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvCell).join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
}

export async function processExport(organizationId: string, payload: { exportId: string }): Promise<void> {
  const job = await withTenant(organizationId, (tx) => tx.exportJob.findUnique({ where: { id: payload.exportId } }));
  if (!job || job.status === "DONE") return;
  await withTenant(organizationId, (tx) => tx.exportJob.update({ where: { id: job.id }, data: { status: "RUNNING" } }));

  const params = (job.params as Record<string, any>) ?? {};
  const from = params.from ? new Date(params.from) : null;
  const to = params.to ? new Date(`${String(params.to).slice(0, 10)}T23:59:59`) : null;
  const range = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  const dateFilter = from || to ? range : undefined;

  try {
    let csv = "";
    let rows = 0;

    if (job.type === "contacts") {
      const contacts = await withTenant(organizationId, (tx) =>
        tx.contact.findMany({
          where: { deletedAt: null, ...(dateFilter ? { createdAt: dateFilter } : {}) },
          orderBy: { createdAt: "asc" },
          take: MAX_ROWS,
        }),
      );
      const stages = await withTenant(organizationId, (tx) =>
        tx.$queryRaw<{ contact_id: string; name: string }[]>`
          SELECT DISTINCT ON (l.contact_id) l.contact_id, ls.name
          FROM leads l JOIN lead_statuses ls ON ls.id = l.status_id
          ORDER BY l.contact_id, l.created_at DESC`,
      );
      const stageBy = new Map(stages.map((s) => [s.contact_id, s.name]));
      csv = toCsv(
        ["id", "nombre", "apellido", "telefono", "email", "pais", "etapa", "origen", "via", "creado"],
        contacts.map((c) => [c.id, c.firstName, c.lastName, c.phone, c.email, c.country, stageBy.get(c.id) ?? "", c.source, c.createdVia, c.createdAt.toISOString()]),
      );
      rows = contacts.length;
    } else if (job.type === "conversations") {
      // Transcripciones: una fila por mensaje PÚBLICO (sin notas internas)
      const messages = await withTenant(organizationId, (tx) =>
        tx.message.findMany({
          where: { visibility: "PUBLIC", type: { notIn: ["SYSTEM", "NOTE"] }, ...(dateFilter ? { createdAt: dateFilter } : {}) },
          orderBy: [{ conversationId: "asc" }, { createdAt: "asc" }],
          take: MAX_ROWS,
          include: { conversation: { include: { contact: { select: { firstName: true, lastName: true, phone: true } } } } },
        }),
      );
      csv = toCsv(
        ["conversacion", "contacto", "telefono", "fecha", "direccion", "autor", "tipo", "texto"],
        messages.map((m) => [
          m.conversationId,
          [m.conversation.contact.firstName, m.conversation.contact.lastName].filter(Boolean).join(" "),
          m.conversation.contact.phone,
          m.createdAt.toISOString(),
          m.direction === "INBOUND" ? "entrante" : "saliente",
          m.authorType.toLowerCase(),
          m.type.toLowerCase(),
          m.body ?? "",
        ]),
      );
      rows = messages.length;
    } else {
      const appointments = await withTenant(organizationId, (tx) =>
        tx.appointment.findMany({
          where: dateFilter ? { startsAt: dateFilter } : {},
          orderBy: { startsAt: "asc" },
          take: MAX_ROWS,
          include: { contact: { select: { firstName: true, lastName: true, phone: true } } },
        }),
      );
      csv = toCsv(
        ["id", "contacto", "telefono", "inicio", "fin", "estado", "proveedor", "notas"],
        appointments.map((a) => [
          a.id,
          [a.contact.firstName, a.contact.lastName].filter(Boolean).join(" "),
          a.contact.phone,
          a.startsAt.toISOString(),
          a.endsAt.toISOString(),
          a.status,
          a.provider,
          a.notes ?? "",
        ]),
      );
      rows = appointments.length;
    }

    // Aviso al creador cuando queda listo (preferencia personal dataJobs)
    if (job.createdById) {
      try {
        const member = await getAdminPrisma().organizationUser.findUnique({
          where: { organizationId_userId: { organizationId, userId: job.createdById } },
          include: { user: { select: { email: true } } },
        });
        if (member) {
          const to = await filterRecipientsByPref(organizationId, [member.user.email], "dataJobs");
          if (to.length) {
            await getEmailQueue().add("export-done", {
              organizationId,
              kind: "alert",
              to,
              subject: "Tu export de datos está listo",
              html: `<p>El export de <b>${job.type}</b> (${rows} filas) ya está disponible en <a href="https://www.tubot.cl/settings/export">Configuración → Exportar datos</a>. Expira en 7 días.</p>`,
            });
          }
        }
      } catch {
        /* el aviso es best-effort */
      }
    }

    await withTenant(organizationId, (tx) =>
      tx.exportJob.update({
        where: { id: job.id },
        data: {
          status: "DONE",
          content: csv,
          rows,
          finishedAt: new Date(),
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000), // expira a los 7 días
        },
      }),
    );
  } catch (err) {
    await withTenant(organizationId, (tx) =>
      tx.exportJob.update({
        where: { id: job.id },
        data: { status: "FAILED", error: (err as Error).message.slice(0, 500), finishedAt: new Date() },
      }),
    );
    throw err;
  }
}

/** Purga el contenido de exports expirados (cross-org; corre en el tick de reglas). */
export async function purgeExpiredExports(): Promise<void> {
  const prisma = getAdminPrisma();
  await prisma.exportJob.updateMany({
    where: { expiresAt: { lt: new Date() }, content: { not: null } },
    data: { content: null },
  });
}
