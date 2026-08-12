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
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { workflowDefinitionSchema, type WorkflowDefinition } from "@conversia/types";
import { validateWorkflowDefinition, type WorkflowValidationContext } from "@conversia/workflows";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { canUseFeature, enforcePlanLimit, getTemplatesEntitlement } from "../common/plan-limits";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";
import { simulateWorkflow, type SimNames } from "./workflow-sandbox";
import { stepWorkflowSim, type LiveSimState } from "./workflow-live-sim";

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
  { type: "message_received", label: "Mensaje recibido", description: "Cada mensaje entrante; admite condiciones (canal, palabras, contiene/exacto)", conditions: ["keywords", "channel", "firstMessage"] },
  { type: "conversation_closed", label: "Conversación cerrada", description: "Cuando se cierra la conversación (p. ej. encuesta post-atención)" },
  // Legado: reemplazado por «Mensaje recibido» con condiciones de palabra. Se
  // oculta del selector (hidden) pero sigue funcionando en flujos que ya lo usan.
  { type: "keyword", label: "Palabra clave (simple, legado)", description: "El mensaje contiene una palabra o frase. Usa «Mensaje recibido» en su lugar.", config: ["keyword"], hidden: true },
  { type: "click_to_chat", label: "Anuncios Click-to-Chat (Meta)", description: "El primer mensaje viene de un anuncio Click-to-WhatsApp", conditions: ["adId"] },
  { type: "lead_status_changed", label: "Etapa del ciclo de vida actualizada", description: "Cuando el lead cambia de etapa (origen → destino)", conditions: ["fromStatus", "toStatus"] },
  { type: "tag_added", label: "Etiqueta añadida", description: "Al etiquetar un contacto o conversación (panel, flujo, IA o Lead Ads)", conditions: ["tag"] },
  // Agenda (requieren una agenda conectada, p. ej. Cláriva, que emita los eventos):
  { type: "appointment_created", label: "Cita creada", description: "Al agendarse una cita para el contacto (agente o clínica)" },
  { type: "appointment_confirmed", label: "Cita confirmada", description: "Cuando el paciente/clínica confirma la cita" },
  { type: "appointment_rescheduled", label: "Cita reprogramada", description: "Al reprogramarse una cita — el recordatorio se re-agenda solo" },
  { type: "appointment_cancelled", label: "Cita cancelada", description: "Al cancelarse una cita — cancela el recordatorio pendiente" },
  { type: "appointment_upcoming", label: "Recordatorio de cita", description: "X horas antes de una cita; respeta el horario de atención", conditions: ["hoursBefore"] },
  { type: "manual", label: "Disparo manual", description: "Se ejecuta a mano desde la bandeja o la lista de contactos" },
  // Próximamente (estructura lista; falta la fuente del evento):
  { type: "missed_call", label: "Llamada perdida", description: "Llamada de WhatsApp no contestada (requiere eventos de llamada)", soon: true },
  { type: "tiktok_ad", label: "Anuncios de mensajería TikTok", description: "Mensaje desde un anuncio de TikTok (requiere canal TikTok)", soon: true },
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
  constructor(private prisma: PrismaService, private queues: QueueService) {}

  /** Reúne el contexto del tenant para validar referencias de un flujo. */
  private async buildValidationContext(tx: any): Promise<WorkflowValidationContext> {
    const [tags, agents, statuses, workflows] = await Promise.all([
      tx.tag.findMany({ select: { name: true } }),
      tx.agent.findMany({ where: { deletedAt: null, active: true }, select: { slug: true } }),
      tx.leadStatus.findMany({ where: { active: true }, select: { code: true } }),
      tx.workflow.findMany({ where: { deletedAt: null }, select: { name: true } }),
    ]);
    return {
      tags: tags.map((t: { name: string }) => t.name),
      agentSlugs: agents.map((a: { slug: string }) => a.slug),
      leadStatusCodes: statuses.map((s: { code: string }) => s.code),
      workflowNames: workflows.map((w: { name: string }) => w.name),
    };
  }

  /** Valida una definición (transversal) devolviendo TODOS los problemas. */
  @Post(":id/validate")
  validate(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const input = parse(z.object({ definition: z.unknown() }), body ?? {});
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const wf = await tx.workflow.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
      if (!wf) throw new NotFoundException("Flujo no encontrado");
      const parsed = workflowDefinitionSchema.safeParse(input.definition);
      if (!parsed.success) {
        return { ok: false, issues: [{ target: "trigger", code: "invalid_definition", message: "La estructura del flujo no es válida." }] };
      }
      const vctx = await this.buildValidationContext(tx);
      const issues = validateWorkflowDefinition(parsed.data as WorkflowDefinition, vctx);
      return { ok: issues.length === 0, issues };
    });
  }

  /** Disparo manual masivo: ejecuta un flujo publicado sobre varios contactos. */
  @Post(":id/run-bulk")
  async runBulk(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("workflows:write");
    const input = parse(z.object({ contactIds: z.array(z.string()).min(1).max(500) }), body);
    const info = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const wf = await tx.workflow.findFirst({
        where: { id, deletedAt: null, active: true },
        include: { versions: { where: { status: "PUBLISHED" }, take: 1 } },
      });
      if (!wf || wf.versions.length === 0) {
        throw new BadRequestException("El flujo no existe, no está activo o no tiene versión publicada");
      }
      const contacts = await tx.contact.findMany({ where: { id: { in: input.contactIds } }, select: { id: true } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "workflow.run_bulk", entityType: "workflow", entityId: id, after: { count: contacts.length } },
      });
      return contacts.map((c) => c.id);
    });
    for (const contactId of info) {
      await this.queues.events.add("emit", {
        organizationId: ctx.organizationId,
        type: "__manual_run__",
        contactId,
        data: { workflowId: id },
        occurredAt: new Date().toISOString(),
      });
    }
    return { ok: true, queued: info.length };
  }

  @Get("meta/catalog")
  catalog() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [statuses, agents, members, teams, workflows, templates] = await Promise.all([
        tx.leadStatus.findMany({ where: { active: true }, orderBy: { order: "asc" }, select: { code: true, name: true, emoji: true } }),
        tx.agent.findMany({ where: { deletedAt: null, active: true }, select: { slug: true, name: true } }),
        tx.organizationUser.findMany({ where: { active: true }, include: { user: { select: { id: true, name: true } } } }),
        tx.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
        tx.workflow.findMany({ where: { deletedAt: null }, select: { name: true }, orderBy: { name: "asc" } }),
        tx.whatsappTemplate.findMany({ where: { status: "APPROVED" }, select: { id: true, name: true, language: true }, orderBy: { name: "asc" } }),
      ]);
      // Opciones para los filtros de triggers de cita: se agregan de la proyección
      // local de citas (appointments.meta), que es lo que realmente dispara flujos.
      const appts = await tx.appointment.findMany({ select: { meta: true }, orderBy: { startsAt: "desc" }, take: 3000 });
      const dedup = (rows: Array<{ id: string; name: string }>) => {
        const m = new Map<string, string>();
        for (const r of rows) if (r.id && !m.has(r.id)) m.set(r.id, r.name || r.id);
        return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "es"));
      };
      const appointmentFilters = {
        services: dedup(appts.map((a) => ({ id: String((a.meta as any)?.serviceId ?? ""), name: String((a.meta as any)?.serviceName ?? "") }))),
        professionals: dedup(appts.map((a) => ({ id: String((a.meta as any)?.professionalId ?? ""), name: String((a.meta as any)?.professionalName ?? "") }))),
        clinics: dedup(appts.map((a) => ({ id: String((a.meta as any)?.clinicId ?? ""), name: String((a.meta as any)?.clinicName ?? "") }))),
      };
      const presetsConn = await tx.integrationConnection.findFirst({ where: { provider: "api_presets" } });
      const apiPresets = (((presetsConn?.config as any)?.presets ?? []) as any[]).map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl }));
      const ga4Conn = await tx.integrationConnection.findFirst({ where: { provider: "ga4" } });
      const googleConn = await tx.integrationConnection.findFirst({ where: { provider: "google" } });
      const tmplEnt = await getTemplatesEntitlement(tx);
      return {
        triggers: TRIGGER_CATALOG,
        nodes: NODE_CATALOG,
        leadStatuses: statuses,
        appointmentFilters,
        agents,
        users: members.map((m) => ({ id: m.userId, name: m.user.name })),
        teams,
        workflows: workflows.map((w) => ({ name: w.name })),
        templates,
        apiPresets,
        ga4Connected: Boolean(ga4Conn && ga4Conn.status !== "error"),
        googleConnected: Boolean(googleConn && googleConn.status !== "reauthorize"),
        // Mensajes de plantilla: el editor avisa en el paso «Enviar plantilla» si
        // no está incluido en el plan o el switch del tenant está apagado.
        templatesEnabled: tmplEnt.enabled,
        templatesPlanAllows: tmplEnt.planAllows,
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
      // Valida la versión PUBLICADA (si la hay) para avisar de flujos ya rotos.
      let publishedIssues: Awaited<ReturnType<typeof validateWorkflowDefinition>> = [];
      if (published?.definition) {
        const parsed = workflowDefinitionSchema.safeParse(published.definition);
        if (parsed.success) {
          publishedIssues = validateWorkflowDefinition(parsed.data as WorkflowDefinition, await this.buildValidationContext(tx));
        }
      }
      return {
        id: workflow.id,
        name: workflow.name,
        description: workflow.description,
        active: workflow.active,
        publishedVersion: published?.version ?? null,
        draftVersion: draft?.version ?? null,
        definition: editing?.definition ?? null,
        publishedIssues,
        versions: workflow.versions.map((v) => ({
          version: v.version,
          status: v.status,
          publishedAt: v.publishedAt,
          createdAt: v.createdAt,
        })),
      };
    });
  }

  /** Historial de ejecuciones del flujo con filtros (errores, fechas, contacto). */
  @Get(":id/runs")
  runs(@Param("id") id: string, @Query("status") status?: string, @Query("from") from?: string, @Query("to") to?: string, @Query("contactId") contactId?: string, @Query("take") take?: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const limit = Math.min(Math.max(Number(take) || 30, 1), 100);
      const where: any = { workflowId: id };
      if (status === "errors") where.status = "FAILED";
      else if (status && ["RUNNING", "WAITING", "COMPLETED", "FAILED", "CANCELLED"].includes(status)) where.status = status;
      if (contactId) where.contactId = contactId;
      const startedAt: any = {};
      if (from) startedAt.gte = new Date(from);
      if (to) startedAt.lte = new Date(`${to}T23:59:59`);
      if (from || to) where.startedAt = startedAt;

      const runs = await tx.workflowRun.findMany({
        where,
        orderBy: { startedAt: "desc" },
        take: limit + 1,
        include: { steps: { orderBy: { startedAt: "asc" }, select: { nodeId: true, nodeType: true, status: true } } },
      });
      const hasMore = runs.length > limit;
      const page = runs.slice(0, limit);
      // Nombres de contacto (batch) y etiqueta del disparador por versión.
      const contactIds = [...new Set(page.map((r) => r.contactId).filter(Boolean) as string[])];
      const versionIds = [...new Set(page.map((r) => r.versionId))];
      const [contacts, versions] = await Promise.all([
        contactIds.length ? tx.contact.findMany({ where: { id: { in: contactIds } }, select: { id: true, firstName: true, lastName: true, phone: true } }) : Promise.resolve([]),
        tx.workflowVersion.findMany({ where: { id: { in: versionIds } }, select: { id: true, definition: true } }),
      ]);
      const contactById = new Map(contacts.map((c) => [c.id, c]));
      const triggerByVersion = new Map(versions.map((v) => [v.id, String((v.definition as any)?.trigger?.type ?? "")]));
      return {
        runs: page.map((r) => {
          const c = r.contactId ? contactById.get(r.contactId) : null;
          const triggerType = triggerByVersion.get(r.versionId) ?? "";
          return {
            id: r.id,
            status: r.status,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
            error: r.error,
            currentNodeId: r.currentNodeId,
            contact: c ? { id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || "Contacto", phone: c.phone } : null,
            triggerType,
            triggerLabel: TRIGGER_CATALOG.find((t) => t.type === triggerType)?.label ?? triggerType,
            stepCount: r.steps.length,
            path: r.steps.map((s) => s.nodeId),
          };
        }),
        hasMore,
      };
    });
  }

  /** Detalle de una ejecución: recorrido + pasos + definición para dibujar en el canvas. */
  @Get(":id/runs/:runId")
  runDetail(@Param("id") id: string, @Param("runId") runId: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const run = await tx.workflowRun.findFirst({
        where: { id: runId, workflowId: id },
        include: { steps: { orderBy: { startedAt: "asc" } } },
      });
      if (!run) throw new NotFoundException("Ejecución no encontrada");
      const [version, contact] = await Promise.all([
        tx.workflowVersion.findUnique({ where: { id: run.versionId }, select: { definition: true, version: true } }),
        run.contactId ? tx.contact.findUnique({ where: { id: run.contactId }, select: { id: true, firstName: true, lastName: true, phone: true } }) : Promise.resolve(null),
      ]);
      const triggerType = String((version?.definition as any)?.trigger?.type ?? "");
      return {
        run: {
          id: run.id,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          durationMs: run.finishedAt ? run.finishedAt.getTime() - run.startedAt.getTime() : null,
          error: run.error,
          currentNodeId: run.currentNodeId,
          variables: run.variables,
          triggerEvent: run.triggerEvent,
          triggerType,
          triggerLabel: TRIGGER_CATALOG.find((t) => t.type === triggerType)?.label ?? triggerType,
        },
        contact: contact ? { id: contact.id, name: [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.phone || "Contacto", phone: contact.phone } : null,
        definition: version?.definition ?? null,
        version: version?.version ?? null,
        steps: run.steps.map((s) => ({
          nodeId: s.nodeId,
          nodeType: s.nodeType,
          status: s.status,
          attempt: s.attempt,
          error: s.error,
          startedAt: s.startedAt,
          finishedAt: s.finishedAt,
          durationMs: s.finishedAt ? s.finishedAt.getTime() - s.startedAt.getTime() : null,
          output: s.output,
        })),
        path: run.steps.map((s) => s.nodeId),
      };
    });
  }

  /** Métricas del flujo en el período: ejecuciones, tasa de finalización, dónde se cae, conversiones. */
  @Get(":id/metrics")
  metrics(@Param("id") id: string, @Query("days") days?: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const period = Math.min(Math.max(Number(days) || 30, 1), 365);
      const since = new Date(Date.now() - period * 24 * 3600 * 1000);
      const runs = await tx.workflowRun.findMany({
        where: { workflowId: id, startedAt: { gte: since } },
        select: { id: true, status: true, currentNodeId: true, startedAt: true, finishedAt: true },
      });
      const total = runs.length;
      const byStatus: Record<string, number> = { RUNNING: 0, WAITING: 0, COMPLETED: 0, FAILED: 0, CANCELLED: 0 };
      let durSum = 0, durN = 0;
      const dropoff = new Map<string, number>();
      for (const r of runs) {
        byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
        if (r.finishedAt) { durSum += r.finishedAt.getTime() - r.startedAt.getTime(); durN++; }
        if (r.status === "FAILED" && r.currentNodeId) dropoff.set(r.currentNodeId, (dropoff.get(r.currentNodeId) ?? 0) + 1);
      }
      const topDrop = [...dropoff.entries()].sort((a, b) => b[1] - a[1])[0];
      // Tipo del nodo de mayor caída (para etiquetarlo en la UI).
      let dropoffNodeType: string | null = null;
      if (topDrop) {
        const latest = await tx.workflowVersion.findFirst({ where: { workflowId: id }, orderBy: { version: "desc" }, select: { definition: true } });
        const nodes = ((latest?.definition as any)?.nodes ?? []) as { id: string; type: string }[];
        dropoffNodeType = nodes.find((n) => n.id === topDrop[0])?.type ?? null;
      }
      // Conversiones: ejecuciones que enviaron un evento CAPI (paso send_capi COMPLETED) en el período.
      const capiRuns = await tx.workflowRunStep.findMany({
        where: { nodeType: "send_capi", status: "COMPLETED", run: { workflowId: id, startedAt: { gte: since } } },
        select: { runId: true },
        distinct: ["runId"],
      });
      const finished = byStatus.COMPLETED + byStatus.FAILED + byStatus.CANCELLED;
      return {
        periodDays: period,
        total,
        byStatus,
        completionRate: finished > 0 ? Math.round((byStatus.COMPLETED / finished) * 100) : null,
        avgDurationMs: durN > 0 ? Math.round(durSum / durN) : null,
        dropoffNodeId: topDrop?.[0] ?? null,
        dropoffNodeType,
        dropoffCount: topDrop?.[1] ?? 0,
        conversions: capiRuns.length,
      };
    });
  }

  /**
   * Vista previa del reintento ANTES de ejecutar: qué hará y qué costará. Estima
   * (cota superior, recorriendo TODAS las ramas desde el paso que falló) cuántos
   * mensajes de plantilla podría enviar y el descuento estimado de la bolsa
   * (peso por categoría), contra el saldo actual. El reintento real pasa por las
   * MISMAS 6 condiciones del guard (mismo `deps` que una corrida normal).
   */
  @Get(":id/runs/:runId/retry-preview")
  async retryPreview(@Param("id") id: string, @Param("runId") runId: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const run = await tx.workflowRun.findFirst({ where: { id: runId, workflowId: id }, select: { status: true, currentNodeId: true, versionId: true } });
      if (!run) throw new NotFoundException("Ejecución no encontrada");
      const version = await tx.workflowVersion.findUnique({ where: { id: run.versionId }, select: { definition: true } });
      const def = (version?.definition ?? {}) as { nodes?: any[]; edges?: any[] };
      const nodes: any[] = Array.isArray(def.nodes) ? def.nodes : [];
      const edges: any[] = Array.isArray(def.edges) ? def.edges : [];
      const startNodeId = run.currentNodeId;
      const startNode = nodes.find((n) => n.id === startNodeId);

      // Nodos alcanzables desde el paso que falló (todas las ramas + saltos).
      const byId = new Map(nodes.map((n) => [n.id, n]));
      const adj = new Map<string, string[]>();
      for (const e of edges) { const arr = adj.get(e.from) ?? []; arr.push(e.to); adj.set(e.from, arr); }
      const seen = new Set<string>();
      const stack = startNodeId ? [startNodeId] : [];
      while (stack.length) {
        const nid = stack.pop()!;
        if (seen.has(nid)) continue;
        seen.add(nid);
        const n = byId.get(nid);
        if (!n) continue;
        for (const to of adj.get(nid) ?? []) stack.push(to);
        if (n.type === "goto" && n.config?.targetNodeId) stack.push(String(n.config.targetNodeId));
      }
      const tmplNodeIds = [...seen].filter((nid) => byId.get(nid)?.type === "send_template");

      // Pesos por categoría (platform_setting) + categoría real de cada plantilla.
      let weights = { utility: 1, authentication: 1, marketing: 1 };
      const wr = await this.prisma.admin.platformSetting.findUnique({ where: { key: "walletWeights" } });
      if (wr?.value) { try { const p = JSON.parse(wr.value); weights = { utility: Number(p.utility) || 1, authentication: Number(p.authentication) || 1, marketing: Number(p.marketing) || 1 }; } catch { /* default */ } }
      const weightFor = (cat?: string | null) => { const c = String(cat ?? "").toUpperCase(); return c === "MARKETING" ? weights.marketing : c === "AUTHENTICATION" ? weights.authentication : weights.utility; };

      const templates: { name: string; category: string; weight: number }[] = [];
      let estimatedDebit = 0;
      for (const nid of tmplNodeIds) {
        const templateId = String(byId.get(nid)?.config?.templateId ?? "");
        const tmpl = templateId ? await tx.whatsappTemplate.findUnique({ where: { id: templateId }, select: { name: true, category: true } }) : null;
        const w = weightFor(tmpl?.category);
        estimatedDebit += w;
        templates.push({ name: tmpl?.name ?? "(plantilla no encontrada)", category: tmpl?.category ?? "UTILITY", weight: w });
      }
      const wallet = await tx.messageWallet.findUnique({ where: { organizationId: ctx.organizationId }, select: { balance: true } });
      const walletBalance = wallet?.balance ?? 0;
      return {
        canRetry: run.status === "FAILED" && !!startNodeId,
        fromNodeType: startNode?.type ?? null,
        templateSends: tmplNodeIds.length,
        templates,
        estimatedDebit,
        walletBalance,
        wouldExceed: estimatedDebit > walletBalance,
      };
    });
  }

  /** Reintenta una ejecución fallida desde el paso que falló (ENVÍA cosas reales). */
  @Post(":id/runs/:runId/retry")
  async retryRun(@Param("id") id: string, @Param("runId") runId: string) {
    const ctx = requirePermission("workflows:write");
    const run = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.workflowRun.findFirst({ where: { id: runId, workflowId: id }, select: { id: true, status: true, currentNodeId: true } }),
    );
    if (!run) throw new NotFoundException("Ejecución no encontrada");
    if (run.status !== "FAILED") throw new BadRequestException("Solo se pueden reintentar ejecuciones con error.");
    if (!run.currentNodeId) throw new BadRequestException("No hay un paso donde reintentar.");
    // El reintento re-ejecuta con el MISMO `deps` que una corrida normal → los
    // envíos de plantilla pasan por chargeTemplateSend (las 6 condiciones).
    await this.queues.enqueueWorkflowRetry({ organizationId: ctx.organizationId, runId });
    return { ok: true };
  }

  /**
   * Modo prueba: recorre la definición ACTUAL (sin publicar) contra un contacto
   * ficticio y devuelve, paso a paso, qué haría cada nodo. No persiste nada ni
   * envía nada por los canales (sandbox).
   */
  @Post(":id/test")
  test(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("workflows:write");
    const input = parse(
      z.object({
        definition: z.unknown(),
        assumeNoReply: z.boolean().default(true),
        contact: z
          .object({ firstName: z.string().max(80).nullable().optional(), lastName: z.string().max(80).nullable().optional() })
          .optional(),
      }),
      body,
    );
    const definition = workflowDefinitionSchema.safeParse(input.definition);
    if (!definition.success) {
      throw new BadRequestException(`Definición inválida: ${definition.error.issues.map((i) => i.message).join("; ")}`);
    }
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const wf = await tx.workflow.findFirst({ where: { id, deletedAt: null } });
      if (!wf) throw new NotFoundException("Flujo no encontrado");
      const [org, clinic, statuses, agents, teams, members] = await Promise.all([
        tx.organization.findUnique({ where: { id: ctx.organizationId } }),
        tx.clinic.findFirst({ where: { active: true, deletedAt: null } }),
        tx.leadStatus.findMany({ select: { code: true, name: true } }),
        tx.agent.findMany({ where: { deletedAt: null }, select: { slug: true, name: true } }),
        tx.team.findMany({ select: { id: true, name: true } }),
        tx.organizationUser.findMany({ where: { active: true }, include: { user: { select: { id: true, name: true } } } }),
      ]);
      const names: SimNames = {
        leadStatus: Object.fromEntries(statuses.map((s) => [s.code, s.name])),
        agent: Object.fromEntries(agents.map((a) => [a.slug, a.name])),
        team: Object.fromEntries(teams.map((t) => [t.id, t.name])),
        user: Object.fromEntries(members.map((m) => [m.userId, m.user.name])),
      };
      const vars: Record<string, string> = {
        "organization.name": org?.name ?? "",
        "clinic.name": clinic?.name ?? "",
        "clinic.city": clinic?.city ?? "",
        "clinic.address": clinic?.address ?? "",
        "contact.firstName": input.contact?.firstName || "Prueba",
      };
      const trace = simulateWorkflow(definition.data, { vars, names, assumeNoReply: input.assumeNoReply ?? true });
      return { ok: true, trace };
    });
  }

  /**
   * Simulador INTERACTIVO del flujo: ejecuta el motor real y la IA real, un paso
   * por llamada. El estado viaja de ida y vuelta (sin sesión en servidor).
   * action = start | advance (adelantar espera/timeout) | reply (respuesta del
   * contacto). NO envía WhatsApp ni escribe en la BD (solo cuenta tokens IA).
   */
  @Post(":id/test/live")
  async testLive(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("workflows:write");
    const input = parse(
      z.object({
        definition: z.unknown(),
        contact: z.object({ firstName: z.string().max(80).nullable().optional() }).optional(),
        state: z.unknown().optional(),
        action: z.object({ type: z.enum(["start", "advance", "reply"]), text: z.string().max(2000).optional() }),
      }),
      body,
    );
    const definition = workflowDefinitionSchema.safeParse(input.definition);
    if (!definition.success) {
      throw new BadRequestException(`Definición inválida: ${definition.error.issues.map((i) => i.message).join("; ")}`);
    }
    // El flujo debe existir y pertenecer al tenant (aunque el probador usa la
    // definición del borrador que llega en el cuerpo, no la publicada).
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const wf = await tx.workflow.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
      if (!wf) throw new NotFoundException("Flujo no encontrado");
    });
    const state = await stepWorkflowSim(ctx.organizationId, definition.data, {
      contact: input.contact,
      state: (input.state as LiveSimState | undefined) ?? null,
      action: input.action,
    });
    return { ok: true, state };
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
      // Validación transversal: campos requeridos, referencias rotas, nodos sin
      // conectar… Bloquea la publicación y devuelve los problemas por nodo.
      const parsedDef = workflowDefinitionSchema.safeParse(draft.definition);
      if (!parsedDef.success) throw new BadRequestException("La estructura del flujo no es válida.");
      const structuralIssues = validateWorkflowDefinition(parsedDef.data as WorkflowDefinition, await this.buildValidationContext(tx));
      if (structuralIssues.length > 0) {
        throw new BadRequestException({
          message: "El flujo tiene problemas que impiden publicarlo. Revisa los pasos marcados.",
          code: "workflow_invalid",
          issues: structuralIssues,
        });
      }
      // Gating por plan: la "Petición HTTP" (call_api) es un paso premium.
      const nodes = ((draft.definition as any)?.nodes ?? []) as { type?: string; config?: Record<string, unknown> }[];
      if (nodes.some((n) => n.type === "call_api") && !(await canUseFeature(tx, "http_step"))) {
        throw new BadRequestException("El paso «Petición HTTP» requiere un plan superior. Actualiza tu plan para publicar este flujo.");
      }
      // Requisitos de integraciones: no publicar pasos que no pueden ejecutarse.
      // Mensajes de plantilla: requiere que el plan lo incluya Y que el switch del
      // tenant esté encendido (lo activa el Super Admin). Igual que una integración
      // no conectada: se bloquea la publicación, no se falla en silencio al enviar.
      const tmplNodes = nodes.filter((x) => x.type === "send_template");
      if (tmplNodes.length > 0) {
        const ent = await getTemplatesEntitlement(tx);
        if (!ent.planAllows) {
          throw new BadRequestException(
            "El paso «Enviar plantilla WhatsApp» no está incluido en tu plan. Sube de plan para publicar este flujo.",
          );
        }
        if (!ent.switchOn) {
          throw new BadRequestException(
            "El paso «Enviar plantilla WhatsApp» requiere activar los mensajes de plantilla en tu cuenta. Contáctanos para habilitarlos.",
          );
        }
      }
      for (const n of tmplNodes) {
        const templateId = String((n.config as any)?.templateId ?? "");
        if (!templateId) {
          throw new BadRequestException("El paso «Enviar plantilla WhatsApp» no tiene plantilla elegida. Selecciónala en el panel del paso.");
        }
        const template = await tx.whatsappTemplate.findUnique({ where: { id: templateId } });
        if (!template || template.status !== "APPROVED") {
          throw new BadRequestException(
            "La plantilla del paso «Enviar plantilla WhatsApp» no existe o no está aprobada por Meta. Sincroniza las plantillas en Canales → Plantillas.",
          );
        }
      }
      if (nodes.some((n) => n.type === "send_capi")) {
        const mapping = await tx.metaEventMapping.findUnique({ where: { organizationId: ctx.organizationId } });
        if (!mapping?.datasetId || !mapping.active) {
          throw new BadRequestException(
            "El paso «Enviar evento CAPI» requiere conectar Conversions API (dataset) en Integraciones → Centro Meta antes de publicar.",
          );
        }
      }
      if (nodes.some((n) => n.type === "send_ga4_event")) {
        const ga4 = await tx.integrationConnection.findUnique({
          where: { organizationId_provider: { organizationId: ctx.organizationId, provider: "ga4" } },
        });
        if (!ga4 || ga4.status === "error") {
          throw new BadRequestException(
            "El paso «Enviar evento GA4» requiere conectar Google Analytics en Integraciones antes de publicar.",
          );
        }
      }
      for (const n of nodes.filter((x) => x.type === "google_sheets_append")) {
        const cfg = (n.config ?? {}) as Record<string, unknown>;
        if (!cfg.spreadsheetId || !(Array.isArray(cfg.values) && (cfg.values as unknown[]).length)) {
          throw new BadRequestException("El paso «Agregar fila a Google Sheets» necesita el ID de la planilla y al menos una columna.");
        }
        const google = await tx.integrationConnection.findUnique({
          where: { organizationId_provider: { organizationId: ctx.organizationId, provider: "google" } },
        });
        if (!google || google.status === "reauthorize") {
          throw new BadRequestException(
            "El paso «Agregar fila a Google Sheets» requiere conectar Google en Integraciones antes de publicar.",
          );
        }
      }
      for (const n of nodes.filter((x) => x.type === "send_internal_email")) {
        const cfg = (n.config ?? {}) as Record<string, unknown>;
        const to = Array.isArray(cfg.to) ? (cfg.to as string[]) : [];
        if (!to.length || !cfg.subject) {
          throw new BadRequestException("El paso «Enviar correo interno» necesita destinatarios y asunto.");
        }
        const emailConn = await tx.integrationConnection.findUnique({
          where: { organizationId_provider: { organizationId: ctx.organizationId, provider: "email" } },
        });
        if (!emailConn && !getEnv().RESEND_API_KEY) {
          throw new BadRequestException(
            "El paso «Enviar correo interno» requiere conectar Correo electrónico en Integraciones antes de publicar.",
          );
        }
      }
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
