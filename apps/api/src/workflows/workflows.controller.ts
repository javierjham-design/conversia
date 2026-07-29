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
  Put,
} from "@nestjs/common";
import { z } from "zod";
import { workflowDefinitionSchema } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { enforcePlanLimit } from "../common/plan-limits";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

const createSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(300).optional(),
});

const draftSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(300).nullable().optional(),
  definition: z.unknown(),
});

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => i.message).join("; "));
  return r.data;
}

/** Catálogo del constructor: triggers y pasos IMPLEMENTADOS por el motor v0. */
const TRIGGER_CATALOG = [
  { type: "conversation_started", label: "Conversación nueva", description: "Primer mensaje de un contacto (crea la conversación)" },
  { type: "message_received", label: "Mensaje recibido", description: "Cada mensaje entrante; admite condiciones", conditions: ["keyword", "firstMessage"] },
  { type: "conversation_closed", label: "Conversación cerrada", description: "Cuando se cierra la conversación (p. ej. encuesta post-atención)" },
  { type: "keyword", label: "Palabra clave (simple)", description: "El mensaje contiene una palabra o frase", config: ["keyword"] },
];

const NODE_CATALOG = [
  { type: "send_text", label: "Enviar mensaje", description: "Envía un texto (admite variables {{contact.firstName}}…)" },
  { type: "run_agent", label: "Ejecutar agente IA", description: "El agente elegido responde la conversación" },
  { type: "wait", label: "Esperar", description: "Pausa el flujo; opcionalmente se cancela si el contacto responde" },
  { type: "condition_no_reply", label: "¿Sigue sin responder?", description: "Si NO ha respondido continúa; si respondió, termina el flujo" },
  { type: "update_lead_status", label: "Cambiar estado del lead", description: "Actualiza el estado del lead del contacto" },
  { type: "add_tag", label: "Agregar etiqueta", description: "Etiqueta la conversación" },
  { type: "remove_tag", label: "Quitar etiqueta", description: "Quita una etiqueta de la conversación" },
  { type: "update_contact", label: "Actualizar datos del contacto", description: "Guarda nombre, apellido o email del contacto" },
  { type: "assign_user", label: "Asignar a usuario", description: "Asigna la conversación a una persona (pausa la IA)" },
  { type: "assign_team", label: "Asignar a equipo", description: "Asigna la conversación a un equipo (pausa la IA)" },
  { type: "switch_agent", label: "Cambiar agente IA", description: "Otro agente IA toma el control de la conversación" },
  { type: "transfer_human", label: "Escalar a humano", description: "Pausa la IA y notifica al equipo" },
  { type: "close_conversation", label: "Cerrar conversación", description: "Marca la conversación como cerrada" },
  { type: "start_workflow", label: "Disparar otro flujo", description: "Inicia otro workflow por su nombre" },
  { type: "stop", label: "Terminar flujo", description: "Finaliza la ejecución" },
];

@Controller("workflows")
export class WorkflowsController {
  constructor(private prisma: PrismaService) {}

  @Get("meta/catalog")
  catalog() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [statuses, agents, members, teams, workflows] = await Promise.all([
        tx.leadStatus.findMany({ orderBy: { order: "asc" }, select: { code: true, name: true } }),
        tx.agent.findMany({ where: { deletedAt: null, active: true }, select: { slug: true, name: true } }),
        tx.organizationUser.findMany({ where: { active: true }, include: { user: { select: { id: true, name: true } } } }),
        tx.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
        tx.workflow.findMany({ where: { deletedAt: null }, select: { name: true }, orderBy: { name: "asc" } }),
      ]);
      return {
        triggers: TRIGGER_CATALOG,
        nodes: NODE_CATALOG,
        leadStatuses: statuses,
        agents,
        users: members.map((m) => ({ id: m.userId, name: m.user.name })),
        teams,
        workflows: workflows.map((w) => ({ name: w.name })),
      };
    });
  }

  @Get()
  list() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [workflows, runCounts, members] = await Promise.all([
        tx.workflow.findMany({
          where: { deletedAt: null },
          include: { versions: { orderBy: { version: "desc" } } },
          orderBy: { updatedAt: "desc" },
        }),
        tx.workflowRun.groupBy({ by: ["workflowId", "status"], _count: { _all: true } }),
        tx.organizationUser.findMany({ where: { active: true }, include: { user: true } }),
      ]);
      const nameOf = (userId?: string | null) =>
        userId ? members.find((m) => m.userId === userId)?.user.name ?? null : null;
      return workflows.map((w) => {
        const published = w.versions.find((v) => v.status === "PUBLISHED");
        const draft = w.versions.find((v) => v.status === "DRAFT" && (!published || v.version > published.version));
        const first = w.versions[w.versions.length - 1];
        const runs = runCounts.filter((r) => r.workflowId === w.id);
        // Estado de negocio: sin versión publicada = borrador; publicada + activa =
        // publicado; publicada pero inactiva = detenido (no procesa disparos).
        const status = !published ? "draft" : w.active ? "published" : "stopped";
        return {
          id: w.id,
          name: w.name,
          description: w.description,
          active: w.active,
          status,
          publishedVersion: published?.version ?? null,
          hasDraft: Boolean(draft),
          trigger: ((published ?? draft)?.definition as any)?.trigger?.type ?? null,
          runsTotal: runs.reduce((a, r) => a + r._count._all, 0),
          runsWaiting: runs.find((r) => r.status === "WAITING")?._count._all ?? 0,
          createdAt: w.createdAt,
          createdBy: nameOf(first?.createdById),
          updatedAt: w.updatedAt,
          publishedAt: published?.publishedAt ?? null,
          publishedBy: nameOf(published?.createdById),
        };
      });
    });
  }

  @Post()
  create(@Body() body: unknown) {
    const ctx = requirePermission("workflows:write");
    const input = parse(createSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await enforcePlanLimit(tx, "workflows", await tx.workflow.count({ where: { deletedAt: null } }));
      const workflow = await tx.workflow.create({
        data: { organizationId: ctx.organizationId, name: input.name, description: input.description, active: false },
      });
      await tx.workflowVersion.create({
        data: {
          organizationId: ctx.organizationId,
          workflowId: workflow.id,
          version: 1,
          status: "DRAFT",
          definition: {
            trigger: { type: "conversation_started", config: {} },
            variables: {},
            nodes: [{ id: "n1", type: "send_text", config: { text: "Hola {{contact.firstName}} 👋" } }],
            edges: [],
          },
          changelog: "Borrador inicial",
          createdById: ctx.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "workflow.create",
          entityType: "workflow",
          entityId: workflow.id,
        },
      });
      return workflow;
    });
  }

  /** Renombrar / editar descripción sin tocar la definición. */
  @Patch(":id")
  rename(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("workflows:write");
    const input = parse(
      z.object({ name: z.string().min(2).max(80).optional(), description: z.string().max(300).nullable().optional() }),
      body,
    );
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const wf = await tx.workflow.findFirst({ where: { id, deletedAt: null } });
      if (!wf) throw new NotFoundException("Flujo no encontrado");
      await tx.workflow.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "workflow.rename", entityType: "workflow", entityId: id },
      });
      return { ok: true };
    });
  }

  /** Duplica el flujo (última versión) como un borrador nuevo, inactivo. */
  @Post(":id/duplicate")
  duplicate(@Param("id") id: string) {
    const ctx = requirePermission("workflows:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const source = await tx.workflow.findFirst({ where: { id, deletedAt: null } });
      if (!source) throw new NotFoundException("Flujo no encontrado");
      await enforcePlanLimit(tx, "workflows", await tx.workflow.count({ where: { deletedAt: null } }));
      const latest = await tx.workflowVersion.findFirst({ where: { workflowId: id }, orderBy: { version: "desc" } });
      const copy = await tx.workflow.create({
        data: {
          organizationId: ctx.organizationId,
          name: `${source.name} (copia)`,
          description: source.description,
          active: false,
          templateKey: source.templateKey,
        },
      });
      await tx.workflowVersion.create({
        data: {
          organizationId: ctx.organizationId,
          workflowId: copy.id,
          version: 1,
          status: "DRAFT",
          definition: (latest?.definition ?? {
            trigger: { type: "conversation_started", config: {} },
            variables: {},
            nodes: [{ id: "n1", type: "send_text", config: { text: "Hola 👋" } }],
            edges: [],
          }) as object,
          changelog: "Duplicado",
          createdById: ctx.userId,
        },
      });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "workflow.duplicate", entityType: "workflow", entityId: copy.id, after: { from: id } },
      });
      return { id: copy.id };
    });
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const workflow = await tx.workflow.findFirst({
        where: { id, deletedAt: null },
        include: { versions: { orderBy: { version: "desc" }, take: 15 } },
      });
      if (!workflow) throw new NotFoundException("Flujo no encontrado");
      const published = workflow.versions.find((v) => v.status === "PUBLISHED");
      const draft = workflow.versions.find(
        (v) => v.status === "DRAFT" && (!published || v.version > published.version),
      );
      const editing = draft ?? published ?? workflow.versions[0];
      return {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        active: workflow.active,
        publishedVersion: published?.version ?? null,
        draftVersion: draft?.version ?? null,
        definition: editing?.definition ?? null,
        versions: workflow.versions.map((v) => ({
          version: v.version,
          status: v.status,
          publishedAt: v.publishedAt,
          createdAt: v.createdAt,
        })),
      };
    });
  }

  @Get(":id/runs")
  runs(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const runs = await tx.workflowRun.findMany({
        where: { workflowId: id },
        orderBy: { startedAt: "desc" },
        take: 25,
        include: { steps: { orderBy: { startedAt: "asc" } } },
      });
      return runs.map((r) => ({
        id: r.id,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        error: r.error,
        currentNodeId: r.currentNodeId,
        steps: r.steps.map((s) => ({ nodeId: s.nodeId, nodeType: s.nodeType, status: s.status, error: s.error })),
      }));
    });
  }

  @Put(":id/draft")
  saveDraft(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("workflows:write");
    const input = parse(draftSchema, body);
    const definition = workflowDefinitionSchema.safeParse(input.definition);
    if (!definition.success) {
      throw new BadRequestException(
        `Definición inválida: ${definition.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const workflow = await tx.workflow.findFirst({ where: { id, deletedAt: null } });
      if (!workflow) throw new NotFoundException("Flujo no encontrado");
      if (input.name || input.description !== undefined) {
        await tx.workflow.update({
          where: { id },
          data: {
            ...(input.name ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
          },
        });
      }
      const latest = await tx.workflowVersion.findFirst({ where: { workflowId: id }, orderBy: { version: "desc" } });
      const data = { definition: definition.data as object, createdById: ctx.userId };
      let version;
      if (latest && latest.status === "DRAFT") {
        version = await tx.workflowVersion.update({ where: { id: latest.id }, data });
      } else {
        version = await tx.workflowVersion.create({
          data: {
            organizationId: ctx.organizationId,
            workflowId: id,
            version: (latest?.version ?? 0) + 1,
            status: "DRAFT",
            ...data,
          },
        });
      }
      return { ok: true, draftVersion: version.version };
    });
  }

  @Post(":id/publish")
  publish(@Param("id") id: string) {
    const ctx = requirePermission("workflows:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const draft = await tx.workflowVersion.findFirst({
        where: { workflowId: id, status: "DRAFT" },
        orderBy: { version: "desc" },
      });
      if (!draft) throw new BadRequestException("No hay borrador para publicar");
      const published = await tx.workflowVersion.update({
        where: { id: draft.id },
        data: { status: "PUBLISHED", publishedAt: new Date() },
      });
      await tx.workflow.update({ where: { id }, data: { currentVersionId: published.id, active: true } });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "workflow.publish",
          entityType: "workflow",
          entityId: id,
          after: { version: published.version },
        },
      });
      return { ok: true, publishedVersion: published.version };
    });
  }

  @Post(":id/active")
  setActive(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("workflows:write");
    const input = parse(z.object({ active: z.boolean() }), body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.workflow.update({ where: { id }, data: { active: input.active } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: input.active ? "workflow.resume" : "workflow.stop", entityType: "workflow", entityId: id },
      });
      return { ok: true, active: input.active };
    });
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    const ctx = requirePermission("workflows:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.workflow.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "workflow.delete", entityType: "workflow", entityId: id },
      });
      return { ok: true };
    });
  }
}
