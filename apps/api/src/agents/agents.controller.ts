import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import { z } from "zod";
import { buildCoreTools } from "@conversia/agents";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";

const createAgentSchema = z.object({
  name: z.string().min(2).max(60),
  kind: z.string().default("custom"),
  description: z.string().max(300).optional(),
});

const draftSchema = z.object({
  name: z.string().min(2).max(60).optional(),
  description: z.string().max(300).nullable().optional(),
  kind: z.string().optional(),
  systemPrompt: z.string().min(20, "El prompt debe tener al menos 20 caracteres"),
  config: z
    .object({
      model: z.string().default("claude-opus-4-8"),
      maxTokens: z.coerce.number().int().min(50).max(4000).default(400),
      maxToolRounds: z.coerce.number().int().min(0).max(10).default(5),
      language: z.string().default("es"),
    })
    .passthrough(),
  tools: z.array(z.string()).default([]),
  changelog: z.string().max(300).optional(),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return result.data;
}

const DEFAULT_PROMPT = `Eres {{agent.name}}, asistente virtual de {{organization.name}} ({{clinic.name}}). Atiendes por WhatsApp de forma cercana, profesional y breve (máximo 2-3 frases, una pregunta a la vez). Responde SOLO con información obtenida de tus herramientas; si no sabes algo, reconócelo y ofrece que una persona del equipo contacte. Nunca inventes precios, horarios ni disponibilidad, y nunca entregues indicaciones clínicas. Si detectas urgencia, frustración o piden hablar con una persona, usa transferToHuman.`;

@Controller("agents")
export class AgentsController {
  constructor(private prisma: PrismaService) {}

  /** Catálogo de herramientas disponibles para habilitar por agente. */
  @Get("meta/tools")
  toolCatalog() {
    return buildCoreTools().map((t) => ({ name: t.name, description: t.description }));
  }

  @Get()
  list() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const agents = await tx.agent.findMany({
        where: { deletedAt: null },
        include: {
          versions: { orderBy: { version: "desc" }, take: 5 },
        },
        orderBy: { createdAt: "asc" },
      });
      return agents.map((a) => {
        const published = a.versions.find((v) => v.status === "PUBLISHED");
        const draft = a.versions.find((v) => v.status === "DRAFT");
        return {
          id: a.id,
          slug: a.slug,
          name: a.name,
          kind: a.kind,
          description: a.description,
          active: a.active,
          publishedVersion: published?.version ?? null,
          publishedAt: published?.publishedAt ?? null,
          hasDraft: Boolean(draft && (!published || draft.version > published.version)),
          model: ((published ?? draft)?.config as any)?.model ?? null,
        };
      });
    });
  }

  @Post()
  create(@Body() body: unknown) {
    const ctx = requireContext();
    const input = parse(createAgentSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      let slug = slugify(input.name) || "agente";
      const existing = await tx.agent.findUnique({
        where: { organizationId_slug: { organizationId: ctx.organizationId, slug } },
      });
      if (existing) slug = `${slug}-${Math.random().toString(36).slice(2, 5)}`;

      const agent = await tx.agent.create({
        data: {
          organizationId: ctx.organizationId,
          slug,
          name: input.name,
          kind: input.kind,
          description: input.description,
          active: true,
        },
      });
      await tx.agentVersion.create({
        data: {
          organizationId: ctx.organizationId,
          agentId: agent.id,
          version: 1,
          status: "DRAFT",
          systemPrompt: DEFAULT_PROMPT,
          config: { model: "claude-opus-4-8", maxTokens: 400, maxToolRounds: 5, language: "es" },
          tools: ["getServices", "getServicePrice", "searchKnowledgeBase", "transferToHuman"],
          changelog: "Borrador inicial",
          createdById: ctx.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "agent.create",
          entityType: "agent",
          entityId: agent.id,
        },
      });
      return agent;
    });
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const agent = await tx.agent.findFirst({
        where: { id, deletedAt: null },
        include: { versions: { orderBy: { version: "desc" }, take: 20 } },
      });
      if (!agent) throw new NotFoundException("Agente no encontrado");
      const published = agent.versions.find((v) => v.status === "PUBLISHED");
      const draft = agent.versions.find(
        (v) => v.status === "DRAFT" && (!published || v.version > published.version),
      );
      const editing = draft ?? published ?? agent.versions[0];
      return {
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        kind: agent.kind,
        description: agent.description,
        active: agent.active,
        publishedVersion: published?.version ?? null,
        draftVersion: draft?.version ?? null,
        editing: editing
          ? {
              systemPrompt: editing.systemPrompt,
              config: editing.config,
              tools: editing.tools,
              status: editing.status,
              version: editing.version,
            }
          : null,
        versions: agent.versions.map((v) => ({
          version: v.version,
          status: v.status,
          changelog: v.changelog,
          publishedAt: v.publishedAt,
          createdAt: v.createdAt,
        })),
      };
    });
  }

  /** Guarda el borrador: actualiza el DRAFT vigente o crea la versión siguiente. */
  @Put(":id/draft")
  saveDraft(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const input = parse(draftSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const agent = await tx.agent.findFirst({ where: { id, deletedAt: null } });
      if (!agent) throw new NotFoundException("Agente no encontrado");

      if (input.name || input.kind || input.description !== undefined) {
        await tx.agent.update({
          where: { id },
          data: {
            ...(input.name ? { name: input.name } : {}),
            ...(input.kind ? { kind: input.kind } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          },
        });
      }

      const latest = await tx.agentVersion.findFirst({
        where: { agentId: id },
        orderBy: { version: "desc" },
      });
      const data = {
        systemPrompt: input.systemPrompt,
        config: input.config as object,
        tools: input.tools,
        changelog: input.changelog ?? null,
        createdById: ctx.userId,
      };
      let version;
      if (latest && latest.status === "DRAFT") {
        version = await tx.agentVersion.update({ where: { id: latest.id }, data });
      } else {
        version = await tx.agentVersion.create({
          data: {
            organizationId: ctx.organizationId,
            agentId: id,
            version: (latest?.version ?? 0) + 1,
            status: "DRAFT",
            ...data,
          },
        });
      }
      return { ok: true, draftVersion: version.version };
    });
  }

  /** Publica el borrador: pasa a PRODUCCIÓN inmediatamente para nuevas respuestas. */
  @Post(":id/publish")
  publish(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const draft = await tx.agentVersion.findFirst({
        where: { agentId: id, status: "DRAFT" },
        orderBy: { version: "desc" },
      });
      if (!draft) throw new BadRequestException("No hay borrador para publicar");
      const published = await tx.agentVersion.update({
        where: { id: draft.id },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });
      await tx.agent.update({ where: { id }, data: { currentVersionId: published.id } });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "agent.publish",
          entityType: "agent",
          entityId: id,
          after: { version: published.version },
        },
      });
      return { ok: true, publishedVersion: published.version };
    });
  }

  @Post(":id/active")
  setActive(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const input = parse(z.object({ active: z.boolean() }), body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.agent.update({ where: { id }, data: { active: input.active } });
      return { ok: true, active: input.active };
    });
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const usedAsDefault = await tx.channelConnection.findFirst({ where: { defaultAgentId: id } });
      if (usedAsDefault) {
        throw new BadRequestException(
          `Este agente es el agente por defecto del canal "${usedAsDefault.name}". Cambia el canal antes de eliminarlo.`,
        );
      }
      await tx.agent.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "agent.delete",
          entityType: "agent",
          entityId: id,
        },
      });
      return { ok: true };
    });
  }
}
