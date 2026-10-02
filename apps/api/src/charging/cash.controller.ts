import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { requirePermission } from "../tenancy/permissions";

/**
 * F9 — RECAUDACIÓN Y CAJA. Libro APPEND-ONLY e inmutable (UPDATE/DELETE revocados a nivel
 * de BD en setup.sql): un error se corrige con un asiento de REVERSA. Montos en ENTEROS
 * CON SIGNO (ingreso +, egreso −, reversa = −original) → el neto es la suma simple. La IA
 * jamás escribe aquí: solo humanos con cash:manage o el webhook verificado (asiento
 * conciliado). cash:report = solo lectura. No toca el billing de la suscripción Conversia.
 */
const METHODS = ["link_flow", "link_getnet", "efectivo", "transferencia", "tarjeta", "otro"] as const;

const entrySchema = z.object({
  type: z.enum(["ingreso", "egreso"]),
  method: z.enum(METHODS),
  amount: z.coerce.number().int().positive().max(2_000_000_000),
  currency: z.string().length(3).default("CLP"),
  concept: z.string().trim().max(200).optional(),
  refType: z.enum(["appointment", "contact", "concepto"]).optional(),
  refId: z.string().max(60).optional(),
  idempotencyKey: z.string().max(100).optional(),
});

/** Límites del día en zona de Chile (-03:00). date = YYYY-MM-DD (default hoy). */
function dayRange(date?: string): { from: Date; to: Date } {
  const base = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
  const from = new Date(`${base}T00:00:00-03:00`);
  const to = new Date(from.getTime() + 24 * 3600_000);
  return { from, to };
}
function rangeFor(range: "day" | "week" | "month", date?: string): { from: Date; to: Date } {
  const { from, to } = dayRange(date);
  if (range === "day") return { from, to };
  if (range === "week") return { from: new Date(from.getTime() - 6 * 24 * 3600_000), to };
  return { from: new Date(from.getTime() - 29 * 24 * 3600_000), to };
}

export type Entry = { id: string; type: string; method: string; amount: number; currency: string; status: string; concept: string | null; refType: string | null; refId: string | null; reversalOf: string | null; origin: string; createdById: string; createdAt: Date };

/** Resumen del libro: neto = SUMA de montos con signo (property: siempre cuadra con el total). */
export function summarize(entries: Pick<Entry, "amount" | "method" | "status">[]) {
  let net = 0, conciliado = 0, declarado = 0, efectivo = 0;
  const byMethod: Record<string, number> = {};
  for (const e of entries) {
    net += e.amount;
    byMethod[e.method] = (byMethod[e.method] ?? 0) + e.amount;
    if (e.status === "conciliado") conciliado += e.amount;
    else declarado += e.amount;
    if (e.method === "efectivo") efectivo += e.amount;
  }
  return { net, conciliado, declarado, efectivo, byMethod, count: entries.length };
}

@Controller("cash")
export class CashController {
  constructor(private prisma: PrismaService) {}

  /** Crea un asiento de ingreso o egreso (humano con cash:manage). Idempotente por clave. */
  @Post("entry")
  async createEntry(@Body() body: unknown) {
    const ctx = requirePermission("cash:manage");
    const parsed = entrySchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => i.message).join("; "));
    const d = parsed.data;
    const signed = d.type === "ingreso" ? d.amount : -d.amount;
    const idem = d.idempotencyKey ?? randomUUID();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const existing = await tx.cashLedger.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: idem } } });
      if (existing) return { ok: true, id: existing.id, idempotent: true };
      const e = await tx.cashLedger.create({
        data: {
          organizationId: ctx.organizationId,
          type: d.type,
          method: d.method,
          amount: signed,
          currency: d.currency,
          concept: d.concept ?? null,
          refType: d.refType ?? null,
          refId: d.refId ?? null,
          status: "declarado",
          createdById: ctx.userId ?? "unknown",
          origin: "panel",
          idempotencyKey: idem,
        },
      });
      await tx.auditLog.create({ data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "cash.entry", entityType: "cash_ledger", entityId: e.id, after: { type: d.type, method: d.method, amount: signed } } });
      return { ok: true, id: e.id };
    });
  }

  /** Reversa un asiento: inserta el asiento opuesto (nunca modifica/borra el original). */
  @Post("reverse")
  async reverse(@Body() body: unknown) {
    const ctx = requirePermission("cash:manage");
    const parsed = z.object({ entryId: z.string().min(1), reason: z.string().max(200).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("entryId requerido");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const orig = await tx.cashLedger.findFirst({ where: { id: parsed.data.entryId } });
      if (!orig) throw new NotFoundException("Asiento no encontrado");
      const idem = `reversa:${orig.id}`;
      const existing = await tx.cashLedger.findUnique({ where: { organizationId_idempotencyKey: { organizationId: ctx.organizationId, idempotencyKey: idem } } });
      if (existing) return { ok: true, id: existing.id, idempotent: true };
      const e = await tx.cashLedger.create({
        data: {
          organizationId: ctx.organizationId,
          type: "reversa",
          method: orig.method,
          amount: -orig.amount, // negación exacta del original (re-reversa vuelve a invertir)
          currency: orig.currency,
          concept: parsed.data.reason ? `Reversa: ${parsed.data.reason}` : `Reversa de ${orig.id}`,
          refType: "reversal",
          refId: orig.id,
          reversalOf: orig.id,
          status: orig.status,
          createdById: ctx.userId ?? "unknown",
          origin: "panel",
          idempotencyKey: idem,
        },
      });
      await tx.auditLog.create({ data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "cash.reverse", entityType: "cash_ledger", entityId: e.id, after: { reversalOf: orig.id, amount: -orig.amount } } });
      return { ok: true, id: e.id };
    });
  }

  /** Caja del día: asientos + totales + si ya está cerrada (alimenta el KPI del Hoy). */
  @Get("day")
  async day(@Query("date") date?: string) {
    const ctx = requirePermission("cash:report");
    const { from, to } = dayRange(date);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [entries, closure] = await Promise.all([
        tx.cashLedger.findMany({ where: { createdAt: { gte: from, lt: to } }, orderBy: { createdAt: "desc" } }),
        tx.cashClosure.findFirst({ where: { fromAt: from }, orderBy: { createdAt: "desc" } }),
      ]);
      return { from, to, summary: summarize(entries as Entry[]), entries, closed: !!closure, closure };
    });
  }

  /** Reporte por rango (day|week|month): totales por método + conciliado vs declarado. */
  @Get("report")
  async report(@Query("range") range?: string, @Query("date") date?: string) {
    const ctx = requirePermission("cash:report");
    const r = range === "week" || range === "month" ? range : "day";
    const { from, to } = rangeFor(r, date);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const entries = (await tx.cashLedger.findMany({ where: { createdAt: { gte: from, lt: to } } })) as Entry[];
      return { range: r, from, to, ...summarize(entries) };
    });
  }

  /** Export CSV de los asientos del rango (conciliado/declarado explícito). */
  @Get("export")
  async exportCsv(@Res() res: Response, @Query("range") range?: string, @Query("date") date?: string) {
    const ctx = requirePermission("cash:report");
    const r = range === "week" || range === "month" ? range : "day";
    const { from, to } = rangeFor(r, date);
    const rows = await this.prisma.withTenant(ctx.organizationId, (tx) => tx.cashLedger.findMany({ where: { createdAt: { gte: from, lt: to } }, orderBy: { createdAt: "asc" } }));
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const header = ["fecha", "tipo", "metodo", "monto", "moneda", "estado", "concepto", "refType", "refId", "origen"].join(",");
    const lines = (rows as Entry[]).map((e) => [e.createdAt.toISOString(), e.type, e.method, e.amount, e.currency, e.status, e.concept ?? "", e.refType ?? "", e.refId ?? "", e.origin].map(esc).join(","));
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="caja-${r}-${from.toISOString().slice(0, 10)}.csv"`);
    res.send([header, ...lines].join("\n"));
  }

  /** Cierre de caja del día: snapshot INMUTABLE (reabrir = nuevo cierre). */
  @Post("close")
  async close(@Body() body: unknown) {
    const ctx = requirePermission("cash:manage");
    const parsed = z.object({ declaredCash: z.coerce.number().int().min(0), date: z.string().optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("declaredCash (efectivo contado) requerido");
    const { from, to } = dayRange(parsed.data.date);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const entries = (await tx.cashLedger.findMany({ where: { createdAt: { gte: from, lt: to } } })) as Entry[];
      const s = summarize(entries);
      const difference = parsed.data.declaredCash - s.efectivo;
      const closure = await tx.cashClosure.create({
        data: {
          organizationId: ctx.organizationId,
          fromAt: from,
          toAt: to,
          totalsByMethod: s.byMethod as object,
          conciliado: s.conciliado,
          declarado: s.declarado,
          declaredCash: parsed.data.declaredCash,
          calculatedCash: s.efectivo,
          difference,
          closedById: ctx.userId ?? "unknown",
        },
      });
      await tx.auditLog.create({ data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "cash.close", entityType: "cash_closure", entityId: closure.id, after: { declaredCash: parsed.data.declaredCash, calculatedCash: s.efectivo, difference } } });
      return { ok: true, closure };
    });
  }

  /** Historial de cierres. */
  @Get("closures")
  async closures() {
    const ctx = requirePermission("cash:report");
    return this.prisma.withTenant(ctx.organizationId, (tx) => tx.cashClosure.findMany({ orderBy: { createdAt: "desc" }, take: 60 }));
  }
}

/**
 * Asiento AUTOMÁTICO desde un pago confirmado por webhook (Flow/Getnet). Conciliado,
 * origen webhook, createdById 'system'. Idempotente por paymentId (no duplica si el
 * webhook se repite). Lo llama el ChargingWebhookController tras marcar el pago pagado.
 */
export async function recordPaymentCashEntry(
  adminPrisma: { cashLedger: { findUnique: Function; create: Function } },
  payment: { id: string; organizationId: string; amount: number; subject?: string | null; contactId?: string | null; conversationId?: string | null },
  method: "link_flow" | "link_getnet",
): Promise<void> {
  const idem = `payment:${payment.id}`;
  const existing = await adminPrisma.cashLedger.findUnique({ where: { organizationId_idempotencyKey: { organizationId: payment.organizationId, idempotencyKey: idem } } });
  if (existing) return;
  await adminPrisma.cashLedger.create({
    data: {
      organizationId: payment.organizationId,
      type: "ingreso",
      method,
      amount: Math.round(payment.amount),
      currency: "CLP",
      concept: payment.subject ?? "Pago por link",
      refType: "payment",
      refId: payment.id,
      status: "conciliado",
      createdById: "system",
      origin: "webhook",
      idempotencyKey: idem,
    },
  });
}
