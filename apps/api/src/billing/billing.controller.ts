import { BadRequestException, Body, Controller, Get, Post } from "@nestjs/common";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { createPaymentProvider } from "./payment-provider";

/**
 * Facturación del TENANT (su propia suscripción). Vista del plan actual, uso
 * vs. límites, facturas y checkout para cambiar de plan. Todo tenant-scoped
 * (withTenant / RLS). El checkout usa la pasarela configurada (mock en dev).
 */
@Controller("billing")
export class BillingController {
  constructor(private prisma: PrismaService) {}

  @Get("me")
  overview() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const [org, sub, usage, aiToday, invoices] = await Promise.all([
        tx.organization.findUnique({ where: { id: ctx.organizationId } }),
        tx.subscription.findFirst({ orderBy: { createdAt: "desc" } }),
        Promise.all([
          tx.agent.count({ where: { deletedAt: null } }),
          tx.channelConnection.count({ where: { status: "active" } }),
          tx.workflow.count({ where: { deletedAt: null } }),
          tx.organizationUser.count({ where: { active: true } }),
        ]),
        tx.usageEvent.aggregate({ where: { type: "ai_tokens", occurredAt: { gte: startOfDay } }, _sum: { quantity: true } }),
        tx.invoice.findMany({ orderBy: { createdAt: "desc" }, take: 12 }),
      ]);
      // Los planes son globales; se leen con el cliente admin (catálogo público)
      const plan = sub ? await this.prisma.admin.plan.findUnique({ where: { id: sub.planId } }) : null;
      const [agents, channels, workflows, users] = usage;
      const limits = (plan?.limits ?? {}) as Record<string, number>;
      const aiBudget = limits.aiTokensDaily ?? getEnv().AI_DAILY_TOKEN_BUDGET_PER_ORG;

      return {
        organization: { name: org?.name, status: org?.status, currency: org?.currency },
        plan: plan
          ? { code: plan.code, name: plan.name, priceClp: Number(plan.priceClp), priceUsd: Number(plan.priceUsd), interval: plan.interval }
          : null,
        subscription: sub ? { status: sub.status, periodEnd: sub.periodEnd } : null,
        usage: {
          agents: { used: agents, limit: limits.agents ?? null },
          channels: { used: channels, limit: limits.channels ?? null },
          workflows: { used: workflows, limit: limits.workflows ?? null },
          users: { used: users, limit: limits.users ?? null },
          aiTokensToday: { used: Number(aiToday._sum.quantity ?? 0), limit: aiBudget },
        },
        invoices,
      };
    });
  }

  /** Catálogo público de planes para elegir/upgradear. */
  @Get("plans")
  plans() {
    requireContext();
    return this.prisma.admin.plan.findMany({ where: { isPublic: true, active: true }, orderBy: { order: "asc" } });
  }

  /** Inicia el checkout de cambio de plan (mock en dev, Stripe en prod). */
  @Post("checkout")
  async checkout(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ planCode: z.string() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("planCode requerido");
    const plan = await this.prisma.admin.plan.findUnique({ where: { code: parsed.data.planCode } });
    if (!plan || !plan.active) throw new BadRequestException("Plan no disponible");

    const org = await this.prisma.withTenant(ctx.organizationId, (tx) => tx.organization.findUnique({ where: { id: ctx.organizationId } }));
    const currency = org?.currency ?? "CLP";
    const amount = currency === "CLP" ? Number(plan.priceClp) : Number(plan.priceUsd);
    const provider = createPaymentProvider();
    const session = await provider.createCheckout({
      organizationId: ctx.organizationId,
      planCode: plan.code,
      amount,
      currency,
      successUrl: `${getEnv().WEB_URL}/billing`,
      cancelUrl: `${getEnv().WEB_URL}/billing`,
    });
    await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "billing.checkout", entityType: "plan", entityId: plan.id, after: { planCode: plan.code, provider: session.provider } },
      }),
    );
    return { ...session, mock: session.provider === "mock" };
  }

  /**
   * Confirmación mock del checkout: activa la suscripción y emite factura
   * pagada. En producción esto lo hace el webhook del proveedor (Stripe).
   */
  @Post("mock-confirm")
  async mockConfirm(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ planCode: z.string() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("planCode requerido");
    if (getEnv().NODE_ENV === "production" && process.env.STRIPE_SECRET_KEY) {
      throw new BadRequestException("Confirmación mock deshabilitada: hay pasarela real configurada");
    }
    const plan = await this.prisma.admin.plan.findUnique({ where: { code: parsed.data.planCode } });
    if (!plan) throw new BadRequestException("Plan desconocido");

    const org = await this.prisma.withTenant(ctx.organizationId, (tx) => tx.organization.findUnique({ where: { id: ctx.organizationId } }));
    const currency = org?.currency ?? "CLP";
    const amount = currency === "CLP" ? Number(plan.priceClp) : Number(plan.priceUsd);
    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + (plan.interval === "yearly" ? 12 : 1));

    // Suscripción + factura pagada (cliente admin: subscription/plan/invoice)
    const existing = await this.prisma.admin.subscription.findFirst({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" } });
    if (existing) {
      await this.prisma.admin.subscription.update({ where: { id: existing.id }, data: { planId: plan.id, status: "ACTIVE", periodStart: new Date(), periodEnd } });
    } else {
      await this.prisma.admin.subscription.create({ data: { organizationId: ctx.organizationId, planId: plan.id, status: "ACTIVE", periodStart: new Date(), periodEnd } });
    }
    await this.prisma.admin.organization.update({ where: { id: ctx.organizationId }, data: { status: "ACTIVE", planId: plan.id } });
    if (amount > 0) {
      const count = await this.prisma.admin.invoice.count();
      await this.prisma.admin.invoice.create({
        data: {
          organizationId: ctx.organizationId,
          number: `CONV-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`,
          status: "PAID",
          currency,
          amountDue: amount,
          lines: [{ concept: `Plan ${plan.name} (${plan.interval})`, amount }],
          paidAt: new Date(),
          provider: "mock",
        },
      });
    }
    return { ok: true, planCode: plan.code, note: "Pago simulado (dev). En producción lo confirma el webhook de la pasarela." };
  }
}
