import { BadRequestException, Body, Controller, Get, Post, Put, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { getEnv, brandOf, billingReturnUrls } from "@conversia/config";
import { messageWalletQuota, refillMessageWallet } from "@conversia/database";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";
import { getTemplateUsage } from "../common/plan-limits";
import { createPaymentProvider, flowSign, verifyLemonSqueezySignature, verifyStripeSignature } from "./payment-provider";
import { flowCollect, flowCustomerCreate, flowRegisterCard, flowRegisterStatus } from "./flow-subscriptions";
import { PaymentSettingsService } from "./payment-settings.service";
import { isLotPack, packUnitForOrg } from "./pack-unit";
import { resolveConsent } from "./auto-recharge-consent";

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
    const ctx = requireContext();
    // Catálogo POR MARCA (F5/H9): un tenant solo ve los planes de su marca. Una org
    // conversia ve conversia_*; una org tubot ve exactamente lo de hoy (brand default).
    const org = await this.prisma.admin.organization.findUnique({ where: { id: ctx.organizationId }, select: { brand: true } });
    const brand = brandOf(org).key;
    const rows = await this.prisma.admin.plan.findMany({ where: { active: true, brand } });
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

  /**
   * Resumen de consumo de la bolsa para el contador (F5/H26; F3 lo consume): saldo,
   * consumo del mes por categoría, proyección simple (promedio diario × días restantes)
   * y si se cruzó el 80 %. Las alertas al 80 % las emite notifyWalletThresholds al debitar.
   */
  /** Features del plan vigente (suscripción ACTIVE/TRIALING; free si no hay). */
  private async activePlanFeatures(organizationId: string): Promise<Record<string, unknown>> {
    const admin = this.prisma.admin;
    const sub = await admin.subscription.findFirst({ where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } }, orderBy: { createdAt: "desc" }, select: { planId: true } });
    const plan = sub?.planId
      ? await admin.plan.findUnique({ where: { id: sub.planId }, select: { features: true } })
      : await admin.plan.findUnique({ where: { code: "free" }, select: { features: true } });
    return (plan?.features as Record<string, unknown> | undefined) ?? {};
  }

  /** V2-1 — medidor de la bolsa de CONVERSACIONES (solo lectura; la lógica vive en el worker). */
  /**
   * CRE 2 — medidor de la bolsa de LOTES, que sirve a las dos unidades (conversaciones y
   * Créditos IA): el saldo, el rollover y la gracia funcionan igual; lo único que cambia es
   * cómo se llama la unidad y cuánta gracia hay. `unit` y `graceLimit` entran por parámetro
   * para que el panel muestre la palabra correcta en vez de decirle "conversaciones" a quien
   * compró créditos.
   */
  private async conversationWalletSummary(organizationId: string, included: number, opts: { unit?: "conversation" | "credit"; graceLimit?: number } = {}) {
    const admin = this.prisma.admin;
    const now = new Date();
    const endOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const [lotsAgg, wallet, expAgg, debits, sub] = await Promise.all([
      admin.conversationCreditLot.aggregate({ _sum: { remaining: true }, where: { organizationId, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] } }),
      admin.conversationWallet.findUnique({ where: { organizationId }, select: { graceUsed: true, periodStart: true } }),
      admin.conversationCreditLot.aggregate({ _sum: { remaining: true }, where: { organizationId, remaining: { gt: 0 }, expiresAt: { gt: now, lt: endOfMonth } } }),
      admin.conversationCreditLedger.count({ where: { organizationId, reason: "conversation_debit", createdAt: { gte: since } } }),
      admin.subscription.findFirst({ where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } }, orderBy: { createdAt: "desc" }, select: { periodStart: true, planId: true } }),
    ]);
    // Acreditación PENDIENTE del período (solo display): el lote real lo crea el worker
    // (perezoso) al primer débito; sin esto, una org recién contratada (o recién
    // UPGRADEADA) vería "consumido 100 de 100" hasta su primera conversación. Mismo
    // criterio que el worker: ¿existe ya el asiento plan_renewal de (plan, período)?
    const floorDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const subPeriod = sub?.periodStart ? floorDay(sub.periodStart) : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    // ¿Ya se creó el lote del plan DE ESTE período? (cubre también acreditaciones
    // previas a este cambio, que no llevaban refId). Si no, se muestra como pendiente.
    const accrued = included > 0
      ? await admin.conversationCreditLot.findFirst({ where: { organizationId, source: "plan", createdAt: { gte: new Date(subPeriod) } }, select: { id: true } })
      : null;
    const pendingAccrual = included > 0 && !accrued ? included : 0;
    const lots = (lotsAgg._sum.remaining ?? 0) + pendingAccrual;
    const grace = wallet?.graceUsed ?? 0;
    const consumed = Math.max(0, included - lots);
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const projected = Math.round(debits + (debits / Math.max(1, dayOfMonth)) * Math.max(0, daysInMonth - dayOfMonth));
    const pctUsed = included > 0 ? Math.round((consumed / included) * 100) : 0;
    return {
      unit: opts.unit ?? ("conversation" as const),
      balance: lots - grace,
      included,
      consumed,
      remaining: lots - grace,
      graceUsed: grace,
      graceLimit: opts.graceLimit ?? 20,
      expiringThisMonth: expAgg._sum.remaining ?? 0,
      byCategory: {},
      projected,
      pctUsed,
      over80: included > 0 && pctUsed >= 80,
    };
  }

  @Get("wallet/summary")
  async walletSummary() {
    const ctx = requireContext();
    const admin = this.prisma.admin;
    // V2-1: planes por conversación (conversationDebitsWallet) → medidor de conversaciones.
    const feats = await this.activePlanFeatures(ctx.organizationId);
    // CRE 2 — Créditos IA: mismo medidor, otra unidad y otra gracia (100, §6).
    if (feats.aiCreditsWallet === true) {
      return this.conversationWalletSummary(ctx.organizationId, Number(feats.aiCreditsIncluded) || 0, { unit: "credit", graceLimit: 100 });
    }
    if (feats.conversationDebitsWallet === true) {
      return this.conversationWalletSummary(ctx.organizationId, Number(feats.conversationsIncluded) || 0);
    }
    const wallet = await admin.messageWallet.findUnique({
      where: { organizationId: ctx.organizationId },
      select: { balance: true, includedPerPeriod: true },
    });
    const balance = wallet?.balance ?? 0;
    const included = wallet?.includedPerPeriod ?? 0;
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const ledger = await admin.walletLedger.findMany({
      where: { organizationId: ctx.organizationId, reason: "send_debit", createdAt: { gte: since } },
      select: { delta: true, category: true },
    });
    const byCategory: Record<string, number> = {};
    let consumed = 0;
    for (const l of ledger) {
      const amt = Math.abs(l.delta);
      consumed += amt;
      const cat = l.category ?? "otro";
      byCategory[cat] = (byCategory[cat] ?? 0) + amt;
    }
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const daysLeft = Math.max(0, daysInMonth - dayOfMonth);
    const avgDaily = consumed / Math.max(1, dayOfMonth);
    const projected = Math.round(consumed + avgDaily * daysLeft);
    const pctUsed = included > 0 ? Math.round((consumed / included) * 100) : 0;
    return { balance, included, consumed, byCategory, projected, pctUsed, over80: included > 0 && pctUsed >= 80 };
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
    await this.assertPlanBrand(ctx.organizationId, plan);
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
      // Retorno POR MARCA (hallazgo 3): TuBot vuelve a /billing?card=1 (igual que siempre);
      // una org Conversia vuelve a /cobros?card=1, que es la pantalla que SÍ existe en su panel.
      reg = await flowRegisterCard(cfg, { customerId: customerRef, urlReturn: billingReturnUrls(org).card });
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
    // F1/B2 — asunto y retorno por marca del tenant (no el panel de TuBot fijo).
    const org = await this.prisma.admin.organization.findUnique({ where: { id: organizationId }, select: { brand: true } });
    const brand = brandOf(org);
    await this.prisma.admin.paymentAttempt.create({ data: { organizationId, subscriptionId: subId, commerceOrder, amount, currency, kind, attemptNumber, status: "pending", provider: "flow" } });
    const r = await flowCollect(cfg, { customerId: customerRef, commerceOrder, subject: `${brand.paymentSubjectPrefix} · Plan ${planName} (${interval === "yearly" ? "anual" : "mensual"})`, amount, currency, urlConfirmation: `${getEnv().API_URL}/billing/webhooks/flow`, urlReturn: billingReturnUrls(org).home });
    await this.prisma.admin.paymentAttempt.updateMany({ where: { commerceOrder }, data: { providerRef: r.token ?? undefined, status: r.ok ? "pending" : "failed", reason: r.reason ?? undefined } });
  }

  /** Bolsa de mensajes del tenant: saldo, incluido y paquetes disponibles. */
  @Get("wallet")
  async wallet() {
    const ctx = requireContext();
    // A4 — solo los sobres de la MARCA del tenant (sin filtro = fuga de packs/pricing de la otra marca).
    const org = await this.prisma.admin.organization.findUnique({ where: { id: ctx.organizationId }, select: { brand: true } });
    const brand = brandOf(org).key;
    // Y solo los del MODELO de la cuenta (auditoría sim 250): a una cuenta V2 (debita
    // conversaciones) se le ofrecían también los sobres de MENSAJES al mismo precio —
    // compraba el producto equivocado hacia una bolsa que su plan no consume.
    // CRE 2: y con Créditos IA, los packs de CRÉDITOS. Sin esta rama, a un cliente de
    // créditos se le ofrecerían sobres de PLANTILLAS — el mismo error que se arregló para
    // las cuentas V2, con el mismo resultado: compra saldo que su plan no consume.
    const feats = await this.activePlanFeatures(ctx.organizationId);
    const type =
      feats.aiCreditsWallet === true ? "credit" : feats.conversationDebitsWallet === true ? "conversation" : "message";
    const [wallet, packages] = await Promise.all([
      this.prisma.withTenant(ctx.organizationId, (tx) => tx.messageWallet.findUnique({ where: { organizationId: ctx.organizationId } })),
      this.prisma.admin.messagePackage.findMany({ where: { active: true, brand, type }, orderBy: { order: "asc" } }),
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
    await this.assertPlanBrand(ctx.organizationId, plan);

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
    const brand = brandOf(org);
    // Retornos POR MARCA: TuBot → /billing (como hoy); Conversia → /cobros?pago=ok|cancelado.
    const back = billingReturnUrls(org);
    const session = await provider.createCheckout({
      organizationId: ctx.organizationId,
      planCode: plan.code,
      amount,
      currency,
      email: user?.email,
      interval,
      variantId: variantId ? String(variantId) : undefined,
      brandSubjectPrefix: brand.paymentSubjectPrefix,
      successUrl: back.success,
      cancelUrl: back.cancel,
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
    // Catálogo por MARCA (auditoría sim 250): un pack con marca solo lo compra una org de
    // esa marca (una org Conversia no debe ver/comprar packs TuBot ni viceversa). Un pack
    // sin marca es común a ambas (compat con el catálogo actual de TuBot).
    if (pkg.brand && pkg.brand !== brandOf(org).key) throw new BadRequestException("Paquete no disponible");
    const currency = org?.currency ?? "CLP";
    const amount = currency === "CLP" ? pkg.priceClp : Number(pkg.priceUsd);
    const user = await this.prisma.admin.user.findUnique({ where: { id: ctx.userId }, select: { email: true } });
    const settings = await this.paymentSettings.get();
    const preferred = (org?.settings as any)?.paymentProvider as string | undefined;
    const provider = createPaymentProvider(settings, currency, preferred);
    const brand = brandOf(org);
    const session = await provider.createCheckout({
      organizationId: ctx.organizationId,
      planCode: `pkg:${pkg.code}`, // el webhook detecta el prefijo y acredita el paquete
      amount,
      currency,
      email: user?.email,
      interval: "monthly",
      brandSubjectPrefix: brand.paymentSubjectPrefix,
      // TuBot → /settings/plan (como hoy); Conversia → /cobros (su única pantalla de dinero).
      successUrl: billingReturnUrls(org).packagesSuccess,
      cancelUrl: billingReturnUrls(org).packagesCancel,
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
    // Activa plan/pack SIN cobrar: exige permiso de facturación como el checkout real
    // (auditoría §3.5/§9.5 — antes bastaba con tener sesión, cualquier rol).
    const ctx = requirePermission("billing:write");
    const parsed = z.object({ planCode: z.string(), billingInterval: z.enum(["monthly", "yearly"]).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("planCode requerido");
    // SEGURIDAD (hallazgo sim 200, 2026-10-17 + auditoría §9.5): el guard solo miraba
    // Stripe y después dependía de poder LEER la configuración de pasarelas — si esa
    // lectura fallaba, el endpoint quedaba ABIERTO en producción y cualquier tenant se
    // activaba planes/packs gratis. Ahora en producción se bloquea SIEMPRE salvo
    // interruptor explícito (BILLING_MOCK_ENABLED=true), y aun con el interruptor se
    // bloquea si hay pasarela real configurada o si no se puede verificar (fail-closed).
    if (getEnv().NODE_ENV === "production") {
      if (!getEnv().BILLING_MOCK_ENABLED) {
        throw new BadRequestException("Confirmación mock deshabilitada en producción");
      }
      let gw: { flow?: unknown; lemonSqueezy?: unknown };
      try {
        gw = await this.paymentSettings.get();
      } catch {
        throw new BadRequestException("Confirmación mock deshabilitada: no se pudo verificar la configuración de pasarelas");
      }
      if (getEnv().STRIPE_SECRET_KEY || gw.flow || gw.lemonSqueezy) {
        throw new BadRequestException("Confirmación mock deshabilitada: hay pasarela real configurada");
      }
    }
    // FRONTERA DE MARCAS (auditoría 17-oct-2026): mock-confirm toma el código del
    // cliente y saltaba los checks de checkout/buy-package → validar aquí también.
    const code = parsed.data.planCode;
    if (code.startsWith("pkg:")) {
      const pkg = await this.prisma.admin.messagePackage.findUnique({ where: { code: code.slice(4) } });
      if (!pkg || !pkg.active) throw new BadRequestException("Paquete no disponible");
      const org = await this.prisma.admin.organization.findUnique({ where: { id: ctx.organizationId }, select: { brand: true } });
      if (pkg.brand && pkg.brand !== brandOf(org).key) throw new BadRequestException("Paquete no disponible");
    } else if (!code.startsWith("setup:")) {
      const plan = await this.prisma.admin.plan.findUnique({ where: { code } });
      if (!plan || !plan.active) throw new BadRequestException("Plan no disponible");
      await this.assertPlanBrand(ctx.organizationId, plan);
    }
    // providerRef determinístico por día: el dedup de creditPackage descansa en el ref
    // (los webhooks reales siempre traen uno). Sin esto, dos clics en "ya pagué" (mock)
    // acreditaban el pack DOS veces (hallazgo sim 200: lotes=2/800 tras doble confirm).
    const mockRef = `mock:${ctx.organizationId}:${parsed.data.planCode}:${new Date().toISOString().slice(0, 10)}`;
    await this.activateOrCredit(ctx.organizationId, parsed.data.planCode, "mock", mockRef, parsed.data.billingInterval ?? "monthly");
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
    // status.status: 1 pendiente · 2 pagado · 3 rechazado · 4 anulado (Flow puede mandarlo como STRING).
    if (Number(status?.status) === 2 && status?.optional) {
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
    const attrs = event?.data?.attributes ?? {};
    const dataId = event?.data?.id != null ? String(event.data.id) : "";
    const updatedAt = attrs.updated_at ?? "";
    const isPayment = eventName === "subscription_payment_success";
    // IDEMPOTENCIA POR PAGO (auditoría §9.2): antes se deduplicaba por
    // `evento:suscripción:updated_at`, así que los 2-3 webhooks del MISMO cobro
    // (`subscription_created` + `subscription_updated` + `subscription_payment_success`)
    // pasaban el filtro y acreditaban 2-3 veces: cada uno sumaba un mes desde hoy,
    // recargaba la bolsa y emitía factura. Ahora el pago se identifica por el id del
    // objeto de PAGO (`data.id` de la subscription-invoice), idéntico en cada reintento.
    const dedupeKey = isPayment ? `payment:${dataId}` : `${eventName}:${dataId}:${updatedAt}`;
    if (dataId && (await this.alreadyProcessed("lemonsqueezy", dedupeKey, eventName))) {
      return { received: true, deduped: true };
    }
    // DINERO: SOLO el evento de pago exitoso acredita/renueva.
    if (isPayment && organizationId && planCode) {
      await this.activateOrCredit(organizationId, planCode, "lemonsqueezy", dataId || undefined, custom.billing_interval === "yearly" ? "yearly" : "monthly");
      return { received: true, credited: true };
    }
    // ESTADO: el resto de los eventos NO tocan dinero (ni período ni bolsa ni factura).
    if (
      organizationId &&
      (eventName === "subscription_created" ||
        eventName === "subscription_updated" ||
        eventName === "subscription_cancelled" ||
        eventName === "subscription_expired")
    ) {
      await this.applyLemonSubscriptionState(organizationId, eventName, String(attrs.status ?? ""), dataId);
    }
    return { received: true };
  }

  /**
   * Estado (NO dinero) de la suscripción en Lemon Squeezy. `cancelled`/`expired` marcan
   * `cancelAtPeriodEnd` (el motor del worker suspende al vencer el período ya pagado — no
   * se corta el servicio de un período pagado); el resto solo queda auditado. Aquí jamás
   * se renueva el período ni se recarga la bolsa: eso es exclusivo del evento de pago.
   */
  private async applyLemonSubscriptionState(organizationId: string, eventName: string, status: string, providerRef: string) {
    const cancelling =
      eventName === "subscription_cancelled" || eventName === "subscription_expired" || status === "cancelled" || status === "expired";
    const sub = await this.prisma.admin.subscription.findFirst({ where: { organizationId }, orderBy: { createdAt: "desc" }, select: { id: true } });
    if (cancelling && sub) {
      await this.prisma.admin.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
    }
    await this.prisma.admin.auditLog
      .create({
        data: {
          organizationId,
          actorType: "system",
          actorId: "billing-webhook",
          action: `billing.lemonsqueezy.${eventName}`,
          entityType: "subscription",
          entityId: sub?.id ?? organizationId,
          after: { status, providerRef, cancelAtPeriodEnd: cancelling && !!sub },
        },
      })
      .catch(() => undefined);
  }

  /** Enruta el pago confirmado: `pkg:<code>` acredita un paquete; si no, activa plan. */
  private async activateOrCredit(organizationId: string, planCode: string, provider: string, providerRef?: string, interval: string = "monthly") {
    if (planCode.startsWith("pkg:")) return this.creditPackage(organizationId, planCode.slice(4), provider, providerRef);
    // Setup de Conversia (F5/D5): el cobro único NO activa la suscripción — solo marca
    // "setup pagado" y pasa el lifecycle a "implementing". El ciclo mensual (con créditos)
    // lo activa F10 al marcar ENTREGADO (acción explícita; "setup pagado" es precondición).
    if (planCode.startsWith("setup:")) return this.markSetupPaid(organizationId, planCode.slice(6), provider, providerRef);
    return this.activate(organizationId, planCode, provider, providerRef, interval);
  }

  /** Marca el setup de Conversia como pagado (NO activa suscripción). Idempotente. */
  private async markSetupPaid(organizationId: string, vertical: string, provider: string, providerRef?: string) {
    const org = await this.prisma.admin.organization.findUnique({ where: { id: organizationId } });
    if (!org) return;
    const prev = (org.settings as Record<string, unknown> | null) ?? {};
    const prevConversia = (prev.conversia as Record<string, unknown> | undefined) ?? {};
    const nextSettings = {
      ...prev,
      setupPaid: true,
      conversia: { ...prevConversia, lifecycle: "implementing", setupVertical: vertical || null, setupPaidAt: new Date().toISOString() },
    };
    await this.prisma.admin.organization.update({ where: { id: organizationId }, data: { settings: nextSettings as object } });
    await this.prisma.admin.auditLog.create({
      data: { organizationId, actorType: "system", action: "conversia.setup_paid", entityType: "organization", entityId: organizationId, after: { vertical: vertical || null, provider, providerRef: providerRef ?? null } },
    });
  }

  /**
   * FRONTERA DE MARCAS (auditoría 17-oct-2026): un plan solo es contratable por una org
   * de SU marca. Sin esto, cualquier tenant con el código podía contratar el plan de la
   * otra marca (TuBot → conversia_v2_base y viceversa), cruzando modelo de cobro,
   * débitos y catálogo. Un plan sin marca cuenta como tubot (default del schema).
   */
  private async assertPlanBrand(organizationId: string, plan: { brand?: string | null; code: string }): Promise<void> {
    const org = await this.prisma.admin.organization.findUnique({ where: { id: organizationId }, select: { brand: true } });
    const planBrand = plan.brand ?? "tubot";
    if (planBrand !== brandOf(org).key) throw new BadRequestException("Plan no disponible");
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
    // IDEMPOTENCIA POR PAGO (auditoría §9.5): confirmar DOS VECES el mismo pago no puede
    // acreditar dos veces el pack. Los packs de CONVERSACIONES ya lo chequeaban por refId;
    // los de MENSAJES (bolsa de plantillas) no tenían defensa propia. El marcador es
    // atómico (unique provider+eventId de webhook_events) y se escribe ANTES de acreditar.
    if (providerRef && (await this.alreadyProcessed("package", `${provider}:${providerRef}:${pkg.code}`, "package.credit"))) {
      return;
    }
    // V2-2 — packs de CONVERSACIONES (type "conversation") acreditan la bolsa V2 (lotes), no
    // la de plantillas. Idempotente por providerRef (dedup del webhook / commerceOrder).
    // CRE 2: los packs de CRÉDITOS IA acreditan la misma bolsa de lotes (un crédito es un
    // crédito). Sin esto, un pack de créditos caería al camino de abajo —la bolsa de
    // PLANTILLAS— y el cliente pagaría por un saldo que su bot no puede usar.
    if (isLotPack(pkg.type)) return this.creditConversationPackage(organizationId, pkg, provider, providerRef);
    const org = await this.prisma.admin.organization.findUnique({ where: { id: organizationId }, select: { currency: true } });
    const currency = org?.currency ?? "CLP";
    const amount = currency === "CLP" ? pkg.priceClp : Number(pkg.priceUsd);
    // B3 — acreditación ATÓMICA (SET balance = balance + credits) para no perder créditos
    // pagados bajo concurrencia (dos compras / compra + renovación). Si la bolsa no existe, se crea.
    let balance: number;
    try {
      const updated = await this.prisma.admin.messageWallet.update({ where: { organizationId }, data: { balance: { increment: pkg.credits } }, select: { balance: true } });
      balance = updated.balance;
    } catch {
      const created = await this.prisma.admin.messageWallet.create({ data: { organizationId, balance: pkg.credits, includedPerPeriod: 0, carryoverCap: 0 }, select: { balance: true } });
      balance = created.balance;
    }
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
   * V2-2 — acredita un pack de CONVERSACIONES a la bolsa V2 (lote que expira a 12 meses),
   * paga primero la gracia pendiente, y emite factura. Idempotente por providerRef (el dedup
   * del webhook ya evita reprocesar; aquí reforzamos con un chequeo del ledger por refId).
   */
  private async creditConversationPackage(organizationId: string, pkg: { code: string; name: string; credits: number; priceClp: number; priceUsd: unknown; type?: string }, provider: string, providerRef?: string) {
    // CRE 2 — la boleta nombra la unidad REAL del pack. Un pack de créditos facturado como
    // "3.000 conversaciones" es un documento equivocado en manos del cliente. Y los precios
    // de créditos son con IVA incluido (§5, opción B), así que la boleta lo dice.
    const esCredito = pkg.type === "credit";
    const unidad = esCredito ? "créditos de IA" : "conversaciones";
    const org = await this.prisma.admin.organization.findUnique({ where: { id: organizationId }, select: { currency: true } });
    const currency = org?.currency ?? "CLP";
    const amount = currency === "CLP" ? pkg.priceClp : Number(pkg.priceUsd);
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 12); // comprados: 12 meses
    await this.prisma.withTenant(organizationId, async (tx) => {
      // Idempotencia por pago (refId): no re-acreditar el mismo providerRef.
      if (providerRef) {
        const dup = await tx.conversationCreditLedger.findFirst({ where: { organizationId, reason: "package_purchase", refId: providerRef }, select: { id: true } });
        if (dup) return;
      }
      // periodStart = época si la wallet no existía: "nunca acreditada" (ver auth.service).
      const wallet = await tx.conversationWallet.upsert({ where: { organizationId }, create: { organizationId, periodStart: new Date(0) }, update: {} });
      let credit = pkg.credits;
      // Pagar gracia pendiente primero (los créditos nuevos cubren el negativo).
      if (wallet.graceUsed > 0) {
        const pay = Math.min(wallet.graceUsed, credit);
        await tx.conversationWallet.update({ where: { organizationId }, data: { graceUsed: wallet.graceUsed - pay } });
        credit -= pay;
      }
      if (credit > 0) {
        await tx.conversationCreditLot.create({ data: { organizationId, source: "purchase", amount: credit, remaining: credit, expiresAt, refType: "package", refId: providerRef ?? pkg.code } });
      }
      const agg = await tx.conversationCreditLot.aggregate({ _sum: { remaining: true }, where: { organizationId, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
      const w2 = await tx.conversationWallet.findUnique({ where: { organizationId }, select: { graceUsed: true } });
      const balanceAfter = (agg._sum.remaining ?? 0) - (w2?.graceUsed ?? 0);
      await tx.conversationCreditLedger.create({ data: { organizationId, delta: pkg.credits, reason: "package_purchase", balanceAfter, refType: "package", refId: providerRef ?? pkg.code } });
      const count = await tx.invoice.count();
      await tx.invoice.create({
        data: {
          organizationId,
          number: `CONV-${new Date().getFullYear()}-${String(count + 1).padStart(6, "0")}`,
          status: "PAID",
          currency,
          amountDue: amount,
          lines: [{ concept: `Pack ${pkg.name} (${pkg.credits.toLocaleString("es-CL")} ${unidad})${esCredito ? " · IVA incluido" : ""}`, amount }],
          paidAt: new Date(),
          provider,
          providerRef: providerRef ?? null,
        },
      });
    });
  }

  // ============================ AUTO-RECARGA (V2-2) ============================

  /** Config de auto-recarga del tenant (settings.autoRecharge). OFF por defecto. */
  @Get("auto-recharge")
  async getAutoRecharge() {
    const ctx = requireContext();
    const org = await this.prisma.admin.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
    const ar = (((org?.settings as Record<string, any> | null)?.autoRecharge ?? {}) as Record<string, any>);
    // CRE 2 — los packs que se ofrecen son los de la unidad que cobra SU plan.
    const unit = await packUnitForOrg(ctx.organizationId);
    const packs = await this.prisma.admin.messagePackage.findMany({ where: { active: true, brand: "conversia", type: unit }, orderBy: { order: "asc" }, select: { code: true, name: true, credits: true, priceClp: true } });
    // CRE 2 (§6) — con Créditos IA los defaults son otros: dispara bajo 50 créditos y el
    // tope son 3 recargas básicas al mes. El umbral de 20 era "conversaciones".
    const defThreshold = unit === "credit" ? 50 : 20;
    const defCap = unit === "credit" ? 56970 : 40000;
    return {
      unit,
      enabled: ar.enabled === true,
      thresholdRemaining: Number.isFinite(ar.thresholdRemaining) ? ar.thresholdRemaining : defThreshold,
      packCode: typeof ar.packCode === "string" ? ar.packCode : (packs[0]?.code ?? null),
      monthlyCapClp: Number.isFinite(ar.monthlyCapClp) ? ar.monthlyCapClp : defCap,
      // Sin consentimiento registrado NO se cobra, aunque `enabled` esté en true: el
      // worker lo exige. La pantalla lo muestra para que se pueda volver a pedir.
      consentAt: typeof ar.consentAt === "string" ? ar.consentAt : null,
      packs: packs.map((p) => ({ code: p.code, name: p.name, credits: p.credits, priceClp: p.priceClp })),
    };
  }

  @Put("auto-recharge")
  async setAutoRecharge(@Body() body: unknown) {
    const ctx = requirePermission("billing:write");
    const parsed = z
      .object({
        enabled: z.boolean(),
        thresholdRemaining: z.number().int().min(1).max(10000).optional(),
        packCode: z.string().max(60).optional(),
        monthlyCapClp: z.number().int().min(0).max(100000000).optional(),
        /** CRE 2 (§6): casilla explícita "recargar automáticamente cuando se agoten". */
        consent: z.boolean().optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Config de auto-recarga inválida");
    const d = parsed.data;
    // Si se activa, el tope mensual es OBLIGATORIO (patrón OpenAI/Lovable: sin tope no se activa).
    if (d.enabled && !(typeof d.monthlyCapClp === "number" && d.monthlyCapClp > 0)) {
      throw new BadRequestException("Para activar la auto-recarga debes fijar un tope mensual de gasto.");
    }
    if (d.enabled && d.packCode) {
      const pkg = await this.prisma.admin.messagePackage.findUnique({ where: { code: d.packCode } });
      // CRE 2: vale cualquier pack que acredite la bolsa de lotes (conversaciones o
      // créditos). Lo que NO vale es un pack de plantillas: ese saldo no mantiene vivo al bot.
      if (!pkg || !pkg.active || !isLotPack(pkg.type)) throw new BadRequestException("El pack de auto-recarga debe ser un pack de conversaciones o de Créditos IA válido");
    }
    const org = await this.prisma.admin.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
    const prev = (org?.settings as Record<string, unknown> | null) ?? {};
    const prevAr = (prev.autoRecharge as Record<string, any>) ?? {};
    // CRE 2 (§6) — CONSENTIMIENTO EXPLÍCITO Y REGISTRADO. Activar la recarga automática es
    // autorizarnos a cobrarle a su tarjeta sin que él vuelva a apretar nada, así que queda
    // la fecha y el usuario. Si ya lo había dado, no se vuelve a pedir; al apagarla se
    // borra, para que volver a encenderla exija aceptar de nuevo.
    const consentAt = resolveConsent({ enabled: d.enabled, previo: prevAr.consentAt, consent: d.consent });
    if (d.enabled && !consentAt) {
      throw new BadRequestException("Para activar la recarga automática tienes que aceptar que cobremos el pack a tu tarjeta cuando tus créditos se estén agotando.");
    }
    const nextAr = {
      enabled: d.enabled,
      thresholdRemaining: d.thresholdRemaining ?? prevAr.thresholdRemaining ?? 50,
      packCode: d.packCode ?? prevAr.packCode ?? null,
      monthlyCapClp: d.monthlyCapClp ?? prevAr.monthlyCapClp ?? 56970,
      consentAt,
      ...(consentAt && !prevAr.consentAt ? { consentBy: ctx.userId } : prevAr.consentBy ? { consentBy: prevAr.consentBy } : {}),
    };
    await this.prisma.admin.organization.update({ where: { id: ctx.organizationId }, data: { settings: { ...prev, autoRecharge: nextAr } as object } });
    await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.auditLog.create({ data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "billing.auto_recharge_config", entityType: "organization", entityId: ctx.organizationId, after: nextAr } }),
    );
    return { ok: true, ...nextAr };
  }

  /** V2-2 — historial de auto-recargas (asientos de compra de la bolsa de conversaciones). */
  @Get("auto-recharge/history")
  async autoRechargeHistory() {
    const ctx = requireContext();
    const rows = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.conversationCreditLedger.findMany({ where: { organizationId: ctx.organizationId, reason: "package_purchase" }, orderBy: { createdAt: "desc" }, take: 50, select: { delta: true, balanceAfter: true, refId: true, createdAt: true } }),
    );
    return { items: rows };
  }

  // ============================ V2-9 — ESTADO / ACTIVACIÓN / GRANDFATHERING ============================

  /** Monto por conversación estimado para el simulador (recarga 100/$21.900 → ~$219/conv). */
  private readonly V2_PER_CONV_CLP = 219;

  /**
   * Estado V2 del tenant para la UI (home + facturación): si está en el modelo por
   * conversación, cuántas conversaciones gratis le quedan, el CTA de activación (precio
   * base + packs) y, si es una org V1, si puede migrar (banner grandfathering). Solo lectura.
   */
  @Get("v2")
  async v2Status() {
    const ctx = requireContext();
    const admin = this.prisma.admin;
    const org = await admin.organization.findUnique({ where: { id: ctx.organizationId }, select: { brand: true, settings: true, currency: true } });
    const brand = brandOf(org).key;
    const feats = await this.activePlanFeatures(ctx.organizationId);
    // CRE 2 — las dos unidades (conversación y Créditos IA) comparten esta pantalla: el
    // saldo vive en los mismos lotes y el cliente ve el mismo medidor. Si `isV2` siguiera
    // mirando solo `conversationDebitsWallet`, el día que se activen los créditos el
    // cliente abriría su Inicio y no vería saldo por ninguna parte.
    const unit = await packUnitForOrg(ctx.organizationId);
    const isV2 = feats.conversationDebitsWallet === true || feats.aiCreditsWallet === true;
    const included = unit === "credit" ? Number(feats.aiCreditsIncluded) || 0 : Number(feats.conversationsIncluded) || 0;
    const lifecycle = ((org?.settings as any)?.conversia?.lifecycle as string | undefined) ?? null;
    const base = await admin.plan.findUnique({ where: { code: unit === "credit" ? "conversia_creditos_base" : "conversia_v2_base" } });
    const packs = await admin.messagePackage.findMany({ where: { active: true, brand: "conversia", type: unit }, orderBy: { order: "asc" } });
    const activation = base
      ? {
          basePlanCode: base.code,
          basePriceClp: Number(base.priceClp),
          basePriceUsd: Number(base.priceUsd),
          baseIncluded: Number((base.features as any)?.aiCreditsIncluded ?? (base.features as any)?.conversationsIncluded) || 100,
          packs: packs.map((p) => ({ code: p.code, name: p.name, credits: p.credits, priceClp: p.priceClp, priceUsd: Number(p.priceUsd) })),
        }
      : null;

    // Modelo por conversación: saldo + si está en prueba (lifecycle v2_trial / incluido 0).
    let trial: { active: boolean; freeRemaining: number; freeTotal: number } | null = null;
    let wallet: { remaining: number; graceUsed: number } | null = null;
    if (isV2) {
      const sum = await this.conversationWalletSummary(ctx.organizationId, included, unit === "credit" ? { unit: "credit", graceLimit: 100 } : {});
      wallet = { remaining: sum.remaining, graceUsed: sum.graceUsed };
      const inTrial = lifecycle === "v2_trial" || included === 0;
      if (inTrial) {
        // En prueba el único saldo es el lote de bienvenida. Cuánto fue sale del PLAN de
        // prueba (30 por conversación · 200 en créditos), no de un número escrito acá:
        // si no, al activar créditos la barra diría "200 de 30".
        const trialPlan = await admin.plan.findUnique({
          where: { code: unit === "credit" ? "conversia_creditos_trial" : "conversia_v2_trial" },
          select: { features: true },
        });
        const regalo = Number((trialPlan?.features as any)?.signupGiftCredits) || 30;
        trial = { active: true, freeRemaining: Math.max(0, Math.min(regalo, sum.remaining)), freeTotal: regalo };
      }
    }

    // Grandfathering: org conversia V1 (plan conversia_* NO V2) → elegible a migrar.
    let grandfather: { eligible: boolean; v1PlanCode: string; v1PlanName: string } | null = null;
    if (brand === "conversia" && !isV2) {
      const sub = await admin.subscription.findFirst({ where: { organizationId: ctx.organizationId, status: { in: ["ACTIVE", "TRIALING"] } }, orderBy: { createdAt: "desc" }, select: { planId: true } });
      const plan = sub?.planId ? await admin.plan.findUnique({ where: { id: sub.planId }, select: { code: true, name: true, features: true } }) : null;
      const migrationScheduled = (org?.settings as any)?.conversia?.v2MigrationScheduled ?? null;
      if (plan && plan.code.startsWith("conversia_") && (plan.features as any)?.conversationDebitsWallet !== true) {
        grandfather = { eligible: !migrationScheduled, v1PlanCode: plan.code, v1PlanName: plan.name };
      }
    }

    return { isV2, unit, lifecycle, trial, wallet, activation, grandfather };
  }

  /**
   * Simulador personal del grandfathering: con el uso REAL de los ~2 últimos meses
   * (usage_events), estima cuánto pagaría el tenant V1 en el modelo por conversación vs.
   * su plan actual. Honesto: es una ESTIMACIÓN (proxy de conversaciones por actividad).
   */
  @Get("v2-simulator")
  async v2Simulator() {
    const ctx = requireContext();
    const admin = this.prisma.admin;
    const org = await admin.organization.findUnique({ where: { id: ctx.organizationId }, select: { currency: true } });
    const currency = org?.currency ?? "CLP";
    const now = new Date();
    const since = new Date(now.getTime() - 60 * 86_400_000);
    // Proxy de conversaciones atendidas: mensajes de WhatsApp (verdad de Meta) / ~6 por
    // conversación. Si la org registra "conversation" directamente, se usa ese.
    const [convAgg, msgAgg] = await Promise.all([
      admin.usageEvent.aggregate({ _sum: { quantity: true }, where: { organizationId: ctx.organizationId, type: "conversation", occurredAt: { gte: since } } }),
      admin.usageEvent.aggregate({ _sum: { quantity: true }, where: { organizationId: ctx.organizationId, type: "whatsapp_message", occurredAt: { gte: since } } }),
    ]);
    const convDirect = Number(convAgg._sum.quantity ?? 0);
    const msgs = Number(msgAgg._sum.quantity ?? 0);
    const totalConvs = convDirect > 0 ? convDirect : Math.round(msgs / 6);
    const monthlyConvs = Math.round(totalConvs / 2); // ~2 meses de ventana

    const base = await admin.plan.findUnique({ where: { code: "conversia_v2_base" }, select: { priceClp: true, priceUsd: true, features: true } });
    const included = Number((base?.features as any)?.conversationsIncluded) || 100;
    const basePrice = currency === "CLP" ? Number(base?.priceClp ?? 18900) : Number(base?.priceUsd ?? 19);
    const extra = Math.max(0, monthlyConvs - included);
    const perConv = currency === "CLP" ? this.V2_PER_CONV_CLP : 0.23;
    const v2Estimated = Math.round(basePrice + extra * perConv);

    // Precio actual del tenant (plan V1 vigente).
    const sub = await admin.subscription.findFirst({ where: { organizationId: ctx.organizationId, status: { in: ["ACTIVE", "TRIALING"] } }, orderBy: { createdAt: "desc" }, select: { planId: true, lockedPriceClp: true, lockedPriceUsd: true } });
    const plan = sub?.planId ? await admin.plan.findUnique({ where: { id: sub.planId }, select: { name: true, priceClp: true, priceUsd: true } }) : null;
    const v1Current = currency === "CLP" ? Number(sub?.lockedPriceClp ?? plan?.priceClp ?? 0) : Number(sub?.lockedPriceUsd ?? plan?.priceUsd ?? 0);

    return {
      currency,
      windowDays: 60,
      monthlyConversations: monthlyConvs,
      estimateBasis: convDirect > 0 ? "conversation_events" : "whatsapp_messages_proxy",
      v1: { planName: plan?.name ?? "actual", monthlyPrice: v1Current },
      v2: { basePlanCode: "conversia_v2_base", included, estimatedMonthly: v2Estimated, extraConversations: extra },
      savesMoney: v1Current > 0 && v2Estimated < v1Current,
    };
  }

  /**
   * Migración 1-click al modelo por conversación (opt-in, sin fecha forzada): cambia el
   * plan a conversia_v2_base (precio sellado), regala 100 conversaciones de cortesía del
   * primer mes (lote 35 días) y marca el lifecycle. NO cobra ahora: el nuevo precio (más
   * barato) se cobra en la próxima renovación. Idempotente (no re-migra si ya está en V2).
   */
  @Post("v2-migrate")
  async v2Migrate() {
    const ctx = requirePermission("billing:write");
    const admin = this.prisma.admin;
    const org = await admin.organization.findUnique({ where: { id: ctx.organizationId }, select: { brand: true, settings: true } });
    if (brandOf(org).key !== "conversia") throw new BadRequestException("La migración V2 es solo para cuentas Conversia.");
    const feats = await this.activePlanFeatures(ctx.organizationId);
    if (feats.conversationDebitsWallet === true || feats.aiCreditsWallet === true) return { ok: true, already: true };
    // CRE 2 — migra al plan de prepago que esté ACTIVO: Créditos IA si el dueño ya encendió
    // ese catálogo, y si no el de conversaciones. Sin esto, el día del cambio esta ruta
    // dejaría al cliente en un plan desactivado (sin saldo que acreditar y sin poder pagar).
    const creditos = await admin.plan.findUnique({ where: { code: "conversia_creditos_base" } });
    const base = creditos?.active === true ? creditos : await admin.plan.findUnique({ where: { code: "conversia_v2_base" } });
    if (!base || !base.active) throw new BadRequestException("El modelo de prepago aún no está disponible.");
    // Cortesía del primer mes, del catálogo: 100 conversaciones o su equivalente en
    // créditos (×10, §8.4). Escrita en el plan para que el día del cambio no quede un "100"
    // en el código regalando diez veces menos de lo que corresponde.
    const cortesia = Number((base.features as any)?.migrationCourtesyCredits) || 100;

    const sub = await admin.subscription.findFirst({ where: { organizationId: ctx.organizationId, status: { in: ["ACTIVE", "TRIALING"] } }, orderBy: { createdAt: "desc" } });
    // Cambia el plan de la suscripción vigente a V2 (precio sellado V2). Mantiene periodEnd
    // → se cobra el nuevo precio en la próxima renovación (más barato; sin cobro sorpresa hoy).
    if (sub) {
      await admin.subscription.update({ where: { id: sub.id }, data: { planId: base.id, lockedPriceClp: base.priceClp, lockedPriceUsd: base.priceUsd } });
    } else {
      const periodEnd = new Date(Date.now() + 30 * 86_400_000);
      await admin.subscription.create({ data: { organizationId: ctx.organizationId, planId: base.id, status: "ACTIVE", interval: "monthly", periodStart: new Date(), periodEnd, lockedPriceClp: base.priceClp, lockedPriceUsd: base.priceUsd } });
    }
    await admin.organization.update({ where: { id: ctx.organizationId }, data: { planId: base.id } });

    // 100 conversaciones de cortesía del primer mes (lote 35 días). Idempotente por refId.
    const refId = `v2_migration:${ctx.organizationId}`;
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const dup = await tx.conversationCreditLedger.findFirst({ where: { organizationId: ctx.organizationId, refType: "migration_courtesy", refId }, select: { id: true } });
      if (dup) return;
      const expiresAt = new Date(Date.now() + 35 * 86_400_000);
      await tx.conversationWallet.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, periodStart: new Date(0) }, update: {} });
      await tx.conversationCreditLot.create({ data: { organizationId: ctx.organizationId, source: "bonus", amount: cortesia, remaining: cortesia, expiresAt, refType: "migration_courtesy", refId } });
      await tx.conversationCreditLedger.create({ data: { organizationId: ctx.organizationId, delta: cortesia, reason: "admin_adjust", balanceAfter: cortesia, refType: "migration_courtesy", refId } });
    });

    const prev = (org?.settings as Record<string, unknown> | null) ?? {};
    const prevConversia = (prev.conversia as Record<string, unknown> | undefined) ?? {};
    await admin.organization.update({
      where: { id: ctx.organizationId },
      data: { settings: { ...prev, conversia: { ...prevConversia, lifecycle: "v2", v2MigratedAt: new Date().toISOString() } } as object },
    });
    await admin.auditLog.create({ data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "billing.v2_migrate", entityType: "subscription", entityId: base.id, after: { courtesyCredits: 100 } as object } });
    return { ok: true, migrated: true, courtesyCredits: 100 };
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

    // Grandfathering (F5/H12): se SELLA el precio del plan al contratar/cambiar. Si luego
    // sube el "precio de lanzamiento", esta suscripción conserva el precio sellado.
    if (existing) {
      await this.prisma.admin.subscription.update({ where: { id: existing.id }, data: { planId: plan.id, status: "ACTIVE", interval: useYearly ? "yearly" : "monthly", periodStart: new Date(), periodEnd, lockedPriceClp: plan.priceClp, lockedPriceUsd: plan.priceUsd } });
    } else {
      await this.prisma.admin.subscription.create({ data: { organizationId, planId: plan.id, status: "ACTIVE", interval: useYearly ? "yearly" : "monthly", periodStart: new Date(), periodEnd, lockedPriceClp: plan.priceClp, lockedPriceUsd: plan.priceUsd } });
    }
    // Al pagar, la VIGENCIA salta al fin del período pagado y la prueba queda
    // "convertida" (el ciclo de trial ya no la toca). Sin esto, un tenant que paga
    // dentro de la prueba conservaría el `validUntil` del día 7 y `assertOrgActive`
    // lo bloquearía por "vigencia vencida" pese a haber pagado.
    const prevSettings = (org.settings as Record<string, unknown> | null) ?? {};
    const prevTrial = (prevSettings.trial as Record<string, unknown> | undefined) ?? {};
    const nextSettings: Record<string, unknown> = { ...prevSettings, validUntil: periodEnd.toISOString(), trial: { ...prevTrial, state: "converted" } };
    // V2-9 — si se activa un plan por conversación (Base), se DESPAUSA la prueba V2: se
    // limpian graceStartedAt/paused/aiMode forzado y el aiKillSwitch que puso la pausa, y
    // el lifecycle pasa a "v2". Así un tenant que estuvo en copiloto/pausa retoma al pagar.
    const planFeats = (plan.features as Record<string, unknown> | null) ?? {};
    if (planFeats.conversationDebitsWallet === true && (Number(planFeats.conversationsIncluded) || 0) > 0) {
      const prevConversia = (prevSettings.conversia as Record<string, unknown> | undefined) ?? {};
      const { graceStartedAt: _g, paused: _p, aiMode: _m, ...restConversia } = prevConversia;
      nextSettings.conversia = { ...restConversia, lifecycle: "v2" };
      const prevAi = (prevSettings.ai as Record<string, unknown> | undefined) ?? {};
      const { aiKillSwitch: _k, ...restAi } = prevAi;
      nextSettings.ai = restAi;
    }
    await this.prisma.admin.organization.update({ where: { id: organizationId }, data: { status: "ACTIVE", planId: plan.id, settings: nextSettings as object } });

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

  /**
   * Recarga la bolsa al renovar: balance = min(saldo, cupo) + cupo (carryover 1 mes).
   * La regla no cambió; la cuenta ahora la hace `refillMessageWallet` (@conversia/database)
   * en UN solo UPDATE atómico, compartida con el worker y con el Super Admin (§9.3/§9.5).
   */
  private async topUpWallet(organizationId: string, plan: { features: unknown }): Promise<void> {
    const included = messageWalletQuota(plan.features, getEnv().WALLET_DEFAULT_QUOTA);
    await refillMessageWallet(this.prisma.admin, { organizationId, included });
  }
}
