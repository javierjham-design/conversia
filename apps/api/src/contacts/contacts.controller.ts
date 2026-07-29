import { BadRequestException, Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
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
  if (f.blocked === "true") where.blocked = true;
  if (f.blocked === "false") where.blocked = false;
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
  if (tagContactIds) where.id = { in: tagContactIds };
  return where;
}

@Controller("contacts")
export class ContactsController {
  constructor(private prisma: PrismaService) {}

  /** Lista paginada de contactos con búsqueda y filtros (todo server-side). */
  @Get()
  list(@Query() query: unknown) {
    const ctx = requirePermission("contacts:read");
    const q = parse(listQuery, query);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      // Filtro por segmento: expande su definición sobre los mismos campos.
      let filters: Record<string, any> = { ...q };
      if (q.segmentId) {
        const seg = await tx.contactSegment.findUnique({ where: { id: q.segmentId } });
        if (seg) filters = { ...(seg.definition as Record<string, any>), ...filters };
      }
      // Filtro por etiqueta → resolver contactIds con esa etiqueta primero.
      let tagContactIds: string[] | undefined;
      if (filters.tag) {
        const assigns = await tx.tagAssignment.findMany({ where: { tagId: filters.tag, entityType: "contact" }, select: { entityId: true } });
        tagContactIds = assigns.map((a) => a.entityId);
        if (tagContactIds.length === 0) return { items: [], total: 0, page: q.page, pageSize: q.pageSize };
      }
      const where = buildWhere(filters, tagContactIds);

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
}
