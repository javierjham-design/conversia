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
import { getEnv, brandOf } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { computeWhatsappCostUsd } from "@conversia/agents";
import { AuthService } from "../auth/auth.service";
import { VerticalService } from "../organizations/vertical.service";
import { PaymentSettingsService } from "../billing/payment-settings.service";
import { flowCollect, flowCustomerGet, flowPaymentStatus } from "../billing/flow-subscriptions";
import { createPaymentProvider } from "../billing/payment-provider";
import { sendEmail } from "../common/email";
import { signAppToken } from "../auth/jwt";
import { PlatformGuard, type PlatformRequest } from "./platform.guard";
import { isFullPlatformAdmin } from "./platform-policy";
import { getRailwayInfra } from "./railway-metrics";
import { randomBytes } from "node:crypto";
import * as bcryptMod from "bcryptjs";

const bcrypt = (bcryptMod as any).default ?? bcryptMod;

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
    private vertical: VerticalService,
  ) {}

  private audit(req: PlatformRequest, action: string, entityType: string, entityId: string, after?: object) {
    // F10 — trazamos el ROL del actor (super admin vs operador) en la bitácora sin migrar:
    // va como metadata en `after` (actorId ya responde "quién"; el rol da el "con qué poder").
    const role = req.platformAdmin?.role ?? "owner";
    return this.prisma.admin.auditLog.create({
      data: {
        actorType: "platform_admin",
        actorId: req.platformAdmin?.sub,
        action,
        entityType,
        entityId,
        after: { ...(after ?? {}), _actorRole: role },
      },
    });
  }

  // ----------------- Aislamiento por marca del Super Admin (D8) -----------------
  // Cada super admin solo ve y opera los tenants de SU marca (brand del token). Un
  // super admin de TuBot ve exactamente lo de hoy (conversia es nuevo); uno de
  // Conversia nunca ve ni toca TuBot. Las listas/métricas filtran por marca y cada
  // acción por-org valida que la org pertenezca a la marca (404 si no).

  /** Marca del super admin que hace la petición. Default tubot (comportamiento actual). */
  private reqBrand(req: PlatformRequest): string {
    return req.platformAdmin?.brand ?? "tubot";
  }

  /** Ids de las organizaciones de la marca del super admin (para acotar agregados por org). */
  private async brandOrgIds(req: PlatformRequest): Promise<string[]> {
    const rows = await this.prisma.admin.organization.findMany({ where: { brand: this.reqBrand(req) }, select: { id: true } });
    return rows.map((o) => o.id);
  }

  /** Asegura que la org pertenece a la marca del super admin; 404 si no (aísla marcas). */
  private async assertOrgBrand(req: PlatformRequest, id: string): Promise<void> {
    const org = await this.prisma.admin.organization.findUnique({ where: { id }, select: { brand: true } });
    if (!org || (org.brand ?? "tubot") !== this.reqBrand(req)) {
      throw new NotFoundException("Organización no encontrada");
    }
  }

  // ------------------------------ Métricas ------------------------------

  @Get("metrics")
  async metrics(@Req() req: PlatformRequest) {
    const db = this.prisma.admin;
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    // D8 — todo el dashboard se acota a la marca del super admin.
    const brand = this.reqBrand(req);
    const orgIds = await this.brandOrgIds(req);
    const [orgs, active, trialing, suspended, plans, subs, ai, invoicesPaid, whatsapp] = await Promise.all([
      db.organization.count({ where: { brand, deletedAt: null } }),
      db.organization.count({ where: { brand, status: "ACTIVE", deletedAt: null } }),
      db.organization.count({ where: { brand, status: "TRIAL", deletedAt: null } }),
      db.organization.count({ where: { brand, status: "SUSPENDED" } }),
      db.plan.findMany(),
      db.subscription.findMany({ where: { organizationId: { in: orgIds }, status: { in: ["ACTIVE", "TRIALING"] } } }),
      db.aiRequest.aggregate({ where: { organizationId: { in: orgIds }, createdAt: { gte: since } }, _sum: { costUsd: true }, _count: { _all: true } }),
      db.invoice.aggregate({ where: { organizationId: { in: orgIds }, status: "PAID" }, _sum: { amountDue: true } }),
      // Costo que cobra Meta por mensajes de WhatsApp (últimos 30 días).
      db.usageEvent.aggregate({ where: { organizationId: { in: orgIds }, type: "whatsapp_message", occurredAt: { gte: since } }, _sum: { costUsd: true }, _count: { _all: true } }),
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

  /** Métricas de CALIDAD del bot (últimas 24 h): responde / a tiempo / sin fallar. */
  @Get("quality")
  async quality(@Req() req: PlatformRequest) {
    const db = this.prisma.admin;
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    // D8 — calidad acotada a la marca del super admin.
    const orgIds = await this.brandOrgIds(req);
    const [reqAgg, errCount, refusalCount, inbound, botReplies, failedOut, failedByOrg] = await Promise.all([
      db.aiRequest.aggregate({ where: { organizationId: { in: orgIds }, createdAt: { gte: since } }, _avg: { latencyMs: true }, _count: { _all: true } }),
      db.aiRequest.count({ where: { organizationId: { in: orgIds }, createdAt: { gte: since }, status: "error" } }),
      db.aiRequest.count({ where: { organizationId: { in: orgIds }, createdAt: { gte: since }, status: "refusal" } }),
      db.message.count({ where: { organizationId: { in: orgIds }, createdAt: { gte: since }, direction: "INBOUND" } }),
      db.message.count({ where: { organizationId: { in: orgIds }, createdAt: { gte: since }, direction: "OUTBOUND", authorType: "AGENT" } }),
      db.message.count({ where: { organizationId: { in: orgIds }, createdAt: { gte: since }, direction: "OUTBOUND", status: "FAILED" } }),
      db.message.groupBy({
        by: ["organizationId"],
        where: { organizationId: { in: orgIds }, createdAt: { gte: since }, direction: "OUTBOUND", status: "FAILED" },
        _count: { _all: true },
        orderBy: { _count: { organizationId: "desc" } },
        take: 5,
      }),
    ]);
    // Tasa de respuesta aproximada: respuestas del bot / mensajes entrantes.
    const responseRate = inbound > 0 ? Math.min(1, botReplies / inbound) : 1;
    const offenders = await Promise.all(
      failedByOrg.map(async (o) => {
        const org = await db.organization.findUnique({ where: { id: o.organizationId }, select: { name: true } });
        return { organizationId: o.organizationId, name: org?.name ?? o.organizationId, failed: o._count._all };
      }),
    );
    return {
      windowHours: 24,
      aiRequests: reqAgg._count._all,
      avgResponseMs: Math.round(reqAgg._avg.latencyMs ?? 0),
      aiErrors: errCount,
      aiRefusals: refusalCount,
      failedOutbound: failedOut,
      inbound,
      botReplies,
      responseRatePct: Math.round(responseRate * 100),
      topFailingTenants: offenders,
    };
  }

  // ---------------------------- Organizaciones ----------------------------

  @Get("organizations")
  async organizations(@Req() req: PlatformRequest) {
    const db = this.prisma.admin;
    // D8 — el super admin solo lista los tenants de su marca.
    const brand = this.reqBrand(req);
    const [orgs, subs, plans] = await Promise.all([
      db.organization.findMany({ where: { brand }, orderBy: { createdAt: "desc" } }),
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
      // F10 — semáforo de implementación barato (solo settings, sin consultas por org):
      // ciclo de vida Conversia + si el setup está pagado. El detalle del checklist de 6
      // pasos va en GET /organizations/:id/implementation (una org a la vez).
      const conversia = (settings.conversia ?? {}) as Record<string, any>;
      const lifecycle = typeof conversia.lifecycle === "string" ? conversia.lifecycle : null; // implementing | active | null
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
        lifecycle: { stage: lifecycle, setupPaid: settings.setupPaid === true, deliveredAt: typeof conversia.deliveredAt === "string" ? conversia.deliveredAt : null },
      };
    });
  }

  @Get("organizations/:id")
  async organizationDetail(@Param("id") id: string, @Req() req: PlatformRequest) {
    const db = this.prisma.admin;
    await this.assertOrgBrand(req, id);
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
      adminName: adminMember?.user.name ?? null,
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

  // ----------------- F10 — implementación, contexto y GO-LIVE -----------------

  /**
   * Deriva el checklist de puesta en marcha de UNA org (mismo criterio que
   * /onboarding del tenant, pero del lado plataforma con el cliente admin). TODAS las
   * consultas filtran por organizationId (el cliente admin bypasea RLS) → nunca cruza tenant.
   */
  private async orgImplementation(id: string) {
    const db = this.prisma.admin;
    const [org, whatsappNumbers, templates, publishedAgents, publishedWorkflows, activeMembers] = await Promise.all([
      db.organization.findUnique({ where: { id }, select: { settings: true } }),
      db.whatsappPhoneNumber.count({ where: { organizationId: id, status: "active" } }),
      db.whatsappTemplate.count({ where: { organizationId: id } }),
      db.agentVersion.count({ where: { organizationId: id, status: "PUBLISHED" } }),
      db.workflowVersion.count({ where: { organizationId: id, status: "PUBLISHED" } }),
      db.organizationUser.count({ where: { organizationId: id, active: true } }),
    ]);
    const settings = (org?.settings ?? {}) as Record<string, any>;
    const industry = String(settings.general?.industry ?? "");
    const hasVertical = !!settings.vertical?.key;
    const conversia = (settings.conversia ?? {}) as Record<string, any>;
    const steps = [
      { key: "whatsapp", title: "WhatsApp conectado y sano", done: whatsappNumbers > 0 },
      { key: "templates", title: "Rubro definido + plantillas", done: !!industry && templates > 0 },
      { key: "vertical", title: "Paquete del rubro instalado", done: hasVertical },
      { key: "agent", title: "Agente publicado", done: publishedAgents > 0 },
      { key: "workflow", title: "Flujo publicado", done: publishedWorkflows > 0 },
      { key: "team", title: "Equipo invitado", done: activeMembers > 1 },
    ];
    const completed = steps.filter((s) => s.done).length;
    return {
      steps,
      completed,
      total: steps.length,
      percent: Math.round((completed / steps.length) * 100),
      goLiveReady: completed >= 5, // WhatsApp + agente + paquete + flujo + plantillas
      lifecycle: {
        stage: typeof conversia.lifecycle === "string" ? conversia.lifecycle : null,
        setupPaid: settings.setupPaid === true,
        setupVertical: typeof conversia.setupVertical === "string" ? conversia.setupVertical : null,
        setupPaidAt: typeof conversia.setupPaidAt === "string" ? conversia.setupPaidAt : null,
        deliveredAt: typeof conversia.deliveredAt === "string" ? conversia.deliveredAt : null,
      },
      whatsapp: { numbers: whatsappNumbers, templates },
    };
  }

  /** Semáforo de implementación detallado de un tenant (ficha de operación). */
  @Get("organizations/:id/implementation")
  async implementation(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    return this.orgImplementation(id);
  }

  /**
   * TAREA 4 — Contexto total del cliente para el agente/equipo de soporte. Resumen
   * estructurado + render en texto para inyectar al prompt. SOLO del tenant indicado
   * (cada consulta filtra por organizationId). De SOLO LECTURA.
   */
  private async buildClientContext(id: string) {
    const db = this.prisma.admin;
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [org, sub, plans, phones, agents, wallet, consumedAgg, errors, tickets] = await Promise.all([
      db.organization.findUnique({ where: { id }, select: { name: true, brand: true, country: true, status: true, settings: true } }),
      db.subscription.findFirst({ where: { organizationId: id }, orderBy: { createdAt: "desc" } }),
      db.plan.findMany({ select: { id: true, code: true, name: true } }),
      db.whatsappPhoneNumber.findMany({ where: { organizationId: id }, select: { displayPhone: true, status: true } }),
      db.agent.findMany({ where: { organizationId: id, deletedAt: null }, select: { name: true, slug: true, active: true, currentVersionId: true } }),
      db.messageWallet.findUnique({ where: { organizationId: id }, select: { balance: true, includedPerPeriod: true } }).catch(() => null),
      db.walletLedger.aggregate({ where: { organizationId: id, reason: "send_debit", createdAt: { gte: monthStart } }, _sum: { delta: true } }).catch(() => ({ _sum: { delta: 0 } }) as any),
      db.integrationEvent.findMany({ where: { organizationId: id, status: { in: ["warning", "error"] } }, orderBy: { createdAt: "desc" }, take: 5, select: { provider: true, type: true, status: true, message: true, createdAt: true } }),
      db.supportTicket.findMany({ where: { organizationId: id }, orderBy: { createdAt: "desc" }, take: 5, select: { code: true, subject: true, status: true, createdAt: true } }),
    ]);
    const settings = (org?.settings ?? {}) as Record<string, any>;
    const plan = sub ? plans.find((p) => p.id === sub.planId) ?? null : null;
    const vertical = (settings.vertical ?? {}) as Record<string, any>;
    const conversia = (settings.conversia ?? {}) as Record<string, any>;
    const included = Number(wallet?.includedPerPeriod ?? 0);
    const consumed = Math.abs(Number(consumedAgg?._sum?.delta ?? 0));
    const pctUsed = included > 0 ? Math.round((consumed / included) * 100) : null;
    const ctx = {
      organization: { name: org?.name ?? id, brand: org?.brand ?? "tubot", country: org?.country ?? null, status: org?.status ?? null },
      vertical: vertical.key ? { key: vertical.key, version: vertical.version ?? null, variant: vertical.variant ?? null } : null,
      lifecycle: { stage: conversia.lifecycle ?? null, setupPaid: settings.setupPaid === true, deliveredAt: conversia.deliveredAt ?? null },
      plan: plan ? { code: plan.code, name: plan.name } : null,
      subscription: sub ? { status: sub.status, periodEnd: sub.periodEnd } : null,
      channels: { whatsapp: phones.map((p) => ({ phone: p.displayPhone, status: p.status })) },
      credits: { balance: Number(wallet?.balance ?? 0), included, consumedThisMonth: consumed, pctUsed, over80: pctUsed != null && pctUsed >= 80 },
      agents: agents.map((a) => ({ name: a.name, slug: a.slug, active: a.active, published: !!a.currentVersionId })),
      recentErrors: errors.map((e) => ({ provider: e.provider, type: e.type, status: e.status, message: e.message, at: e.createdAt })),
      priorTickets: tickets.map((t) => ({ code: t.code, subject: t.subject, status: t.status, at: t.createdAt })),
    };
    return { ...ctx, text: renderClientContext(ctx), windowDays: 30, since };
  }

  /** TAREA 4 — contexto estructurado del cliente (ficha + soporte). */
  @Get("organizations/:id/client-context")
  async clientContext(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    return this.buildClientContext(id);
  }

  /**
   * TAREA 3 — marcar ENTREGADO (GO-LIVE). Flip del ciclo de vida Conversia a "active"
   * (D5: la activación del cobro ocurre SOLO aquí, no al pagar el setup). Idempotente.
   * Requiere setup pagado. La asignación del plan mensual es un paso explícito aparte
   * (endpoint /subscription) — aquí no tocamos billing para no acoplar.
   */
  @Post("organizations/:id/lifecycle/delivered")
  async markDelivered(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const db = this.prisma.admin;
    const org = await db.organization.findUnique({ where: { id }, select: { settings: true } });
    if (!org) throw new NotFoundException("Organización no encontrada");
    const settings = (org.settings ?? {}) as Record<string, any>;
    const conversia = (settings.conversia ?? {}) as Record<string, any>;
    if (settings.setupPaid !== true) {
      throw new BadRequestException("El setup debe estar pagado antes de marcar ENTREGADO.");
    }
    if (conversia.lifecycle === "active") {
      return { ok: true, alreadyDelivered: true, deliveredAt: conversia.deliveredAt ?? null };
    }
    const deliveredAt = new Date().toISOString();
    // F-1 — registrar la permanencia al entregar (base del enforcement manual de 6 meses,
    // CICLO_VIDA_CLIENTE §3). No sobreescribe un contrato ya existente.
    const contract = (settings.contract as Record<string, any>) ?? {};
    const nextContract = contract.startedAt ? contract : { commitmentMonths: 6, startedAt: deliveredAt };
    const nextSettings = { ...settings, contract: nextContract, conversia: { ...conversia, lifecycle: "active", deliveredAt, deliveredBy: req.platformAdmin?.sub ?? null } };
    await db.organization.update({ where: { id }, data: { settings: nextSettings } });
    await this.audit(req, "platform.org.delivered", "organization", id, { deliveredAt, commitmentMonths: nextContract.commitmentMonths });
    return { ok: true, deliveredAt };
  }

  /** Configuración completa por tenant: vigencia, override de límites (token limiter),
   *  kill switch de IA, datos básicos. Punto único para operar cada cliente. */
  @Post("organizations/:id/config")
  async setConfig(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
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
            maxTokens: z.coerce.number().int().min(50).max(8000),
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
    await this.assertOrgBrand(req, id);
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

  /** Detalle de UN agente del tenant (prompt/tools/estado de la versión vigente) para editar. */
  @Get("organizations/:id/agents/:agentId")
  async getAgent(@Param("id") id: string, @Param("agentId") agentId: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const db = this.prisma.admin;
    const agent = await db.agent.findFirst({ where: { id: agentId, organizationId: id, deletedAt: null } });
    if (!agent) throw new NotFoundException("Agente no encontrado");
    const version = agent.currentVersionId
      ? await db.agentVersion.findUnique({ where: { id: agent.currentVersionId } })
      : await db.agentVersion.findFirst({ where: { agentId }, orderBy: { version: "desc" } });
    return {
      id: agent.id,
      slug: agent.slug,
      name: agent.name,
      kind: agent.kind,
      active: agent.active,
      systemPrompt: version?.systemPrompt ?? "",
      tools: Array.isArray(version?.tools) ? version!.tools : [],
      config: (version?.config ?? {}) as Record<string, unknown>,
      status: version?.status ?? null,
      version: version?.version ?? null,
    };
  }

  /** Edita el system prompt (y opcionalmente las tools) del agente: publica la versión vigente. */
  @Post("organizations/:id/agents/:agentId/prompt")
  async setAgentPrompt(@Param("id") id: string, @Param("agentId") agentId: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const parsed = z.object({ systemPrompt: z.string().min(1).max(20000), tools: z.array(z.string().max(60)).max(40).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("systemPrompt requerido");
    const db = this.prisma.admin;
    const agent = await db.agent.findFirst({ where: { id: agentId, organizationId: id, deletedAt: null } });
    if (!agent) throw new NotFoundException("Agente no encontrado");
    let version = await db.agentVersion.findFirst({ where: { agentId }, orderBy: { version: "desc" } });
    const toolsPatch = parsed.data.tools ? { tools: parsed.data.tools } : {};
    if (version) {
      version = await db.agentVersion.update({
        where: { id: version.id },
        data: { systemPrompt: parsed.data.systemPrompt, status: "PUBLISHED", publishedAt: new Date(), ...toolsPatch },
      });
    } else {
      version = await db.agentVersion.create({
        data: { organizationId: id, agentId, version: 1, config: {}, tools: parsed.data.tools ?? [], systemPrompt: parsed.data.systemPrompt, status: "PUBLISHED", publishedAt: new Date() },
      });
    }
    await db.agent.update({ where: { id: agentId }, data: { currentVersionId: version.id } });
    await this.audit(req, "platform.agent.prompt", "agent", agentId, { organizationId: id });
    return { ok: true };
  }

  /** Activa/desactiva un agente del tenant. */
  @Post("organizations/:id/agents/:agentId/active")
  async setAgentActive(@Param("id") id: string, @Param("agentId") agentId: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const parsed = z.object({ active: z.boolean() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("active requerido");
    const db = this.prisma.admin;
    const agent = await db.agent.findFirst({ where: { id: agentId, organizationId: id, deletedAt: null } });
    if (!agent) throw new NotFoundException("Agente no encontrado");
    await db.agent.update({ where: { id: agentId }, data: { active: parsed.data.active } });
    await this.audit(req, "platform.agent.active", "agent", agentId, { organizationId: id, active: parsed.data.active });
    return { ok: true, active: parsed.data.active };
  }

  /** Catálogo COMPLETO de rubros para la consola (incluye beta): mayor versión por key. */
  @Get("verticals")
  async verticalsCatalog() {
    const rows = await this.prisma.admin.verticalTemplate.findMany({ where: { active: true }, orderBy: [{ wave: "asc" }, { key: "asc" }, { version: "desc" }] });
    const seen = new Set<string>();
    const out: { key: string; name: string; wave: number; status: string; variant: string; requiresFeature: string[] }[] = [];
    for (const r of rows) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      out.push({ key: r.key, name: r.name, wave: r.wave, status: r.status, variant: r.variant, requiresFeature: Array.isArray(r.requiresFeature) ? (r.requiresFeature as string[]) : [] });
    }
    return out;
  }

  // ===================== SA-2: ver conversaciones del tenant (solo lectura) =====================

  /** Lista de conversaciones del tenant (cross-tenant, solo lectura, para soporte/ajustes). */
  @Get("organizations/:id/conversations")
  async orgConversations(@Param("id") id: string, @Req() req: PlatformRequest, @Query("status") status?: string) {
    await this.assertOrgBrand(req, id);
    const db = this.prisma.admin;
    const where: Record<string, unknown> = { organizationId: id };
    if (status === "open") where.status = "OPEN";
    else if (status === "pending") where.status = "PENDING";
    else if (status === "closed") where.status = "CLOSED";
    const rows = await db.conversation.findMany({
      where,
      orderBy: { lastMessageAt: "desc" },
      take: 50,
      include: { contact: { select: { firstName: true, lastName: true, profileName: true, phone: true } } },
    });
    return rows.map((c) => ({
      id: c.id,
      status: c.status,
      aiEnabled: c.aiEnabled,
      unreadCount: c.unreadCount,
      lastMessagePreview: c.lastMessagePreview,
      lastMessageAt: c.lastMessageAt,
      contact: { name: [c.contact?.firstName, c.contact?.lastName].filter(Boolean).join(" ") || c.contact?.profileName || c.contact?.phone || "Sin nombre", phone: c.contact?.phone ?? null },
    }));
  }

  /** Hilo de una conversación del tenant (solo lectura). */
  @Get("organizations/:id/conversations/:cid/messages")
  async orgConversationMessages(@Param("id") id: string, @Param("cid") cid: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const db = this.prisma.admin;
    const conv = await db.conversation.findFirst({ where: { id: cid, organizationId: id }, include: { contact: { select: { firstName: true, lastName: true, profileName: true, phone: true } } } });
    if (!conv) throw new NotFoundException("Conversación no encontrada");
    const messages = await db.message.findMany({ where: { conversationId: cid }, orderBy: { createdAt: "asc" }, take: 300, select: { id: true, direction: true, type: true, visibility: true, body: true, authorType: true, status: true, createdAt: true } });
    return {
      conversation: { id: conv.id, status: conv.status, aiEnabled: conv.aiEnabled, contact: { name: [conv.contact?.firstName, conv.contact?.lastName].filter(Boolean).join(" ") || conv.contact?.profileName || conv.contact?.phone || "Sin nombre", phone: conv.contact?.phone ?? null } },
      messages,
    };
  }

  // ===================== SA-4: ficha de implementación / onboarding =====================

  /** Checklist y notas de montaje del tenant (en settings.onboarding). */
  @Get("organizations/:id/onboarding")
  async getOnboarding(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const org = await this.prisma.admin.organization.findUnique({ where: { id }, select: { settings: true } });
    const ob = (((org?.settings as Record<string, any>) ?? {}).onboarding ?? {}) as { steps?: Record<string, boolean>; notes?: string };
    return { steps: ob.steps ?? {}, notes: ob.notes ?? "" };
  }

  @Patch("organizations/:id/onboarding")
  async setOnboarding(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const parsed = z.object({ steps: z.record(z.boolean()).optional(), notes: z.string().max(5000).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    const org = await this.prisma.admin.organization.findUnique({ where: { id }, select: { settings: true } });
    const settings = { ...((org?.settings ?? {}) as Record<string, any>) };
    const prev = (settings.onboarding ?? {}) as { steps?: Record<string, boolean>; notes?: string };
    settings.onboarding = { steps: parsed.data.steps ?? prev.steps ?? {}, notes: parsed.data.notes ?? prev.notes ?? "" };
    await this.prisma.admin.organization.update({ where: { id }, data: { settings: settings as object } });
    await this.audit(req, "platform.org.onboarding", "organization", id);
    return { ok: true };
  }

  // ========== SA-5: canales (cableado por tenant; conexión real a Meta/TikTok al final) ==========

  /** Canales del tenant: conexiones reales (si existen) + intents configurados (pendientes). */
  @Get("organizations/:id/channels")
  async orgChannels(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const db = this.prisma.admin;
    const [org, connections] = await Promise.all([
      db.organization.findUnique({ where: { id }, select: { settings: true } }),
      db.channelConnection.findMany({ where: { organizationId: id }, select: { id: true, type: true, name: true, status: true } }),
    ]);
    const intents = (((org?.settings as Record<string, any>) ?? {}).channels ?? []) as { type: string; status: string }[];
    return { connections, intents };
  }

  /** Agrega un canal a configurar (intent) para el tenant. La conexión real se hace al final. */
  @Post("organizations/:id/channels")
  async addOrgChannel(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const parsed = z.object({ type: z.enum(["whatsapp", "instagram", "messenger", "tiktok"]) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Tipo de canal inválido");
    const org = await this.prisma.admin.organization.findUnique({ where: { id }, select: { settings: true } });
    const settings = { ...((org?.settings ?? {}) as Record<string, any>) };
    const intents = (settings.channels ?? []) as { type: string; status: string }[];
    if (!intents.some((c) => c.type === parsed.data.type)) intents.push({ type: parsed.data.type, status: "pending" });
    settings.channels = intents;
    await this.prisma.admin.organization.update({ where: { id }, data: { settings: settings as object } });
    await this.audit(req, "platform.org.channel_add", "organization", id, { type: parsed.data.type });
    return { ok: true, intents };
  }

  /** Quita un canal configurado (intent) del tenant. */
  @Delete("organizations/:id/channels/:type")
  async removeOrgChannel(@Param("id") id: string, @Param("type") type: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const org = await this.prisma.admin.organization.findUnique({ where: { id }, select: { settings: true } });
    const settings = { ...((org?.settings ?? {}) as Record<string, any>) };
    settings.channels = ((settings.channels ?? []) as { type: string; status: string }[]).filter((c) => c.type !== type);
    await this.prisma.admin.organization.update({ where: { id }, data: { settings: settings as object } });
    await this.audit(req, "platform.org.channel_remove", "organization", id, { type });
    return { ok: true };
  }

  /** Resumen de caja del tenant (F9) — SOLO LECTURA: el super admin ve, nunca crea/edita/revierte. */
  @Get("organizations/:id/cash-summary")
  async orgCashSummary(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const db = this.prisma.admin;
    const since = new Date(Date.now() - 30 * 24 * 3600_000);
    const [entries, closures] = await Promise.all([
      db.cashLedger.findMany({ where: { organizationId: id, createdAt: { gte: since } }, select: { method: true, amount: true, status: true } }),
      db.cashClosure.findMany({ where: { organizationId: id }, orderBy: { createdAt: "desc" }, take: 10, select: { fromAt: true, difference: true, declaredCash: true, calculatedCash: true, conciliado: true, declarado: true } }),
    ]);
    let net = 0, conciliado = 0, declarado = 0;
    const byMethod: Record<string, number> = {};
    for (const e of entries) {
      net += e.amount;
      byMethod[e.method] = (byMethod[e.method] ?? 0) + e.amount;
      if (e.status === "conciliado") conciliado += e.amount;
      else declarado += e.amount;
    }
    return { periodDays: 30, net, conciliado, declarado, byMethod, count: entries.length, closures };
  }

  // ------------------- Cuenta del administrador del tenant -------------------

  /** Restablece la contraseña del admin y devuelve la temporal (mostrada una vez). */
  @Post("organizations/:id/admin/reset-password")
  async resetAdminPassword(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const res = await this.auth.resetOrgAdminPassword(id);
    if (!res) throw new BadRequestException("La organización no tiene usuarios activos");
    await this.audit(req, "platform.admin.reset_password", "user", res.userId, { email: res.email });
    return { ok: true, email: res.email, tempPassword: res.tempPassword };
  }

  /** Restablece la contraseña y la ENVÍA por correo (Resend). Si no hay email
   *  configurado, cae a devolver la temporal para entrega manual. */
  @Post("organizations/:id/admin/send-reset")
  async sendAdminReset(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const res = await this.auth.resetOrgAdminPassword(id);
    if (!res) throw new BadRequestException("La organización no tiene usuarios activos");
    // F1/B1 — correo por marca: nombre, link y remitente de la marca del tenant (no TuBot fijo).
    const brand = brandOf({ brand: this.reqBrand(req) });
    const loginUrl = `${brand.webUrl}/login`;
    const html = `<p>Hola,</p>
<p>Se restableció el acceso a tu cuenta de ${brand.name}.</p>
<p><b>Usuario:</b> ${res.email}<br/><b>Contraseña temporal:</b> ${res.tempPassword}</p>
<p>Ingresa en <a href="${loginUrl}">${loginUrl.replace(/^https?:\/\//, "")}</a> y cámbiala.</p>`;
    const sent = await sendEmail({ to: res.email, subject: `Restablecimiento de acceso · ${brand.name}`, html, from: brand.mailFrom });
    await this.audit(req, "platform.admin.send_reset", "user", res.userId, { email: res.email, sent });
    return { ok: true, email: res.email, sent, tempPassword: sent ? null : res.tempPassword };
  }

  /** Cambia el correo del admin del tenant. */
  @Post("organizations/:id/admin/email")
  async updateAdminEmail(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const parsed = z.object({ email: z.string().email().max(200) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Correo inválido");
    const res = await this.auth.setOrgAdminEmail(id, parsed.data.email);
    await this.audit(req, "platform.admin.change_email", "user", res.userId, { email: res.email });
    return { ok: true, email: res.email };
  }

  /** Instala un paquete vertical (rubro) en una organización desde el Super Admin (F2). */
  @Post("organizations/:id/vertical")
  async installVertical(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const parsed = z.object({ key: z.string().trim().min(2).max(40), version: z.number().int().positive().optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("key requerido (version opcional)");
    const result = await this.vertical.install(id, parsed.data.key, { version: parsed.data.version, source: "platform" });
    await this.audit(req, "platform.org.vertical_install", "organization", id, result);
    return { ok: true, ...result };
  }

  @Post("organizations/:id/status")
  async setStatus(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const parsed = z.object({ status: z.enum(["ACTIVE", "TRIAL", "SUSPENDED", "CANCELLED"]) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("status inválido");
    // F-3 — al CANCELAR se marca la ventana de retención/purga (purgeAt = +90d): señal y fecha
    // para el offboarding (la purga la ejecuta el operador — ver CICLO_VIDA_CLIENTE §2). Al
    // REACTIVAR se limpia. No se auto-borran datos en un timer (operación destructiva).
    const current = await this.prisma.admin.organization.findUnique({ where: { id }, select: { settings: true } });
    const settings = (current?.settings ?? {}) as Record<string, any>;
    let nextSettings: Record<string, any> | undefined;
    if (parsed.data.status === "CANCELLED" && !(settings.offboarding as any)?.purgeAt) {
      const cancelledAt = new Date();
      const purgeAt = new Date(cancelledAt.getTime() + 90 * 24 * 3600_000);
      nextSettings = { ...settings, offboarding: { cancelledAt: cancelledAt.toISOString(), purgeAt: purgeAt.toISOString(), retentionDays: 90 } };
    } else if (parsed.data.status === "ACTIVE" && settings.offboarding) {
      const { offboarding: _drop, ...rest } = settings;
      nextSettings = rest;
    }
    const org = await this.prisma.admin.organization.update({
      where: { id },
      data: { status: parsed.data.status, ...(nextSettings ? { settings: nextSettings } : {}) },
    });
    await this.audit(req, `platform.org.${parsed.data.status.toLowerCase()}`, "organization", id, { status: parsed.data.status, purgeAt: (nextSettings?.offboarding as any)?.purgeAt });
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
    await this.assertOrgBrand(req, id);
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
  async auditList(@Req() req: PlatformRequest, @Query("limit") limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 100, 1), 200);
    // D8 — cada super admin solo ve la auditoría de los admins de SU marca.
    const admins = await this.prisma.admin.platformAdmin.findMany({ where: { brand: this.reqBrand(req) }, select: { id: true, email: true } });
    const actorIds = admins.map((a) => a.id);
    const rows = await this.prisma.admin.auditLog.findMany({
      where: { actorType: "platform_admin", actorId: { in: actorIds } },
      orderBy: { createdAt: "desc" },
      take,
    });
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
  async alerts(@Req() req: PlatformRequest, @Query("limit") limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 100, 1), 200);
    // D8 — alertas acotadas a las orgs de la marca del super admin.
    const brandIds = await this.brandOrgIds(req);
    const rows = await this.prisma.admin.integrationEvent.findMany({
      where: { organizationId: { in: brandIds }, status: { in: ["warning", "error"] } },
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
  async support(@Req() req: PlatformRequest, @Query("status") status?: string) {
    // D8 — tickets acotados a las orgs de la marca del super admin.
    const brandIds = await this.brandOrgIds(req);
    const brandWhere = { organizationId: { in: brandIds } };
    const where =
      status === "resolved"
        ? { ...brandWhere, status: "resolved" }
        : status === "all"
          ? brandWhere
          : { ...brandWhere, status: "open" };
    const [tickets, openCount] = await Promise.all([
      this.prisma.admin.supportTicket.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 }),
      this.prisma.admin.supportTicket.count({ where: { ...brandWhere, status: "open" } }),
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

  /** Detalle de un ticket de soporte (con hilo), para responderlo desde la consola (F7). */
  @Get("support/:id")
  async supportDetail(@Param("id") id: string, @Req() req: PlatformRequest) {
    const t = await this.prisma.admin.supportTicket.findUnique({ where: { id }, select: { id: true, organizationId: true, code: true, subject: true, message: true, status: true, email: true, thread: true, createdAt: true } });
    if (!t) throw new NotFoundException("Ticket no encontrado");
    await this.assertOrgBrand(req, t.organizationId); // aislamiento por marca
    const org = await this.prisma.admin.organization.findUnique({ where: { id: t.organizationId }, select: { name: true } });
    // F10 TAREA 4 — el contexto completo del cliente viaja CON el ticket: quien atiende
    // (operador o agente de soporte) lo tiene a la mano desde el primer mensaje.
    const clientContext = await this.buildClientContext(t.organizationId).catch(() => null);
    return { ...t, organizationName: org?.name ?? t.organizationId, clientContext };
  }

  /** El equipo responde el ticket: agrega su mensaje al hilo (lo ve el cliente en el widget). */
  @Post("support/:id/reply")
  async supportReply(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z.object({ body: z.string().trim().min(1).max(4000) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Mensaje requerido");
    const t = await this.prisma.admin.supportTicket.findUnique({ where: { id }, select: { organizationId: true, thread: true } });
    if (!t) throw new NotFoundException("Ticket no encontrado");
    await this.assertOrgBrand(req, t.organizationId);
    const thread = [...((t.thread as unknown as { author: string; body: string; at: string }[]) ?? []), { author: "team", body: parsed.data.body, at: new Date().toISOString() }];
    await this.prisma.admin.supportTicket.update({ where: { id }, data: { thread: thread as object, status: "open" } });
    await this.audit(req, "platform.support.reply", "support_ticket", id);
    return { ok: true };
  }

  // --------------------------- Demos / CRM ---------------------------

  /** CRM de prospectos/demos, con días en la plataforma y estado de IA si ya se provisionó. */
  @Get("demo-leads")
  async demoLeads(@Req() req: PlatformRequest) {
    // D8 — el CRM de prospectos público es de TuBot (byte-for-byte: ve todo como hoy,
    // incluidos leads sin org provisionada). Un super admin de Conversia solo ve los
    // prospectos ya vinculados a una org de su marca.
    const brand = this.reqBrand(req);
    const where = brand === "tubot" ? {} : { organizationId: { in: await this.brandOrgIds(req) } };
    const leads = await this.prisma.admin.demoLead.findMany({ where, orderBy: { createdAt: "desc" }, take: 300 });
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
  async recurringOverview(@Req() req: PlatformRequest) {
    const admin = this.prisma.admin;
    const now = new Date();
    const in7 = new Date(now.getTime() + 7 * 86_400_000);
    const from30 = new Date(now.getTime() - 30 * 86_400_000);
    // D8 — el panel de cobro recurrente se acota a las orgs de la marca.
    const brandIds = await this.brandOrgIds(req);
    const [activeSubs, pastDue, suspended, canceling, failed30, upcoming, plans] = await Promise.all([
      admin.subscription.findMany({ where: { organizationId: { in: brandIds }, status: "ACTIVE" }, select: { organizationId: true, planId: true, interval: true } }),
      admin.subscription.count({ where: { organizationId: { in: brandIds }, status: "PAST_DUE" } }),
      admin.subscription.count({ where: { organizationId: { in: brandIds }, status: "SUSPENDED" } }),
      admin.subscription.count({ where: { organizationId: { in: brandIds }, status: "ACTIVE", cancelAtPeriodEnd: true } }),
      admin.paymentAttempt.count({ where: { organizationId: { in: brandIds }, status: "failed", createdAt: { gte: from30 } } }),
      admin.subscription.findMany({ where: { organizationId: { in: brandIds }, status: "ACTIVE", nextChargeAt: { gte: now, lte: in7 } }, select: { organizationId: true, nextChargeAt: true, interval: true }, orderBy: { nextChargeAt: "asc" }, take: 30 }),
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
  async orgMessaging(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
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
    await this.assertOrgBrand(req, id);
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
  async orgWallet(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
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
    await this.assertOrgBrand(req, id);
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
  async messagingPanel(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
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
  async canSend(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const s = await this.messagingSnapshot(id);
    const gate = evalMessagingGate(s.inputs);
    return { canSend: gate.canSend, blockedBy: gate.blockedBy, reason: gate.reason, line: gate.canSend ? "Sí puede enviar" : `Bloqueado por: ${gate.reason}` };
  }

  /** Últimos envíos de plantilla rechazados por el gate (con condición y conversación). */
  @Get("organizations/:id/rejected-sends")
  async rejectedSends(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
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
  async margins(@Req() req: PlatformRequest) {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const { usdToClp } = await this.readCostSettings();
    const [orgs, invoices, usage] = await Promise.all([
      this.prisma.admin.organization.findMany({ where: { brand: this.reqBrand(req), deletedAt: null }, select: { id: true, name: true, currency: true } }),
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
    await this.assertOrgBrand(req, id);
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
    await this.assertOrgBrand(req, id);
    const parsed = z.object({ action: z.enum(["reactivate", "extend_window", "register_payment", "charge_now"]), hours: z.coerce.number().int().min(1).max(240).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Acción inválida");
    const sub = await this.prisma.admin.subscription.findFirst({ where: { organizationId: id }, orderBy: { createdAt: "desc" } });
    if (!sub) throw new BadRequestException("El tenant no tiene suscripción");
    const admin = this.prisma.admin;

    if (parsed.data.action === "charge_now") {
      // COBRAR AHORA: dispara el cobro del plan contra la tarjeta ya registrada del cliente
      // (p. ej. quedó en prueba tras registrar la TC y nunca se le cobró el plan). El collect
      // de Flow es asíncrono: el worker (reconciliación) confirma y activa la suscripción.
      if (!sub.providerCustomerRef) throw new BadRequestException("El cliente no tiene una tarjeta registrada para cobrar.");
      const s = await this.paymentSettings.get();
      if (!s.flow?.apiKey || !s.flow?.secretKey || !s.flow?.baseUrl) throw new BadRequestException("Flow no está configurado para suscripciones.");
      const [plan, org] = await Promise.all([
        admin.plan.findUnique({ where: { id: sub.planId } }),
        admin.organization.findUnique({ where: { id } }),
      ]);
      if (!plan) throw new BadRequestException("El cliente no tiene un plan de pago asignado.");
      const currency = org?.currency ?? "CLP";
      const yearly = sub.interval === "yearly";
      const base = currency === "CLP"
        ? Number((yearly && plan.priceClpYearly != null ? plan.priceClpYearly : plan.priceClp) ?? 0)
        : Number((yearly && plan.priceUsdYearly != null ? plan.priceUsdYearly : plan.priceUsd) ?? 0);
      const billablesArr = (org?.settings as Record<string, unknown> | null)?.billables;
      const billables = Array.isArray(billablesArr)
        ? billablesArr.filter((x: any) => x && typeof x.concept === "string" && Number(x.amount) > 0).reduce((a: number, x: any) => a + Math.round(Number(x.amount)), 0)
        : 0;
      const amount = Math.round(base) + billables;
      if (amount <= 0) throw new BadRequestException("El plan del cliente no tiene un monto a cobrar (¿es Free?).");
      const commerceOrder = `sub-${sub.id}-${Date.now()}`;
      await admin.paymentAttempt.create({ data: { organizationId: id, subscriptionId: sub.id, commerceOrder, amount, currency, kind: "manual", attemptNumber: (sub.retriesDone ?? 0) + 1, status: "pending", provider: "flow" } });
      const r = await flowCollect(s.flow, {
        customerId: sub.providerCustomerRef,
        commerceOrder,
        subject: `Plan ${plan.name} (${yearly ? "anual" : "mensual"})`,
        amount,
        currency,
        urlConfirmation: `${getEnv().API_URL}/billing/webhooks/flow`,
        urlReturn: `${getEnv().WEB_URL}/billing`,
      });
      await admin.paymentAttempt.updateMany({ where: { commerceOrder }, data: { providerRef: r.token ?? undefined, status: r.ok ? "pending" : "failed", reason: r.reason ?? undefined } });
      if (!r.ok) throw new BadRequestException(`Flow rechazó el cobro: ${r.reason ?? "error del proveedor"}`);
      await this.audit(req, "platform.billing.charge_now", "subscription", sub.id, { amount, currency });
      return { ok: true, amount, currency };
    }

    // Limpia la marca de deuda (settings.billing) al reactivar/registrar pago: la
    // escriben la gracia/suspensión y sin limpiarla el panel seguía "en deuda".
    const clearBillingFlag = async () => {
      const orgRow = await admin.organization.findUnique({ where: { id }, select: { settings: true } });
      const s = { ...((orgRow?.settings as Record<string, unknown>) ?? {}) };
      delete s.billing;
      return s as object;
    };

    if (parsed.data.action === "reactivate") {
      // Reactivación manual (override del Super Admin): vuelve a ACTIVE sin cobrar.
      await admin.subscription.update({ where: { id: sub.id }, data: { status: "ACTIVE", pastDueSince: null, retriesDone: 0 } });
      await admin.organization.update({ where: { id }, data: { status: "ACTIVE", settings: await clearBillingFlag() } });
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
      await admin.organization.update({ where: { id }, data: { status: "ACTIVE", settings: await clearBillingFlag() } });
      await admin.paymentAttempt.create({ data: { organizationId: id, subscriptionId: sub.id, commerceOrder: `ext-${sub.id}-${Date.now()}`, amount: 0, currency: "CLP", kind: "manual", status: "succeeded", provider: "external", reason: "Pago externo registrado por el Super Admin" } });
    }
    await this.audit(req, `platform.billing.${parsed.data.action}`, "subscription", sub.id, { hours: parsed.data.hours ?? null });
    return { ok: true };
  }

  /**
   * DIAGNÓSTICO de cobro: consulta a Flow la tarjeta registrada del cliente y el estado REAL
   * de sus últimos intentos (para entender por qué no se concreta un cobro — p. ej. tarjeta de
   * débito que no admite cargo automático, o el motivo de rechazo). Solo lectura.
   */
  @Get("organizations/:id/billing-diagnose")
  async billingDiagnose(@Param("id") id: string, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const sub = await this.prisma.admin.subscription.findFirst({ where: { organizationId: id }, orderBy: { createdAt: "desc" } });
    if (!sub) return { ok: false, error: "El tenant no tiene suscripción." };
    const s = await this.paymentSettings.get();
    if (!s.flow?.apiKey || !s.flow?.secretKey || !s.flow?.baseUrl) return { ok: false, error: "Flow no está configurado para suscripciones." };
    const cfg = s.flow;

    let card: { registered: boolean; brand: string | null; last4: string | null } | { error: string } | null = null;
    if (sub.providerCustomerRef) {
      try {
        const c = await flowCustomerGet(cfg, sub.providerCustomerRef);
        card = { registered: c.registered, brand: c.creditCardType, last4: c.last4 };
      } catch (e) {
        card = { error: (e as Error).message };
      }
    }

    const rows = await this.prisma.admin.paymentAttempt.findMany({ where: { organizationId: id }, orderBy: { createdAt: "desc" }, take: 8 });
    const attempts: Array<Record<string, unknown>> = [];
    for (const a of rows) {
      let flow: { status: number | null; label: string; message: string | null } | null = null;
      if (a.providerRef) {
        try {
          const f = await flowPaymentStatus(cfg, a.providerRef);
          flow = { status: f.status, label: f.label, message: f.message };
        } catch (e) {
          flow = { status: null, label: "error", message: (e as Error).message };
        }
      }
      attempts.push({ createdAt: a.createdAt, amount: a.amount, currency: a.currency, kind: a.kind, ourStatus: a.status, reason: a.reason, flow });
    }

    return {
      ok: true,
      subscription: { status: sub.status, interval: sub.interval, hasCard: !!sub.providerCustomerRef },
      card,
      attempts,
      hint: "Si el ESTADO EN FLOW de los cobros es 'pendiente' y la tarjeta es de débito, Flow no admite cargo automático (customer/collect) en débito: el cliente debe registrar una tarjeta de CRÉDITO.",
    };
  }

  /**
   * LINK DE PAGO para un tenant (débito o cualquier medio): genera un checkout de Flow
   * (payment/create) por el monto del plan, con la metadata org+plan. Al pagarlo, el webhook
   * /billing/webhooks/flow ACTIVA la suscripción automáticamente. Sirve para clientes con
   * tarjeta de DÉBITO (que no admite cargo automático) — se les envía el link y pagan.
   */
  @Post("organizations/:id/payment-link")
  async paymentLink(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
    const parsed = z.object({ planCode: z.string().optional(), interval: z.enum(["monthly", "yearly"]).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    const org = await this.prisma.admin.organization.findUnique({ where: { id } });
    if (!org) throw new BadRequestException("Organización no encontrada");
    const sub = await this.prisma.admin.subscription.findFirst({ where: { organizationId: id }, orderBy: { createdAt: "desc" } });
    const plan = parsed.data.planCode
      ? await this.prisma.admin.plan.findUnique({ where: { code: parsed.data.planCode } })
      : sub?.planId
        ? await this.prisma.admin.plan.findUnique({ where: { id: sub.planId } })
        : null;
    if (!plan || !plan.active) throw new BadRequestException("El cliente no tiene un plan de pago asignado (o especifica el plan).");
    const currency = org.currency ?? "CLP";
    const wantYearly = parsed.data.interval === "yearly" || (!parsed.data.interval && sub?.interval === "yearly");
    const yearlyPrice = currency === "CLP" ? Number(plan.priceClpYearly ?? 0) : Number(plan.priceUsdYearly ?? 0);
    const useYearly = wantYearly && yearlyPrice > 0;
    const interval = useYearly ? "yearly" : "monthly";
    const base = useYearly ? yearlyPrice : currency === "CLP" ? Number(plan.priceClp) : Number(plan.priceUsd);
    const billablesArr = (org.settings as Record<string, unknown> | null)?.billables;
    const billables = Array.isArray(billablesArr)
      ? billablesArr.filter((x: any) => x && typeof x.concept === "string" && Number(x.amount) > 0).reduce((a: number, x: any) => a + Math.round(Number(x.amount)), 0)
      : 0;
    const amount = Math.round(base) + billables;
    if (amount <= 0) throw new BadRequestException("El plan no tiene un monto a cobrar (¿es Free?).");
    const settings = await this.paymentSettings.get();
    const preferred = (org.settings as Record<string, unknown> | null)?.paymentProvider as string | undefined;
    const provider = createPaymentProvider(settings, currency, preferred);
    // Email del dueño (Flow lo pide) — best-effort.
    const owner = await this.prisma.admin.organizationUser.findFirst({ where: { organizationId: id }, orderBy: { createdAt: "asc" }, select: { userId: true } });
    const user = owner ? await this.prisma.admin.user.findUnique({ where: { id: owner.userId }, select: { email: true } }) : null;
    const session = await provider.createCheckout({
      organizationId: id,
      planCode: plan.code,
      amount,
      currency,
      email: user?.email ?? `pagos+${id.slice(-8)}@tubot.cl`,
      interval,
      successUrl: `${getEnv().WEB_URL}/billing`,
      cancelUrl: `${getEnv().WEB_URL}/billing`,
    });
    await this.audit(req, "platform.billing.payment_link", "subscription", sub?.id ?? id, { planCode: plan.code, amount, interval, provider: session.provider });
    return { ok: true, url: session.url, amount, currency, planName: plan.name, interval };
  }

  // ------------------------------ Facturas ------------------------------

  @Get("invoices")
  async invoices(@Req() req: PlatformRequest) {
    // D8 — facturas acotadas a las orgs de la marca del super admin.
    const brandIds = await this.brandOrgIds(req);
    const rows = await this.prisma.admin.invoice.findMany({ where: { organizationId: { in: brandIds } }, orderBy: { createdAt: "desc" }, take: 100 });
    const orgIds = [...new Set(rows.map((r) => r.organizationId))];
    const orgs = await this.prisma.admin.organization.findMany({ where: { id: { in: orgIds } }, select: { id: true, name: true } });
    const nameById = new Map(orgs.map((o) => [o.id, o.name]));
    return rows.map((r) => ({ ...r, organizationName: nameById.get(r.organizationId) ?? "?" }));
  }

  /** Emite una factura para una organización (cobro manual/mock del período). */
  @Post("organizations/:id/invoices")
  async createInvoice(@Param("id") id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    await this.assertOrgBrand(req, id);
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

  // -------------- F10 — Administradores de plataforma (OPERADORES) --------------
  // Solo el super admin (owner/admin) llega aquí: /platform/admins está en la denylist
  // del operador. Permite dar de alta/baja al EQUIPO de implementación sin tocar SQL.

  @Get("admins")
  async listAdmins(@Req() req: PlatformRequest) {
    const admins = await this.prisma.admin.platformAdmin.findMany({
      where: { brand: this.reqBrand(req) },
      select: { id: true, email: true, name: true, role: true, mfaEnabledAt: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    return admins.map((a) => ({ ...a, mfaEnabled: !!a.mfaEnabledAt, isSuperAdmin: isFullPlatformAdmin(a.role) }));
  }

  /** Crea un OPERADOR (rol acotado) en la marca del super admin. Devuelve una contraseña
   *  temporal UNA sola vez; el operador deberá enrolar MFA en su primer ingreso. */
  @Post("admins")
  async createAdmin(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = z.object({ email: z.string().email(), name: z.string().trim().min(2).max(80) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Correo y nombre válidos requeridos.");
    const brand = this.reqBrand(req);
    const email = parsed.data.email.toLowerCase();
    const exists = await this.prisma.admin.platformAdmin.findUnique({ where: { email_brand: { email, brand } } });
    if (exists) throw new BadRequestException("Ya existe un administrador con ese correo en esta marca.");
    const tempPassword = randomBytes(9).toString("base64url"); // ~12 chars, se muestra una vez
    const admin = await this.prisma.admin.platformAdmin.create({
      data: { email, name: parsed.data.name, brand, role: "operador", passwordHash: bcrypt.hashSync(tempPassword, 10) },
      select: { id: true, email: true, name: true, role: true },
    });
    await this.audit(req, "platform.admin.create", "platform_admin", admin.id, { role: "operador", email });
    return { ok: true, id: admin.id, email: admin.email, role: admin.role, tempPassword };
  }

  /** Elimina un OPERADOR (nunca a un super admin ni a uno mismo). */
  @Delete("admins/:id")
  async deleteAdmin(@Param("id") id: string, @Req() req: PlatformRequest) {
    const target = await this.prisma.admin.platformAdmin.findUnique({ where: { id }, select: { id: true, brand: true, role: true } });
    if (!target || target.brand !== this.reqBrand(req)) throw new NotFoundException("Administrador no encontrado");
    if (target.id === req.platformAdmin?.sub) throw new BadRequestException("No puedes eliminar tu propia cuenta.");
    if (isFullPlatformAdmin(target.role)) throw new BadRequestException("No puedes eliminar a un super admin desde aquí.");
    await this.prisma.admin.platformAdmin.delete({ where: { id } });
    await this.audit(req, "platform.admin.delete", "platform_admin", id, { role: target.role });
    return { ok: true };
  }
}

/** F10 — render en texto del contexto del cliente para inyectar al prompt del soporte. */
function renderClientContext(c: {
  organization: { name: string; country: string | null; status: string | null };
  vertical: { key: string; version: unknown; variant: unknown } | null;
  lifecycle: { stage: unknown; setupPaid: boolean; deliveredAt: unknown };
  plan: { code: string; name: string } | null;
  subscription: { status: string; periodEnd: unknown } | null;
  channels: { whatsapp: { phone: string; status: string }[] };
  credits: { balance: number; included: number; consumedThisMonth: number; pctUsed: number | null; over80: boolean };
  agents: { name: string; active: boolean; published: boolean }[];
  recentErrors: { provider: string; type: string; message: string | null; at: unknown }[];
  priorTickets: { code: string | null; subject: string | null; status: string }[];
}): string {
  const L: string[] = [];
  L.push(`CONTEXTO DEL CLIENTE (solo lectura — no inventes datos fuera de esto):`);
  L.push(`• Negocio: ${c.organization.name}${c.organization.country ? ` (${c.organization.country})` : ""} — estado ${c.organization.status ?? "?"}.`);
  if (c.vertical) L.push(`• Rubro/paquete: ${c.vertical.key}${c.vertical.version ? ` v${c.vertical.version}` : ""}.`);
  L.push(`• Ciclo: ${c.lifecycle.stage ?? "sin marca"}${c.lifecycle.setupPaid ? ", setup pagado" : ", setup NO pagado"}${c.lifecycle.deliveredAt ? ", entregado" : ""}.`);
  if (c.plan) L.push(`• Plan: ${c.plan.name} (${c.plan.code})${c.subscription ? ` — suscripción ${c.subscription.status}` : ""}.`);
  const wa = c.channels.whatsapp;
  L.push(`• WhatsApp: ${wa.length ? wa.map((p) => `${p.phone} [${p.status}]`).join(", ") : "sin número conectado"}.`);
  L.push(`• Créditos: saldo ${c.credits.balance}${c.credits.included ? ` / ${c.credits.included} incluidos` : ""}${c.credits.pctUsed != null ? ` (${c.credits.pctUsed}% usado${c.credits.over80 ? " ⚠️ sobre 80%" : ""})` : ""}.`);
  if (c.agents.length) L.push(`• Agentes: ${c.agents.map((a) => `${a.name}${a.published ? "" : " (sin publicar)"}${a.active ? "" : " (inactivo)"}`).join(", ")}.`);
  if (c.recentErrors.length) L.push(`• Errores recientes: ${c.recentErrors.map((e) => `${e.provider}/${e.type}`).join(", ")}.`);
  if (c.priorTickets.length) L.push(`• Tickets previos: ${c.priorTickets.map((t) => `${t.code ?? "?"} [${t.status}]`).join(", ")}.`);
  return "\n\n" + L.join("\n");
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
