import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";
import { signAppToken } from "../auth/jwt";
import { validateUploadedImage } from "../common/images";
import { BASE_VOCAB, INDUSTRIES, resolvePersonalization } from "../common/industries";

const generalSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  timezone: z.string().min(3).max(60).optional(),
  logoUrl: z.string().url().max(500).optional().or(z.literal("")),
  industry: z.string().max(60).optional(),
  currency: z.string().length(3).optional(), // ISO 4217: CLP, USD…
  language: z.enum(["es", "en", "pt"]).optional(),
  contactEmail: z.string().email().max(120).optional().or(z.literal("")),
  contactPhone: z.string().max(30).optional(),
  website: z.string().url().max(200).optional().or(z.literal("")),
});

/**
 * Centro de Configuración del tenant (/settings) — Información general.
 * UNA fuente de verdad: organization.name/timezone + organization.settings.general.
 * Consumidores: zona horaria → agenda, resumen diario de correo y default del
 * nodo «Fecha y hora»; moneda → default de servicios nuevos (no pisa el
 * currency por servicio); idioma → asistente del compositor.
 */
/** Tipos de plantilla de prompt del tenant. */
export const PROMPT_TEMPLATE_TYPES = ["instructions", "indications", "tone", "policy", "script"] as const;

/** ¿La plantilla aplica a este agente? ([] = todos los agentes). Puro; testeado. */
export function templateVisibleForAgent(tpl: { agentIds: unknown }, agentId: string): boolean {
  const ids = Array.isArray(tpl.agentIds) ? (tpl.agentIds as string[]) : [];
  return ids.length === 0 || ids.includes(agentId);
}

@Controller("settings")
export class SettingsController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
  ) {}

  /**
   * Emite un token de LARGA DURACIÓN (1 año) para conectar el MCP de TuBot con Claude
   * (por-tenant: lleva el orgId + permisos del usuario). Se muestra una sola vez. Así el
   * usuario no regenera autorizaciones a cada rato. Requiere permiso de escritura de agentes.
   */
  @Post("mcp-token")
  async mcpToken() {
    const ctx = requirePermission("agents:write");
    const token = signAppToken(
      { sub: ctx.userId, orgId: ctx.organizationId, role: ctx.roleCode, perms: ctx.permissions },
      { expiresIn: "365d", extra: { mcp: true } },
    );
    return { token, apiUrl: getEnv().API_URL, expiresInDays: 365 };
  }

  @Get("general")
  general() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
      const settings = (org?.settings ?? {}) as Record<string, any>;
      const general = (settings.general ?? {}) as Record<string, any>;
      return {
        name: org?.name ?? "",
        slug: org?.slug ?? "",
        timezone: org?.timezone ?? "America/Santiago",
        logoUrl: general.logoUrl ?? "",
        industry: general.industry ?? "",
        // Moneda e idioma viven en columnas reales de la organización (fuente única)
        currency: org?.currency ?? "CLP",
        language: org?.locale ?? "es",
        contactEmail: general.contactEmail ?? "",
        contactPhone: general.contactPhone ?? "",
        website: general.website ?? "",
      };
    });
  }

  @Put("general")
  updateGeneral(@Body() body: unknown) {
    const ctx = requirePermission("settings:write"); // owner/admin (permiso "*")
    const parsed = generalSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? "Datos inválidos");
    const input = parsed.data;
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
      if (!org) throw new BadRequestException("Organización no encontrada");
      const settings = (org.settings ?? {}) as Record<string, any>;
      const general = { ...((settings.general ?? {}) as object) } as Record<string, any>;
      for (const key of ["logoUrl", "industry", "contactEmail", "contactPhone", "website"] as const) {
        if (input[key] !== undefined) general[key] = input[key];
      }
      await tx.organization.update({
        where: { id: ctx.organizationId },
        data: {
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
          ...(input.currency ? { currency: input.currency } : {}),
          ...(input.language ? { locale: input.language } : {}),
          settings: { ...settings, general } as object,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "settings.general_update",
          entityType: "organization",
          entityId: ctx.organizationId,
          after: input as object,
        },
      });
      return { ok: true };
    });
  }

  // ------------------------- Conversaciones (reglas de la bandeja) -------------------------

  /** Reglas: auto-cierre por inactividad, retoma del bot y objetivo de 1.ª respuesta. */
  @Get("inbox")
  inboxRules() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
      const inbox = (((org?.settings ?? {}) as Record<string, any>).inbox ?? {}) as Record<string, any>;
      return {
        autoCloseDays: Number(inbox.autoCloseDays ?? 0), // 0 = apagado
        autoCloseNote: String(inbox.autoCloseNote ?? ""),
        botResumeMinutes: Number(inbox.botResumeMinutes ?? 0), // 0 = el bot no retoma solo
        firstResponseTargetMinutes: Number(inbox.firstResponseTargetMinutes ?? 15),
      };
    });
  }

  @Put("inbox")
  updateInboxRules(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const parsed = z
      .object({
        autoCloseDays: z.number().int().min(0).max(90).optional(),
        autoCloseNote: z.string().max(500).optional(),
        botResumeMinutes: z.number().int().min(0).max(24 * 60).optional(),
        firstResponseTargetMinutes: z.number().int().min(1).max(24 * 60).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Reglas inválidas");
    return this.mergeSettings(ctx.organizationId, ctx.userId, "inbox", parsed.data, "settings.inbox_update");
  }

  // ------------------------- Horario de atención -------------------------

  /** Horario org (mismo formato que el nodo «Fecha y hora»: hours + holidays). */
  @Get("hours")
  hours() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
      const bh = (((org?.settings ?? {}) as Record<string, any>).businessHours ?? {}) as Record<string, any>;
      return { timezone: org?.timezone ?? "America/Santiago", hours: bh.hours ?? {}, holidays: bh.holidays ?? [] };
    });
  }

  @Put("hours")
  updateHours(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const interval = z.object({ from: z.string().regex(/^d{2}:d{2}$/), to: z.string().regex(/^d{2}:d{2}$/) });
    const parsed = z
      .object({
        hours: z.record(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), z.array(interval).max(4)),
        holidays: z.array(z.string().regex(/^d{4}-d{2}-d{2}$/)).max(60),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Horario inválido");
    return this.mergeSettings(ctx.organizationId, ctx.userId, "businessHours", parsed.data, "settings.hours_update");
  }

  // ------------------------- Datos: retención y borrado -------------------------

  /** Política de retención del tenant (0 = indefinido = default conservador). */
  @Get("data")
  dataPolicy() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
      const r = (((org?.settings ?? {}) as Record<string, any>).retention ?? {}) as Record<string, any>;
      return {
        conversationsMonths: Number(r.conversationsMonths ?? 0), // 0 = indefinido
        transcriptionsMonths: Number(r.transcriptionsMonths ?? 0),
        lastPurgeAt: r.lastPurgeAt ?? null,
      };
    });
  }

  @Put("data")
  updateDataPolicy(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    // 0 = indefinido; opciones razonables 6/12/24 meses.
    const opt = z.union([z.literal(0), z.literal(6), z.literal(12), z.literal(24)]);
    const parsed = z.object({ conversationsMonths: opt.optional(), transcriptionsMonths: opt.optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Política de retención inválida (usa 0, 6, 12 o 24 meses).");
    return this.mergeSettings(ctx.organizationId, ctx.userId, "retention", parsed.data, "settings.retention_update");
  }

  // ------------------------- Rubro y personalización -------------------------

  /** Catálogo de rubros + personalización efectiva (vocabulario + módulos). */
  @Get("personalization")
  personalization() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
      const settings = (org?.settings ?? {}) as Record<string, any>;
      const resolved = resolvePersonalization(settings);
      return {
        ...resolved,
        base: BASE_VOCAB,
        overrides: (settings.vocabulary ?? {}) as Record<string, string>,
        industries: INDUSTRIES.map((i) => ({ code: i.code, label: i.label })),
      };
    });
  }

  @Put("personalization")
  updatePersonalization(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const parsed = z
      .object({
        industry: z.string().max(40).optional(),
        vocabulary: z.record(z.string(), z.string().max(40)).optional(),
        modules: z.record(z.string(), z.boolean()).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Personalización inválida");
    const input = parsed.data;
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
      const settings = (org?.settings ?? {}) as Record<string, any>;
      if (input.industry !== undefined) {
        settings.general = { ...(settings.general ?? {}), industry: input.industry };
      }
      if (input.vocabulary !== undefined) settings.vocabulary = input.vocabulary;
      if (input.modules !== undefined) settings.modules = { ...(settings.modules ?? {}), ...input.modules };
      await tx.organization.update({ where: { id: ctx.organizationId }, data: { settings: settings as object } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "settings.personalization_update", entityType: "organization", after: input as object },
      });
      return { ok: true, ...resolvePersonalization(settings) };
    });
  }

  // ------------------------- IA (por tenant) -------------------------

  /** Modelo/tope/rondas: SOLO LECTURA (los administra TuBot según el plan). */
  @Get("ia")
  ia() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
      const settings = (org?.settings ?? {}) as Record<string, any>;
      const ai = (settings.ai ?? {}) as Record<string, any>;
      const limits = (settings.limits ?? {}) as Record<string, any>;
      return {
        managed: {
          model: ai.model ?? getEnv().AI_DEFAULT_MODEL,
          maxTokens: ai.maxTokens ?? 400,
          maxToolRounds: ai.maxToolRounds ?? 5,
          dailyTokenBudget: limits.aiTokensDaily ?? getEnv().AI_DAILY_TOKEN_BUDGET_PER_ORG,
        },
        transcription: settings.transcription !== false,
        vision: settings.vision !== false,
        assistantLanguage: String(settings.assistantLanguage ?? org?.locale ?? "es"),
      };
    });
  }

  @Put("ia")
  updateIa(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const parsed = z
      .object({ transcription: z.boolean().optional(), vision: z.boolean().optional(), assistantLanguage: z.enum(["es", "en", "pt"]).optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Ajustes inválidos");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
      const settings = (org?.settings ?? {}) as Record<string, any>;
      await tx.organization.update({
        where: { id: ctx.organizationId },
        data: {
          settings: {
            ...settings,
            ...(parsed.data.transcription !== undefined ? { transcription: parsed.data.transcription } : {}),
            ...(parsed.data.vision !== undefined ? { vision: parsed.data.vision } : {}),
            ...(parsed.data.assistantLanguage ? { assistantLanguage: parsed.data.assistantLanguage } : {}),
          } as object,
        },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "settings.ia_update", entityType: "organization", after: parsed.data as object },
      });
      return { ok: true };
    });
  }

  // ------------------------- Biblioteca de plantillas de prompt -------------------------

  /** Biblioteca del tenant; ?agentId= filtra las asignadas a ese agente ([]=todos). */
  @Get("prompt-templates")
  promptTemplates(@Query("agentId") agentId?: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const all = await tx.promptTemplate.findMany({ orderBy: [{ type: "asc" }, { name: "asc" }] });
      return agentId ? all.filter((t) => templateVisibleForAgent(t, agentId)) : all;
    });
  }

  @Post("prompt-templates")
  createPromptTemplate(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const parsed = z.object({ name: z.string().min(2).max(60), body: z.string().min(5).max(8000), type: z.enum(PROMPT_TEMPLATE_TYPES).optional(), agentIds: z.array(z.string()).max(50).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Plantilla inválida (nombre 2-60, contenido 5-8000)");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const exists = await tx.promptTemplate.findUnique({
        where: { organizationId_name: { organizationId: ctx.organizationId, name: parsed.data.name.trim() } },
      });
      if (exists) throw new BadRequestException("Ya existe una plantilla con ese nombre");
      return tx.promptTemplate.create({
        data: {
          organizationId: ctx.organizationId,
          name: parsed.data.name.trim(),
          body: parsed.data.body,
          type: parsed.data.type ?? "instructions",
          agentIds: (parsed.data.agentIds ?? []) as object,
          createdById: ctx.userId,
        },
      });
    });
  }

  @Patch("prompt-templates/:id")
  updatePromptTemplate(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const parsed = z
      .object({
        name: z.string().min(2).max(60).optional(),
        body: z.string().min(5).max(8000).optional(),
        type: z.enum(PROMPT_TEMPLATE_TYPES).optional(),
        agentIds: z.array(z.string()).max(50).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Plantilla inválida");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const tpl = await tx.promptTemplate.findUnique({ where: { id } });
      if (!tpl) throw new NotFoundException("Plantilla no encontrada");
      return tx.promptTemplate.update({
        where: { id },
        data: {
          ...(parsed.data.name ? { name: parsed.data.name } : {}),
          ...(parsed.data.body ? { body: parsed.data.body } : {}),
          ...(parsed.data.type ? { type: parsed.data.type } : {}),
          ...(parsed.data.agentIds ? { agentIds: parsed.data.agentIds as object } : {}),
        },
      });
    });
  }

  @Delete("prompt-templates/:id")
  deletePromptTemplate(@Param("id") id: string) {
    const ctx = requirePermission("settings:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.promptTemplate.deleteMany({ where: { id } });
      return { ok: true };
    });
  }

  // ------------------------- Exports en background -------------------------

  /** Lanza un export (contactos/conversaciones/citas) que procesa el worker. */
  @Post("exports")
  async createExport(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const parsed = z
      .object({
        type: z.enum(["contacts", "conversations", "appointments"]),
        from: z.string().optional(), // ISO date
        to: z.string().optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Export inválido");
    const job = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const pending = await tx.exportJob.count({ where: { status: { in: ["PENDING", "RUNNING"] } } });
      if (pending >= 3) throw new BadRequestException("Ya hay exports en curso — espera a que terminen");
      const created = await tx.exportJob.create({
        data: {
          organizationId: ctx.organizationId,
          type: parsed.data.type,
          params: { from: parsed.data.from ?? null, to: parsed.data.to ?? null } as object,
          createdById: ctx.userId,
        },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "settings.export_create", entityType: "export_job", entityId: created.id, after: parsed.data as object },
      });
      return created;
    });
    await this.queues.sync.add("export", {
      organizationId: ctx.organizationId,
      kind: "export_data",
      payload: { exportId: job.id },
    });
    return { ok: true, id: job.id };
  }

  @Get("exports")
  exportsList() {
    const ctx = requirePermission("settings:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const jobs = await tx.exportJob.findMany({
        orderBy: { createdAt: "desc" },
        take: 30,
        select: { id: true, type: true, params: true, status: true, rows: true, error: true, createdById: true, createdAt: true, finishedAt: true, expiresAt: true },
      });
      const authors = await tx.organizationUser.findMany({
        where: { userId: { in: [...new Set(jobs.map((j) => j.createdById).filter(Boolean))] as string[] } },
        include: { user: { select: { id: true, name: true } } },
      });
      const nameBy = new Map(authors.map((a) => [a.userId, a.user.name]));
      return jobs.map((j) => ({
        ...j,
        createdBy: j.createdById ? (nameBy.get(j.createdById) ?? null) : null,
        expired: j.expiresAt ? j.expiresAt.getTime() < Date.now() : false,
      }));
    });
  }

  /** Descarga del CSV (dato sensible: requiere permiso de Datos y queda auditado). */
  @Get("exports/:id/download")
  async downloadExport(@Param("id") id: string, @Res() res: Response) {
    const ctx = requirePermission("settings:write");
    const job = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const j = await tx.exportJob.findUnique({ where: { id } });
      if (!j) throw new NotFoundException("Export no encontrado");
      if (j.status !== "DONE" || !j.content) throw new BadRequestException("El export aún no está listo");
      if (j.expiresAt && j.expiresAt.getTime() < Date.now()) throw new BadRequestException("El export expiró (7 días) — genéralo de nuevo");
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "settings.export_download", entityType: "export_job", entityId: id, after: { type: j.type, rows: j.rows } },
      });
      return j;
    });
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="tubot-${job.type}-${job.createdAt.toISOString().slice(0, 10)}.csv"`);
    res.send("﻿" + job.content);
  }

  // ------------------------- Registro de auditoría -------------------------

  /** audit_logs del tenant (solo Owner/Admin), filtrable por usuario/módulo/fecha. */
  @Get("audit")
  audit(
    @Query("actorId") actorId?: string,
    @Query("module") module?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("cursor") cursor?: string,
  ) {
    const ctx = requirePermission("settings:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const take = 50;
      const rows = await tx.auditLog.findMany({
        where: {
          ...(actorId ? { actorId } : {}),
          ...(module ? { action: { startsWith: module } } : {}),
          ...(from ? { createdAt: { gte: new Date(from) } } : {}),
          ...(to ? { createdAt: { ...(from ? { gte: new Date(from) } : {}), lte: new Date(`${to}T23:59:59`) } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > take;
      const page = hasMore ? rows.slice(0, take) : rows;
      const userIds = [...new Set(page.map((r) => r.actorId).filter(Boolean))] as string[];
      const members = userIds.length
        ? await tx.organizationUser.findMany({ where: { userId: { in: userIds } }, include: { user: { select: { id: true, name: true } } } })
        : [];
      const nameBy = new Map(members.map((m) => [m.userId, m.user.name]));
      return {
        items: page.map((r) => ({
          id: r.id,
          action: r.action,
          actorType: r.actorType,
          actorName: r.actorId ? (nameBy.get(r.actorId) ?? r.actorId) : null,
          entityType: r.entityType,
          entityId: r.entityId,
          after: r.after,
          createdAt: r.createdAt,
        })),
        nextCursor: hasMore ? page[page.length - 1]!.id : null,
      };
    });
  }

  // ------------------- Preferencias de notificaciones (personales) -------------------

  /** Defaults sensatos: todo activado menos el resumen diario. */
  static NOTIF_DEFAULTS = { assignedToMe: true, aiEscalation: true, integrationError: true, dailySummary: false, dataJobs: true };

  @Get("notifications")
  notificationPrefs() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
      const all = (((org?.settings ?? {}) as Record<string, any>).notifPrefs ?? {}) as Record<string, any>;
      return { ...SettingsController.NOTIF_DEFAULTS, ...(all[ctx.userId] ?? {}) };
    });
  }

  @Put("notifications")
  updateNotificationPrefs(@Body() body: unknown) {
    const ctx = requireContext(); // personal: cualquier rol, solo sus propias prefs
    const parsed = z
      .object({
        assignedToMe: z.boolean().optional(),
        aiEscalation: z.boolean().optional(),
        integrationError: z.boolean().optional(),
        dailySummary: z.boolean().optional(),
        dataJobs: z.boolean().optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Preferencias inválidas");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId } });
      const settings = (org?.settings ?? {}) as Record<string, any>;
      const all = (settings.notifPrefs ?? {}) as Record<string, any>;
      all[ctx.userId] = { ...SettingsController.NOTIF_DEFAULTS, ...(all[ctx.userId] ?? {}), ...parsed.data };
      await tx.organization.update({ where: { id: ctx.organizationId }, data: { settings: { ...settings, notifPrefs: all } as object } });
      return { ok: true };
    });
  }


  // ------------------------- Logo y avatar (subida de archivo) -------------------------
  // Regla: files.content SOLO se lee en los endpoints que sirven la imagen;
  // ningún listado de File selecciona esa columna.

  /** Sube el logo del negocio (PNG/JPG/WebP ≤2MB; validado por magic bytes). */
  @Post("logo")
  async uploadLogo(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    return this.saveImage(ctx.organizationId, ctx.userId, `${ctx.organizationId}/branding/logo`, "logo del negocio", body);
  }

  /** Sirve el logo (única lectura de files.content junto al avatar). */
  @Get("logo")
  async serveLogo(@Res() res: Response) {
    const ctx = requireContext();
    await this.serveImage(ctx.organizationId, `${ctx.organizationId}/branding/logo`, res);
  }

  @Delete("logo")
  async deleteLogo() {
    const ctx = requirePermission("settings:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.file.deleteMany({ where: { key: `${ctx.organizationId}/branding/logo` } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "settings.logo_delete", entityType: "file" },
      });
      return { ok: true };
    });
  }

  /** Avatar personal (cualquier rol; mismo pipeline de validación del logo). */
  @Post("profile/avatar")
  async uploadAvatar(@Body() body: unknown) {
    const ctx = requireContext();
    return this.saveImage(ctx.organizationId, ctx.userId, `${ctx.organizationId}/branding/avatar/${ctx.userId}`, "avatar", body);
  }

  @Get("avatar/:userId")
  async serveAvatar(@Param("userId") userId: string, @Res() res: Response) {
    const ctx = requireContext();
    await this.serveImage(ctx.organizationId, `${ctx.organizationId}/branding/avatar/${userId}`, res);
  }

  @Delete("profile/avatar")
  async deleteAvatar() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.file.deleteMany({ where: { key: `${ctx.organizationId}/branding/avatar/${ctx.userId}` } });
      return { ok: true };
    });
  }

  private async saveImage(orgId: string, userId: string, key: string, label: string, body: unknown) {
    const parsed = z.object({ dataBase64: z.string().min(1), filename: z.string().max(200).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Imagen requerida");
    const buf = Buffer.from(parsed.data.dataBase64, "base64");
    let info: { mime: string; width: number; height: number };
    try {
      info = validateUploadedImage(buf);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return this.prisma.withTenant(orgId, async (tx) => {
      const existing = await tx.file.findFirst({ where: { key }, select: { id: true } });
      const data = {
        organizationId: orgId,
        bucket: "db",
        key,
        name: parsed.data.filename ?? label,
        mime: info.mime,
        size: buf.length,
        uploadedById: userId,
        scope: "branding",
        content: parsed.data.dataBase64,
        meta: { width: info.width, height: info.height } as object,
      };
      const file = existing
        ? await tx.file.update({ where: { id: existing.id }, data, select: { id: true } })
        : await tx.file.create({ data, select: { id: true } });
      await tx.auditLog.create({
        data: { organizationId: orgId, actorType: "user", actorId: userId, action: "settings.image_upload", entityType: "file", entityId: file.id, after: { key, mime: info.mime, size: buf.length } },
      });
      return { ok: true, fileId: file.id, width: info.width, height: info.height };
    });
  }

  private async serveImage(orgId: string, key: string, res: Response) {
    const file = await this.prisma.withTenant(orgId, (tx) =>
      tx.file.findFirst({ where: { key }, select: { mime: true, content: true } }),
    );
    if (!file?.content) {
      res.status(404).json({ message: "Sin imagen" });
      return;
    }
    res.setHeader("content-type", file.mime ?? "image/png");
    res.setHeader("cache-control", "private, max-age=300");
    res.send(Buffer.from(file.content, "base64"));
  }

  // ------------------------- Helpers -------------------------

  private mergeSettings(orgId: string, userId: string, key: string, patch: object, auditAction: string) {
    return this.prisma.withTenant(orgId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: orgId } });
      const settings = (org?.settings ?? {}) as Record<string, any>;
      const section = { ...((settings[key] ?? {}) as object), ...patch } as object;
      await tx.organization.update({ where: { id: orgId }, data: { settings: { ...settings, [key]: section } as object } });
      await tx.auditLog.create({
        data: { organizationId: orgId, actorType: "user", actorId: userId, action: auditAction, entityType: "organization", after: patch },
      });
      return { ok: true };
    });
  }
}
