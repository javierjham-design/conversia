import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

const boardQuery = z.object({
  /** origen del contacto: meta_lead_ads | whatsapp | import | clariva | manual */
  source: z.string().max(40).optional(),
  /** id externo del formulario de Lead Ads */
  formId: z.string().max(60).optional(),
  q: z.string().trim().max(120).optional(),
  /** leads creados en los últimos N días */
  days: z.coerce.number().int().positive().max(3650).optional(),
  /** rango de fechas de creación del lead (YYYY-MM-DD) */
  dateFrom: z.string().max(10).optional(),
  dateTo: z.string().max(10).optional(),
});

const PER_COLUMN = 50;

const listQuery = boardQuery.extend({
  /** code de la etapa del ciclo de vida (columna) */
  stage: z.string().max(60).optional(),
  page: z.coerce.number().int().positive().max(10_000).default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
  sort: z.enum(["updatedAt", "createdAt"]).default("updatedAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

/**
 * Tablero CRM de leads: pipeline por etapa del ciclo de vida. Es una VISTA
 * sobre leads+contactos (no un modelo nuevo); mover una tarjeta usa el mismo
 * evento canónico `lead.status_changed` que alimenta workflows y las reglas
 * CAPI del dataset de Meta (reporte de vuelta por etapa).
 */
@Controller("crm")
export class CrmController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
  ) {}

  /** Columnas (etapas activas en orden) con sus leads más recientes. */
  @Get("board")
  board(@Query() query: Record<string, string>) {
    const ctx = requireContext();
    const q = boardQuery.parse(query ?? {});
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const stages = await tx.leadStatus.findMany({ where: { active: true }, orderBy: { order: "asc" } });

      const contactWhere: Record<string, unknown> = { deletedAt: null };
      if (q.source) contactWhere.source = q.source;
      if (q.q) {
        contactWhere.OR = [
          { firstName: { contains: q.q, mode: "insensitive" } },
          { lastName: { contains: q.q, mode: "insensitive" } },
          { phone: { contains: q.q.replace(/[^\d+]/g, "") || q.q } },
          { email: { contains: q.q, mode: "insensitive" } },
        ];
      }
      const leadWhere: Record<string, unknown> = { contact: contactWhere };
      if (q.formId) leadWhere.meta = { path: ["formId"], equals: q.formId };
      if (q.days) leadWhere.createdAt = { gte: new Date(Date.now() - q.days * 86_400_000) };
      if (q.dateFrom || q.dateTo) {
        leadWhere.createdAt = {
          ...((leadWhere.createdAt as object) ?? {}),
          ...(q.dateFrom ? { gte: new Date(`${q.dateFrom}T00:00:00`) } : {}),
          ...(q.dateTo ? { lte: new Date(`${q.dateTo}T23:59:59`) } : {}),
        };
      }

      const [counts, leads] = await Promise.all([
        tx.lead.groupBy({ by: ["statusId"], where: leadWhere as any, _count: { _all: true } }),
        tx.lead.findMany({
          where: leadWhere as any,
          orderBy: { updatedAt: "desc" },
          take: PER_COLUMN * Math.max(stages.length, 1),
          include: {
            contact: { select: { id: true, firstName: true, lastName: true, profileName: true, phone: true, email: true, source: true, attributes: true, country: true } },
          },
        }),
      ]);
      const countByStatus = new Map(counts.map((c) => [c.statusId, c._count._all]));

      // Conversación abierta más reciente por contacto (para el acceso directo)
      const contactIds = [...new Set(leads.map((l) => l.contactId))];
      const conversations = contactIds.length
        ? await tx.conversation.findMany({
            where: { contactId: { in: contactIds }, status: { not: "CLOSED" } },
            orderBy: { lastMessageAt: "desc" },
            select: { id: true, contactId: true },
          })
        : [];
      const convByContact = new Map<string, string>();
      for (const c of conversations) if (!convByContact.has(c.contactId)) convByContact.set(c.contactId, c.id);

      const byStage = new Map<string, any[]>();
      for (const lead of leads) {
        const arr = byStage.get(lead.statusId) ?? [];
        if (arr.length >= PER_COLUMN) continue;
        const meta = (lead.meta as Record<string, any> | null) ?? {};
        const attrs = (lead.contact.attributes as Record<string, any> | null) ?? {};
        arr.push({
          id: lead.id,
          contactId: lead.contact.id,
          name:
            [lead.contact.firstName, lead.contact.lastName].filter(Boolean).join(" ") ||
            lead.contact.profileName ||
            lead.contact.phone ||
            "Sin nombre",
          phone: lead.contact.phone,
          email: lead.contact.email,
          country: lead.contact.country,
          source: lead.contact.source,
          formId: meta.formId ?? attrs.metaLead?.formId ?? null,
          campaignId: meta.campaignId ?? attrs.metaLead?.campaignId ?? null,
          conversationId: convByContact.get(lead.contact.id) ?? null,
          createdAt: lead.createdAt.toISOString(),
          updatedAt: lead.updatedAt.toISOString(),
        });
        byStage.set(lead.statusId, arr);
      }

      return {
        stages: stages.map((s) => ({
          id: s.id,
          code: s.code,
          name: s.name,
          emoji: s.emoji,
          color: s.color,
          category: s.category,
          count: countByStatus.get(s.id) ?? 0,
          leads: byStage.get(s.id) ?? [],
        })),
        total: counts.reduce((acc, c) => acc + c._count._all, 0),
      };
    });
  }

  /** Listado plano de leads (vista tabla del CRM): mismos filtros del tablero
   *  + etapa, con paginación y orden. */
  @Get("list")
  list(@Query() query: Record<string, string>) {
    const ctx = requireContext();
    const q = listQuery.parse(query ?? {});
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const contactWhere: Record<string, unknown> = { deletedAt: null };
      if (q.source) contactWhere.source = q.source;
      if (q.q) {
        contactWhere.OR = [
          { firstName: { contains: q.q, mode: "insensitive" } },
          { lastName: { contains: q.q, mode: "insensitive" } },
          { phone: { contains: q.q.replace(/[^\d+]/g, "") || q.q } },
          { email: { contains: q.q, mode: "insensitive" } },
        ];
      }
      const leadWhere: Record<string, unknown> = { contact: contactWhere };
      if (q.formId) leadWhere.meta = { path: ["formId"], equals: q.formId };
      if (q.days) leadWhere.createdAt = { gte: new Date(Date.now() - q.days * 86_400_000) };
      if (q.dateFrom || q.dateTo) {
        leadWhere.createdAt = {
          ...((leadWhere.createdAt as object) ?? {}),
          ...(q.dateFrom ? { gte: new Date(`${q.dateFrom}T00:00:00`) } : {}),
          ...(q.dateTo ? { lte: new Date(`${q.dateTo}T23:59:59`) } : {}),
        };
      }
      if (q.stage) {
        const status = await tx.leadStatus.findUnique({
          where: { organizationId_code: { organizationId: ctx.organizationId, code: q.stage } },
        });
        leadWhere.statusId = status?.id ?? "__none__";
      }

      const [total, leads] = await Promise.all([
        tx.lead.count({ where: leadWhere as any }),
        tx.lead.findMany({
          where: leadWhere as any,
          orderBy: { [q.sort]: q.order },
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
          include: {
            status: { select: { code: true, name: true, emoji: true, color: true, category: true } },
            contact: { select: { id: true, firstName: true, lastName: true, profileName: true, phone: true, email: true, source: true, attributes: true, country: true } },
          },
        }),
      ]);

      const contactIds = [...new Set(leads.map((l) => l.contactId))];
      const conversations = contactIds.length
        ? await tx.conversation.findMany({
            where: { contactId: { in: contactIds }, status: { not: "CLOSED" } },
            orderBy: { lastMessageAt: "desc" },
            select: { id: true, contactId: true },
          })
        : [];
      const convByContact = new Map<string, string>();
      for (const c of conversations) if (!convByContact.has(c.contactId)) convByContact.set(c.contactId, c.id);

      return {
        total,
        page: q.page,
        pageSize: q.pageSize,
        rows: leads.map((lead) => {
          const meta = (lead.meta as Record<string, any> | null) ?? {};
          const attrs = (lead.contact.attributes as Record<string, any> | null) ?? {};
          return {
            id: lead.id,
            contactId: lead.contact.id,
            name:
              [lead.contact.firstName, lead.contact.lastName].filter(Boolean).join(" ") ||
              lead.contact.profileName ||
              lead.contact.phone ||
              "Sin nombre",
            phone: lead.contact.phone,
            email: lead.contact.email,
            country: lead.contact.country,
            source: lead.contact.source,
            formId: meta.formId ?? attrs.metaLead?.formId ?? null,
            campaignId: meta.campaignId ?? attrs.metaLead?.campaignId ?? null,
            stage: { code: lead.status.code, name: lead.status.name, emoji: lead.status.emoji, color: lead.status.color, category: lead.status.category },
            conversationId: convByContact.get(lead.contact.id) ?? null,
            createdAt: lead.createdAt.toISOString(),
            updatedAt: lead.updatedAt.toISOString(),
          };
        }),
      };
    });
  }

  /** Orígenes y formularios presentes (para poblar los filtros del tablero). */
  @Get("filters")
  filters() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [sources, forms, stages] = await Promise.all([
        tx.contact.groupBy({ by: ["source"], where: { deletedAt: null, source: { not: null } }, _count: { _all: true } }),
        tx.metaAsset.findMany({ where: { kind: "lead_form" }, select: { externalId: true, name: true } }),
        tx.leadStatus.findMany({ where: { active: true }, orderBy: { order: "asc" }, select: { code: true, name: true, emoji: true, color: true } }),
      ]);
      return {
        sources: sources.map((s) => ({ value: s.source, count: s._count._all })),
        forms: forms.map((f) => ({ id: f.externalId, name: f.name ?? f.externalId })),
        stages,
      };
    });
  }

  /** Mueve un lead de etapa (tarjeta del tablero) → evento canónico. */
  @Post("leads/:id/stage")
  async moveStage(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("leads:write");
    const parsed = z.object({ statusCode: z.string().min(1).max(60) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("statusCode requerido");
    const result = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id }, include: { status: true, contact: { select: { id: true, phone: true } } } });
      if (!lead) throw new NotFoundException("Lead no encontrado");
      const status = await tx.leadStatus.findUnique({
        where: { organizationId_code: { organizationId: ctx.organizationId, code: parsed.data.statusCode } },
      });
      if (!status || !status.active) throw new BadRequestException("Etapa desconocida");
      if (lead.statusId === status.id) return { changed: false, from: lead.status.code, to: status.code, contactId: lead.contact.id, contactPhone: lead.contact.phone };
      await tx.lead.update({ where: { id }, data: { statusId: status.id } });
      await tx.leadEvent.create({
        data: { organizationId: ctx.organizationId, leadId: id, type: "status_changed", data: { from: lead.status.code, to: status.code, via: "crm_board" }, actorType: "user", actorId: ctx.userId },
      });
      return { changed: true, from: lead.status.code, to: status.code, contactId: lead.contact.id, contactPhone: lead.contact.phone, conversion: status.category === "WON" };
    });
    if (result.changed) {
      await this.queues.events.add("emit", {
        organizationId: ctx.organizationId,
        type: "lead.status_changed",
        contactId: result.contactId,
        data: { from: result.from, to: result.to, statusCode: result.to, via: "crm_board", contactId: result.contactId },
        occurredAt: new Date().toISOString(),
      });
    }
    return result;
  }

  /**
   * Cambia la etapa del lead de un CONTACTO (desde el chat). El chat tiene el contacto,
   * no el lead; se usa/crea el lead más reciente. Emite el mismo `lead.status_changed`
   * que el tablero → alimenta workflows y reglas (misma verdad canónica).
   */
  @Post("contacts/:contactId/stage")
  async moveContactStage(@Param("contactId") contactId: string, @Body() body: unknown) {
    const ctx = requirePermission("leads:write");
    const parsed = z.object({ statusCode: z.string().min(1).max(60) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("statusCode requerido");
    const result = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const status = await tx.leadStatus.findUnique({ where: { organizationId_code: { organizationId: ctx.organizationId, code: parsed.data.statusCode } } });
      if (!status || !status.active) throw new BadRequestException("Etapa desconocida");
      const contact = await tx.contact.findUnique({ where: { id: contactId }, select: { id: true, phone: true } });
      if (!contact) throw new NotFoundException("Contacto no encontrado");
      let lead = await tx.lead.findFirst({ where: { contactId }, orderBy: { createdAt: "desc" }, include: { status: true } });
      const from = lead?.status?.code ?? null;
      if (lead && lead.statusId === status.id) return { changed: false, from, to: status.code, contactId, contactPhone: contact.phone };
      if (!lead) lead = await tx.lead.create({ data: { organizationId: ctx.organizationId, contactId, statusId: status.id }, include: { status: true } });
      else await tx.lead.update({ where: { id: lead.id }, data: { statusId: status.id } });
      await tx.leadEvent.create({ data: { organizationId: ctx.organizationId, leadId: lead.id, type: "status_changed", data: { from, to: status.code, via: "chat" }, actorType: "user", actorId: ctx.userId } });
      return { changed: true, from, to: status.code, contactId, contactPhone: contact.phone, conversion: status.category === "WON" };
    });
    if (result.changed) {
      await this.queues.events.add("emit", {
        organizationId: ctx.organizationId,
        type: "lead.status_changed",
        contactId: result.contactId,
        data: { from: result.from, to: result.to, statusCode: result.to, via: "chat", contactId: result.contactId },
        occurredAt: new Date().toISOString(),
      });
    }
    return result;
  }
}
