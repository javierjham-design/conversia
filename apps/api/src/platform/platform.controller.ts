import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { PlatformGuard, type PlatformRequest } from "./platform.guard";

/**
 * API del panel de PLATAFORMA (super-admin). Opera cross-tenant por diseño
 * (cliente admin de BD) — es el ÚNICO lugar autorizado a hacerlo, detrás de
 * autenticación de plataforma separada y con auditoría en cada mutación.
 */
@Controller("platform")
@UseGuards(PlatformGuard)
export class PlatformController {
  constructor(private prisma: PrismaService) {}

  private audit(req: PlatformRequest, action: string, entityType: string, entityId: string, after?: object) {
    return this.prisma.admin.auditLog.create({
      data: {
        actorType: "platform_admin",
        actorId: req.platformAdmin?.sub,
        action,
        entityType,
        entityId,
        after: after ?? undefined,
      },
    });
  }

  // ------------------------------ Métricas ------------------------------

  @Get("metrics")
  async metrics() {
    const db = this.prisma.admin;
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const [orgs, active, trialing, suspended, plans, subs, ai, invoicesPaid] = await Promise.all([
      db.organization.count({ where: { deletedAt: null } }),
      db.organization.count({ where: { status: "ACTIVE", deletedAt: null } }),
      db.organization.count({ where: { status: "TRIAL", deletedAt: null } }),
      db.organization.count({ where: { status: "SUSPENDED" } }),
      db.plan.findMany(),
      db.subscription.findMany({ where: { status: { in: ["ACTIVE", "TRIALING"] } } }),
      db.aiRequest.aggregate({ where: { createdAt: { gte: since } }, _sum: { costUsd: true }, _count: { _all: true } }),
      db.invoice.aggregate({ where: { status: "PAID" }, _sum: { amountDue: true } }),
    ]);
    // MRR aproximado: suma del precio del plan de cada suscripción activa
    const planById = new Map(plans.map((p) => [p.id, p]));
    let mrrClp = 0;
    let mrrUsd = 0;
    for (const s of subs) {
      const p = planById.get(s.planId);
      if (!p) continue;
      mrrClp += Number(p.priceClp);
      mrrUsd += Number(p.priceUsd);
    }
    return {
      organizations: { total: orgs, active, trialing, suspended },
      subscriptionsActive: subs.length,
      mrr: { clp: mrrClp, usd: mrrUsd },
      aiCostUsd30d: Number(ai._sum.costUsd ?? 0),
      aiRequests30d: ai._count._all,
      revenuePaidClp: Number(invoicesPaid._sum.amountDue ?? 0),
    };
  }

  // ---------------------------- Organizaciones ----------------------------

  @Get("organizations")
  async organizations() {
    const db = this.prisma.admin;
    const [orgs, subs, plans] = await Promise.all([
      db.organization.findMany({ orderBy: { createdAt: "desc" } }),
      db.subscription.findMany(),
      db.plan.findMany(),
    ]);
    const planById = new Map(plans.map((p) => [p.id, p]));
    const subByOrg = new Map(subs.map((s) => [s.organizationId, s]));
    // Conteos agregados por organización
    const [userCounts, convCounts, agentCounts] = await Promise.all([
      db.organizationUser.groupBy({ by: ["organizationId"], _count: { _all: true } }),
      db.conversation.groupBy({ by: ["organizationId"], _count: { _all: true } }),
      db.agent.groupBy({ by: ["organizationId"], where: { deletedAt: null }, _count: { _all: true } }),
    ]);
    const cmap = (rows: any[]) => new Map(rows.map((r) => [r.organizationId, r._count._all]));
    const uc = cmap(userCounts), cc = cmap(convCounts), ac = cmap(agentCounts);

    return orgs.map((o) => {
      const sub = subByOrg.get(o.id);
      const plan = sub ? planById.get(sub.planId) : null;
      return {
        id: o.id,
        name: o.name,
        slug: o.slug,
        status: o.status,
        country: o.country,
        createdAt: o.createdAt,
        deletedAt: o.deletedAt,
        plan: plan ? { code: plan.code, name: plan.name } : null,
        subscriptionStatus: sub?.status ?? null,
        counts: { users: uc.get(o.id) ?? 0, conversations: cc.get(o.id) ?? 0, agents: ac.get(o.id) ?? 0 },
      };
    });
  }

  @Get("organizations/:id")
  async organizationDetail(@Param("id") id: string) {
    const db = this.prisma.admin;
    const org = await db.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException("Organización no encontrada");
    const [sub, plans, invoices, usage, members] = await Promise.all([
      db.subscription.findFirst({ where: { organizationId: id }, orderBy: { createdAt: "desc" } }),
      db.plan.findMany(),
      db.invoice.findMany({ where: { organizationId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
      db.usageEvent.groupBy({ by: ["type"], where: { organizationId: id, occurredAt: { gte: new Date(Date.now() - 30 * 24 * 3600 * 1000) } }, _sum: { quantity: true, costUsd: true } }),
      db.organizationUser.findMany({ where: { organizationId: id }, include: { user: { select: { email: true, name: true } } } }),
    ]);
    const plan = sub ? plans.find((p) => p.id === sub.planId) : null;
    return {
      organization: { id: org.id, name: org.name, slug: org.slug, status: org.status, country: org.country, createdAt: org.createdAt, settings: org.settings },
      subscription: sub ? { status: sub.status, planCode: plan?.code, planName: plan?.name, periodEnd: sub.periodEnd } : null,
      invoices,
      usage,
      members: members.map((m) => ({ email: m.user.email, name: m.user.name, active: m.active })),
    };
  }

  @Post("organizations/:id/status")
  async setStatus(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z.object({ status: z.enum(["ACTIVE", "TRIAL", "SUSPENDED", "CANCELLED"]) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("status inválido");
    const org = await this.prisma.admin.organization.update({ where: { id }, data: { status: parsed.data.status } });
    await this.audit(req, `platform.org.${parsed.data.status.toLowerCase()}`, "organization", id, { status: parsed.data.status });
    return { ok: true, status: org.status };
  }

  // ------------------------------- Planes -------------------------------

  @Get("plans")
  plans() {
    return this.prisma.admin.plan.findMany({ orderBy: { order: "asc" } });
  }

  @Post("plans")
  async createPlan(@Body() body: unknown, @Req() req: PlatformRequest) {
    const input = planSchema.parse2(body);
    const plan = await this.prisma.admin.plan.create({ data: input });
    await this.audit(req, "platform.plan.create", "plan", plan.id, { code: plan.code });
    return plan;
  }

  @Patch("plans/:id")
  async updatePlan(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const input = planSchema.partial2(body);
    const plan = await this.prisma.admin.plan.update({ where: { id }, data: input });
    await this.audit(req, "platform.plan.update", "plan", id);
    return plan;
  }

  // ---------------------------- Suscripciones ----------------------------

  @Post("organizations/:id/subscription")
  async assignSubscription(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z.object({ planCode: z.string(), status: z.enum(["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED"]).default("ACTIVE") }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("planCode requerido");
    const plan = await this.prisma.admin.plan.findUnique({ where: { code: parsed.data.planCode } });
    if (!plan) throw new BadRequestException("Plan desconocido");
    const existing = await this.prisma.admin.subscription.findFirst({ where: { organizationId: id }, orderBy: { createdAt: "desc" } });
    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + (plan.interval === "yearly" ? 12 : 1));
    const sub = existing
      ? await this.prisma.admin.subscription.update({ where: { id: existing.id }, data: { planId: plan.id, status: parsed.data.status, periodStart: new Date(), periodEnd } })
      : await this.prisma.admin.subscription.create({ data: { organizationId: id, planId: plan.id, status: parsed.data.status, periodStart: new Date(), periodEnd } });
    // Al asignar plan pagado, la org pasa a ACTIVE
    if (parsed.data.status === "ACTIVE") {
      await this.prisma.admin.organization.update({ where: { id }, data: { status: "ACTIVE", planId: plan.id } });
    }
    await this.audit(req, "platform.subscription.assign", "subscription", sub.id, { planCode: plan.code, status: parsed.data.status });
    return { ok: true, planCode: plan.code, status: sub.status };
  }

  // ------------------------------ Facturas ------------------------------

  @Get("invoices")
  async invoices() {
    const rows = await this.prisma.admin.invoice.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
    const orgIds = [...new Set(rows.map((r) => r.organizationId))];
    const orgs = await this.prisma.admin.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } });
    const nameById = new Map(orgs.map((o) => [o.id, o.name]));
    return rows.map((r) => ({ ...r, organizationName: nameById.get(r.organizationId) ?? "?" }));
  }

  /** Emite una factura para una organización (cobro manual/mock del período). */
  @Post("organizations/:id/invoices")
  async createInvoice(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z
      .object({ amount: z.coerce.number().min(0), currency: z.string().default("CLP"), concept: z.string().default("Suscripción Conversia") })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("amount requerido");
    const count = await this.prisma.admin.invoice.count();
    const number = `CONV-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`;
    const due = new Date();
    due.setDate(due.getDate() + 15);
    const invoice = await this.prisma.admin.invoice.create({
      data: {
        organizationId: id,
        number,
        status: "OPEN",
        currency: parsed.data.currency,
        amountDue: parsed.data.amount,
        lines: [{ concept: parsed.data.concept, amount: parsed.data.amount }],
        dueAt: due,
      },
    });
    await this.audit(req, "platform.invoice.create", "invoice", invoice.id, { number, amount: parsed.data.amount });
    return invoice;
  }

  @Post("invoices/:id/mark-paid")
  async markPaid(@Param("id") id: string, @Req() req: PlatformRequest) {
    const invoice = await this.prisma.admin.invoice.update({ where: { id }, data: { status: "PAID", paidAt: new Date() } });
    await this.audit(req, "platform.invoice.mark_paid", "invoice", id);
    return { ok: true, status: invoice.status };
  }
}

// Validación de planes (helper con parse total/parcial)
const planFields = {
  code: z.string().min(2).max(40),
  name: z.string().min(2).max(80),
  priceClp: z.coerce.number().min(0).default(0),
  priceUsd: z.coerce.number().min(0).default(0),
  interval: z.enum(["monthly", "yearly"]).default("monthly"),
  trialDays: z.coerce.number().int().min(0).max(90).default(0),
  isPublic: z.boolean().default(true),
  order: z.coerce.number().int().default(0),
  active: z.boolean().default(true),
  limits: z.record(z.unknown()).default({}),
  features: z.record(z.unknown()).default({}),
};
const planSchema = {
  parse2(body: unknown) {
    const r = z.object(planFields).safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
    return r.data as any;
  },
  partial2(body: unknown) {
    const r = z.object(planFields).partial().safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
    return r.data as any;
  },
};
