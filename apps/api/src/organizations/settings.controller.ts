import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

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
@Controller("settings")
export class SettingsController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
  ) {}

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
        currency: general.currency ?? "CLP",
        language: general.language ?? "es",
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
      for (const key of ["logoUrl", "industry", "currency", "language", "contactEmail", "contactPhone", "website"] as const) {
        if (input[key] !== undefined) general[key] = input[key];
      }
      await tx.organization.update({
        where: { id: ctx.organizationId },
        data: {
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.timezone ? { timezone: input.timezone } : {}),
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
        assistantLanguage: String(settings.assistantLanguage ?? ((settings.general as any)?.language ?? "es")),
      };
    });
  }

  @Put("ia")
  updateIa(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const parsed = z
      .object({ transcription: z.boolean().optional(), assistantLanguage: z.enum(["es", "en", "pt"]).optional() })
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

  @Get("prompt-templates")
  promptTemplates() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) => tx.promptTemplate.findMany({ orderBy: { name: "asc" } }));
  }

  @Post("prompt-templates")
  createPromptTemplate(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const parsed = z.object({ name: z.string().min(2).max(60), body: z.string().min(5).max(8000) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Plantilla inválida (nombre 2-60, contenido 5-8000)");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const exists = await tx.promptTemplate.findUnique({
        where: { organizationId_name: { organizationId: ctx.organizationId, name: parsed.data.name.trim() } },
      });
      if (exists) throw new BadRequestException("Ya existe una plantilla con ese nombre");
      return tx.promptTemplate.create({
        data: { organizationId: ctx.organizationId, name: parsed.data.name.trim(), body: parsed.data.body, createdById: ctx.userId },
      });
    });
  }

  @Patch("prompt-templates/:id")
  updatePromptTemplate(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const parsed = z.object({ name: z.string().min(2).max(60).optional(), body: z.string().min(5).max(8000).optional() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Plantilla inválida");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const tpl = await tx.promptTemplate.findUnique({ where: { id } });
      if (!tpl) throw new NotFoundException("Plantilla no encontrada");
      return tx.promptTemplate.update({ where: { id }, data: parsed.data });
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
