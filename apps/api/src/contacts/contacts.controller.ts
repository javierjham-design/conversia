import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { requirePermission } from "../tenancy/permissions";

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().refine((v) => [25, 50, 100].includes(v), "pageSize inválido").default(25),
  q: z.string().trim().max(120).optional(),
  stage: z.string().optional(), // código de LeadStatus
  tag: z.string().optional(), // tagId
  channel: z.string().optional(), // ChannelType
  assignedUser: z.string().optional(),
  assignedTeam: z.string().optional(),
  assignedAgent: z.string().optional(),
  country: z.string().optional(),
  source: z.enum(["ad", "organic"]).optional(),
  blocked: z.enum(["true", "false"]).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  segmentId: z.string().optional(),
  sortBy: z.enum(["createdAt", "lastContactAt", "firstName"]).default("createdAt"),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
});

// Infiere el tipo de SALIDA del schema (con `.default()` aplicados → no opcionales).
function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

/** Normaliza a E.164 conservando solo dígitos (mismo criterio que el worker). */
function normalizePhone(raw?: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  return digits ? `+${digits}` : null;
}

const createBody = z
  .object({
    firstName: z.string().trim().max(120).optional(),
    lastName: z.string().trim().max(120).optional(),
    phone: z.string().trim().max(32).optional(),
    email: z.string().trim().max(160).email("email inválido").optional().or(z.literal("")),
    country: z.string().trim().max(2).optional(),
    locale: z.string().trim().max(10).optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((b) => b.firstName || b.lastName || b.phone || b.email, "Indica al menos nombre, teléfono o email");

const updateBody = z.object({
  firstName: z.string().trim().max(120).nullable().optional(),
  lastName: z.string().trim().max(120).nullable().optional(),
  email: z.string().trim().max(160).email("email inválido").nullable().optional().or(z.literal("")),
  phone: z.string().trim().max(32).nullable().optional(),
  documentId: z.string().trim().max(40).nullable().optional(),
  birthDate: z.string().trim().nullable().optional(),
  locale: z.string().trim().max(10).optional(),
  timezone: z.string().trim().max(64).nullable().optional(),
  country: z.string().trim().max(2).nullable().optional(),
  consent: z.boolean().optional(),
  doNotContact: z.boolean().optional(),
  customFields: z.record(z.string(), z.any()).optional(),
});

const bulkBody = z.object({
  ids: z.array(z.string()).min(1).max(1000),
  action: z.enum(["tag_add", "tag_remove", "stage", "assign", "block", "unblock", "delete"]),
  tagId: z.string().optional(),
  statusCode: z.string().optional(),
  assignedUserId: z.string().nullable().optional(),
  assignedTeamId: z.string().nullable().optional(),
  activeAgentId: z.string().nullable().optional(),
});

// La definición del segmento es un subconjunto de los filtros de la lista.
const segmentDefinition = z
  .object({
    q: z.string().optional(),
    stage: z.string().optional(),
    tag: z.string().optional(),
    channel: z.string().optional(),
    assignedUser: z.string().optional(),
    assignedTeam: z.string().optional(),
    assignedAgent: z.string().optional(),
    country: z.string().optional(),
    source: z.enum(["ad", "organic"]).optional(),
    blocked: z.enum(["true", "false"]).optional(),
    dateFrom: z.string().optional(),
    dateTo: z.string().optional(),
    createdWithinDays: z.number().int().positive().max(3650).optional(),
  })
  .strip();
const segmentBody = z.object({ name: z.string().trim().min(1).max(80), definition: segmentDefinition });

const importRow = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  country: z.string().optional(),
  locale: z.string().optional(),
  tags: z.string().optional(), // separadas por coma
});
const importBody = z.object({ rows: z.array(importRow).min(1).max(5000), updateExisting: z.boolean().default(false) });

const mergeBody = z.object({ primaryId: z.string(), mergeIds: z.array(z.string()).min(1).max(20) });

/** Traduce la definición de un segmento (o los query params) al `where` de Prisma. */
function buildWhere(f: Record<string, any>, tagContactIds?: string[]): any {
  const where: any = { deletedAt: null };
  if (f.q) {
    where.OR = [
      { firstName: { contains: f.q, mode: "insensitive" } },
      { lastName: { contains: f.q, mode: "insensitive" } },
      { profileName: { contains: f.q, mode: "insensitive" } },
      { phone: { contains: f.q } },
      { email: { contains: f.q, mode: "insensitive" } },
    ];
  }
  if (f.country) where.country = f.country;
  if (f.blocked === "true" || f.blocked === true) where.blocked = true;
  if (f.blocked === "false" || f.blocked === false) where.blocked = false;
  if (f.source) where.acquisitionSource = f.source; // "ad" | "organic"
  if (f.stage) where.leads = { some: { status: { code: f.stage } } };
  if (f.channel) where.identities = { some: { channelType: f.channel } };
  const convFilter: any = {};
  if (f.assignedUser) convFilter.assignedUserId = f.assignedUser;
  if (f.assignedTeam) convFilter.assignedTeamId = f.assignedTeam;
  if (f.assignedAgent) convFilter.activeAgentId = f.assignedAgent;
  if (Object.keys(convFilter).length) where.conversations = { some: convFilter };
  if (f.dateFrom || f.dateTo) {
    where.createdAt = {
      ...(f.dateFrom ? { gte: new Date(f.dateFrom) } : {}),
      ...(f.dateTo ? { lte: new Date(f.dateTo) } : {}),
    };
  }
  // Segmento dinámico "últimos N días" (relativo, no se queda obsoleto).
  if (f.createdWithinDays && !f.dateFrom) {
    where.createdAt = { ...(where.createdAt ?? {}), gte: new Date(Date.now() - Number(f.createdWithinDays) * 86_400_000) };
  }
  if (tagContactIds) where.id = { in: tagContactIds };
  return where;
}

/** Segmento (base) + filtros explícitos del query encima → `where` de Prisma.
 *  Compartido por la lista y la exportación. `emptyTag` corta si la etiqueta no
 *  tiene contactos (evita un `IN ()` innecesario). */
async function resolveWhere(tx: any, q: Record<string, any>): Promise<{ where: any; emptyTag: boolean }> {
  let filters: Record<string, any> = {};
  if (q.segmentId) {
    const seg = await tx.contactSegment.findUnique({ where: { id: q.segmentId } });
    if (seg) filters = { ...(seg.definition as Record<string, any>) };
  }
  for (const k of ["q", "stage", "tag", "channel", "assignedUser", "assignedTeam", "assignedAgent", "country", "source", "blocked", "dateFrom", "dateTo"]) {
    if (q[k] !== undefined) filters[k] = q[k];
  }
  let tagContactIds: string[] | undefined;
  if (filters.tag) {
    const assigns = await tx.tagAssignment.findMany({ where: { tagId: filters.tag, entityType: "contact" }, select: { entityId: true } });
    tagContactIds = assigns.map((a: { entityId: string }) => a.entityId);
    if (tagContactIds!.length === 0) return { where: buildWhere(filters, tagContactIds), emptyTag: true };
  }
  return { where: buildWhere(filters, tagContactIds), emptyTag: false };
}

const csvEscape = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

@Controller("contacts")
export class ContactsController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
  ) {}

  /** Lista paginada de contactos con búsqueda y filtros (todo server-side). */
  @Get()
  list(@Query() query: unknown) {
    const ctx = requirePermission("contacts:read");
    const q = parse(listQuery, query);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const { where, emptyTag } = await resolveWhere(tx, q);
      if (emptyTag) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };

      const [total, contacts] = await Promise.all([
        tx.contact.count({ where }),
        tx.contact.findMany({
          where,
          orderBy: { [q.sortBy]: q.sortDir },
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
          include: {
            leads: { orderBy: { createdAt: "desc" }, take: 1, include: { status: true } },
            conversations: { orderBy: { lastMessageAt: "desc" }, take: 1, select: { id: true, status: true, assignedUserId: true, assignedTeamId: true, activeAgentId: true, lastMessageAt: true } },
            identities: { select: { channelType: true } },
          },
        }),
      ]);

      // Etiquetas de los contactos de esta página (1 consulta + join a nombres).
      const ids = contacts.map((c) => c.id);
      const assigns = ids.length ? await tx.tagAssignment.findMany({ where: { entityType: "contact", entityId: { in: ids } }, select: { entityId: true, tagId: true } }) : [];
      const tagIds = [...new Set(assigns.map((a) => a.tagId))];
      const tags = tagIds.length ? await tx.tag.findMany({ where: { id: { in: tagIds } }, select: { id: true, name: true, color: true } }) : [];
      const tagById = new Map(tags.map((t) => [t.id, t]));
      const tagsByContact = new Map<string, { name: string; color: string | null }[]>();
      for (const a of assigns) {
        const t = tagById.get(a.tagId);
        if (!t) continue;
        const arr = tagsByContact.get(a.entityId) ?? [];
        arr.push({ name: t.name, color: t.color });
        tagsByContact.set(a.entityId, arr);
      }

      return {
        page: q.page,
        pageSize: q.pageSize,
        total,
        items: contacts.map((c) => {
          const lead = c.leads[0];
          const conv = c.conversations[0];
          return {
            id: c.id,
            firstName: c.firstName,
            lastName: c.lastName,
            profileName: c.profileName,
            phone: c.phone,
            email: c.email,
            country: c.country,
            locale: c.locale,
            blocked: c.blocked,
            acquisitionSource: c.acquisitionSource,
            createdAt: c.createdAt,
            lastContactAt: c.lastContactAt,
            stage: lead ? { code: lead.status.code, name: lead.status.name, color: lead.status.color } : null,
            conversation: conv ? { id: conv.id, status: conv.status, assignedUserId: conv.assignedUserId, assignedTeamId: conv.assignedTeamId, activeAgentId: conv.activeAgentId } : null,
            channels: [...new Set(c.identities.map((i) => i.channelType))],
            tags: tagsByContact.get(c.id) ?? [],
          };
        }),
      };
    });
  }

  /** Alta manual de un contacto desde la UI. */
  @Post()
  create(@Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const b = parse(createBody, body);
    const phone = normalizePhone(b.phone);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      if (phone) {
        const existing = await tx.contact.findFirst({ where: { phone, deletedAt: null }, select: { id: true } });
        if (existing) throw new BadRequestException("Ya existe un contacto con ese teléfono");
      }
      const contact = await tx.contact.create({
        data: {
          organizationId: ctx.organizationId,
          firstName: b.firstName || null,
          lastName: b.lastName || null,
          phone,
          email: b.email || null,
          country: b.country ? b.country.toUpperCase() : null,
          locale: b.locale || "es",
          source: "manual",
          createdVia: "manual",
          acquisitionSource: "organic",
          attributes: b.notes ? { notes: b.notes } : {},
        },
        select: { id: true },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "contact.create",
          entityType: "contact",
          entityId: contact.id,
          after: { firstName: b.firstName ?? null, lastName: b.lastName ?? null, phone },
        },
      });
      return { id: contact.id };
    });
  }

  /** Datos del sidebar (conteos en vivo) + opciones de filtros. */
  @Get("meta")
  meta() {
    const ctx = requirePermission("contacts:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [all, blocked, leadStatuses, agents, members, teams, tags, leadsByStatus, convsByAgent, countryRows, segments] = await Promise.all([
        tx.contact.count({ where: { deletedAt: null } }),
        tx.contact.count({ where: { deletedAt: null, blocked: true } }),
        tx.leadStatus.findMany({ orderBy: { order: "asc" }, select: { code: true, name: true, color: true, category: true } }),
        tx.agent.findMany({ where: { deletedAt: null, active: true }, select: { id: true, name: true, slug: true } }),
        tx.organizationUser.findMany({ where: { active: true }, include: { user: { select: { id: true, name: true } } } }),
        tx.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
        tx.tag.findMany({ select: { id: true, name: true, color: true }, orderBy: { name: "asc" } }),
        tx.lead.groupBy({ by: ["statusId"], _count: { _all: true } }),
        tx.conversation.groupBy({ by: ["activeAgentId"], _count: { _all: true }, where: { activeAgentId: { not: null } } }),
        tx.contact.findMany({ where: { deletedAt: null, country: { not: null } }, select: { country: true }, distinct: ["country"] }),
        tx.contactSegment.findMany({ orderBy: { name: "asc" } }),
      ]);

      const statusIdToCode = new Map((await tx.leadStatus.findMany({ select: { id: true, code: true } })).map((s) => [s.id, s.code]));
      const countByStage = new Map<string, number>();
      for (const g of leadsByStatus) countByStage.set(statusIdToCode.get(g.statusId) ?? "", g._count._all);
      const countByAgent = new Map<string, number>();
      for (const g of convsByAgent) if (g.activeAgentId) countByAgent.set(g.activeAgentId, g._count._all);

      return {
        counts: { all, blocked },
        lifecycle: leadStatuses.map((s) => ({ ...s, count: countByStage.get(s.code) ?? 0 })),
        agents: agents.map((a) => ({ id: a.id, name: a.name, slug: a.slug, count: countByAgent.get(a.id) ?? 0 })),
        users: members.map((m) => ({ id: m.userId, name: m.user.name })),
        teams,
        tags,
        countries: countryRows.map((r) => r.country).filter(Boolean),
        segments: segments.map((s) => ({ id: s.id, name: s.name, isDefault: s.isDefault })),
      };
    });
  }

  // --------------------------- Segmentos (filtros guardados) ---------------------------

  /** Segmentos guardados del tenant (con su definición). Declarado ANTES de :id. */
  @Get("segments")
  listSegments() {
    const ctx = requirePermission("contacts:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const segments = await tx.contactSegment.findMany({ orderBy: { name: "asc" } });
      return segments.map((s) => ({ id: s.id, name: s.name, definition: s.definition, isDefault: s.isDefault }));
    });
  }

  @Post("segments")
  createSegment(@Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const b = parse(segmentBody, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const exists = await tx.contactSegment.findFirst({ where: { name: b.name }, select: { id: true } });
      if (exists) throw new BadRequestException("Ya existe un segmento con ese nombre");
      const seg = await tx.contactSegment.create({
        data: { organizationId: ctx.organizationId, name: b.name, definition: b.definition as object, createdById: ctx.userId },
        select: { id: true, name: true, definition: true },
      });
      return seg;
    });
  }

  @Patch("segments/:id")
  updateSegment(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const b = parse(segmentBody.partial(), body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const seg = await tx.contactSegment.findFirst({ where: { id }, select: { id: true } });
      if (!seg) throw new NotFoundException("Segmento no encontrado");
      await tx.contactSegment.update({
        where: { id },
        data: { ...(b.name ? { name: b.name } : {}), ...(b.definition ? { definition: b.definition as object } : {}) },
      });
      return { ok: true };
    });
  }

  @Delete("segments/:id")
  deleteSegment(@Param("id") id: string) {
    const ctx = requirePermission("contacts:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.contactSegment.deleteMany({ where: { id } });
      return { ok: true };
    });
  }

  // --------------------------- Exportación / duplicados (GET, antes de :id) ---------------------------

  /** Exporta a CSV respetando los filtros actuales (hasta 10 000 filas). */
  @Get("export")
  async export(@Res() res: Response, @Query() query: unknown) {
    const ctx = requirePermission("contacts:read");
    const q = parse(listQuery, query);
    const rows = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const { where, emptyTag } = await resolveWhere(tx, q);
      if (emptyTag) return [];
      const contacts = await tx.contact.findMany({
        where,
        orderBy: { [q.sortBy]: q.sortDir },
        take: 10_000,
        include: { leads: { orderBy: { createdAt: "desc" }, take: 1, include: { status: true } } },
      });
      const ids = contacts.map((c) => c.id);
      const assigns = ids.length ? await tx.tagAssignment.findMany({ where: { entityType: "contact", entityId: { in: ids } }, select: { entityId: true, tagId: true } }) : [];
      const tags = assigns.length ? await tx.tag.findMany({ where: { id: { in: [...new Set(assigns.map((a) => a.tagId))] } }, select: { id: true, name: true } }) : [];
      const tagName = new Map(tags.map((t) => [t.id, t.name]));
      const tagsByContact = new Map<string, string[]>();
      for (const a of assigns) {
        const n = tagName.get(a.tagId);
        if (!n) continue;
        tagsByContact.set(a.entityId, [...(tagsByContact.get(a.entityId) ?? []), n]);
      }
      return contacts.map((c) => ({ c, tags: tagsByContact.get(c.id) ?? [] }));
    });

    const header = "nombre;apellido;telefono;email;pais;idioma;etapa;etiquetas;origen;perfil_whatsapp;bloqueado;creado;ultimo_contacto";
    const lines = rows.map(({ c, tags }) =>
      [c.firstName, c.lastName, c.phone, c.email, c.country, c.locale, c.leads[0]?.status.name ?? "", tags.join(", "), c.acquisitionSource, c.profileName, c.blocked ? "si" : "no", c.createdAt.toISOString(), c.lastContactAt?.toISOString() ?? ""]
        .map(csvEscape)
        .join(";"),
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="contactos.csv"');
    res.send("﻿" + [header, ...lines].join("\n"));
  }

  /** Grupos de contactos que comparten el mismo teléfono (candidatos a fusión). */
  @Get("duplicates")
  duplicates() {
    const ctx = requirePermission("contacts:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const groups = await tx.contact.groupBy({
        by: ["phone"],
        where: { deletedAt: null, phone: { not: null } },
        _count: { _all: true },
        having: { phone: { _count: { gt: 1 } } },
      });
      const phones = groups.map((g) => g.phone).filter((p): p is string => !!p);
      if (phones.length === 0) return { groups: [] };
      const contacts = await tx.contact.findMany({
        where: { deletedAt: null, phone: { in: phones } },
        select: { id: true, firstName: true, lastName: true, phone: true, email: true, profileName: true, createdAt: true, lastContactAt: true },
        orderBy: { createdAt: "asc" },
      });
      const byPhone = new Map<string, typeof contacts>();
      for (const c of contacts) {
        if (!c.phone) continue;
        byPhone.set(c.phone, [...(byPhone.get(c.phone) ?? []), c]);
      }
      return { groups: [...byPhone.entries()].map(([phone, items]) => ({ phone, items })) };
    });
  }

  // --------------------------------- Acciones masivas ---------------------------------

  /** Acción sobre múltiples contactos (etiquetar, etapa, asignar, bloquear, borrar). */
  @Post("bulk")
  async bulk(@Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const b = parse(bulkBody, body);
    const orgId = ctx.organizationId;
    // Contactos recién etiquetados → evento tag.added (workflows con ese trigger).
    let tagged: { name: string; contactIds: string[] } | null = null;
    const result = await this.prisma.withTenant(orgId, async (tx) => {
      // Solo IDs que realmente pertenecen al tenant (RLS ya aísla, pero validamos).
      const valid = (await tx.contact.findMany({ where: { id: { in: b.ids }, deletedAt: null }, select: { id: true } })).map((c) => c.id);
      if (valid.length === 0) return { affected: 0 };
      let affected = 0;

      switch (b.action) {
        case "tag_add": {
          if (!b.tagId) throw new BadRequestException("Falta tagId");
          const tag = await tx.tag.findFirst({ where: { id: b.tagId }, select: { id: true, name: true } });
          if (!tag) throw new BadRequestException("Etiqueta inválida");
          const existing = await tx.tagAssignment.findMany({
            where: { tagId: b.tagId, entityType: "contact", entityId: { in: valid } },
            select: { entityId: true },
          });
          const already = new Set(existing.map((e) => e.entityId));
          const fresh = valid.filter((id) => !already.has(id));
          if (fresh.length) {
            await tx.tagAssignment.createMany({
              data: fresh.map((entityId) => ({ organizationId: orgId, tagId: b.tagId!, entityType: "contact", entityId })),
              skipDuplicates: true,
            });
          }
          tagged = { name: tag.name, contactIds: fresh };
          affected = fresh.length;
          break;
        }
        case "tag_remove": {
          if (!b.tagId) throw new BadRequestException("Falta tagId");
          const res = await tx.tagAssignment.deleteMany({ where: { tagId: b.tagId, entityType: "contact", entityId: { in: valid } } });
          affected = res.count;
          break;
        }
        case "stage": {
          if (!b.statusCode) throw new BadRequestException("Falta statusCode");
          const status = await tx.leadStatus.findFirst({ where: { code: b.statusCode }, select: { id: true } });
          if (!status) throw new BadRequestException("Etapa inválida");
          for (const contactId of valid) {
            const lead = await tx.lead.findFirst({ where: { contactId }, orderBy: { createdAt: "desc" }, select: { id: true } });
            if (lead) await tx.lead.update({ where: { id: lead.id }, data: { statusId: status.id } });
            else await tx.lead.create({ data: { organizationId: orgId, contactId, statusId: status.id } });
            affected++;
          }
          break;
        }
        case "assign": {
          const data: Record<string, unknown> = {};
          if (b.assignedUserId !== undefined) data.assignedUserId = b.assignedUserId;
          if (b.assignedTeamId !== undefined) data.assignedTeamId = b.assignedTeamId;
          if (b.activeAgentId !== undefined) data.activeAgentId = b.activeAgentId;
          if (Object.keys(data).length === 0) throw new BadRequestException("Nada que asignar");
          for (const contactId of valid) {
            const conv = await tx.conversation.findFirst({ where: { contactId }, orderBy: { lastMessageAt: "desc" }, select: { id: true } });
            if (conv) {
              await tx.conversation.update({ where: { id: conv.id }, data });
              affected++;
            }
          }
          break;
        }
        case "block":
        case "unblock": {
          const res = await tx.contact.updateMany({
            where: { id: { in: valid } },
            data: b.action === "block" ? { blocked: true, doNotContact: true } : { blocked: false },
          });
          affected = res.count;
          break;
        }
        case "delete": {
          const res = await tx.contact.updateMany({ where: { id: { in: valid } }, data: { deletedAt: new Date() } });
          affected = res.count;
          break;
        }
      }

      await tx.auditLog.create({
        data: { organizationId: orgId, actorType: "user", actorId: ctx.userId, action: `contact.bulk.${b.action}`, entityType: "contact", after: { count: affected, ids: valid.length } },
      });
      return { affected };
    });
    if (tagged !== null) {
      const { name, contactIds } = tagged as { name: string; contactIds: string[] };
      const occurredAt = new Date().toISOString();
      for (const contactId of contactIds) {
        await this.queues.events.add("emit", {
          organizationId: orgId,
          type: "tag.added",
          contactId,
          data: { tag: name, contactId },
          occurredAt,
        });
      }
    }
    return result;
  }

  // --------------------------------- Importación CSV ---------------------------------

  /** Importa filas mapeadas (normaliza teléfono, dedupe por teléfono; crea o
   *  actualiza según updateExisting). Procesa en lotes para no exceder el
   *  timeout de la transacción. Para volúmenes muy grandes convendría un job
   *  BullMQ en segundo plano (pendiente). */
  @Post("import")
  async import(@Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const b = parse(importBody, body);
    const orgId = ctx.organizationId;
    let created = 0,
      updated = 0,
      skipped = 0;
    const errors: { row: number; reason: string }[] = [];
    const CHUNK = 200;

    for (let i = 0; i < b.rows.length; i += CHUNK) {
      const chunk = b.rows.slice(i, i + CHUNK);
      await this.prisma.withTenant(orgId, async (tx) => {
        for (let j = 0; j < chunk.length; j++) {
          const idx = i + j + 1; // fila 1-based (sin cabecera)
          const row = chunk[j];
          const phone = normalizePhone(row.phone);
          if (!phone && !row.email && !row.firstName && !row.lastName) {
            errors.push({ row: idx, reason: "fila sin datos" });
            continue;
          }
          let contactId: string;
          const existing = phone ? await tx.contact.findFirst({ where: { phone, deletedAt: null } }) : null;
          if (existing) {
            contactId = existing.id;
            if (b.updateExisting) {
              const data: Record<string, unknown> = {};
              if (row.firstName && !existing.firstName) data.firstName = row.firstName;
              if (row.lastName && !existing.lastName) data.lastName = row.lastName;
              if (row.email && !existing.email) data.email = row.email;
              if (row.country && !existing.country) data.country = row.country.toUpperCase().slice(0, 2);
              if (Object.keys(data).length) await tx.contact.update({ where: { id: existing.id }, data });
              updated++;
            } else {
              skipped++;
            }
          } else {
            const c = await tx.contact.create({
              data: {
                organizationId: orgId,
                firstName: row.firstName || null,
                lastName: row.lastName || null,
                phone,
                email: row.email || null,
                country: row.country ? row.country.toUpperCase().slice(0, 2) : null,
                locale: row.locale || "es",
                source: "import",
                createdVia: "import",
                acquisitionSource: "organic",
              },
              select: { id: true },
            });
            contactId = c.id;
            created++;
          }
          // Etiquetas (separadas por coma) → upsert Tag + asignación
          if (row.tags) {
            for (const raw of row.tags.split(",").map((t) => t.trim()).filter(Boolean)) {
              const tag = await tx.tag.upsert({
                where: { organizationId_name: { organizationId: orgId, name: raw } },
                create: { organizationId: orgId, name: raw },
                update: {},
                select: { id: true },
              });
              await tx.tagAssignment.createMany({
                data: [{ organizationId: orgId, tagId: tag.id, entityType: "contact", entityId: contactId }],
                skipDuplicates: true,
              });
            }
          }
        }
      });
    }

    await this.prisma.withTenant(orgId, (tx) =>
      tx.auditLog.create({ data: { organizationId: orgId, actorType: "user", actorId: ctx.userId, action: "contact.import", entityType: "contact", after: { created, updated, skipped } } }),
    );
    return { created, updated, skipped, errors: errors.slice(0, 100) };
  }

  // --------------------------------- Fusión de duplicados ---------------------------------

  /** Fusiona contactos en uno primario: reasigna conversaciones/leads/citas/
   *  identidades/etiquetas/campos, rellena huecos del primario y da de baja el resto. */
  @Post("merge")
  merge(@Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const b = parse(mergeBody, body);
    const orgId = ctx.organizationId;
    return this.prisma.withTenant(orgId, async (tx) => {
      const primary = await tx.contact.findFirst({ where: { id: b.primaryId, deletedAt: null } });
      if (!primary) throw new NotFoundException("Contacto primario no encontrado");
      const mergeIds = b.mergeIds.filter((id) => id !== b.primaryId);
      const merges = await tx.contact.findMany({ where: { id: { in: mergeIds }, deletedAt: null } });
      if (merges.length === 0) throw new BadRequestException("Sin contactos válidos para fusionar");

      for (const m of merges) {
        await tx.conversation.updateMany({ where: { contactId: m.id }, data: { contactId: primary.id } });
        await tx.lead.updateMany({ where: { contactId: m.id }, data: { contactId: primary.id } });
        await tx.appointment.updateMany({ where: { contactId: m.id }, data: { contactId: primary.id } });

        // Identidades: mover solo si no colisionan con una del primario
        const idents = await tx.contactIdentity.findMany({ where: { contactId: m.id } });
        for (const id of idents) {
          const clash = await tx.contactIdentity.findUnique({
            where: { organizationId_channelType_externalId: { organizationId: orgId, channelType: id.channelType, externalId: id.externalId } },
          });
          if (!clash) await tx.contactIdentity.update({ where: { id: id.id }, data: { contactId: primary.id } });
          else await tx.contactIdentity.delete({ where: { id: id.id } });
        }
        // Etiquetas (evitar duplicados) y campos personalizados (solo si faltan en el primario)
        const tagAssigns = await tx.tagAssignment.findMany({ where: { entityType: "contact", entityId: m.id } });
        for (const ta of tagAssigns) {
          await tx.tagAssignment.createMany({ data: [{ organizationId: orgId, tagId: ta.tagId, entityType: "contact", entityId: primary.id }], skipDuplicates: true });
        }
        await tx.tagAssignment.deleteMany({ where: { entityType: "contact", entityId: m.id } });
        const cfvs = await tx.customFieldValue.findMany({ where: { entityId: m.id } });
        for (const v of cfvs) {
          const has = await tx.customFieldValue.findUnique({ where: { organizationId_definitionId_entityId: { organizationId: orgId, definitionId: v.definitionId, entityId: primary.id } } });
          if (!has) await tx.customFieldValue.create({ data: { organizationId: orgId, definitionId: v.definitionId, entityId: primary.id, value: v.value as object } });
        }
      }

      // Rellenar huecos del primario desde los fusionados
      const fill: Record<string, unknown> = {};
      const keys = ["firstName", "lastName", "email", "documentId", "country", "birthDate", "profileName", "adId", "ctwaClid"] as const;
      for (const k of keys) {
        if (!(primary as any)[k]) {
          const src = merges.find((m) => (m as any)[k]);
          if (src) fill[k] = (src as any)[k];
        }
      }
      if (Object.keys(fill).length) await tx.contact.update({ where: { id: primary.id }, data: fill });
      await tx.contact.updateMany({ where: { id: { in: merges.map((m) => m.id) } }, data: { deletedAt: new Date() } });
      await tx.auditLog.create({ data: { organizationId: orgId, actorType: "user", actorId: ctx.userId, action: "contact.merge", entityType: "contact", entityId: primary.id, after: { merged: merges.map((m) => m.id) } } });
      return { ok: true, primaryId: primary.id, merged: merges.length };
    });
  }

  /** Ficha completa del contacto: identidad, atribución, conversaciones,
   *  ciclo de vida, campos personalizados, notas y actividad. */
  @Get(":id")
  detail(@Param("id") id: string) {
    const ctx = requirePermission("contacts:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const c = await tx.contact.findFirst({
        where: { id, deletedAt: null },
        include: {
          identities: { select: { channelType: true, externalId: true } },
          conversations: {
            orderBy: { lastMessageAt: "desc" },
            take: 10,
            select: { id: true, status: true, lastMessageAt: true, lastMessagePreview: true, unreadCount: true, activeAgentId: true, assignedUserId: true },
          },
          leads: { orderBy: { createdAt: "desc" }, take: 10, include: { status: { select: { code: true, name: true, color: true, category: true } } } },
        },
      });
      if (!c) throw new NotFoundException("Contacto no encontrado");

      // Etiquetas
      const assigns = await tx.tagAssignment.findMany({ where: { entityType: "contact", entityId: id }, select: { tagId: true } });
      const tags = assigns.length ? await tx.tag.findMany({ where: { id: { in: assigns.map((a) => a.tagId) } }, select: { id: true, name: true, color: true } }) : [];

      // Campos personalizados (definición del tenant + valor de este contacto)
      const [defs, values] = await Promise.all([
        tx.customFieldDefinition.findMany({ where: { entity: "contact" }, orderBy: { createdAt: "asc" } }),
        tx.customFieldValue.findMany({ where: { entityId: id } }),
      ]);
      const valueByDef = new Map(values.map((v) => [v.definitionId, v.value]));
      const customFields = defs.map((d) => ({ id: d.id, key: d.key, label: d.label, type: d.type, options: d.options, required: d.required, value: valueByDef.get(d.id) ?? null }));

      // Actividad (audit log) + nombres de actores
      const activity = await tx.auditLog.findMany({ where: { entityType: "contact", entityId: id }, orderBy: { createdAt: "desc" }, take: 25 });
      const actorIds = [...new Set(activity.map((a) => a.actorId).filter(Boolean) as string[])];
      const actors = actorIds.length ? await tx.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : [];
      const actorName = new Map(actors.map((u) => [u.id, u.name]));

      const attrs = (c.attributes as Record<string, any>) ?? {};
      const notes = Array.isArray(attrs.notes) ? attrs.notes : [];

      return {
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        phone: c.phone,
        email: c.email,
        documentId: c.documentId,
        birthDate: c.birthDate,
        locale: c.locale,
        timezone: c.timezone,
        country: c.country,
        consent: c.consent,
        doNotContact: c.doNotContact,
        blocked: c.blocked,
        // Perfil de WhatsApp (solo lectura, separado del nombre real)
        profileName: c.profileName,
        // Bloque "Origen" (atribución, solo lectura)
        origin: {
          source: c.source,
          createdVia: c.createdVia,
          acquisitionSource: c.acquisitionSource,
          adId: c.adId,
          ctwaClid: c.ctwaClid,
          campaignId: c.campaignId,
          referral: (c.meta as Record<string, any>)?.referral ?? null,
          firstContactAt: c.firstContactAt,
          lastContactAt: c.lastContactAt,
          createdAt: c.createdAt,
        },
        identities: c.identities,
        conversations: c.conversations,
        leads: c.leads.map((l) => ({ id: l.id, createdAt: l.createdAt, status: l.status })),
        tags,
        customFields,
        notes,
        activity: activity.map((a) => ({ id: a.id, action: a.action, actor: a.actorId ? actorName.get(a.actorId) ?? null : null, actorType: a.actorType, before: a.before, after: a.after, createdAt: a.createdAt })),
      };
    });
  }

  /** Edición de campos del contacto + valores de campos personalizados. */
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const b = parse(updateBody, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const current = await tx.contact.findFirst({ where: { id, deletedAt: null } });
      if (!current) throw new NotFoundException("Contacto no encontrado");

      const data: Record<string, unknown> = {};
      if (b.firstName !== undefined) data.firstName = b.firstName || null;
      if (b.lastName !== undefined) data.lastName = b.lastName || null;
      if (b.email !== undefined) data.email = b.email || null;
      if (b.phone !== undefined) data.phone = normalizePhone(b.phone || undefined);
      if (b.documentId !== undefined) data.documentId = b.documentId || null;
      if (b.birthDate !== undefined) data.birthDate = b.birthDate ? new Date(b.birthDate) : null;
      if (b.locale !== undefined) data.locale = b.locale || "es";
      if (b.timezone !== undefined) data.timezone = b.timezone || null;
      if (b.country !== undefined) data.country = b.country ? b.country.toUpperCase() : null;
      if (b.consent !== undefined) data.consent = b.consent;
      if (b.doNotContact !== undefined) data.doNotContact = b.doNotContact;

      // Dedupe de teléfono al editar
      if (typeof data.phone === "string" && data.phone && data.phone !== current.phone) {
        const dup = await tx.contact.findFirst({ where: { phone: data.phone as string, deletedAt: null, id: { not: id } }, select: { id: true } });
        if (dup) throw new BadRequestException("Ya existe otro contacto con ese teléfono");
      }

      if (Object.keys(data).length) await tx.contact.update({ where: { id }, data });

      // Campos personalizados (solo definiciones válidas de entidad "contact")
      if (b.customFields && Object.keys(b.customFields).length) {
        const validDefs = new Set((await tx.customFieldDefinition.findMany({ where: { entity: "contact" }, select: { id: true } })).map((d) => d.id));
        for (const [definitionId, value] of Object.entries(b.customFields)) {
          if (!validDefs.has(definitionId)) continue;
          await tx.customFieldValue.upsert({
            where: { organizationId_definitionId_entityId: { organizationId: ctx.organizationId, definitionId, entityId: id } },
            create: { organizationId: ctx.organizationId, definitionId, entityId: id, value: value as object },
            update: { value: value as object },
          });
        }
      }

      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "contact.update", entityType: "contact", entityId: id, after: data as object },
      });
      return { ok: true };
    });
  }

  /** Bloquear / desbloquear (bloquear implica no-contactar). */
  @Post(":id/block")
  block(@Param("id") id: string) {
    return this.setBlocked(id, true);
  }
  @Post(":id/unblock")
  unblock(@Param("id") id: string) {
    return this.setBlocked(id, false);
  }
  private setBlocked(id: string, blocked: boolean) {
    const ctx = requirePermission("contacts:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const current = await tx.contact.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
      if (!current) throw new NotFoundException("Contacto no encontrado");
      await tx.contact.update({ where: { id }, data: blocked ? { blocked: true, doNotContact: true } : { blocked: false } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: blocked ? "contact.block" : "contact.unblock", entityType: "contact", entityId: id },
      });
      return { ok: true, blocked };
    });
  }

  /** Nota interna (se guarda en attributes.notes, sin tabla nueva). */
  @Post(":id/notes")
  addNote(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("contacts:write");
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(2000) }), body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const c = await tx.contact.findFirst({ where: { id, deletedAt: null }, select: { attributes: true } });
      if (!c) throw new NotFoundException("Contacto no encontrado");
      const author = await tx.user.findUnique({ where: { id: ctx.userId }, select: { name: true } });
      const attrs = (c.attributes as Record<string, any>) ?? {};
      const notes = Array.isArray(attrs.notes) ? attrs.notes : [];
      const note = { id: randomUUID(), text, authorId: ctx.userId, authorName: author?.name ?? null, createdAt: new Date().toISOString() };
      await tx.contact.update({ where: { id }, data: { attributes: { ...attrs, notes: [note, ...notes] } } });
      return note;
    });
  }

  /** Baja lógica del contacto. */
  @Delete(":id")
  remove(@Param("id") id: string) {
    const ctx = requirePermission("contacts:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const current = await tx.contact.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
      if (!current) throw new NotFoundException("Contacto no encontrado");
      await tx.contact.update({ where: { id }, data: { deletedAt: new Date() } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "contact.delete", entityType: "contact", entityId: id },
      });
      return { ok: true };
    });
  }
}
