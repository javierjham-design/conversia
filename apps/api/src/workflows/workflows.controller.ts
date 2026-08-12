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
import { getEnv } from "@conversia/config";
import { workflowDefinitionSchema, type WorkflowDefinition } from "@conversia/types";
import { validateWorkflowDefinition, type WorkflowValidationContext } from "@conversia/workflows";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { canUseFeature, enforcePlanLimit } from "../common/plan-limits";
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
      for (const n of nodes.filter((x) => x.type === "send_template")) {
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
