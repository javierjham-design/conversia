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
import { workflowDefinitionSchema } from "@conversia/types";
import { PrismaService } from "../prisma.service";
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
  { type: "message_received", label: "Cada mensaje recibido", description: "Cualquier mensaje entrante del contacto" },
  { type: "keyword", label: "Palabra clave", description: "El mensaje contiene una palabra/frase", config: ["keyword"] },
];

const NODE_CATALOG = [
  { type: "send_text", label: "Enviar mensaje", description: "Envía un texto (admite variables {{contact.firstName}}…)" },
  { type: "run_agent", label: "Ejecutar agente IA", description: "El agente elegido responde la conversación" },
  { type: "wait", label: "Esperar", description: "Pausa el flujo; opcionalmente se cancela si el contacto responde" },
  { type: "condition_no_reply", label: "¿Sigue sin responder?", description: "Si NO ha respondido continúa; si respondió, termina el flujo" },
  { type: "update_lead_status", label: "Cambiar estado del lead", description: "Actualiza el estado del lead del contacto" },
  { type: "add_tag", label: "Agregar etiqueta", description: "Etiqueta la conversación" },
  { type: "transfer_human", label: "Escalar a humano", description: "Pausa la IA y notifica al equipo" },
  { type: "close_conversation", label: "Cerrar conversación", description: "Marca la conversación como cerrada" },
  { type: "stop", label: "Terminar flujo", description: "Finaliza la ejecución" },
];

@Controller("workflows")
export class WorkflowsController {
  constructor(private prisma: PrismaService) {}

  @Get("meta/catalog")
  catalog() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [statuses, agents] = await Promise.all([
        tx.leadStatus.findMany({ orderBy: { order: "asc" }, select: { code: true, name: true } }),
        tx.agent.findMany({ where: { deletedAt: null, active: true }, select: { slug: true, name: true } }),
      ]);
      return { triggers: TRIGGER_CATALOG, nodes: NODE_CATALOG, leadStatuses: statuses, agents };
    });
  }

  @Get()
  list() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const workflows = await tx.workflow.findMany({
        where: { deletedAt: null },
        include: { versions: { orderBy: { version: "desc" }, take: 5 } },
        orderBy: { createdAt: "asc" },
      });
      const runCounts = await tx.workflowRun.groupBy({
        by: ["workflowId", "status"],
        _count: { _all: true },
      });
      return workflows.map((w) => {
        const published = w.versions.find((v) => v.status === "PUBLISHED");
        const draft = w.versions.find((v) => v.status === "DRAFT" && (!published || v.version > published.version));
        const runs = runCounts.filter((r) => r.workflowId === w.id);
        return {
          id: w.id,
          name: w.name,
          description: w.description,
          active: w.active,
          publishedVersion: published?.version ?? null,
          hasDraft: Boolean(draft),
          trigger: ((published ?? draft)?.definition as any)?.trigger?.type ?? null,
          runsTotal: runs.reduce((a, r) => a + r._count._all, 0),
          runsWaiting: runs.find((r) => r.status === "WAITING")?._count._all ?? 0,
        };
      });
    });
  }

  @Post()
  create(@Body() body: unknown) {
    const ctx = requirePermission("workflows:write");
    const input = parse(createSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
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
      return workflow;
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
      return { ok: true };
    });
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    const ctx = requirePermission("workflows:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.workflow.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
      return { ok: true };
    });
  }
}
