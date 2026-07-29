import { BadRequestException, Body, Controller, Get, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";
import { createPaymentProvider, flowSign, verifyLemonSqueezySignature, verifyStripeSignature } from "./payment-provider";
import { PaymentSettingsService } from "./payment-settings.service";

/**
 * Facturación del TENANT (su propia suscripción). Vista del plan actual, uso
 * vs. límites, facturas y checkout para cambiar de plan. Todo tenant-scoped
 * (withTenant / RLS). Las credenciales de pasarela salen del gestor (BD/env).
 */
@Controller("billing")
export class BillingController {
  constructor(
    private prisma: PrismaService,
    private paymentSettings: PaymentSettingsService,
  ) {}

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
    const ctx = requirePermission("billing:write");
    const parsed = z.object({ planCode: z.string(), couponCode: z.string().max(40).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("planCode requerido");
    const plan = await this.prisma.admin.plan.findUnique({ where: { code: parsed.data.planCode } });
    if (!plan || !plan.active) throw new BadRequestException("Plan no disponible");

    const org = await this.prisma.withTenant(ctx.organizationId, (tx) => tx.organization.findUnique({ where: { id: ctx.organizationId } }));
    const currency = org?.currency ?? "CLP";
    const listAmount = currency === "CLP" ? Number(plan.priceClp) : Number(plan.priceUsd);
    const applied = await this.applyCoupon(parsed.data.couponCode, listAmount, currency);
    const amount = applied.amount;
    const user = await this.prisma.admin.user.findUnique({ where: { id: ctx.userId }, select: { email: true } });
    const settings = await this.paymentSettings.get();
    const preferred = (org?.settings as any)?.paymentProvider as string | undefined; // proveedor asignado al tenant
    const provider = createPaymentProvider(settings, currency, preferred);
    const session = await provider.createCheckout({
      organizationId: ctx.organizationId,
      planCode: plan.code,
      amount,
      currency,
      email: user?.email,
      interval: plan.interval,
      variantId: (plan.features as any)?.lsVariantId ? String((plan.features as any).lsVariantId) : undefined,
      successUrl: `${getEnv().WEB_URL}/billing`,
      cancelUrl: `${getEnv().WEB_URL}/billing`,
    });
    // Cuenta la redención sólo cuando el checkout se creó bien (no en validaciones fallidas).
    if (applied.coupon) {
      await this.prisma.admin.coupon.update({ where: { id: applied.coupon.id }, data: { timesRedeemed: { increment: 1 } } });
    }
    await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "billing.checkout", entityType: "plan", entityId: plan.id, after: { planCode: plan.code, provider: session.provider, couponCode: applied.coupon?.code ?? null, amount } },
      }),
    );
    return { ...session, mock: session.provider === "mock", listAmount, amount, couponCode: applied.coupon?.code ?? null };
  }

  /** Valida un cupón y calcula el monto con descuento. No incrementa la redención. */
  private async applyCoupon(code: string | undefined, amount: number, currency: string) {
    if (!code) return { amount, coupon: null as null | { id: string; code: string } };
    const coupon = await this.prisma.admin.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
    if (!coupon || !coupon.active) throw new BadRequestException("Cupón inválido");
    if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new BadRequestException("Cupón expirado");
    if (coupon.maxRedemptions != null && coupon.timesRedeemed >= coupon.maxRedemptions) throw new BadRequestException("Cupón agotado");
    if (coupon.discountType === "FIXED" && coupon.currency && coupon.currency !== currency) {
      throw new BadRequestException("Cupón no válido para esta moneda");
    }
    const value = Number(coupon.discountValue);
    const discounted = coupon.discountType === "PERCENT" ? amount * (1 - value / 100) : amount - value;
    return { amount: Math.max(0, Math.round(discounted)), coupon: { id: coupon.id, code: coupon.code } };
  }

  /**
   * Idempotencia de webhooks: registra (provider, eventId) de forma atómica.
   * Devuelve true si el evento YA se procesó (no volver a activar/facturar).
   */
  private async alreadyProcessed(provider: string, eventId: string, type?: string): Promise<boolean> {
    try {
      await this.prisma.admin.webhookEvent.create({ data: { provider, eventId, type } });
      return false;
    } catch (e: any) {
      if (e?.code === "P2002") return true; // violación de unique → ya procesado
      throw e;
    }
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
    if (getEnv().NODE_ENV === "production" && getEnv().STRIPE_SECRET_KEY) {
      throw new BadRequestException("Confirmación mock deshabilitada: hay pasarela real configurada");
    }
    await this.activate(ctx.organizationId, parsed.data.planCode, "mock");
    return { ok: true, planCode: parsed.data.planCode, note: "Pago simulado (dev). En producción lo confirma el webhook de la pasarela." };
  }

  /** Webhook de Stripe (firmado): activa/renueva la suscripción al confirmarse el pago. */
  @Post("webhooks/stripe")
  async stripeWebhook(@Req() req: Request & { rawBody?: Buffer }) {
    const env = getEnv();
    if (!env.STRIPE_WEBHOOK_SECRET) throw new BadRequestException("Webhook de Stripe no configurado");
    const sig = req.headers["stripe-signature"] as string | undefined;
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), "utf-8");
    if (!verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET)) {
      throw new UnauthorizedException("Firma de Stripe inválida");
    }
    const event: any = JSON.parse(raw.toString("utf8"));
    // Idempotencia: Stripe reintenta; no procesar el mismo evento dos veces.
    if (event?.id && (await this.alreadyProcessed("stripe", String(event.id), event.type))) {
      return { received: true, deduped: true };
    }
    const obj = event?.data?.object ?? {};
    if (event?.type === "checkout.session.completed") {
      const meta = obj.metadata ?? {};
      const organizationId = meta.organizationId ?? obj.client_reference_id;
      if (organizationId && meta.planCode) {
        await this.activate(organizationId, meta.planCode, "stripe", obj.subscription ?? obj.id);
      }
    }
    return { received: true };
  }

  /** Webhook de Flow: consulta el estado firmado (getStatus) y activa si está pagado. */
  @Post("webhooks/flow")
  async flowWebhook(@Body() body: any) {
    const token = body?.token;
    const settings = await this.paymentSettings.get();
    if (!token || !settings.flow) {
      throw new BadRequestException("Webhook de Flow inválido o no configurado");
    }
    const params: Record<string, string> = { apiKey: settings.flow.apiKey, token };
    params.s = flowSign(params, settings.flow.secretKey);
    const res = await fetch(`${settings.flow.baseUrl}/payment/getStatus?${new URLSearchParams(params).toString()}`);
    const status: any = await res.json().catch(() => ({}));
    // status.status: 1 pendiente · 2 pagado · 3 rechazado · 4 anulado
    if (status?.status === 2 && status?.optional) {
      let meta: any = {};
      try {
        meta = typeof status.optional === "string" ? JSON.parse(status.optional) : status.optional;
      } catch {
        meta = {};
      }
      if (meta.organizationId && meta.planCode) {
        // Dedup al confirmarse el pago (Flow reenvía callbacks del mismo token).
        if (await this.alreadyProcessed("flow", token, "flow.payment")) {
          return { received: true, deduped: true };
        }
        await this.activate(meta.organizationId, meta.planCode, "flow", token);
      }
    }
    return { received: true };
  }

  /** Webhook de Lemon Squeezy (MoR). Firma X-Signature (HMAC del raw body). */
  @Post("webhooks/lemonsqueezy")
  async lemonSqueezyWebhook(@Req() req: Request & { rawBody?: Buffer }) {
    const settings = await this.paymentSettings.get();
    const secret = settings.lemonSqueezy?.webhookSecret;
    if (!secret) throw new BadRequestException("Webhook de Lemon Squeezy no configurado");
    const sig = req.headers["x-signature"] as string | undefined;
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), "utf-8");
    if (!verifyLemonSqueezySignature(raw, sig, secret)) {
      throw new UnauthorizedException("Firma de Lemon Squeezy inválida");
    }
    const event: any = JSON.parse(raw.toString("utf8"));
    const eventName: string | undefined = event?.meta?.event_name;
    const custom = event?.meta?.custom_data ?? {};
    const organizationId = custom.organization_id;
    const planCode = custom.plan_code;
    const subId = event?.data?.id;
    const updatedAt = event?.data?.attributes?.updated_at ?? "";
    // Idempotencia (LS reintenta): dedup por evento+suscripción+fecha.
    if (subId && (await this.alreadyProcessed("lemonsqueezy", `${eventName}:${subId}:${updatedAt}`, eventName))) {
      return { received: true, deduped: true };
    }
    if (
      organizationId &&
      planCode &&
      (eventName === "subscription_created" || eventName === "subscription_updated" || eventName === "subscription_payment_success")
    ) {
      const status = event?.data?.attributes?.status; // active | on_trial | past_due | cancelled | expired | unpaid
      if (status === "active" || status === "on_trial" || eventName === "subscription_payment_success") {
        await this.activate(organizationId, planCode, "lemonsqueezy", subId);
      }
    }
    return { received: true };
  }

  /**
   * Activa/renueva la suscripción del tenant y emite la factura pagada. La usan
   * el mock (dev) y los webhooks de Stripe/Flow/Lemon Squeezy (prod). Cliente admin: es una
   * operación de plataforma sobre subscription/organization/invoice.
   */
  private async activate(organizationId: string, planCode: string, provider: string, providerRef?: string) {
    const plan = await this.prisma.admin.plan.findUnique({ where: { code: planCode } });
    if (!plan) return;
    const org = await this.prisma.admin.organization.findUnique({ where: { id: organizationId } });
    if (!org) return;
    const currency = org.currency ?? "CLP";
    const amount = currency === "CLP" ? Number(plan.priceClp) : Number(plan.priceUsd);
    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + (plan.interval === "yearly" ? 12 : 1));

    const existing = await this.prisma.admin.subscription.findFirst({ where: { organizationId }, orderBy: { createdAt: "desc" } });
    if (existing) {
      await this.prisma.admin.subscription.update({ where: { id: existing.id }, data: { planId: plan.id, status: "ACTIVE", periodStart: new Date(), periodEnd } });
    } else {
      await this.prisma.admin.subscription.create({ data: { organizationId, planId: plan.id, status: "ACTIVE", periodStart: new Date(), periodEnd } });
    }
    await this.prisma.admin.organization.update({ where: { id: organizationId }, data: { status: "ACTIVE", planId: plan.id } });

    if (amount > 0) {
      const count = await this.prisma.admin.invoice.count();
      await this.prisma.admin.invoice.create({
        data: {
          organizationId,
          number: `CONV-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`,
          status: "PAID",
          currency,
          amountDue: amount,
          lines: [{ concept: `Plan ${plan.name} (${plan.interval})`, amount }],
          paidAt: new Date(),
          provider,
          providerRef: providerRef ?? null,
        },
      });
    }
  }
}
