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
import { MODEL_PRICING, createAIRouter } from "@conversia/agents";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { AuthService } from "../auth/auth.service";
import { sendEmail } from "../common/email";
import { signAppToken } from "../auth/jwt";
import { PlatformGuard, type PlatformRequest } from "./platform.guard";

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
    const settings = (org.settings ?? {}) as Record<string, any>;
    const override = settings.limits && typeof settings.limits === "object" ? (settings.limits as Record<string, number>) : {};
    const planLimits = (plan?.limits as Record<string, number>) ?? {};
    // Correo del admin (owner) del tenant, para la sección de cuenta.
    const orgRoles = await db.role.findMany({ where: { organizationId: id }, select: { id: true, code: true } });
    const ownerRoleIds = new Set(orgRoles.filter((r) => r.code === "owner").map((r) => r.id));
    const adminMember = members.find((m) => ownerRoleIds.has(m.roleId) && m.active) ?? members.find((m) => m.active) ?? members[0];
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
      availablePlans: plans.map((p) => ({ code: p.code, name: p.name })),
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
        limits: z.record(z.coerce.number().int().min(0)).optional(), // override por-tenant; 0 = ilimitado
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
    const data: any = { settings };
    if (parsed.data.name) data.name = parsed.data.name;
    if (parsed.data.country) data.country = parsed.data.country;
    await this.prisma.admin.organization.update({ where: { id }, data });
    await this.audit(req, "platform.org.config", "organization", id, {
      validUntil: settings.validUntil ?? null,
      aiKillSwitch: settings.aiKillSwitch ?? false,
      limits: settings.limits ?? {},
    });
    return { ok: true };
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

  /** Precios por token (USD/millón) por modelo — insumo del estimador de costos de planes. */
  @Get("cost-model")
  costModel() {
    return { models: MODEL_PRICING };
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
