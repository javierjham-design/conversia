import { Controller, Get, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";

function sinceDays(days: number): Date {
  return new Date(Date.now() - days * 24 * 3600 * 1000);
}

/** Rango [gte, lte] a partir de from/to (YYYY-MM-DD). Default: últimos 30 días. Bordes de día en UTC. */
function parseRange(from?: string, to?: string): { gte: Date; lte: Date } {
  const now = new Date();
  const g = from ? new Date(`${from.slice(0, 10)}T00:00:00.000Z`) : new Date(now.getTime() - 30 * 24 * 3600 * 1000);
  const l = to ? new Date(`${to.slice(0, 10)}T23:59:59.999Z`) : now;
  const gte = isNaN(g.getTime()) ? new Date(now.getTime() - 30 * 24 * 3600 * 1000) : g;
  const lte = isNaN(l.getTime()) || l < gte ? now : l;
  return { gte, lte };
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

@Controller("reports")
export class ReportsController {
  constructor(private prisma: PrismaService) {}

  @Get("overview")
  async overview(@Query("days") daysParam?: string) {
    const ctx = requireContext();
    const days = Math.min(Math.max(Number(daysParam ?? 30) || 30, 1), 90);
    const since = sinceDays(days);

    // Pagos RECIBIDOS de clientes (Flow) — en su PROPIA transacción, AISLADO del reporte.
    // Si la tabla customer_payments aún no fue migrada, la consulta aborta la transacción
    // en Postgres; corriéndola aparte, ese fallo NO contamina el resto del reporte.
    let payments = { count: 0, total: 0 };
    try {
      payments = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
        const agg = await tx.customerPayment.aggregate({ where: { status: "paid", paidAt: { gte: since } }, _count: { _all: true }, _sum: { amount: true } });
        return { count: agg._count._all, total: Number(agg._sum.amount ?? 0) };
      });
    } catch {
      /* tabla customer_payments aún no migrada en este entorno */
    }

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

      // Uso de CONTACTOS del mes vs el cupo del plan (con override por-tenant).
      // El período arranca en el periodStart de la suscripción, o el 1° del mes.
      const now = new Date();
      const [sub, orgRow] = await Promise.all([
        tx.subscription.findFirst({ select: { periodStart: true, planId: true } }),
        tx.organization.findFirst({ select: { settings: true } }),
      ]);
      const periodStart = sub?.periodStart ?? new Date(now.getFullYear(), now.getMonth(), 1);
      const contactsUsed = await tx.contact.count({ where: { createdAt: { gte: periodStart }, deletedAt: null } });
      const plan = sub?.planId ? await tx.plan.findUnique({ where: { id: sub.planId }, select: { limits: true } }) : null;
      const override = (orgRow?.settings as { limits?: Record<string, unknown> } | null)?.limits?.contactsMonthly;
      const planLimit = (plan?.limits as Record<string, unknown> | null)?.contactsMonthly;
      const rawLimit = typeof override === "number" ? override : typeof planLimit === "number" ? planLimit : 0;
      const limit = rawLimit > 0 ? rawLimit : null; // null = ilimitado / sin cupo definido
      const contactsUsage = {
        used: contactsUsed,
        limit,
        remaining: limit != null ? Math.max(0, limit - contactsUsed) : null,
        pct: limit != null ? Math.min(100, Math.round((contactsUsed / limit) * 100)) : null,
        periodStart: periodStart.toISOString(),
      };

      return {
        days,
        conversations: {
          total: conversationsTotal,
          newInPeriod: conversationsNew,
          openNow: conversationsOpen,
          humanControlNow: humanControl,
        },
        messages: { inbound: messagesIn, outbound: messagesOut },
        contactsUsage,
        payments,
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

  /**
   * Reporte de PAGOS recibidos (Flow) en un rango de fechas ajustable: resumen, desglose
   * por ítem cobrado (subject) y detalle de pagos. Resiliente: si la tabla customer_payments
   * no está migrada, devuelve available=false sin romper.
   */
  @Get("payments")
  async payments(@Query("from") from?: string, @Query("to") to?: string) {
    const ctx = requireContext();
    const { gte, lte } = parseRange(from, to);
    const empty = { available: false, currency: "CLP", range: { from: gte.toISOString(), to: lte.toISOString() }, summary: { paidCount: 0, paidTotal: 0, pendingCount: 0 }, byItem: [] as Array<{ subject: string; count: number; total: number }>, payments: [] as unknown[] };
    try {
      return await this.prisma.withTenant(ctx.organizationId, async (tx) => {
        const paidWhere = { status: "paid", paidAt: { gte, lte } };
        const [agg, byItemRaw, pendingCount, list] = await Promise.all([
          tx.customerPayment.aggregate({ where: paidWhere, _count: { _all: true }, _sum: { amount: true } }),
          tx.customerPayment.groupBy({ by: ["subject"], where: paidWhere, _count: { _all: true }, _sum: { amount: true } }),
          tx.customerPayment.count({ where: { status: "pending", createdAt: { gte, lte } } }),
          tx.customerPayment.findMany({ where: paidWhere, orderBy: { paidAt: "desc" }, take: 1000, include: { contact: { select: { firstName: true, lastName: true, phone: true } } } }),
        ]);
        const byItem = byItemRaw
          .map((r) => ({ subject: r.subject, count: r._count._all, total: Number(r._sum.amount ?? 0) }))
          .sort((a, b) => b.total - a.total);
        return {
          available: true,
          currency: "CLP",
          range: { from: gte.toISOString(), to: lte.toISOString() },
          summary: { paidCount: agg._count._all, paidTotal: Number(agg._sum.amount ?? 0), pendingCount },
          byItem,
          payments: list.map((p) => ({
            id: p.id,
            paidAt: (p.paidAt ?? p.createdAt).toISOString(),
            subject: p.subject,
            amount: p.amount,
            currency: p.currency,
            status: p.status,
            contact: { name: [p.contact?.firstName, p.contact?.lastName].filter(Boolean).join(" ") || p.contact?.phone || "—", phone: p.contact?.phone ?? null },
          })),
        };
      });
    } catch {
      return empty; // tabla customer_payments aún no migrada
    }
  }

  @Get("export/payments")
  async exportPayments(@Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    const ctx = requireContext();
    const { gte, lte } = parseRange(from, to);
    let rows: Array<{ paidAt: Date | null; createdAt: Date; subject: string; amount: number; currency: string; status: string; commerceOrder: string; contact: { firstName: string | null; lastName: string | null; phone: string | null } | null }> = [];
    try {
      rows = await this.prisma.withTenant(ctx.organizationId, (tx) =>
        tx.customerPayment.findMany({
          where: { status: "paid", paidAt: { gte, lte } },
          orderBy: { paidAt: "desc" },
          take: 10000,
          include: { contact: { select: { firstName: true, lastName: true, phone: true } } },
        }),
      );
    } catch {
      rows = [];
    }
    const header = "fecha_pago;contacto;telefono;item;monto;moneda;estado;orden";
    const lines = rows.map((p) =>
      [
        (p.paidAt ?? p.createdAt).toISOString(),
        [p.contact?.firstName, p.contact?.lastName].filter(Boolean).join(" "),
        p.contact?.phone ?? "",
        p.subject,
        p.amount,
        p.currency,
        p.status,
        p.commerceOrder,
      ]
        .map(csvEscape)
        .join(";"),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="pagos.csv"');
    res.send("﻿" + [header, ...lines].join("\n"));
  }
}
