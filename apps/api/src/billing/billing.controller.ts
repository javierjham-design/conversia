import { BadRequestException, Body, Controller, Get, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";
import { getTemplateUsage } from "../common/plan-limits";
import { createPaymentProvider, flowSign, verifyLemonSqueezySignature, verifyStripeSignature } from "./payment-provider";
import { flowCollect, flowCustomerCreate, flowRegisterCard, flowRegisterStatus } from "./flow-subscriptions";
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
      const [org, sub, usage, aiToday, invoices, paymentMethod] = await Promise.all([
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
        tx.paymentMethod.findFirst({ orderBy: { createdAt: "desc" } }),
      ]);
      // Los planes son globales; se leen con el cliente admin (catálogo público)
      const plan = sub ? await this.prisma.admin.plan.findUnique({ where: { id: sub.planId } }) : null;
      const [agents, channels, workflows, users] = usage;
      const limits = (plan?.limits ?? {}) as Record<string, number>;
      const aiBudget = limits.aiTokensDaily ?? getEnv().AI_DAILY_TOKEN_BUDGET_PER_ORG;

      // Estado de cobro para el aviso en la UI (gracia / suspensión).
      const billingSettings = ((org?.settings as Record<string, any>)?.billing ?? {}) as { state?: string; graceEndsAt?: string };
      const billingState =
        org?.status === "SUSPENDED" || org?.status === "CANCELLED"
          ? "suspended"
          : sub?.status === "PAST_DUE"
            ? "grace"
            : "ok";

      // Prueba de 7 días: días restantes para el banner de cuenta regresiva.
      // Si el registro/tick aún no fijó settings.trial, se calcula desde createdAt.
      const trialSettings = ((org?.settings as Record<string, any>)?.trial ?? null) as
        | { endsAt?: string; state?: string }
        | null;
      const trialEndsAt =
        org?.status === "TRIAL"
          ? new Date(trialSettings?.endsAt ?? org.createdAt.getTime() + 7 * 86_400_000)
          : trialSettings?.state === "disabled" && trialSettings?.endsAt
            ? new Date(trialSettings.endsAt)
            : null;
      const trial = trialEndsAt
        ? {
            state: trialSettings?.state === "disabled" ? ("disabled" as const) : ("active" as const),
            endsAt: trialEndsAt.toISOString(),
            daysLeft: Math.max(0, Math.ceil((trialEndsAt.getTime() - Date.now()) / 86_400_000)),
          }
        : null;

      return {
        organization: { name: org?.name, status: org?.status, currency: org?.currency },
        billing: { state: billingState, graceEndsAt: billingSettings.graceEndsAt ?? null, trial },
        plan: plan
          ? {
              code: plan.code,
              name: plan.name,
              priceClp: Number(plan.priceClp),
              priceUsd: Number(plan.priceUsd),
              priceClpYearly: plan.priceClpYearly != null ? Number(plan.priceClpYearly) : null,
              priceUsdYearly: plan.priceUsdYearly != null ? Number(plan.priceUsdYearly) : null,
              // Cadencia REAL de la suscripción (el mismo plan puede ser mensual o anual).
              interval: sub?.interval ?? plan.interval,
              custom: (plan.features as any)?.custom === true,
            }
          : null,
        // Facturables a medida del tenant (se suman a la base del plan).
        billables: this.readBillables(org),
        subscription: sub ? { status: sub.status, periodEnd: sub.periodEnd, interval: sub.interval } : null,
        usage: {
          agents: { used: agents, limit: limits.agents ?? null },
          channels: { used: channels, limit: limits.channels ?? null },
          workflows: { used: workflows, limit: limits.workflows ?? null },
          users: { used: users, limit: limits.users ?? null },
          aiTokensToday: { used: Number(aiToday._sum.quantity ?? 0), limit: aiBudget },
        },
        // Mensajes de plantilla (los que Meta cobra): cupo incluido + excedente.
        templates: await getTemplateUsage(tx),
        invoices,
        paymentMethod: paymentMethod
          ? { provider: paymentMethod.provider, brand: paymentMethod.brand, last4: paymentMethod.last4 }
          : null,
        // Proveedor con el que pagaría hoy (asignado por TuBot o según moneda)
        paymentProvider: ((org?.settings as any)?.paymentProvider as string | undefined) ?? ((org?.currency ?? "CLP") === "CLP" ? "flow" : "lemonsqueezy"),
      };
    });
  }

  /** Catálogo público de planes para elegir/upgradear. */
  /** Catálogo para el tenant: TODOS los planes activos (Enterprise incluido), por precio. */
  /** ¿Plan gratis/de prueba? (costo 0 en ambas monedas). No contratable desde el panel. */
  private isFreePlan(plan: { priceClp: unknown; priceUsd: unknown }): boolean {
    return Number(plan.priceClp) <= 0 && Number(plan.priceUsd) <= 0;
  }

  @Get("plans")
  async plans() {
    requireContext();
    const rows = await this.prisma.admin.plan.findMany({ where: { active: true } });
    return (
      rows
        // FUSIBLE: el plan costo 0 (free/prueba) NO se muestra a los tenants —
        // solo existe en el entorno externo (registro). Si fuera contratable
        // aquí, un cliente podría renovar la prueba eternamente sin pagar.
        .filter((pl) => !this.isFreePlan(pl))
        .map((pl) => ({
          ...pl,
          priceClp: Number(pl.priceClp),
          priceUsd: Number(pl.priceUsd),
          priceClpYearly: pl.priceClpYearly != null ? Number(pl.priceClpYearly) : null,
          priceUsdYearly: pl.priceUsdYearly != null ? Number(pl.priceUsdYearly) : null,
          custom: (pl.features as any)?.custom === true,
        }))
        .sort((a, b) => a.priceClp - b.priceClp)
    );
  }

  // ============================ SUSCRIPCIÓN RECURRENTE ============================
  // La API INICIA (registrar tarjeta, primer cobro, pago manual); el worker (engine +
  // reconciliación) APLICA las transiciones de estado leyendo payment_attempts. Requiere
  // la migración 20260818000000 aplicada y credenciales de Flow.

  /** Monto a cobrar: base de la cadencia + facturables a medida (misma regla que el engine). */
  private subAmount(plan: { priceClp: unknown; priceUsd: unknown; priceClpYearly: unknown; priceUsdYearly: unknown }, interval: string, currency: string, org: { settings?: unknown } | null): number {
    const yearly = interval === "yearly";
    const base = currency === "CLP"
      ? Number(yearly && plan.priceClpYearly != null ? plan.priceClpYearly : plan.priceClp)
      : Number(yearly && plan.priceUsdYearly != null ? plan.priceUsdYearly : plan.priceUsd);
    return base + this.readBillables(org).reduce((a, b) => a + b.amount, 0);
  }

  private async flowCfg() {
    const s = await this.paymentSettings.get();
    if (!s.flow?.apiKey || !s.flow?.secretKey || !s.flow?.baseUrl) throw new BadRequestException("Flow no está configurado para suscripciones.");
    return s.flow;
  }

  /** Alta: elige plan+cadencia y devuelve la URL de Flow para registrar la tarjeta. */
  @Post("subscription/start")
  async subscriptionStart(@Body() body: unknown) {
    const ctx = requirePermission("billing:write");
    const parsed = z.object({ planCode: z.string(), billingInterval: z.enum(["monthly", "yearly"]).default("monthly") }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("planCode requerido");
    const plan = await this.prisma.admin.plan.findUnique({ where: { code: parsed.data.planCode } });
    if (!plan || !plan.active) throw new BadRequestException("Plan no disponible");
    // FUSIBLE anti-prueba-eterna (mismo criterio que checkout): sin planes costo 0.
    if (this.isFreePlan(plan)) throw new BadRequestException("Ese plan no es contratable — elige un plan de pago");
    const org = await this.prisma.admin.organization.findUnique({ where: { id: ctx.organizationId } });
    const user = await this.prisma.admin.user.findUnique({ where: { id: ctx.userId }, select: { email: true, name: true } });
    const cfg = await this.flowCfg();
    // Cliente Flow (reutiliza el existente si ya lo hay en una suscripción previa).
    const existing = await this.prisma.admin.subscription.findFirst({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" } });
    let customerRef = existing?.providerCustomerRef ?? null;
    if (!customerRef) {
      customerRef = await flowCustomerCreate(cfg, { name: org?.name ?? "Cliente", email: user?.email ?? "facturacion@tubot.cl", organizationId: ctx.organizationId });
    }
    // Registra/actualiza la suscripción (aún sin cobrar; estado TRIALING hasta la tarjeta).
    const data = { planId: plan.id, interval: parsed.data.billingInterval, providerCustomerRef: customerRef, cancelAtPeriodEnd: false };
    if (existing) await this.prisma.admin.subscription.update({ where: { id: existing.id }, data });
    else await this.prisma.admin.subscription.create({ data: { organizationId: ctx.organizationId, status: "TRIALING", ...data } });
    let reg: { url: string; token: string };
    try {
      reg = await flowRegisterCard(cfg, { customerId: customerRef, urlReturn: `${getEnv().WEB_URL}/billing?card=1` });
    } catch (err) {
      // El comercio aún no tiene contratado "cobro automático" en Flow: error
      // claro y marcado para que el frontend caiga al checkout de pago único.
      if (/automatic charge/i.test((err as Error).message)) {
        throw new BadRequestException(
          "FLOW_NO_AUTO_CHARGE: tu cuenta de Flow aún no tiene habilitado el cobro automático (suscripciones). Actívalo en el panel de Flow o contacta a Flow; mientras tanto procesamos un pago único.",
        );
      }
      throw err;
    }
    await this.prisma.withTenant(ctx.organizationId, (tx) => tx.auditLog.create({ data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "billing.subscription_start", entityType: "subscription", after: { planCode: plan.code, interval: parsed.data.billingInterval } } }));
    return { url: reg.url, token: reg.token };
  }

  /** Tras volver del registro de tarjeta: si quedó registrada, guarda el medio y COBRA el primer período. */
  @Post("subscription/confirm-card")
  async subscriptionConfirmCard(@Body() body: unknown) {
    const ctx = requirePermission("billing:write");
    const parsed = z.object({ token: z.string().min(6) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("token requerido");
    const cfg = await this.flowCfg();
    const st = await flowRegisterStatus(cfg, parsed.data.token);
    if (!st.registered) return { registered: false };
    const sub = await this.prisma.admin.subscription.findFirst({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" } });
    if (!sub?.providerCustomerRef) throw new BadRequestException("No hay suscripción iniciada");
    const plan = await this.prisma.admin.plan.findUnique({ where: { id: sub.planId } });
    const org = await this.prisma.admin.organization.findUnique({ where: { id: ctx.organizationId } });
    const currency = org?.currency ?? "CLP";
    const amount = plan ? this.subAmount(plan, sub.interval, currency, org) : 0;
    // Guarda el medio de pago (solo token/brand/last4 — nunca datos de tarjeta).
    const pm = await this.prisma.admin.paymentMethod.create({ data: { organizationId: ctx.organizationId, provider: "flow", kind: "card", brand: st.brand, last4: st.last4, providerRef: sub.providerCustomerRef, isDefault: true } });
    await this.prisma.admin.subscription.update({ where: { id: sub.id }, data: { paymentMethodId: pm.id, nextChargeAt: new Date() } });
    // Primer cobro (collect). El worker aplica el resultado por reconciliación.
    await this.startCollect(ctx.organizationId, sub.id, sub.providerCustomerRef, amount, currency, plan?.name ?? "Plan", sub.interval, "auto", 1);
    return { registered: true };
  }

  /** Pago MANUAL del monto adeudado (dentro de la ventana de 48 h o estando suspendido). */
  @Post("subscription/manual-pay")
  async subscriptionManualPay() {
    const ctx = requirePermission("billing:write");
    const sub = await this.prisma.admin.subscription.findFirst({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" } });
    if (!sub?.providerCustomerRef) throw new BadRequestException("No hay suscripción con medio de pago");
    const plan = await this.prisma.admin.plan.findUnique({ where: { id: sub.planId } });
    const org = await this.prisma.admin.organization.findUnique({ where: { id: ctx.organizationId } });
    const currency = org?.currency ?? "CLP";
    const amount = plan ? this.subAmount(plan, sub.interval, currency, org) : 0;
    await this.startCollect(ctx.organizationId, sub.id, sub.providerCustomerRef, amount, currency, plan?.name ?? "Plan", sub.interval, "manual", (sub.retriesDone ?? 0) + 1);
    return { ok: true, amount };
  }

  /** Cancelar: sigue activa hasta el fin del período pagado y ahí se suspende. */
  @Post("subscription/cancel")
  async subscriptionCancel() {
    const ctx = requirePermission("billing:write");
    const sub = await this.prisma.admin.subscription.findFirst({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" } });
    if (!sub) throw new BadRequestException("Sin suscripción");
    await this.prisma.admin.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
    await this.prisma.withTenant(ctx.organizationId, (tx) => tx.auditLog.create({ data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "billing.subscription_cancel", entityType: "subscription", entityId: sub.id } }));
    return { ok: true, activeUntil: sub.periodEnd };
  }

  /** Reactivar antes del fin del período: quita la cancelación. */
  @Post("subscription/reactivate")
  async subscriptionReactivate() {
    const ctx = requirePermission("billing:write");
    const sub = await this.prisma.admin.subscription.findFirst({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" } });
    if (!sub) throw new BadRequestException("Sin suscripción");
    await this.prisma.admin.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false } });
    return { ok: true };
  }

  /** Historial de cobros (intentos) + comprobantes. */
  @Get("subscription/history")
  async subscriptionHistory() {
    const ctx = requireContext();
    const [attempts, invoices, sub] = await Promise.all([
      this.prisma.admin.paymentAttempt.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" }, take: 50 }),
      this.prisma.withTenant(ctx.organizationId, (tx) => tx.invoice.findMany({ orderBy: { createdAt: "desc" }, take: 50 })),
      this.prisma.admin.subscription.findFirst({ where: { organizationId: ctx.organizationId }, orderBy: { createdAt: "desc" } }),
    ]);
    return {
      subscription: sub ? { status: sub.status, interval: sub.interval, periodEnd: sub.periodEnd, nextChargeAt: sub.nextChargeAt, cancelAtPeriodEnd: sub.cancelAtPeriodEnd } : null,
      attempts: attempts.map((a) => ({ id: a.id, amount: Number(a.amount), currency: a.currency, kind: a.kind, status: a.status, reason: a.reason, createdAt: a.createdAt })),
      invoices: invoices.map((i) => ({ number: i.number, amountDue: Number(i.amountDue), currency: i.currency, status: i.status, paidAt: i.paidAt, createdAt: i.createdAt })),
    };
  }

  /** Inicia un cobro (collect) y registra el intento PENDIENTE; el worker aplica el resultado. */
  private async startCollect(organizationId: string, subId: string, customerRef: string, amount: number, currency: string, planName: string, interval: string, kind: "auto" | "manual", attemptNumber: number) {
    const cfg = await this.flowCfg();
    const commerceOrder = `sub-${subId}-${Date.now()}`;
    await this.prisma.admin.paymentAttempt.create({ data: { organizationId, subscriptionId: subId, commerceOrder, amount, currency, kind, attemptNumber, status: "pending", provider: "flow" } });
    const r = await flowCollect(cfg, { customerId: customerRef, commerceOrder, subject: `Plan ${planName} (${interval === "yearly" ? "anual" : "mensual"})`, amount, currency, urlConfirmation: `${getEnv().API_URL}/billing/webhooks/flow`, urlReturn: `${getEnv().WEB_URL}/billing` });
    await this.prisma.admin.paymentAttempt.updateMany({ where: { commerceOrder }, data: { providerRef: r.token ?? undefined, status: r.ok ? "pending" : "failed", reason: r.reason ?? undefined } });
  }

  /** Bolsa de mensajes del tenant: saldo, incluido y paquetes disponibles. */
  @Get("wallet")
  async wallet() {
    const ctx = requireContext();
    const [wallet, packages] = await Promise.all([
      this.prisma.withTenant(ctx.organizationId, (tx) => tx.messageWallet.findUnique({ where: { organizationId: ctx.organizationId } })),
      this.prisma.admin.messagePackage.findMany({ where: { active: true }, orderBy: { order: "asc" } }),
    ]);
    const balance = wallet?.balance ?? 0;
    const included = wallet?.includedPerPeriod ?? 0;
    return {
      balance,
      included,
      // % restante sobre el incluido del período (para la barra y los avisos 80/100).
      remainingPct: included > 0 ? Math.max(0, Math.round((balance / included) * 100)) : null,
      packages: packages.map((p) => ({ code: p.code, name: p.name, credits: p.credits, priceClp: p.priceClp, priceUsd: Number(p.priceUsd) })),
    };
  }

  /** Inicia el checkout de cambio de plan (mock en dev, Stripe en prod). */
  @Post("checkout")
  async checkout(@Body() body: unknown) {
    const ctx = requirePermission("billing:write");
    const parsed = z.object({ planCode: z.string(), couponCode: z.string().max(40).optional(), billingInterval: z.enum(["monthly", "yearly"]).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("planCode requerido");
    const plan = await this.prisma.admin.plan.findUnique({ where: { code: parsed.data.planCode } });
    if (!plan || !plan.active) throw new BadRequestException("Plan no disponible");
    // FUSIBLE anti-prueba-eterna: contratar un plan costo 0 activaría la org sin
    // pago (escapando del ciclo de 7 días). El free solo existe en el registro.
    if (this.isFreePlan(plan)) throw new BadRequestException("Ese plan no es contratable — elige un plan de pago");

    const org = await this.prisma.withTenant(ctx.organizationId, (tx) => tx.organization.findUnique({ where: { id: ctx.organizationId } }));
    const currency = org?.currency ?? "CLP";
    // Cadencia elegida: anual solo si el plan tiene precio anual configurado.
    const wantYearly = parsed.data.billingInterval === "yearly";
    const yearlyPrice = currency === "CLP" ? Number(plan.priceClpYearly ?? 0) : Number(plan.priceUsdYearly ?? 0);
    if (wantYearly && yearlyPrice <= 0) throw new BadRequestException("Este plan no tiene precio anual configurado");
    const useYearly = wantYearly && yearlyPrice > 0;
    const interval = useYearly ? "yearly" : "monthly";
    const baseAmount = useYearly ? yearlyPrice : currency === "CLP" ? Number(plan.priceClp) : Number(plan.priceUsd);
    // Facturables a medida del tenant (plan "desde"): se suman a la base (el cupón solo
    // descuenta la base, no los facturables).
    const billablesTotal = this.readBillables(org).reduce((a, b) => a + b.amount, 0);
    const applied = await this.applyCoupon(parsed.data.couponCode, baseAmount, currency);
    const listAmount = baseAmount + billablesTotal;
    const amount = applied.amount + billablesTotal;
    const user = await this.prisma.admin.user.findUnique({ where: { id: ctx.userId }, select: { email: true } });
    const settings = await this.paymentSettings.get();
    const preferred = (org?.settings as any)?.paymentProvider as string | undefined; // proveedor asignado al tenant
    const provider = createPaymentProvider(settings, currency, preferred);
    // Lemon Squeezy: la variante anual es otra (el precio lo fija LS server-side).
    const feats = (plan.features as any) ?? {};
    const variantId = useYearly ? (feats.lsVariantIdYearly ?? feats.lsVariantId) : feats.lsVariantId;
    const session = await provider.createCheckout({
      organizationId: ctx.organizationId,
      planCode: plan.code,
      amount,
      currency,
      email: user?.email,
      interval,
      variantId: variantId ? String(variantId) : undefined,
      successUrl: `${getEnv().WEB_URL}/billing`,
      cancelUrl: `${getEnv().WEB_URL}/billing`,
    });
    // Cuenta la redención sólo cuando el checkout se creó bien (no en validaciones fallidas).
    if (applied.coupon) {
      await this.prisma.admin.coupon.update({ where: { id: applied.coupon.id }, data: { timesRedeemed: { increment: 1 } } });
    }
    await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "billing.checkout", entityType: "plan", entityId: plan.id, after: { planCode: plan.code, provider: session.provider, couponCode: applied.coupon?.code ?? null, amount, interval } },
      }),
    );
    return { ...session, mock: session.provider === "mock", listAmount, amount, interval, couponCode: applied.coupon?.code ?? null };
  }

  /** Compra de un PAQUETE de mensajes: checkout por el precio del paquete. */
  @Post("buy-package")
  async buyPackage(@Body() body: unknown) {
    const ctx = requirePermission("billing:write");
    const parsed = z.object({ code: z.string().max(60) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("code requerido");
    const pkg = await this.prisma.admin.messagePackage.findUnique({ where: { code: parsed.data.code } });
    if (!pkg || !pkg.active) throw new BadRequestException("Paquete no disponible");
    const org = await this.prisma.withTenant(ctx.organizationId, (tx) => tx.organization.findUnique({ where: { id: ctx.organizationId } }));
    const currency = org?.currency ?? "CLP";
    const amount = currency === "CLP" ? pkg.priceClp : Number(pkg.priceUsd);
    const user = await this.prisma.admin.user.findUnique({ where: { id: ctx.userId }, select: { email: true } });
    const settings = await this.paymentSettings.get();
    const preferred = (org?.settings as any)?.paymentProvider as string | undefined;
    const provider = createPaymentProvider(settings, currency, preferred);
    const session = await provider.createCheckout({
      organizationId: ctx.organizationId,
      planCode: `pkg:${pkg.code}`, // el webhook detecta el prefijo y acredita el paquete
      amount,
      currency,
      email: user?.email,
      interval: "monthly",
      successUrl: `${getEnv().WEB_URL}/settings/plan`,
      cancelUrl: `${getEnv().WEB_URL}/settings/plan`,
    });
    await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.auditLog.create({ data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "billing.buy_package", entityType: "package", entityId: pkg.code, after: { amount, provider: session.provider } } }),
    );
    return { ...session, mock: session.provider === "mock", amount, code: pkg.code };
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
    const parsed = z.object({ planCode: z.string(), billingInterval: z.enum(["monthly", "yearly"]).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("planCode requerido");
    if (getEnv().NODE_ENV === "production" && getEnv().STRIPE_SECRET_KEY) {
      throw new BadRequestException("Confirmación mock deshabilitada: hay pasarela real configurada");
    }
    await this.activateOrCredit(ctx.organizationId, parsed.data.planCode, "mock", undefined, parsed.data.billingInterval ?? "monthly");
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
        // S-4: el monto pagado debe corresponder al del checkout que emitimos
        // (ambos en unidad menor). Sin expectedAmount (sesiones previas) no se valida.
        if (this.amountMismatch(meta.expectedAmount, obj.amount_total)) {
          await this.reportAmountMismatch(organizationId, meta.planCode, "stripe", meta.expectedAmount, obj.amount_total, obj.id);
          return { received: true, rejected: "amount_mismatch" };
        }
        await this.activateOrCredit(organizationId, meta.planCode, "stripe", obj.subscription ?? obj.id, meta.interval === "yearly" ? "yearly" : "monthly");
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
        // S-4: lo pagado (getStatus firmado) debe calzar con el checkout emitido.
        if (this.amountMismatch(meta.expectedAmount, status?.amount)) {
          await this.reportAmountMismatch(meta.organizationId, meta.planCode, "flow", meta.expectedAmount, status?.amount, token);
          return { received: true, rejected: "amount_mismatch" };
        }
        await this.activateOrCredit(meta.organizationId, meta.planCode, "flow", token, meta.interval === "yearly" ? "yearly" : "monthly");
      }
    }
    return { received: true };
  }

  /** S-4: hay conflicto solo si ambos montos existen y difieren en más de 1 unidad. */
  private amountMismatch(expected: unknown, paid: unknown): boolean {
    const e = Number(expected);
    const p = Number(paid);
    if (!Number.isFinite(e) || !Number.isFinite(p)) return false;
    return Math.abs(p - e) > 1;
  }

  /** Deja rastro auditable de un pago con monto distinto al del checkout emitido. */
  private async reportAmountMismatch(
    organizationId: string,
    planCode: string,
    provider: string,
    expected: unknown,
    paid: unknown,
    providerRef?: string,
  ): Promise<void> {
    console.error(`✖ billing: monto pagado no coincide (${provider} ${planCode}): esperado=${expected} pagado=${paid} ref=${providerRef}`);
    await this.prisma
      .withTenant(organizationId, (tx) =>
        tx.auditLog.create({
          data: {
            organizationId,
            actorType: "system",
            actorId: "billing-webhook",
            action: "billing.amount_mismatch",
            entityType: "plan",
            entityId: planCode,
            after: { provider, expected: String(expected), paid: String(paid), providerRef: providerRef ?? null },
          },
        }),
      )
      .catch(() => undefined);
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
        await this.activateOrCredit(organizationId, planCode, "lemonsqueezy", subId, custom.billing_interval === "yearly" ? "yearly" : "monthly");
      }
    }
    return { received: true };
  }

  /** Enruta el pago confirmado: `pkg:<code>` acredita un paquete; si no, activa plan. */
  private async activateOrCredit(organizationId: string, planCode: string, provider: string, providerRef?: string, interval: string = "monthly") {
    if (planCode.startsWith("pkg:")) return this.creditPackage(organizationId, planCode.slice(4), provider, providerRef);
    return this.activate(organizationId, planCode, provider, providerRef, interval);
  }

  /** Facturables a medida del tenant (settings.billables): se suman a la base del plan. */
  private readBillables(org: { settings?: unknown } | null): Array<{ concept: string; amount: number }> {
    const b = (org?.settings as Record<string, unknown> | undefined)?.billables;
    if (!Array.isArray(b)) return [];
    return b
      .filter((x): x is { concept: string; amount: number } => !!x && typeof (x as any).concept === "string" && Number((x as any).amount) > 0)
      .map((x) => ({ concept: String(x.concept), amount: Math.round(Number(x.amount)) }));
  }

  /**
   * Acredita un PAQUETE de mensajes a la bolsa (compra prepago adicional) y emite
   * la factura. Idempotencia garantizada por el dedup de webhooks del llamador.
   * Nota: los créditos comprados quedan en el saldo y, como todo saldo, están
   * sujetos al tope de acumulación de 1 mes en la renovación.
   */
  private async creditPackage(organizationId: string, code: string, provider: string, providerRef?: string) {
    const pkg = await this.prisma.admin.messagePackage.findUnique({ where: { code } });
    if (!pkg || !pkg.active) return;
    const org = await this.prisma.admin.organization.findUnique({ where: { id: organizationId }, select: { currency: true } });
    const currency = org?.currency ?? "CLP";
    const amount = currency === "CLP" ? pkg.priceClp : Number(pkg.priceUsd);
    const w = await this.prisma.admin.messageWallet.findUnique({ where: { organizationId } });
    const balance = (w?.balance ?? 0) + pkg.credits;
    await this.prisma.admin.messageWallet.upsert({
      where: { organizationId },
      create: { organizationId, balance, includedPerPeriod: 0, carryoverCap: 0 },
      update: { balance },
    });
    await this.prisma.admin.walletLedger.create({
      data: { organizationId, delta: pkg.credits, reason: "package_purchase", balanceAfter: balance, refType: "package", refId: pkg.code },
    });
    const count = await this.prisma.admin.invoice.count();
    await this.prisma.admin.invoice.create({
      data: {
        organizationId,
        number: `CONV-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`,
        status: "PAID",
        currency,
        amountDue: amount,
        lines: [{ concept: `Paquete ${pkg.name} (${pkg.credits.toLocaleString("es-CL")} mensajes)`, amount }],
        paidAt: new Date(),
        provider,
        providerRef: providerRef ?? null,
      },
    });
  }

  /**
   * Activa/renueva la suscripción del tenant y emite la factura pagada. La usan
   * el mock (dev) y los webhooks de Stripe/Flow/Lemon Squeezy (prod). Cliente admin: es una
   * operación de plataforma sobre subscription/organization/invoice.
   */
  private async activate(organizationId: string, planCode: string, provider: string, providerRef?: string, interval: string = "monthly") {
    const plan = await this.prisma.admin.plan.findUnique({ where: { code: planCode } });
    if (!plan) return;
    const org = await this.prisma.admin.organization.findUnique({ where: { id: organizationId } });
    if (!org) return;
    const currency = org.currency ?? "CLP";
    const yearly = interval === "yearly";
    const monthlyAmount = currency === "CLP" ? Number(plan.priceClp) : Number(plan.priceUsd);
    const yearlyAmount = currency === "CLP" ? Number(plan.priceClpYearly ?? 0) : Number(plan.priceUsdYearly ?? 0);
    // Si se pidió anual pero el plan no tiene precio anual, cae a mensual (defensivo).
    const useYearly = yearly && yearlyAmount > 0;
    const baseAmount = useYearly ? yearlyAmount : monthlyAmount;
    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + (useYearly ? 12 : 1));

    const existing = await this.prisma.admin.subscription.findFirst({ where: { organizationId }, orderBy: { createdAt: "desc" } });

    // Modelo PREPAGO: plan base + FACTURABLES a medida del tenant (plan "desde").
    // Los mensajes de plantilla se pagan por adelantado con la bolsa + paquetes.
    const billables = this.readBillables(org);
    const lines: Array<{ concept: string; amount: number }> = [
      { concept: `Plan ${plan.name} (${useYearly ? "anual" : "mensual"})`, amount: baseAmount },
      ...billables,
    ];

    if (existing) {
      await this.prisma.admin.subscription.update({ where: { id: existing.id }, data: { planId: plan.id, status: "ACTIVE", interval: useYearly ? "yearly" : "monthly", periodStart: new Date(), periodEnd } });
    } else {
      await this.prisma.admin.subscription.create({ data: { organizationId, planId: plan.id, status: "ACTIVE", interval: useYearly ? "yearly" : "monthly", periodStart: new Date(), periodEnd } });
    }
    await this.prisma.admin.organization.update({ where: { id: organizationId }, data: { status: "ACTIVE", planId: plan.id } });

    // Bolsa prepagada: el período pagado recarga el cupo del plan, acumulando el
    // saldo no usado hasta 1 mes de bolsa (docs/PREPAID_WALLET_DESIGN.md).
    await this.topUpWallet(organizationId, plan).catch(() => undefined);

    const totalDue = lines.reduce((a, l) => a + l.amount, 0);
    if (totalDue > 0) {
      const count = await this.prisma.admin.invoice.count();
      await this.prisma.admin.invoice.create({
        data: {
          organizationId,
          number: `CONV-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`,
          status: "PAID",
          currency,
          amountDue: totalDue,
          lines,
          paidAt: new Date(),
          provider,
          providerRef: providerRef ?? null,
        },
      });
    }
  }

  /** Recarga la bolsa al renovar: balance = min(saldo, cupo) + cupo (carryover 1 mes). */
  private async topUpWallet(organizationId: string, plan: { features: unknown }): Promise<void> {
    const feats = (plan.features as Record<string, any>) ?? {};
    const q = Number(feats.templateMessages);
    // −1 = ilimitado (práctico); 0 = plan sin cupo (Free); sin definir = mínimo seguro.
    const included = q === -1 ? 1_000_000 : Number.isFinite(q) && q >= 0 ? Math.round(q) : getEnv().WALLET_DEFAULT_QUOTA;
    const w = await this.prisma.admin.messageWallet.findUnique({ where: { organizationId } });
    const keep = w ? Math.min(w.balance, included) : 0; // carryover tope = 1 mes de bolsa
    const balance = keep + included;
    await this.prisma.admin.messageWallet.upsert({
      where: { organizationId },
      create: { organizationId, balance, includedPerPeriod: included, carryoverCap: included, periodStart: new Date() },
      update: { balance, includedPerPeriod: included, carryoverCap: included, periodStart: new Date() },
    });
    await this.prisma.admin.walletLedger.create({
      data: { organizationId, delta: balance - (w?.balance ?? 0), reason: "plan_renewal", balanceAfter: balance, refType: "invoice" },
    });
  }
}
