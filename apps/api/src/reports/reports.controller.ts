import { Controller, Get, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";

function sinceDays(days: number): Date {
  return new Date(Date.now() - days * 24 * 3600 * 1000);
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

@Controller("reports")
export class ReportsController {
  constructor(private prisma: PrismaService) {}

  @Get("overview")
  overview(@Query("days") daysParam?: string) {
    const ctx = requireContext();
    const days = Math.min(Math.max(Number(daysParam ?? 30) || 30, 1), 90);
    const since = sinceDays(days);

    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [
        conversationsTotal,
        conversationsNew,
        conversationsOpen,
        humanControl,
        messagesIn,
        messagesOut,
        handoffs,
        appointments,
        leadStatuses,
        leadsByStatus,
        convSeries,
        msgSeries,
      ] = await Promise.all([
        tx.conversation.count(),
        tx.conversation.count({ where: { createdAt: { gte: since } } }),
        tx.conversation.count({ where: { status: "OPEN" } }),
        tx.conversation.count({ where: { aiEnabled: false, status: { in: ["OPEN", "PENDING"] } } }),
        tx.message.count({ where: { direction: "INBOUND", createdAt: { gte: since } } }),
        tx.message.count({ where: { direction: "OUTBOUND", createdAt: { gte: since } } }),
        tx.humanHandoff.count({ where: { createdAt: { gte: since } } }),
        tx.appointment.groupBy({ by: ["status"], _count: { _all: true }, where: { createdAt: { gte: since } } }),
        tx.leadStatus.findMany({ orderBy: { order: "asc" } }),
        tx.lead.groupBy({ by: ["statusId"], _count: { _all: true } }),
        // Costos/uso de IA: SOLO en el Super Admin — nunca exponerlos al tenant.
        // Series diarias — organization_id explícito: el SQL crudo no pasa por
        // los filtros de Prisma y la conexión admin bypasea RLS.
        tx.$queryRaw<Array<{ day: Date; count: bigint }>>`
          SELECT date_trunc('day', created_at) AS day, count(*)::bigint AS count
          FROM conversations
          WHERE organization_id = ${ctx.organizationId} AND created_at >= ${sinceDays(14)}
          GROUP BY 1 ORDER BY 1`,
        tx.$queryRaw<Array<{ day: Date; count: bigint }>>`
          SELECT date_trunc('day', created_at) AS day, count(*)::bigint AS count
          FROM messages
          WHERE organization_id = ${ctx.organizationId} AND direction = 'INBOUND' AND created_at >= ${sinceDays(14)}
          GROUP BY 1 ORDER BY 1`,
      ]);

      return {
        days,
        conversations: {
          total: conversationsTotal,
          newInPeriod: conversationsNew,
          openNow: conversationsOpen,
          humanControlNow: humanControl,
        },
        messages: { inbound: messagesIn, outbound: messagesOut },
        humanHandoffs: handoffs,
        appointments: appointments.map((a) => ({ status: a.status, count: a._count._all })),
        leadFunnel: leadStatuses.map((s) => ({
          code: s.code,
          name: s.name,
          category: s.category,
          count: leadsByStatus.find((l) => l.statusId === s.id)?._count._all ?? 0,
        })),
        series: {
          conversationsPerDay: convSeries.map((r) => ({ day: r.day.toISOString().slice(0, 10), count: Number(r.count) })),
          inboundPerDay: msgSeries.map((r) => ({ day: r.day.toISOString().slice(0, 10), count: Number(r.count) })),
        },
      };
    });
  }

  @Get("export/conversations")
  async exportConversations(@Res() res: Response, @Query("days") daysParam?: string) {
    const ctx = requireContext();
    const days = Math.min(Math.max(Number(daysParam ?? 30) || 30, 1), 365);
    const rows = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.conversation.findMany({
        where: { createdAt: { gte: sinceDays(days) } },
        include: { contact: true },
        orderBy: { createdAt: "desc" },
        take: 5000,
      }),
    );
    const header = "fecha_creacion;contacto;telefono;estado;ia_activa;ultimo_mensaje;fecha_ultimo_mensaje";
    const lines = rows.map((c) =>
      [
        c.createdAt.toISOString(),
        [c.contact.firstName, c.contact.lastName].filter(Boolean).join(" "),
        c.contact.phone,
        c.status,
        c.aiEnabled ? "si" : "no",
        c.lastMessagePreview,
        c.lastMessageAt?.toISOString() ?? "",
      ]
        .map(csvEscape)
        .join(";"),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="conversaciones_${days}d.csv"`);
    res.send("﻿" + [header, ...lines].join("\n"));
  }

  @Get("export/leads")
  async exportLeads(@Res() res: Response) {
    const ctx = requireContext();
    const rows = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.lead.findMany({
        include: { contact: true, status: true },
        orderBy: { createdAt: "desc" },
        take: 5000,
      }),
    );
    const header = "fecha_creacion;contacto;telefono;estado;categoria";
    const lines = rows.map((l) =>
      [
        l.createdAt.toISOString(),
        [l.contact.firstName, l.contact.lastName].filter(Boolean).join(" "),
        l.contact.phone,
        l.status.name,
        l.status.category,
      ]
        .map(csvEscape)
        .join(";"),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="leads.csv"');
    res.send("﻿" + [header, ...lines].join("\n"));
  }
}
