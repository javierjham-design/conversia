import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { MODEL_PRICING, WHATSAPP_PRICING, createAIRouter } from "@conversia/agents";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { computeWhatsappCostUsd } from "@conversia/agents";
import { AuthService } from "../auth/auth.service";
import { PaymentSettingsService } from "../billing/payment-settings.service";
import { sendEmail } from "../common/email";
import { signAppToken } from "../auth/jwt";
import { PlatformGuard, type PlatformRequest } from "./platform.guard";
import { getRailwayInfra } from "./railway-metrics";

// ---------------------------------------------------------------------------
// Evaluador (solo lectura) del gate de envío de plantillas — MISMA lógica y
// orden que chargeTemplateSend (worker/messaging-guard), sin efectos. Es la
// fuente de verdad del panel de mensajería, el botón "¿puede enviar?" y el
// indicador de la lista, para no cazar el bloqueo en seis lugares.
// ---------------------------------------------------------------------------
const MESSAGING_REASON_LABELS: Record<string, string> = {
  plan_no_templates: "El plan no incluye plantillas",
  templates_switch_off: "Interruptor del tenant apagado",
  demo: "Cuenta en demo (TRIAL)",
  grace: "Pago pendiente (período de gracia)",
  suspended: "Cuenta suspendida",
  tenant_cap: "Tope diario alcanzado",
  no_balance: "Bolsa sin saldo",
  global_fuse: "Fusible global cortado",
};
const ACTIVE_SUB_STATUSES = ["ACTIVE", "TRIALING"];

interface GateInputs {
  orgStatus: string;
  templatesEnabled: boolean;
  planAllows: boolean;
  latestSubStatus: string | null;
  balance: number;
  today: number;
  dailyCapEffective: number;
  todayGlobal: number;
  globalCap: number;
  fuseTripped: boolean;
}
interface GateCondition { key: string; pass: boolean; reason: string | null }
interface GateResult { conditions: GateCondition[]; canSend: boolean; blockedBy: string | null; reason: string | null }

/** Evalúa las seis condiciones en el mismo orden que el gate real. Puro. */
function evalMessagingGate(i: GateInputs): GateResult {
  const conditions: GateCondition[] = [];
  const push = (key: string, pass: boolean, reason: string) => conditions.push({ key, pass, reason: pass ? null : reason });

  push("plan", i.planAllows, "plan_no_templates");
  push("switch", i.templatesEnabled, "templates_switch_off");
  let accReason = "";
  if (i.orgStatus === "TRIAL") accReason = "demo";
  else if (i.orgStatus === "SUSPENDED" || i.orgStatus === "CANCELLED") accReason = "suspended";
  else if (i.latestSubStatus === "PAST_DUE") accReason = "grace";
  push("account", accReason === "", accReason || "suspended");
  push("daily", i.today < i.dailyCapEffective, "tenant_cap");
  push("wallet", i.balance > 0, "no_balance");
  push("fuse", !i.fuseTripped && i.todayGlobal < i.globalCap, "global_fuse");

  const firstBlock = conditions.find((c) => !c.pass) ?? null;
  return {
    conditions,
    canSend: !firstBlock,
    blockedBy: firstBlock?.key ?? null,
    reason: firstBlock?.reason ? (MESSAGING_REASON_LABELS[firstBlock.reason] ?? firstBlock.reason) : null,
  };
}

/**
 * API del panel de PLATAFORMA (super-admin). Opera cross-tenant por diseño
 * (cliente admin de BD) — es el ÚNICO lugar autorizado a hacerlo, detrás de
 * autenticación de plataforma separada y con auditoría en cada mutación.
 */
@Controller("platform")
@UseGuards(PlatformGuard)
export class PlatformController {
  constructor(
    private prisma: PrismaService,
    private auth: AuthService,
    private paymentSettings: PaymentSettingsService,
    private queues: QueueService,
  ) {}

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
    const [orgs, active, trialing, suspended, plans, subs, ai, invoicesPaid, whatsapp] = await Promise.all([
      db.organization.count({ where: { deletedAt: null } }),
      db.organization.count({ where: { status: "ACTIVE", deletedAt: null } }),
      db.organization.count({ where: { status: "TRIAL", deletedAt: null } }),
      db.organization.count({ where: { status: "SUSPENDED" } }),
      db.plan.findMany(),
      db.subscription.findMany({ where: { status: { in: ["ACTIVE", "TRIALING"] } } }),
      db.aiRequest.aggregate({ where: { createdAt: { gte: since } }, _sum: { costUsd: true }, _count: { _all: true } }),
      db.invoice.aggregate({ where: { status: "PAID" }, _sum: { amountDue: true } }),
      // Costo que cobra Meta por mensajes de WhatsApp (últimos 30 días).
      db.usageEvent.aggregate({ where: { type: "whatsapp_message", occurredAt: { gte: since } }, _sum: { costUsd: true }, _count: { _all: true } }),
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
      whatsappCostUsd30d: Number(whatsapp._sum.costUsd ?? 0),
      whatsappMessages30d: whatsapp._count._all,
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

    // Indicador de mensajería: ¿algún tenant tiene bloqueado el envío de plantillas?
    // Batch: bolsa por org + tope + fusible/consumo global + consumo diario por tenant.
    const date = new Date().toISOString().slice(0, 10);
    const [wallets, freePlan, caps] = await Promise.all([
      db.messageWallet.findMany({ select: { organizationId: true, balance: true } }),
      db.plan.findUnique({ where: { code: "free" } }),
      this.readMessagingCaps(),
    ]);
    const walletByOrg = new Map(wallets.map((w) => [w.organizationId, w.balance]));
    let todayGlobal = 0;
    let fuseTripped = false;
    const tenantToday = new Map<string, number>();
    try {
      const conn = this.queues.connection;
      const [g, f] = await conn.mget(`msgcap:g:${date}`, `msgcap:fuse:${date}`);
      todayGlobal = Number(g) || 0;
      fuseTripped = f === "1";
      const activeOrgs = orgs.filter((o) => !o.deletedAt);
      if (activeOrgs.length) {
        const vals = await conn.mget(...activeOrgs.map((o) => `msgcap:t:${o.id}:${date}`));
        activeOrgs.forEach((o, idx) => tenantToday.set(o.id, Number(vals[idx]) || 0));
      }
    } catch {
      /* redis caído → conteos en 0 (no bloquea por el contador) */
    }

    return orgs.map((o) => {
      const sub = subByOrg.get(o.id);
      const plan = sub ? planById.get(sub.planId) : null;
      const activePlan = sub && ACTIVE_SUB_STATUSES.includes(sub.status) ? plan : freePlan;
      const settings = (o.settings ?? {}) as Record<string, any>;
      const override = Number(settings?.messaging?.dailyCap);
      const gate = evalMessagingGate({
        orgStatus: o.status,
        templatesEnabled: settings?.messaging?.templatesEnabled === true,
        planAllows: ((activePlan?.features as any)?.whatsappTemplates) === true,
        latestSubStatus: sub?.status ?? null,
        balance: walletByOrg.get(o.id) ?? 0,
        today: tenantToday.get(o.id) ?? 0,
        dailyCapEffective: Number.isFinite(override) && override > 0 ? override : caps.perTenantDefault,
        todayGlobal,
        globalCap: caps.global,
        fuseTripped,
      });
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
        messaging: { blocked: !gate.canSend, blockedBy: gate.blockedBy, reason: gate.reason },
      };
    });
  }

  @Get("organizations/:id")
  async organizationDetail(@Param("id") id: string) {
    const db = this.prisma.admin;
    const org = await db.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException("Organización no encontrada");
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [sub, plans, invoices, usage, members, convInitiated, activeClientRows, tokensTodayAgg] = await Promise.all([
      db.subscription.findFirst({ where: { organizationId: id }, orderBy: { createdAt: "desc" } }),
      db.plan.findMany({ orderBy: { order: "asc" } }),
      db.invoice.findMany({ where: { organizationId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
      db.usageEvent.groupBy({ by: ["type"], where: { organizationId: id, occurredAt: { gte: since } }, _sum: { quantity: true, costUsd: true } }),
      db.organizationUser.findMany({ where: { organizationId: id }, include: { user: { select: { email: true, name: true } } } }),
      db.conversation.count({ where: { organizationId: id, createdAt: { gte: since } } }),
      db.conversation.findMany({ where: { organizationId: id, lastMessageAt: { gte: since } }, select: { contactId: true }, distinct: ["contactId"] }),
      db.usageEvent.aggregate({ where: { organizationId: id, type: "ai_tokens", occurredAt: { gte: startOfDay } }, _sum: { quantity: true } }),
    ]);
    const plan = sub ? plans.find((p) => p.id === sub.planId) : null;
    const paymentAttempts = await db.paymentAttempt.findMany({ where: { organizationId: id }, orderBy: { createdAt: "desc" }, take: 10 });
    const settings = (org.settings ?? {}) as Record<string, any>;
    const override = settings.limits && typeof settings.limits === "object" ? (settings.limits as Record<string, number>) : {};
    const planLimits = (plan?.limits as Record<string, number>) ?? {};
    // Correo del admin (owner) del tenant, para la sección de cuenta.
    const orgRoles = await db.role.findMany({ where: { organizationId: id }, select: { id: true, code: true } });
    const ownerRoleIds = new Set(orgRoles.filter((r) => r.code === "owner").map((r) => r.id));
    const adminMember = members.find((m) => ownerRoleIds.has(m.roleId) && m.active) ?? members.find((m) => m.active) ?? members[0];
    // Mensajes de plantilla facturables del período (informativo; el cobro es
    // prepago por la bolsa, sin excedente post-pago).
    const now = new Date();
    const tmplPeriodStart = sub?.periodStart ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const tmplAgg = await db.usageEvent.aggregate({ where: { organizationId: id, type: "whatsapp_message", occurredAt: { gte: tmplPeriodStart } }, _count: { _all: true }, _sum: { costUsd: true } });
    const planFeatures = (plan?.features as Record<string, any>) ?? {};
    const tmplIncluded = typeof planFeatures.templateMessages === "number" ? planFeatures.templateMessages : 0;
    const tmplUsed = tmplAgg._count._all;
    // Agentes de IA del tenant con su modelo POR-AGENTE (override en la versión
    // publicada) + el modelo efectivo (agente → tenant → default de plataforma).
    // Permite optimizar costos: p. ej. ventas en gpt-4o-mini y implementación en Opus.
    const agents = await db.agent.findMany({
      where: { organizationId: id, deletedAt: null },
      select: { id: true, name: true, slug: true, kind: true, active: true, currentVersionId: true },
      orderBy: { createdAt: "asc" },
    });
    const agentVersionIds = agents.map((a) => a.currentVersionId).filter(Boolean) as string[];
    const agentVersions = agentVersionIds.length
      ? await db.agentVersion.findMany({ where: { id: { in: agentVersionIds } }, select: { id: true, config: true } })
      : [];
    const cfgByVersion = new Map(agentVersions.map((v) => [v.id, (v.config ?? {}) as Record<string, any>]));
    const tenantModel = ((settings.ai as any)?.model as string | undefined) ?? null;
    const platformDefaultModel = getEnv().AI_DEFAULT_MODEL;
    const agentsList = agents.map((a) => {
      const cfg = a.currentVersionId ? cfgByVersion.get(a.currentVersionId) ?? {} : {};
      const agentModel = typeof cfg.model === "string" && cfg.model ? cfg.model : null;
      return {
        id: a.id,
        name: a.name,
        slug: a.slug,
        kind: a.kind,
        active: a.active,
        model: agentModel, // null = hereda del tenant
        effectiveModel: agentModel ?? tenantModel ?? platformDefaultModel,
      };
    });
    return {
      organization: { id: org.id, name: org.name, slug: org.slug, status: org.status, country: org.country, createdAt: org.createdAt, settings: org.settings },
      adminEmail: adminMember?.user.email ?? null,
      subscription: sub ? { status: sub.status, planCode: plan?.code, planName: plan?.name, periodEnd: sub.periodEnd } : null,
      plan: plan ? { code: plan.code, name: plan.name, limits: planLimits, features: plan.features } : null,
      // Límites efectivos = plan + override por-tenant (settings.limits). El override manda.
      effectiveLimits: { ...planLimits, ...override } as Record<string, number>,
      limitsOverride: override,
      validUntil: typeof settings.validUntil === "string" ? settings.validUntil : null,
      aiKillSwitch: settings.aiKillSwitch === true,
      // Interruptor de mensajes de plantilla del tenant + si el plan lo incluye.
      templates_switch: {
        switchOn: (settings.messaging as any)?.templatesEnabled === true,
        planAllows: planFeatures.whatsappTemplates === true,
      },
      paymentProvider: settings.paymentProvider ?? null,
      // Facturables a medida del tenant (se suman a la base del plan al cobrar).
      billables: Array.isArray(settings.billables) ? settings.billables : [],
      currency: (org as any).currency ?? "CLP",
      // Estado del cobro recurrente + últimos intentos (para el Super Admin).
      recurring: sub
        ? { status: sub.status, interval: sub.interval, periodEnd: sub.periodEnd, nextChargeAt: sub.nextChargeAt, pastDueSince: sub.pastDueSince, retriesDone: sub.retriesDone, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, hasCard: !!sub.providerCustomerRef }
        : null,
      paymentAttempts: paymentAttempts.map((a) => ({ id: a.id, amount: Number(a.amount), currency: a.currency, kind: a.kind, status: a.status, reason: a.reason, createdAt: a.createdAt })),
      // Modelo de IA de TODA la plataforma del tenant (lo fija el Super Admin).
      ai: {
        model: (settings.ai as any)?.model ?? null,
        maxTokens: (settings.ai as any)?.maxTokens ?? null,
        maxToolRounds: (settings.ai as any)?.maxToolRounds ?? null,
        platformDefaultModel,
      },
      // Modelo por-agente (override) + modelo efectivo, editable desde el Super Admin.
      agents: agentsList,
      availableModels: Object.keys(MODEL_PRICING),
      availablePlans: plans.map((p) => ({ code: p.code, name: p.name })),
      templates: {
        used: tmplUsed,
        included: tmplIncluded,
        metaCostUsd: Number(tmplAgg._sum.costUsd ?? 0),
      },
      invoices,
      usage,
      metrics: {
        periodDays: 30,
        conversationsInitiated: convInitiated,
        activeClients: activeClientRows.length,
        aiTokensToday: Number(tokensTodayAgg._sum.quantity ?? 0),
      },
      members: members.map((m) => ({ email: m.user.email, name: m.user.name, active: m.active })),
    };
  }

  /** Configuración completa por tenant: vigencia, override de límites (token limiter),
   *  kill switch de IA, datos básicos. Punto único para operar cada cliente. */
  @Post("organizations/:id/config")
  async setConfig(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z
      .object({
        name: z.string().min(2).max(120).optional(),
        country: z.string().max(2).optional(),
        validUntil: z.string().nullable().optional(), // ISO date o null (sin vencimiento)
        aiKillSwitch: z.boolean().optional(),
        // Interruptor de mensajes de plantilla de WhatsApp del tenant (apagado por
        // defecto). Lo enciende el Super Admin al contratar la capacidad.
        templatesEnabled: z.boolean().optional(),
        limits: z.record(z.coerce.number().int().min(0)).optional(), // override por-tenant; 0 = ilimitado
        paymentProvider: z.enum(["flow", "lemonsqueezy"]).nullable().optional(), // proveedor de pago del tenant
        // FACTURABLES a medida del tenant (plan custom "desde"): se suman a la base del
        // plan en cada cobro/factura. Monto en la moneda de la organización, por período.
        billables: z
          .array(z.object({ concept: z.string().min(1).max(80), amount: z.coerce.number().min(0).max(999_999_999) }))
          .max(30)
          .optional(),
        // Modelo de IA para TODA la plataforma del tenant (exclusivo del Super Admin).
        ai: z
          .object({
            model: z.string().min(1).max(60),
            maxTokens: z.coerce.number().int().min(50).max(4000),
            maxToolRounds: z.coerce.number().int().min(0).max(10),
          })
          .partial()
          .optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    const org = await this.prisma.admin.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException("Organización no encontrada");
    const settings = { ...((org.settings ?? {}) as Record<string, any>) };
    if (parsed.data.validUntil !== undefined) {
      settings.validUntil = parsed.data.validUntil || null;
    }
    if (parsed.data.aiKillSwitch !== undefined) settings.aiKillSwitch = parsed.data.aiKillSwitch;
    if (parsed.data.limits !== undefined) settings.limits = parsed.data.limits;
    if (parsed.data.paymentProvider !== undefined) settings.paymentProvider = parsed.data.paymentProvider || null;
    if (parsed.data.billables !== undefined) settings.billables = parsed.data.billables;
    if (parsed.data.ai !== undefined) settings.ai = { ...(settings.ai ?? {}), ...parsed.data.ai };
    // Interruptor de plantillas de WhatsApp: vive en settings.messaging.templatesEnabled.
    const prevTemplatesEnabled = (settings.messaging as any)?.templatesEnabled === true;
    if (parsed.data.templatesEnabled !== undefined) {
      settings.messaging = { ...(settings.messaging ?? {}), templatesEnabled: parsed.data.templatesEnabled };
    }
    const data: any = { settings };
    if (parsed.data.name) data.name = parsed.data.name;
    if (parsed.data.country) data.country = parsed.data.country;
    await this.prisma.admin.organization.update({ where: { id }, data });
    await this.audit(req, "platform.org.config", "organization", id, {
      ...(parsed.data.name ? { name: parsed.data.name, previousName: org.name } : {}),
      validUntil: settings.validUntil ?? null,
      aiKillSwitch: settings.aiKillSwitch ?? false,
      limits: settings.limits ?? {},
    });
    // Auditoría EXPLÍCITA del switch de plantillas (quién lo encendió/apagó y cuándo).
    if (parsed.data.templatesEnabled !== undefined && parsed.data.templatesEnabled !== prevTemplatesEnabled) {
      await this.audit(req, parsed.data.templatesEnabled ? "platform.org.templates_on" : "platform.org.templates_off", "organization", id, {
        templatesEnabled: parsed.data.templatesEnabled,
      });
    }
    return { ok: true };
  }

  /**
   * Fija el modelo de IA de UN agente (override por-agente). `model: null` lo hace
   * heredar del modelo del tenant. Permite bajar costos: los agentes que solo
   * responden (ventas/soporte) en un modelo económico, y reservar Opus para los
   * exigentes (implementación). Se guarda en el config de TODAS las versiones del
   * agente para que sobreviva a re-publicaciones.
   */
  @Post("organizations/:id/agents/:agentId/model")
  async setAgentModel(
    @Param("id") id: string,
    @Param("agentId") agentId: string,
    @Body() body: unknown,
    @Req() req: PlatformRequest,
  ) {
    const parsed = z.object({ model: z.string().min(1).max(60).nullable() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("model requerido (o null para heredar del tenant)");
    if (parsed.data.model && !MODEL_PRICING[parsed.data.model]) {
      throw new BadRequestException("Modelo no reconocido");
    }
    const db = this.prisma.admin;
    const agent = await db.agent.findFirst({ where: { id: agentId, organizationId: id, deletedAt: null } });
    if (!agent) throw new NotFoundException("Agente no encontrado");
    const versions = await db.agentVersion.findMany({ where: { agentId }, select: { id: true, config: true } });
    for (const v of versions) {
      const config = { ...((v.config ?? {}) as Record<string, any>) };
      if (parsed.data.model) config.model = parsed.data.model;
      else delete config.model;
      await db.agentVersion.update({ where: { id: v.id }, data: { config } });
    }
    await this.audit(req, "platform.agent.model", "agent", agentId, { model: parsed.data.model ?? null, organizationId: id });
    return { ok: true, model: parsed.data.model ?? null };
  }

  // ------------------- Cuenta del administrador del tenant -------------------

  /** Restablece la contraseña del admin y devuelve la temporal (mostrada una vez). */
  @Post("organizations/:id/admin/reset-password")
  async resetAdminPassword(@Param("id") id: string, @Req() req: PlatformRequest) {
    const res = await this.auth.resetOrgAdminPassword(id);
    if (!res) throw new BadRequestException("La organización no tiene usuarios activos");
    await this.audit(req, "platform.admin.reset_password", "user", res.userId, { email: res.email });
    return { ok: true, email: res.email, tempPassword: res.tempPassword };
  }

  /** Restablece la contraseña y la ENVÍA por correo (Resend). Si no hay email
   *  configurado, cae a devolver la temporal para entrega manual. */
  @Post("organizations/:id/admin/send-reset")
  async sendAdminReset(@Param("id") id: string, @Req() req: PlatformRequest) {
    const res = await this.auth.resetOrgAdminPassword(id);
    if (!res) throw new BadRequestException("La organización no tiene usuarios activos");
    const html = `<p>Hola,</p>
<p>Se restableció el acceso a tu cuenta de TuBot.</p>
<p><b>Usuario:</b> ${res.email}<br/><b>Contraseña temporal:</b> ${res.tempPassword}</p>
<p>Ingresa en <a href="https://tubot.cl/login">tubot.cl/login</a> y cámbiala.</p>`;
    const sent = await sendEmail({ to: res.email, subject: "Restablecimiento de acceso · TuBot", html });
    await this.audit(req, "platform.admin.send_reset", "user", res.userId, { email: res.email, sent });
    return { ok: true, email: res.email, sent, tempPassword: sent ? null : res.tempPassword };
  }

  /** Cambia el correo del admin del tenant. */
  @Post("organizations/:id/admin/email")
  async updateAdminEmail(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z.object({ email: z.string().email().max(200) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Correo inválido");
    const res = await this.auth.setOrgAdminEmail(id, parsed.data.email);
    await this.audit(req, "platform.admin.change_email", "user", res.userId, { email: res.email });
    return { ok: true, email: res.email };
  }

  @Post("organizations/:id/status")
  async setStatus(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z.object({ status: z.enum(["ACTIVE", "TRIAL", "SUSPENDED", "CANCELLED"]) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("status inválido");
    const org = await this.prisma.admin.organization.update({ where: { id }, data: { status: parsed.data.status } });
    await this.audit(req, `platform.org.${parsed.data.status.toLowerCase()}`, "organization", id, { status: parsed.data.status });
    return { ok: true, status: org.status };
  }

  /**
   * Impersonación AUDITADA: emite un token de TENANT de corta duración (30 min)
   * para entrar como el owner de la organización y dar soporte. El token lleva el
   * claim `imp` (id del super admin) para trazabilidad y queda registrado en la
   * auditoría. No expone contraseñas ni cambia credenciales del tenant.
   */
  @Post("organizations/:id/impersonate")
  async impersonate(@Param("id") id: string, @Req() req: PlatformRequest) {
    const db = this.prisma.admin;
    const org = await db.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundException("Organización no encontrada");
    const [memberships, roles] = await Promise.all([
      db.organizationUser.findMany({
        where: { organizationId: id, active: true },
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
      db.role.findMany({ where: { organizationId: id } }),
    ]);
    if (memberships.length === 0) throw new BadRequestException("La organización no tiene usuarios activos");
    const roleById = new Map(roles.map((r) => [r.id, r]));
    // Preferimos el owner; si no hay, el primer miembro activo.
    const chosen = memberships.find((m) => roleById.get(m.roleId)?.code === "owner") ?? memberships[0];
    const role = roleById.get(chosen.roleId);
    const perms = Array.isArray(role?.permissions) ? (role!.permissions as string[]) : [];
    const token = signAppToken(
      { sub: chosen.userId, orgId: id, role: role?.code ?? "viewer", perms },
      { expiresIn: "30m", extra: { imp: req.platformAdmin!.sub } },
    );
    await this.audit(req, "platform.impersonate", "organization", id, { userId: chosen.userId, email: chosen.user.email });
    return {
      token,
      user: { id: chosen.user.id, email: chosen.user.email, name: chosen.user.name },
      org: { id: org.id, name: org.name },
      expiresInMinutes: 30,
    };
  }

  // ------------------------------ Auditoría ------------------------------

  /** Registro de acciones del super-admin (login, MFA, impersonación, suspensiones, planes). */
  @Get("audit")
  async auditList(@Query("limit") limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const [rows, admins] = await Promise.all([
      this.prisma.admin.auditLog.findMany({ where: { actorType: "platform_admin" }, orderBy: { createdAt: "desc" }, take }),
      this.prisma.admin.platformAdmin.findMany({ select: { id: true, email: true } }),
    ]);
    const emailById = new Map(admins.map((a) => [a.id, a.email]));
    return rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      actor: r.actorId ? emailById.get(r.actorId) ?? r.actorId : "—",
      after: r.after,
      createdAt: r.createdAt,
    }));
  }

  // --------------------------- Pagos (config) ---------------------------

  /** Estado de las pasarelas (credenciales en BD cifrada o env). NO devuelve secretos. */
  @Get("billing/providers")
  async billingProviders() {
    const env = getEnv();
    const st = await this.paymentSettings.status();
    return {
      flow: {
        label: "Flow (CLP / Chile)",
        configured: st.flow.configured,
        source: st.flow.source,
        baseUrl: st.flow.baseUrl,
        webhookUrl: `${env.API_URL}/billing/webhooks/flow`,
      },
      lemonSqueezy: {
        label: "Lemon Squeezy (USD / internacional)",
        configured: st.lemonSqueezy.configured,
        source: st.lemonSqueezy.source,
        storeId: st.lemonSqueezy.storeId,
        hasWebhookSecret: st.lemonSqueezy.hasWebhookSecret,
        webhookUrl: `${env.API_URL}/billing/webhooks/lemonsqueezy`,
      },
      resend: { label: "Resend (correos)", configured: !!env.RESEND_API_KEY, source: env.RESEND_API_KEY ? "env" : null, envVars: ["RESEND_API_KEY", "RESEND_FROM"] },
    };
  }

  /** Guarda credenciales de pasarela (se CIFRAN en BD; nunca se devuelven). */
  @Post("billing/settings")
  async saveBillingSettings(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z
      .object({
        provider: z.enum(["flow", "lemonsqueezy"]),
        flow: z.object({ apiKey: z.string().optional(), secretKey: z.string().optional(), baseUrl: z.string().optional() }).optional(),
        lemonsqueezy: z.object({ apiKey: z.string().optional(), storeId: z.string().optional(), webhookSecret: z.string().optional() }).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    if (parsed.data.provider === "flow" && parsed.data.flow) await this.paymentSettings.saveFlow(parsed.data.flow);
    if (parsed.data.provider === "lemonsqueezy" && parsed.data.lemonsqueezy) await this.paymentSettings.saveLemonSqueezy(parsed.data.lemonsqueezy);
    await this.audit(req, "platform.billing.settings", "billing", parsed.data.provider);
    return { ok: true };
  }

  /**
   * Prueba EN VIVO las credenciales de Flow efectivas (BD cifrada o env) con
   * una consulta inocua — sin crear clientes ni cobrar. Cierra el hueco del
   * sandbox inservible: valida directo contra producción antes de vender.
   */
  @Post("billing/flow/test")
  async testFlowCredentials(@Req() req: PlatformRequest) {
    const s = await this.paymentSettings.get();
    if (!s.flow) throw new BadRequestException("Faltan credenciales de Flow (API Key y Secret Key)");
    const { flowTestCredentials } = await import("../billing/flow-subscriptions.js");
    const r = await flowTestCredentials(s.flow);
    await this.audit(req, "platform.billing.flow_test", "billing", r.ok ? "ok" : "fail");
    return r;
  }

  // ------------------------------ Alertas -------------------------------

  /** Alertas críticas cross-tenant: eventos de integración con status warning/error. */
  @Get("alerts")
  async alerts(@Query("limit") limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const rows = await this.prisma.admin.integrationEvent.findMany({
      where: { status: { in: ["warning", "error"] } },
      orderBy: { createdAt: "desc" },
      take,
    });
    const orgIds = [...new Set(rows.map((r) => r.organizationId))];
    const orgs = await this.prisma.admin.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } });
    const nameById = new Map(orgs.map((o) => [o.id, o.name]));
    return rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      type: r.type,
      status: r.status,
      message: r.message,
      org: nameById.get(r.organizationId) ?? r.organizationId,
      createdAt: r.createdAt,
    }));
  }

  // --------------------------- Soporte in-app ---------------------------

  /** Bandeja de soporte: tickets que reportan los tenants (cross-tenant). */
  @Get("support")
  async support(@Query("status") status?: string) {
    const where = status === "resolved" ? { status: "resolved" } : status === "all" ? {} : { status: "open" };
    const [tickets, openCount] = await Promise.all([
      this.prisma.admin.supportTicket.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 }),
      this.prisma.admin.supportTicket.count({ where: { status: "open" } }),
    ]);
    const orgIds = [...new Set(tickets.map((t) => t.organizationId))];
    const userIds = tickets.map((t) => t.userId).filter(Boolean) as string[];
    const [orgs, users] = await Promise.all([
      this.prisma.admin.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } }),
      userIds.length ? this.prisma.admin.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
    ]);
    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const userName = new Map(users.map((u) => [u.id, u.name]));
    return {
      openCount,
      tickets: tickets.map((t) => ({
        id: t.id,
        org: orgName.get(t.organizationId) ?? t.organizationId,
        user: t.userId ? userName.get(t.userId) ?? null : null,
        email: t.email,
        subject: t.subject,
        message: t.message,
        url: t.url,
        status: t.status,
        createdAt: t.createdAt,
        resolvedAt: t.resolvedAt,
      })),
    };
  }

  /** Marca un ticket como resuelto (o lo reabre). */
  @Patch("support/:id")
  async updateSupport(@Param("id") id: string, @Body() body: unknown) {
    const parsed = z.object({ status: z.enum(["open", "resolved"]) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Estado inválido");
    const t = await this.prisma.admin.supportTicket.update({
      where: { id },
      data: { status: parsed.data.status, resolvedAt: parsed.data.status === "resolved" ? new Date() : null },
    });
    return { ok: true, status: t.status };
  }

  // --------------------------- Demos / CRM ---------------------------

  /** CRM de prospectos/demos, con días en la plataforma y estado de IA si ya se provisionó. */
  @Get("demo-leads")
  async demoLeads() {
    const leads = await this.prisma.admin.demoLead.findMany({ orderBy: { createdAt: "desc" }, take: 300 });
    const orgIds = leads.map((l) => l.organizationId).filter(Boolean) as string[];
    const orgs = orgIds.length
      ? await this.prisma.admin.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, createdAt: true, status: true, settings: true } })
      : [];
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    return leads.map((l) => {
      const org = l.organizationId ? orgById.get(l.organizationId) : null;
      const settings = (org?.settings ?? {}) as Record<string, any>;
      return {
        id: l.id,
        name: l.name,
        email: l.email,
        company: l.company,
        phone: l.phone,
        planInterest: l.planInterest,
        status: l.status,
        notes: l.notes,
        createdAt: l.createdAt,
        organizationId: l.organizationId,
        orgStatus: org?.status ?? null,
        daysOnPlatform: org ? Math.floor((Date.now() - new Date(org.createdAt).getTime()) / 86_400_000) : null,
        aiEnabled: org ? settings.aiKillSwitch !== true : null,
        validUntil: typeof settings.validUntil === "string" ? settings.validUntil : null,
      };
    });
  }

  @Patch("demo-leads/:id")
  async updateDemoLead(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z
      .object({
        status: z.enum(["NEW", "CONTACTED", "PROVISIONED", "ACTIVE", "WON", "LOST"]).optional(),
        notes: z.string().max(1000).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    const lead = await this.prisma.admin.demoLead.update({ where: { id }, data: parsed.data });
    await this.audit(req, "platform.demo.update", "demo_lead", id, parsed.data);
    return lead;
  }

  /** Provisiona el demo: crea org + usuario owner con IA PAUSADA (no gasta tokens). */
  @Post("demo-leads/:id/provision")
  async provisionDemoLead(@Param("id") id: string, @Req() req: PlatformRequest) {
    const lead = await this.prisma.admin.demoLead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException("Prospecto no encontrado");
    if (lead.organizationId) throw new BadRequestException("Este prospecto ya tiene un demo provisionado");
    const res = await this.auth.provisionDemo({ email: lead.email, name: lead.name, company: lead.company ?? lead.name });
    await this.prisma.admin.demoLead.update({ where: { id }, data: { organizationId: res.organizationId, status: "PROVISIONED" } });
    await this.audit(req, "platform.demo.provision", "demo_lead", id, { organizationId: res.organizationId });
    return { ok: true, email: res.email, tempPassword: res.tempPassword, organizationId: res.organizationId, validUntil: res.validUntil };
  }

  /** Crea un prospecto manualmente (para demos agendados fuera de la web). */
  @Post("demo-leads")
  async createDemoLead(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z
      .object({
        name: z.string().min(2).max(80),
        email: z.string().email().max(200),
        company: z.string().max(120).optional(),
        phone: z.string().max(40).optional(),
        planInterest: z.string().max(40).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    const lead = await this.prisma.admin.demoLead.create({ data: { ...parsed.data, status: "NEW" } });
    await this.audit(req, "platform.demo.create", "demo_lead", lead.id, { email: lead.email });
    return lead;
  }

  // ------------------------------- Planes -------------------------------

  @Get("plans")
  plans() {
    return this.prisma.admin.plan.findMany({ orderBy: { order: "asc" } });
  }

  /** Vista global del cobro recurrente: MRR, fallos, suspendidas, canceladas y próximos cobros. */
  @Get("billing/recurring")
  async recurringOverview() {
    const admin = this.prisma.admin;
    const now = new Date();
    const in7 = new Date(now.getTime() + 7 * 86_400_000);
    const from30 = new Date(now.getTime() - 30 * 86_400_000);
    const [activeSubs, pastDue, suspended, canceling, failed30, upcoming, plans] = await Promise.all([
      admin.subscription.findMany({ where: { status: "ACTIVE" }, select: { organizationId: true, planId: true, interval: true } }),
      admin.subscription.count({ where: { status: "PAST_DUE" } }),
      admin.subscription.count({ where: { status: "SUSPENDED" } }),
      admin.subscription.count({ where: { status: "ACTIVE", cancelAtPeriodEnd: true } }),
      admin.paymentAttempt.count({ where: { status: "failed", createdAt: { gte: from30 } } }),
      admin.subscription.findMany({ where: { status: "ACTIVE", nextChargeAt: { gte: now, lte: in7 } }, select: { organizationId: true, nextChargeAt: true, interval: true }, orderBy: { nextChargeAt: "asc" }, take: 30 }),
      admin.plan.findMany({ select: { id: true, priceClp: true, priceClpYearly: true } }),
    ]);
    const priceById = new Map(plans.map((p) => [p.id, { m: Number(p.priceClp), y: p.priceClpYearly != null ? Number(p.priceClpYearly) : null }]));
    // MRR mensual-equivalente en CLP (anual/12). Facturables no incluidos (aprox).
    let mrr = 0;
    for (const s of activeSubs) {
      const pr = priceById.get(s.planId);
      if (!pr) continue;
      mrr += s.interval === "yearly" ? (pr.y ?? pr.m * 12) / 12 : pr.m;
    }
    const orgIds = [...new Set(upcoming.map((u) => u.organizationId))];
    const orgs = await admin.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } });
    const nameById = new Map(orgs.map((o) => [o.id, o.name]));
    return {
      mrr: Math.round(mrr),
      counts: { active: activeSubs.length, pastDue, suspended, canceling, failed30 },
      upcoming: upcoming.map((u) => ({ org: nameById.get(u.organizationId) ?? u.organizationId, nextChargeAt: u.nextChargeAt, interval: u.interval })),
    };
  }

  /**
   * Monitor de infraestructura para el Super Admin: conexiones y tamaño de Postgres
   * (por SQL, el cuello de botella #1) + métricas de Railway (CPU/RAM por servicio y
   * uso mensual estimado) si hay RAILWAY_API_TOKEN. Solo lecturas.
   */
  @Get("infra")
  async infra() {
    const token = getEnv().RAILWAY_API_TOKEN;
    const rows = await this.prisma.admin.$queryRawUnsafe<Array<{ total: number; active: number; max_conn: number; db_size: bigint }>>(
      `SELECT (SELECT count(*)::int FROM pg_stat_activity) AS total,
              (SELECT count(*)::int FROM pg_stat_activity WHERE state = 'active') AS active,
              current_setting('max_connections')::int AS max_conn,
              pg_database_size(current_database())::bigint AS db_size`,
    );
    const r = rows[0];
    const postgres = {
      connections: Number(r?.total ?? 0),
      active: Number(r?.active ?? 0),
      maxConnections: Number(r?.max_conn ?? 0),
      dbSizeBytes: Number(r?.db_size ?? 0),
    };
    if (!token) return { configured: false, postgres };
    try {
      const railway = await getRailwayInfra(token);
      return { configured: true, postgres, railway };
    } catch (e) {
      return { configured: true, postgres, error: (e as Error).message };
    }
  }

  /** Precio de activación de mensajes de plantilla (servicio adicional), editable. */
  @Get("templates-pricing")
  async templatesPricing() {
    const row = await this.prisma.admin.platformSetting.findUnique({ where: { key: "templatesActivation" } });
    let value = { priceClp: null as number | null, priceUsd: null as number | null };
    if (row?.value) {
      try {
        const p = JSON.parse(row.value);
        value = { priceClp: typeof p.priceClp === "number" ? p.priceClp : null, priceUsd: typeof p.priceUsd === "number" ? p.priceUsd : null };
      } catch {
        /* corrupto → nulls */
      }
    }
    return value;
  }

  @Patch("templates-pricing")
  async setTemplatesPricing(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z
      .object({ priceClp: z.number().int().min(0).nullable().optional(), priceUsd: z.number().min(0).nullable().optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Valores inválidos");
    const cur = await this.templatesPricing();
    const next = {
      priceClp: parsed.data.priceClp !== undefined ? parsed.data.priceClp : cur.priceClp,
      priceUsd: parsed.data.priceUsd !== undefined ? parsed.data.priceUsd : cur.priceUsd,
    };
    await this.prisma.admin.platformSetting.upsert({
      where: { key: "templatesActivation" },
      update: { value: JSON.stringify(next) },
      create: { key: "templatesActivation", value: JSON.stringify(next) },
    });
    await this.audit(req, "platform.templates_pricing", "platform_setting", "templatesActivation", next);
    return next;
  }

  /** Tarifas EFECTIVAS (IA por token + WhatsApp por mensaje, con overrides) + tipo de cambio. */
  @Get("cost-model")
  async costModel() {
    const { rates, usdToClp } = await this.readCostSettings();
    return { models: MODEL_PRICING, whatsapp: { ...WHATSAPP_PRICING, ...rates }, usdToClp };
  }

  /** Guarda tarifas de Meta por país y/o el tipo de cambio (editable desde el panel). */
  @Patch("cost-settings")
  async updateCostSettings(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z
      .object({
        usdToClp: z.number().positive().max(100_000).optional(),
        whatsappRates: z
          .record(z.string(), z.object({ marketing: z.number().min(0), utility: z.number().min(0), authentication: z.number().min(0), service: z.number().min(0) }))
          .optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    if (parsed.data.usdToClp !== undefined) {
      await this.prisma.admin.platformSetting.upsert({ where: { key: "usdToClp" }, update: { value: String(parsed.data.usdToClp) }, create: { key: "usdToClp", value: String(parsed.data.usdToClp) } });
    }
    if (parsed.data.whatsappRates) {
      const cur = await this.readCostSettings();
      const merged = { ...cur.rates, ...parsed.data.whatsappRates };
      await this.prisma.admin.platformSetting.upsert({ where: { key: "whatsappRates" }, update: { value: JSON.stringify(merged) }, create: { key: "whatsappRates", value: JSON.stringify(merged) } });
    }
    await this.audit(req, "platform.cost_settings_update", "platform_setting", "cost", parsed.data as object);
    return this.costModel();
  }

  // ---------------------- Límites de mensajería (fusible + topes) ----------------------

  /** Topes globales + tope por defecto por tenant, con consumo del día y equivalencia en CLP. */
  @Get("messaging-limits")
  async messagingLimits() {
    const caps = await this.readMessagingCaps();
    const { usdToClp } = await this.readCostSettings();
    const date = new Date().toISOString().slice(0, 10);
    let todayGlobal = 0;
    let fuseTripped = false;
    try {
      todayGlobal = Number(await this.queues.connection.get(`msgcap:g:${date}`)) || 0;
      fuseTripped = (await this.queues.connection.get(`msgcap:fuse:${date}`)) === "1";
    } catch {
      /* redis caído → 0 */
    }
    return { ...caps, todayGlobal, fuseTripped, clpPerMsg: this.clpPerMsg(usdToClp, "CL") };
  }

  /** Ajusta el tope global y/o el default por tenant (auditado). */
  @Patch("messaging-limits")
  async setMessagingLimits(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z
      .object({ global: z.number().int().min(1).max(10_000_000).optional(), perTenantDefault: z.number().int().min(1).max(10_000_000).optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Valores inválidos");
    if (parsed.data.global !== undefined) {
      await this.prisma.admin.platformSetting.upsert({ where: { key: "messagingCapGlobalDay" }, update: { value: String(parsed.data.global) }, create: { key: "messagingCapGlobalDay", value: String(parsed.data.global) } });
    }
    if (parsed.data.perTenantDefault !== undefined) {
      await this.prisma.admin.platformSetting.upsert({ where: { key: "messagingCapPerTenantDay" }, update: { value: String(parsed.data.perTenantDefault) }, create: { key: "messagingCapPerTenantDay", value: String(parsed.data.perTenantDefault) } });
    }
    await this.audit(req, "platform.messaging_limits_update", "platform_setting", "messaging", parsed.data as object);
    return this.messagingLimits();
  }

  /** Tope propio de un tenant (override del default) + consumo del día. */
  @Get("organizations/:id/messaging")
  async orgMessaging(@Param("id") id: string) {
    const org = await this.prisma.admin.organization.findUnique({ where: { id }, select: { settings: true, country: true } });
    const override = Number((org?.settings as any)?.messaging?.dailyCap);
    const hasOverride = Number.isFinite(override) && override > 0;
    const { perTenantDefault } = await this.readMessagingCaps();
    const { usdToClp } = await this.readCostSettings();
    const date = new Date().toISOString().slice(0, 10);
    let today = 0;
    try {
      today = Number(await this.queues.connection.get(`msgcap:t:${id}:${date}`)) || 0;
    } catch {
      /* redis caído → 0 */
    }
    return {
      override: hasOverride ? override : null,
      default: perTenantDefault,
      effective: hasOverride ? override : perTenantDefault,
      today,
      clpPerMsg: this.clpPerMsg(usdToClp, org?.country ?? "CL"),
    };
  }

  /** Fija/limpia el tope propio de un tenant (null = usar el default). Auditado. */
  @Patch("organizations/:id/messaging-cap")
  async setOrgMessagingCap(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z.object({ dailyCap: z.number().int().min(1).max(10_000_000).nullable() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Valor inválido");
    const org = await this.prisma.admin.organization.findUnique({ where: { id }, select: { settings: true } });
    const settings = (org?.settings ?? {}) as Record<string, any>;
    const messaging = { ...(settings.messaging ?? {}) };
    if (parsed.data.dailyCap === null) delete messaging.dailyCap;
    else messaging.dailyCap = parsed.data.dailyCap;
    await this.prisma.admin.organization.update({ where: { id }, data: { settings: { ...settings, messaging } as object } });
    await this.audit(req, "platform.org_messaging_cap_update", "organization", id, { dailyCap: parsed.data.dailyCap });
    return { ok: true };
  }

  // ---------------------- Bolsa prepagada (pesos + saldo por tenant) ----------------------

  /** Pesos por categoría (A: 1/1/1 por cantidad · B: marketing>1 ponderado). */
  @Get("wallet-weights")
  async walletWeights() {
    return this.readWalletWeights();
  }

  @Patch("wallet-weights")
  async setWalletWeights(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z
      .object({ utility: z.number().int().min(1).max(100), authentication: z.number().int().min(1).max(100), marketing: z.number().int().min(1).max(100) })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Pesos inválidos (enteros ≥ 1)");
    await this.prisma.admin.platformSetting.upsert({ where: { key: "walletWeights" }, update: { value: JSON.stringify(parsed.data) }, create: { key: "walletWeights", value: JSON.stringify(parsed.data) } });
    await this.audit(req, "platform.wallet_weights_update", "platform_setting", "walletWeights", parsed.data);
    return parsed.data;
  }

  /** Saldo y últimos movimientos de la bolsa de un tenant. */
  @Get("organizations/:id/wallet")
  async orgWallet(@Param("id") id: string) {
    const [wallet, ledger] = await Promise.all([
      this.prisma.admin.messageWallet.findUnique({ where: { organizationId: id } }),
      this.prisma.admin.walletLedger.findMany({ where: { organizationId: id }, orderBy: { createdAt: "desc" }, take: 15 }),
    ]);
    return {
      balance: wallet?.balance ?? 0,
      included: wallet?.includedPerPeriod ?? 0,
      periodStart: wallet?.periodStart ?? null,
      ledger: ledger.map((l) => ({ delta: l.delta, reason: l.reason, balanceAfter: l.balanceAfter, category: l.category, createdAt: l.createdAt })),
    };
  }

  /** Ajuste manual de saldo (regalar/quitar créditos), auditado. */
  @Post("organizations/:id/wallet-adjust")
  async adjustWallet(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z.object({ delta: z.number().int().refine((n) => n !== 0, "delta ≠ 0"), reason: z.string().max(200).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Ajuste inválido");
    const w = await this.prisma.admin.messageWallet.findUnique({ where: { organizationId: id } });
    const base = w?.balance ?? 0;
    const balance = Math.max(0, base + parsed.data.delta);
    await this.prisma.admin.messageWallet.upsert({
      where: { organizationId: id },
      create: { organizationId: id, balance, includedPerPeriod: 0, carryoverCap: 0 },
      update: { balance },
    });
    await this.prisma.admin.walletLedger.create({
      data: { organizationId: id, delta: balance - base, reason: "admin_adjust", balanceAfter: balance, refType: "admin", refId: parsed.data.reason ?? null, createdById: req.platformAdmin?.sub },
    });
    await this.audit(req, "platform.wallet_adjust", "organization", id, { delta: parsed.data.delta, reason: parsed.data.reason });
    return { ok: true, balance };
  }

  // ---------------------- Panel único de mensajería por tenant ----------------------

  /** Reúne las entradas del gate para un tenant (solo lectura: BD + Redis). */
  private async messagingSnapshot(id: string) {
    const db = this.prisma.admin;
    const date = new Date().toISOString().slice(0, 10);
    const [org, latestSub, activeSub, wallet, caps, cost] = await Promise.all([
      db.organization.findUnique({ where: { id }, select: { id: true, name: true, status: true, settings: true, country: true } }),
      db.subscription.findFirst({ where: { organizationId: id }, orderBy: { createdAt: "desc" } }),
      db.subscription.findFirst({ where: { organizationId: id, status: { in: ACTIVE_SUB_STATUSES as unknown as string[] } as never }, orderBy: { createdAt: "desc" } }),
      db.messageWallet.findUnique({ where: { organizationId: id } }),
      this.readMessagingCaps(),
      this.readCostSettings(),
    ]);
    if (!org) throw new NotFoundException("Organización no encontrada");
    const plan = activeSub ? await db.plan.findUnique({ where: { id: activeSub.planId } }) : await db.plan.findUnique({ where: { code: "free" } });
    const settings = (org.settings ?? {}) as Record<string, any>;
    const override = Number(settings?.messaging?.dailyCap);
    const hasOverride = Number.isFinite(override) && override > 0;
    const dailyCapEffective = hasOverride ? override : caps.perTenantDefault;
    let today = 0;
    let todayGlobal = 0;
    let fuseTripped = false;
    try {
      const [t, g, f] = await this.queues.connection.mget(`msgcap:t:${id}:${date}`, `msgcap:g:${date}`, `msgcap:fuse:${date}`);
      today = Number(t) || 0;
      todayGlobal = Number(g) || 0;
      fuseTripped = f === "1";
    } catch {
      /* redis caído → 0 (fail open en el conteo, como el gate) */
    }
    const inputs: GateInputs = {
      orgStatus: org.status,
      templatesEnabled: settings?.messaging?.templatesEnabled === true,
      planAllows: ((plan?.features as any)?.whatsappTemplates) === true,
      latestSubStatus: latestSub?.status ?? null,
      balance: wallet?.balance ?? 0,
      today,
      dailyCapEffective,
      todayGlobal,
      globalCap: caps.global,
      fuseTripped,
    };
    return { org, plan, settings, wallet, caps, cost, override: hasOverride ? override : null, dailyCapEffective, today, todayGlobal, fuseTripped, latestSub, inputs };
  }

  /** Panel único: las seis condiciones con semáforo + datos para editar en línea. */
  @Get("organizations/:id/messaging-panel")
  async messagingPanel(@Param("id") id: string) {
    const s = await this.messagingSnapshot(id);
    const gate = evalMessagingGate(s.inputs);
    const cond = (key: string) => gate.conditions.find((c) => c.key === key)!;
    const clpPerMsg = this.clpPerMsg(s.cost.usdToClp, s.org.country ?? "CL");
    const now = new Date();
    const periodStart = s.wallet?.periodStart ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const tmplAgg = await this.prisma.admin.usageEvent.aggregate({
      where: { organizationId: id, type: "whatsapp_message", occurredAt: { gte: periodStart } },
      _count: { _all: true },
    });
    return {
      summary: { canSend: gate.canSend, blockedBy: gate.blockedBy, reason: gate.reason, line: gate.canSend ? "Sí puede enviar" : `Bloqueado por: ${gate.reason}` },
      conditions: {
        plan: { pass: s.inputs.planAllows, planCode: s.plan?.code ?? null, planName: s.plan?.name ?? null, allows: s.inputs.planAllows },
        switch: { pass: s.inputs.templatesEnabled, on: s.inputs.templatesEnabled },
        account: { pass: cond("account").pass, status: s.org.status, subStatus: s.latestSub?.status ?? null },
        daily: { pass: cond("daily").pass, effective: s.dailyCapEffective, override: s.override, today: s.today, clpPerMsg },
        wallet: { pass: s.inputs.balance > 0, balance: s.wallet?.balance ?? 0, included: s.wallet?.includedPerPeriod ?? 0, usedThisPeriod: tmplAgg._count._all, periodStart },
        fuse: { pass: cond("fuse").pass, tripped: s.fuseTripped, todayGlobal: s.todayGlobal, globalCap: s.caps.global },
      },
    };
  }

  /** "¿Puede enviar ahora?": corre las seis validaciones y responde en una línea. */
  @Get("organizations/:id/can-send")
  async canSend(@Param("id") id: string) {
    const s = await this.messagingSnapshot(id);
    const gate = evalMessagingGate(s.inputs);
    return { canSend: gate.canSend, blockedBy: gate.blockedBy, reason: gate.reason, line: gate.canSend ? "Sí puede enviar" : `Bloqueado por: ${gate.reason}` };
  }

  /** Últimos envíos de plantilla rechazados por el gate (con condición y conversación). */
  @Get("organizations/:id/rejected-sends")
  async rejectedSends(@Param("id") id: string) {
    const rows = await this.prisma.admin.integrationEvent.findMany({
      where: { organizationId: id, provider: "messaging", type: "template.blocked" },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    return rows.map((r) => {
      const payload = (r.payload ?? {}) as Record<string, any>;
      const reason = String(payload.reason ?? "");
      return {
        createdAt: r.createdAt,
        reason,
        reasonLabel: MESSAGING_REASON_LABELS[reason] ?? reason,
        message: r.message,
        conversationId: payload.conversationId ?? null,
      };
    });
  }

  // ---------------------- Margen por cliente + catálogo de paquetes ----------------------

  /** Margen real por tenant del mes: ingreso cobrado − costo Meta − costo IA (en CLP). */
  @Get("margins")
  async margins() {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const { usdToClp } = await this.readCostSettings();
    const [orgs, invoices, usage] = await Promise.all([
      this.prisma.admin.organization.findMany({ where: { deletedAt: null }, select: { id: true, name: true, currency: true } }),
      this.prisma.admin.invoice.groupBy({ by: ["organizationId"], where: { status: "PAID", paidAt: { gte: monthStart } }, _sum: { amountDue: true } }),
      this.prisma.admin.usageEvent.groupBy({ by: ["organizationId", "type"], where: { occurredAt: { gte: monthStart } }, _sum: { costUsd: true } }),
    ]);
    const revById = new Map(invoices.map((i) => [i.organizationId, Number(i._sum.amountDue ?? 0)]));
    const metaById = new Map<string, number>();
    const aiById = new Map<string, number>();
    for (const u of usage) {
      const usd = Number(u._sum.costUsd ?? 0);
      if (u.type === "whatsapp_message") metaById.set(u.organizationId, usd);
      else if (u.type === "ai_tokens") aiById.set(u.organizationId, (aiById.get(u.organizationId) ?? 0) + usd);
    }
    const rows = orgs.map((o) => {
      // Ingreso: la factura ya está en la moneda del tenant → normalizamos a CLP.
      const revenueClp = o.currency === "CLP" ? (revById.get(o.id) ?? 0) : (revById.get(o.id) ?? 0) * usdToClp;
      const metaCostClp = (metaById.get(o.id) ?? 0) * usdToClp;
      const aiCostClp = (aiById.get(o.id) ?? 0) * usdToClp;
      const marginClp = revenueClp - metaCostClp - aiCostClp;
      return {
        id: o.id,
        name: o.name,
        revenueClp: Math.round(revenueClp),
        metaCostClp: Math.round(metaCostClp),
        aiCostClp: Math.round(aiCostClp),
        marginClp: Math.round(marginClp),
        marginPct: revenueClp > 0 ? Math.round((marginClp / revenueClp) * 100) : null,
      };
    });
    // Los que pierden plata primero (margen negativo arriba).
    rows.sort((a, b) => a.marginClp - b.marginClp);
    return { month: monthStart.toISOString().slice(0, 7), rows };
  }

  /** Catálogo de paquetes (para el CRUD del Super Admin). */
  @Get("packages")
  packages() {
    return this.prisma.admin.messagePackage.findMany({ orderBy: { order: "asc" } });
  }

  @Post("packages")
  async createPackage(@Body() body: unknown, @Req() req: PlatformRequest) {
    const d = this.parsePackage(body);
    const pkg = await this.prisma.admin.messagePackage.create({ data: d });
    await this.audit(req, "platform.package_create", "package", pkg.id, d);
    return pkg;
  }

  @Patch("packages/:id")
  async updatePackage(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const d = this.parsePackage(body, true);
    const pkg = await this.prisma.admin.messagePackage.update({ where: { id }, data: d });
    await this.audit(req, "platform.package_update", "package", id, d);
    return pkg;
  }

  @Delete("packages/:id")
  async deletePackage(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.prisma.admin.messagePackage.delete({ where: { id } });
    await this.audit(req, "platform.package_delete", "package", id);
    return { ok: true };
  }

  private parsePackage(body: unknown, partial = false) {
    const schema = z.object({
      code: z.string().regex(/^[a-z0-9_]+$/, "código: minúsculas/números/_"),
      name: z.string().min(2).max(60),
      credits: z.number().int().min(1),
      priceClp: z.number().int().min(0),
      priceUsd: z.number().min(0),
      active: z.boolean().default(true),
      order: z.number().int().default(0),
    });
    const r = (partial ? schema.partial() : schema).safeParse(body);
    if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
    return r.data as any;
  }

  private async readWalletWeights(): Promise<{ utility: number; authentication: number; marketing: number }> {
    const def = { utility: 1, authentication: 1, marketing: 1 };
    try {
      const row = await this.prisma.admin.platformSetting.findUnique({ where: { key: "walletWeights" } });
      if (row) {
        const p = JSON.parse(row.value);
        return { utility: Number(p.utility) || 1, authentication: Number(p.authentication) || 1, marketing: Number(p.marketing) || 1 };
      }
    } catch {
      /* defaults */
    }
    return def;
  }

  private async readMessagingCaps(): Promise<{ global: number; perTenantDefault: number }> {
    const env = getEnv();
    const rows = await this.prisma.admin.platformSetting.findMany({ where: { key: { in: ["messagingCapGlobalDay", "messagingCapPerTenantDay"] } } });
    const g = rows.find((r) => r.key === "messagingCapGlobalDay");
    const t = rows.find((r) => r.key === "messagingCapPerTenantDay");
    return {
      global: g && Number(g.value) > 0 ? Number(g.value) : env.MSG_CAP_GLOBAL_DAY,
      perTenantDefault: t && Number(t.value) > 0 ? Number(t.value) : env.MSG_CAP_PER_TENANT_DAY,
    };
  }

  /** Costo por mensaje en CLP (marketing y utilidad) para mostrar equivalencias. */
  private clpPerMsg(usdToClp: number, country: string): { marketing: number; utility: number } {
    return {
      marketing: Math.round(computeWhatsappCostUsd("marketing", country) * usdToClp),
      utility: Math.round(computeWhatsappCostUsd("utility", country) * usdToClp),
    };
  }

  /** Lee overrides de tarifas + tipo de cambio de platform_settings. */
  private async readCostSettings(): Promise<{ rates: Record<string, { marketing: number; utility: number; authentication: number; service: number }>; usdToClp: number }> {
    const rows = await this.prisma.admin.platformSetting.findMany({ where: { key: { in: ["whatsappRates", "usdToClp"] } } });
    const ratesRow = rows.find((r) => r.key === "whatsappRates");
    const fxRow = rows.find((r) => r.key === "usdToClp");
    let rates: Record<string, any> = {};
    try {
      rates = ratesRow ? JSON.parse(ratesRow.value) : {};
    } catch {
      rates = {};
    }
    return { rates, usdToClp: fxRow ? Number(fxRow.value) || 950 : 950 };
  }

  /** Prueba rápida de IA: manda un prompt al modelo y devuelve la respuesta + uso.
   *  Verifica que la llave (OpenAI/Anthropic) funciona sin depender de WhatsApp. */
  @Post("test-ai")
  async testAi(@Body() body: unknown) {
    const parsed = z
      .object({
        model: z.string().default("gpt-4o-mini"),
        prompt: z.string().max(500).default("Responde en una sola frase: ¿estás funcionando correctamente?"),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    const env = getEnv();
    const router = createAIRouter({ anthropicApiKey: env.ANTHROPIC_API_KEY, openaiApiKey: env.OPENAI_API_KEY });
    try {
      const res = await router.chat({
        model: parsed.data.model,
        system: "Eres un asistente de prueba. Responde breve y en español.",
        messages: [{ role: "user", content: parsed.data.prompt }],
      });
      return { ok: true, text: res.text, model: parsed.data.model, usage: res.usage, latencyMs: res.latencyMs, stopReason: res.stopReason };
    } catch (e: any) {
      // Devolvemos el error de forma legible (p.ej. sin saldo, llave inválida).
      return { ok: false, model: parsed.data.model, error: String(e?.message ?? e).slice(0, 300) };
    }
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

  // ------------------------------- Cupones -------------------------------

  @Get("coupons")
  coupons() {
    return this.prisma.admin.coupon.findMany({ orderBy: { createdAt: "desc" } });
  }

  @Post("coupons")
  async createCoupon(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z
      .object({
        code: z.string().min(3).max(40),
        description: z.string().max(200).optional(),
        discountType: z.enum(["PERCENT", "FIXED"]),
        discountValue: z.coerce.number().positive(),
        currency: z.enum(["CLP", "USD"]).optional(),
        maxRedemptions: z.coerce.number().int().positive().optional(),
        expiresAt: z.string().optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos de cupón inválidos");
    const d = parsed.data;
    if (d.discountType === "PERCENT" && d.discountValue > 100) throw new BadRequestException("El porcentaje no puede superar 100");
    const coupon = await this.prisma.admin.coupon
      .create({
        data: {
          code: d.code.trim().toUpperCase(),
          description: d.description,
          discountType: d.discountType,
          discountValue: d.discountValue,
          currency: d.discountType === "FIXED" ? d.currency ?? "CLP" : null,
          maxRedemptions: d.maxRedemptions,
          expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
        },
      })
      .catch((e: any) => {
        if (e?.code === "P2002") throw new BadRequestException("Ya existe un cupón con ese código");
        throw e;
      });
    await this.audit(req, "platform.coupon.create", "coupon", coupon.id, { code: coupon.code });
    return coupon;
  }

  @Patch("coupons/:id")
  async updateCoupon(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z.object({ active: z.boolean().optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    const coupon = await this.prisma.admin.coupon.update({ where: { id }, data: parsed.data });
    await this.audit(req, "platform.coupon.update", "coupon", id, parsed.data);
    return coupon;
  }

  @Delete("coupons/:id")
  async deleteCoupon(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.prisma.admin.coupon.delete({ where: { id } });
    await this.audit(req, "platform.coupon.delete", "coupon", id);
    return { ok: true };
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

  /** Acciones del Super Admin sobre el cobro recurrente de un tenant. */
  @Post("organizations/:id/billing-action")
  async billingAction(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z.object({ action: z.enum(["reactivate", "extend_window", "register_payment"]), hours: z.coerce.number().int().min(1).max(240).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Acción inválida");
    const sub = await this.prisma.admin.subscription.findFirst({ where: { organizationId: id }, orderBy: { createdAt: "desc" } });
    if (!sub) throw new BadRequestException("El tenant no tiene suscripción");
    const admin = this.prisma.admin;

    if (parsed.data.action === "reactivate") {
      // Reactivación manual (override del Super Admin): vuelve a ACTIVE sin cobrar.
      await admin.subscription.update({ where: { id: sub.id }, data: { status: "ACTIVE", pastDueSince: null, retriesDone: 0 } });
      await admin.organization.update({ where: { id }, data: { status: "ACTIVE" } });
    } else if (parsed.data.action === "extend_window") {
      // Extiende la ventana de 48 h: reinicia el reloj del impago desde ahora (+hours opcional).
      const base = new Date(Date.now() + (parsed.data.hours ?? 24) * 3_600_000 - 48 * 3_600_000);
      await admin.subscription.update({ where: { id: sub.id }, data: { status: "PAST_DUE", pastDueSince: base, retriesDone: 0 } });
    } else if (parsed.data.action === "register_payment") {
      // Pago recibido POR FUERA (transferencia, etc.): renueva el período y reactiva.
      const plan = await admin.plan.findUnique({ where: { id: sub.planId }, select: { interval: true } });
      const periodEnd = new Date();
      periodEnd.setMonth(periodEnd.getMonth() + (sub.interval === "yearly" || plan?.interval === "yearly" ? 12 : 1));
      await admin.subscription.update({ where: { id: sub.id }, data: { status: "ACTIVE", pastDueSince: null, retriesDone: 0, periodStart: new Date(), periodEnd, nextChargeAt: periodEnd } });
      await admin.organization.update({ where: { id }, data: { status: "ACTIVE" } });
      await admin.paymentAttempt.create({ data: { organizationId: id, subscriptionId: sub.id, commerceOrder: `ext-${sub.id}-${Date.now()}`, amount: 0, currency: "CLP", kind: "manual", status: "succeeded", provider: "external", reason: "Pago externo registrado por el Super Admin" } });
    }
    await this.audit(req, `platform.billing.${parsed.data.action}`, "subscription", sub.id, { hours: parsed.data.hours ?? null });
    return { ok: true };
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
  // Precio ANUAL opcional (null = no se ofrece anual). `.nullable()` deja pasar null
  // tal cual (no lo coerce a 0). Faltaban aquí → el PATCH los descartaba (bug del PR #127).
  priceClpYearly: z.coerce.number().min(0).nullable().optional(),
  priceUsdYearly: z.coerce.number().min(0).nullable().optional(),
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
