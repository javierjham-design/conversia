import { withTenant } from "@conversia/database";
import {
  executeFrom,
  findStartNode,
  matchesTrigger,
  resumeAfterWait,
  type EngineDeps,
  type RunCtx,
} from "@conversia/workflows";
import { workflowDefinitionSchema, type PlatformEvent, type WorkflowDefinition } from "@conversia/types";
import { runAgentTurn } from "./agent-turn";
import { getChannelProvider } from "./channel-providers";
import { emitPlatformEvent } from "./platform-events";

/** Implementación de efectos del motor sobre la plataforma real. */
function makeDeps(): EngineDeps {
  return {
    async sendText(ctx, text) {
      if (!ctx.conversationId) return;
      const data = await withTenant(ctx.organizationId, async (tx) => {
        const conversation = await tx.conversation.findUnique({
          where: { id: ctx.conversationId! },
          include: { contact: true },
        });
        if (!conversation?.contact.phone) return null;
        const message = await tx.message.create({
          data: {
            organizationId: ctx.organizationId,
            conversationId: ctx.conversationId!,
            direction: "OUTBOUND",
            type: "TEXT",
            body: text,
            authorType: "SYSTEM",
            status: "PENDING",
            payload: { workflowRunId: ctx.runId },
          },
        });
        await tx.conversation.update({
          where: { id: ctx.conversationId! },
          data: { lastMessageAt: new Date(), lastMessagePreview: text.slice(0, 120) },
        });
        return { message, phone: conversation.contact.phone, channelConnectionId: conversation.channelConnectionId };
      });
      if (!data) return;
      const sent = await getChannelProvider().send(`wf:${ctx.organizationId}`, {
        to: data.phone,
        type: "text",
        text,
      });
      await withTenant(ctx.organizationId, (tx) =>
        tx.message.update({
          where: { id: data.message.id },
          data: { status: "SENT", externalId: sent.externalId, sentAt: new Date() },
        }),
      );
    },

    async runAgent(ctx, agentSlug) {
      if (!ctx.conversationId) return;
      await runAgentTurn({ organizationId: ctx.organizationId, conversationId: ctx.conversationId, agentSlug });
    },

    async updateLeadStatus(ctx, statusCode) {
      if (!ctx.contactId) return;
      const fromCode = await withTenant(ctx.organizationId, async (tx) => {
        const status = await tx.leadStatus.findUnique({
          where: { organizationId_code: { organizationId: ctx.organizationId, code: statusCode } },
        });
        if (!status) return null;
        const lead = await tx.lead.findFirst({ where: { contactId: ctx.contactId! }, orderBy: { createdAt: "desc" }, include: { status: true } });
        const prev = lead?.status?.code ?? null;
        if (lead) {
          await tx.lead.update({ where: { id: lead.id }, data: { statusId: status.id } });
          await tx.leadEvent.create({
            data: { organizationId: ctx.organizationId, leadId: lead.id, type: "status_changed", data: { from: prev, to: statusCode }, actorType: "workflow", actorId: ctx.workflowId },
          });
        } else {
          await tx.lead.create({
            data: { organizationId: ctx.organizationId, contactId: ctx.contactId!, statusId: status.id },
          });
        }
        return prev;
      });
      const contact = await withTenant(ctx.organizationId, (tx) =>
        tx.contact.findUnique({ where: { id: ctx.contactId! }, select: { phone: true } }),
      );
      await emitPlatformEvent(
        ctx.organizationId,
        "lead.status_changed",
        { statusCode, contactId: ctx.contactId, conversationId: ctx.conversationId },
        { contactPhone: contact?.phone ?? null },
      );
      // Dispara workflows con trigger "Etapa del ciclo de vida" (origen→destino).
      await dispatchEvent({
        organizationId: ctx.organizationId,
        type: "lead_status_changed",
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        data: { statusCode, fromCode },
        occurredAt: new Date().toISOString(),
      });
    },

    async addTag(ctx, tagName) {
      await withTenant(ctx.organizationId, async (tx) => {
        const tag = await tx.tag.upsert({
          where: { organizationId_name: { organizationId: ctx.organizationId, name: tagName } },
          update: {},
          create: { organizationId: ctx.organizationId, name: tagName },
        });
        if (ctx.conversationId) {
          await tx.tagAssignment.upsert({
            where: {
              organizationId_tagId_entityType_entityId: {
                organizationId: ctx.organizationId,
                tagId: tag.id,
                entityType: "conversation",
                entityId: ctx.conversationId,
              },
            },
            update: {},
            create: {
              organizationId: ctx.organizationId,
              tagId: tag.id,
              entityType: "conversation",
              entityId: ctx.conversationId,
            },
          });
        }
      });
    },

    async transferHuman(ctx, reason) {
      if (!ctx.conversationId) return;
      await withTenant(ctx.organizationId, async (tx) => {
        await tx.conversation.update({ where: { id: ctx.conversationId! }, data: { aiEnabled: false } });
        await tx.humanHandoff.create({
          data: {
            organizationId: ctx.organizationId,
            conversationId: ctx.conversationId!,
            requestedBy: "rule",
            reason: reason ?? "workflow",
            status: "PENDING",
          },
        });
      });
    },

    async setAiEnabled(ctx, enabled) {
      if (!ctx.conversationId) return;
      await withTenant(ctx.organizationId, (tx) =>
        tx.conversation.update({ where: { id: ctx.conversationId! }, data: { aiEnabled: enabled } }),
      );
    },

    async closeConversation(ctx) {
      if (!ctx.conversationId) return;
      await withTenant(ctx.organizationId, (tx) =>
        tx.conversation.update({ where: { id: ctx.conversationId! }, data: { status: "CLOSED" } }),
      );
      await emitPlatformEvent(ctx.organizationId, "conversation.closed", { conversationId: ctx.conversationId });
    },

    async removeTag(ctx, tagName) {
      if (!ctx.conversationId || !tagName) return;
      await withTenant(ctx.organizationId, async (tx) => {
        const tag = await tx.tag.findUnique({
          where: { organizationId_name: { organizationId: ctx.organizationId, name: tagName } },
        });
        if (!tag) return;
        await tx.tagAssignment.deleteMany({
          where: { tagId: tag.id, entityType: "conversation", entityId: ctx.conversationId! },
        });
      });
    },

    async updateContact(ctx, fields) {
      if (!ctx.contactId) return;
      const data: Record<string, string> = {};
      for (const key of ["firstName", "lastName", "email"] as const) {
        const v = fields[key];
        if (typeof v === "string" && v.trim()) data[key] = v.trim();
      }
      if (Object.keys(data).length === 0) return;
      await withTenant(ctx.organizationId, (tx) => tx.contact.update({ where: { id: ctx.contactId! }, data }));
    },

    async assignUser(ctx, userId) {
      if (!ctx.conversationId || !userId) return;
      await withTenant(ctx.organizationId, async (tx) => {
        const member = await tx.organizationUser.findFirst({ where: { userId, active: true } });
        if (!member) return;
        await tx.conversation.update({
          where: { id: ctx.conversationId! },
          data: { assignedUserId: userId, aiEnabled: false },
        });
      });
    },

    async assignTeam(ctx, teamId) {
      if (!ctx.conversationId || !teamId) return;
      await withTenant(ctx.organizationId, async (tx) => {
        const team = await tx.team.findUnique({ where: { id: teamId } });
        if (!team) return;
        await tx.conversation.update({
          where: { id: ctx.conversationId! },
          data: { assignedTeamId: teamId, aiEnabled: false },
        });
      });
    },

    async switchAgent(ctx, agentSlug) {
      if (!ctx.conversationId || !agentSlug) return;
      await withTenant(ctx.organizationId, async (tx) => {
        const agent = await tx.agent.findUnique({
          where: { organizationId_slug: { organizationId: ctx.organizationId, slug: agentSlug } },
        });
        if (!agent || !agent.active) return;
        await tx.conversation.update({
          where: { id: ctx.conversationId! },
          data: { activeAgentId: agent.id, aiEnabled: true },
        });
      });
    },

    async startWorkflow(ctx, workflowName) {
      if (!workflowName) return;
      // Evita el auto-disparo del mismo flujo (loop directo).
      await startWorkflowByName(
        ctx.organizationId,
        workflowName,
        { conversationId: ctx.conversationId, contactId: ctx.contactId },
        { excludeWorkflowId: ctx.workflowId },
      );
    },

    async openConversation(ctx) {
      if (ctx.conversationId || !ctx.contactId) return; // ya hay una / sin contacto
      const convId = await withTenant(ctx.organizationId, async (tx) => {
        const existing = await tx.conversation.findFirst({
          where: { contactId: ctx.contactId!, status: { not: "CLOSED" } },
          orderBy: { lastMessageAt: "desc" },
        });
        if (existing) return existing.id;
        const channel = await tx.channelConnection.findFirst({ where: { status: "active" } });
        const created = await tx.conversation.create({
          data: {
            organizationId: ctx.organizationId,
            contactId: ctx.contactId!,
            channelConnectionId: channel?.id ?? null,
            activeAgentId: channel?.defaultAgentId ?? null,
            status: "OPEN",
          },
        });
        return created.id;
      });
      ctx.conversationId = convId; // los pasos siguientes escriben en esta conversación
    },

    async addNote(ctx, text) {
      if (!ctx.conversationId || !text.trim()) return;
      await withTenant(ctx.organizationId, (tx) =>
        tx.message.create({
          data: {
            organizationId: ctx.organizationId,
            conversationId: ctx.conversationId!,
            direction: "OUTBOUND",
            type: "NOTE",
            visibility: "INTERNAL",
            body: text,
            authorType: "SYSTEM",
            status: "DELIVERED",
          },
        }),
      );
    },

    async scheduleTimer(ctx, nodeId, dueAt, cancelOn) {
      await withTenant(ctx.organizationId, async (tx) => {
        await tx.scheduledJob.upsert({
          where: {
            organizationId_uniqueKey: {
              organizationId: ctx.organizationId,
              uniqueKey: `${ctx.runId}:${nodeId}`,
            },
          },
          update: { dueAt, status: "PENDING" },
          create: {
            organizationId: ctx.organizationId,
            kind: "workflow_timer",
            runId: ctx.runId,
            dueAt,
            uniqueKey: `${ctx.runId}:${nodeId}`,
            payload: {
              nodeId,
              conversationId: ctx.conversationId ?? null,
              contactId: ctx.contactId ?? null,
              cancelOn: cancelOn ?? null,
            },
          },
        });
        await tx.workflowRun.update({
          where: { id: ctx.runId },
          data: { status: "WAITING", currentNodeId: nodeId },
        });
      });
    },

    async evaluateCondition(ctx, config) {
      const kind = String(config.kind ?? "");
      if (kind === "no_reply" && ctx.conversationId) {
        return withTenant(ctx.organizationId, async (tx) => {
          const run = await tx.workflowRun.findUnique({ where: { id: ctx.runId } });
          const reply = await tx.message.findFirst({
            where: {
              conversationId: ctx.conversationId!,
              direction: "INBOUND",
              createdAt: { gt: run?.startedAt ?? new Date(0) },
            },
          });
          return reply === null; // true = NO respondió
        });
      }
      // Condición por defecto/desconocida: false (rama segura)
      return false;
    },

    async persistStep(ctx, step) {
      await withTenant(ctx.organizationId, (tx) =>
        tx.workflowRunStep.create({
          data: {
            organizationId: ctx.organizationId,
            runId: ctx.runId,
            nodeId: step.nodeId,
            nodeType: step.nodeType,
            status: step.status,
            output: (step.output ?? {}) as object,
            error: step.error,
            finishedAt: new Date(),
          },
        }),
      );
    },

    now: () => new Date(),
  };
}

const deps = makeDeps();

/** Despacha un evento de plataforma: inicia los workflows cuyo trigger coincide. */
export async function dispatchEvent(event: PlatformEvent): Promise<void> {
  const candidates = await withTenant(event.organizationId, (tx) =>
    tx.workflow.findMany({
      where: { active: true, deletedAt: null },
      include: { versions: { where: { status: "PUBLISHED" }, orderBy: { version: "desc" }, take: 1 } },
    }),
  );

  for (const wf of candidates) {
    const versionRow = wf.versions[0];
    if (!versionRow) continue;
    const parsed = workflowDefinitionSchema.safeParse(versionRow.definition);
    if (!parsed.success) continue;
    const def: WorkflowDefinition = parsed.data;
    if (!matchesTrigger(def, event)) continue;

    // Idempotencia: un run por workflow+conversación+tipo de evento
    const idempotencyKey = `${wf.id}:${event.conversationId ?? event.contactId ?? "global"}:${event.type}`;
    const run = await withTenant(event.organizationId, async (tx) => {
      const existing = await tx.workflowRun.findUnique({
        where: { organizationId_idempotencyKey: { organizationId: event.organizationId, idempotencyKey } },
      });
      if (existing) return null;
      return tx.workflowRun.create({
        data: {
          organizationId: event.organizationId,
          workflowId: wf.id,
          versionId: versionRow.id,
          status: "RUNNING",
          contactId: event.contactId,
          conversationId: event.conversationId,
          triggerEvent: (event.data ?? {}) as object,
          idempotencyKey,
          variables: {},
        },
      });
    });
    if (!run) continue;

    const ctx: RunCtx = {
      organizationId: event.organizationId,
      runId: run.id,
      workflowId: wf.id,
      versionId: versionRow.id,
      conversationId: event.conversationId,
      contactId: event.contactId,
      variables: await buildRunVars(event),
    };
    const start = findStartNode(def);
    if (!start) continue;
    const result = await executeFrom(deps, ctx, def, start.id);
    await finishRun(event.organizationId, run.id, result);
  }
}

/**
 * Dispara un workflow por su NOMBRE (usado por la tool triggerWorkflow del
 * agente). Crea el run y lo ejecuta desde el nodo inicial, sin depender del
 * matching de triggers por evento.
 */
export async function startWorkflowByName(
  organizationId: string,
  workflowName: string,
  target: { conversationId?: string; contactId?: string },
  opts: { excludeWorkflowId?: string } = {},
): Promise<{ ok: boolean; error?: string }> {
  const wf = await withTenant(organizationId, (tx) =>
    tx.workflow.findFirst({
      where: { active: true, deletedAt: null, name: workflowName },
      include: { versions: { where: { status: "PUBLISHED" }, orderBy: { version: "desc" }, take: 1 } },
    }),
  );
  if (!wf) return { ok: false, error: `No encontré un flujo activo llamado "${workflowName}"` };
  if (opts.excludeWorkflowId && wf.id === opts.excludeWorkflowId) {
    return { ok: false, error: "Un flujo no puede dispararse a sí mismo" };
  }
  const versionRow = wf.versions[0];
  if (!versionRow) return { ok: false, error: `El flujo "${workflowName}" no tiene versión publicada` };
  return runWorkflowVersion(organizationId, wf.id, versionRow.id, versionRow.definition, target);
}

/**
 * Dispara un workflow por su ID (atajo manual desde la bandeja). Ejecuta la
 * versión publicada del flujo activo sobre la conversación/contacto indicados.
 */
export async function startWorkflowById(
  organizationId: string,
  workflowId: string,
  target: { conversationId?: string; contactId?: string },
): Promise<{ ok: boolean; error?: string }> {
  const wf = await withTenant(organizationId, (tx) =>
    tx.workflow.findFirst({
      where: { id: workflowId, active: true, deletedAt: null },
      include: { versions: { where: { status: "PUBLISHED" }, orderBy: { version: "desc" }, take: 1 } },
    }),
  );
  if (!wf) return { ok: false, error: "Flujo no encontrado o inactivo" };
  const versionRow = wf.versions[0];
  if (!versionRow) return { ok: false, error: "El flujo no tiene versión publicada" };
  return runWorkflowVersion(organizationId, wf.id, versionRow.id, versionRow.definition, target);
}

/** Crea el run y ejecuta una versión ya resuelta de un workflow (uso manual). */
async function runWorkflowVersion(
  organizationId: string,
  workflowId: string,
  versionId: string,
  definition: unknown,
  target: { conversationId?: string; contactId?: string },
): Promise<{ ok: boolean; error?: string }> {
  const parsed = workflowDefinitionSchema.safeParse(definition);
  if (!parsed.success) return { ok: false, error: "La definición del flujo es inválida" };
  const def = parsed.data;
  const start = findStartNode(def);
  if (!start) return { ok: false, error: "El flujo no tiene nodo inicial" };

  const idempotencyKey = `manual:${workflowId}:${target.conversationId ?? target.contactId ?? "global"}:${Date.now()}`;
  const run = await withTenant(organizationId, (tx) =>
    tx.workflowRun.create({
      data: {
        organizationId,
        workflowId,
        versionId,
        status: "RUNNING",
        contactId: target.contactId,
        conversationId: target.conversationId,
        triggerEvent: { manual: true },
        idempotencyKey,
        variables: {},
      },
    }),
  );
  const ctx: RunCtx = {
    organizationId,
    runId: run.id,
    workflowId,
    versionId,
    conversationId: target.conversationId,
    contactId: target.contactId,
    variables: {},
  };
  const result = await executeFrom(deps, ctx, def, start.id);
  await finishRun(organizationId, run.id, result);
  return { ok: true };
}

/**
 * Programa recordatorios de cita: por cada workflow activo con trigger
 * "Recordatorio de cita" (appointment_upcoming), crea un scheduled_job a
 * (inicio − hoursBefore) que ejecutará ese flujo. Idempotente por (wf, cita).
 */
export async function scheduleAppointmentReminders(
  organizationId: string,
  appt: { id: string; start: string },
  target: { conversationId?: string; contactId?: string },
): Promise<void> {
  const startsAt = new Date(appt.start);
  await withTenant(organizationId, async (tx) => {
    const wfs = await tx.workflow.findMany({
      where: { active: true, deletedAt: null },
      include: { versions: { where: { status: "PUBLISHED" }, orderBy: { version: "desc" }, take: 1 } },
    });
    for (const wf of wfs) {
      const def = wf.versions[0]?.definition as any;
      if (def?.trigger?.type !== "appointment_upcoming") continue;
      const hoursBefore = Number(def.trigger.config?.hoursBefore ?? 24);
      const dueAt = new Date(startsAt.getTime() - hoursBefore * 3600 * 1000);
      if (dueAt.getTime() <= Date.now()) continue; // el recordatorio ya pasó
      await tx.scheduledJob.upsert({
        where: { organizationId_uniqueKey: { organizationId, uniqueKey: `apptreminder:${wf.id}:${appt.id}` } },
        update: { dueAt, status: "PENDING" },
        create: {
          organizationId,
          kind: "appointment_reminder",
          dueAt,
          uniqueKey: `apptreminder:${wf.id}:${appt.id}`,
          payload: { workflowId: wf.id, contactId: target.contactId ?? null, conversationId: target.conversationId ?? null, appointmentExternalId: appt.id },
        },
      });
    }
  });
}

/** Reanuda un run cuyo timer venció (invocado por el scheduler). */
export async function resumeRun(organizationId: string, runId: string, nodeId: string): Promise<void> {
  const data = await withTenant(organizationId, async (tx) => {
    const run = await tx.workflowRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== "WAITING") return null;
    const versionRow = await tx.workflowVersion.findUnique({ where: { id: run.versionId } });
    if (!versionRow) return null;
    await tx.workflowRun.update({ where: { id: runId }, data: { status: "RUNNING" } });
    return { run, versionRow };
  });
  if (!data) return;

  const parsed = workflowDefinitionSchema.safeParse(data.versionRow.definition);
  if (!parsed.success) return;

  const ctx: RunCtx = {
    organizationId,
    runId,
    workflowId: data.run.workflowId,
    versionId: data.run.versionId,
    conversationId: data.run.conversationId ?? undefined,
    contactId: data.run.contactId ?? undefined,
    variables: (data.run.variables as Record<string, string>) ?? {},
  };
  const result = await resumeAfterWait(deps, ctx, parsed.data, nodeId);
  await finishRun(organizationId, runId, result);
}

/** Cancela esperas (y sus runs) cuando el contacto responde. */
export async function cancelTimersOnReply(organizationId: string, conversationId: string): Promise<void> {
  await withTenant(organizationId, async (tx) => {
    const jobs = await tx.scheduledJob.findMany({
      where: { status: "PENDING", kind: "workflow_timer" },
    });
    const toCancel = jobs.filter((j) => {
      const p = j.payload as Record<string, unknown>;
      return p.conversationId === conversationId && p.cancelOn === "contact_reply";
    });
    for (const job of toCancel) {
      await tx.scheduledJob.update({ where: { id: job.id }, data: { status: "CANCELLED" } });
      if (job.runId) {
        await tx.workflowRun.update({
          where: { id: job.runId },
          data: { status: "CANCELLED", finishedAt: new Date() },
        });
      }
    }
  });
}

async function buildRunVars(event: PlatformEvent): Promise<Record<string, string>> {
  return withTenant(event.organizationId, async (tx) => {
    const vars: Record<string, string> = {};
    const org = await tx.organization.findUnique({ where: { id: event.organizationId } });
    if (org) vars["organization.name"] = org.name;
    const clinic = await tx.clinic.findFirst({ where: { active: true } });
    if (clinic) {
      vars["clinic.name"] = clinic.name;
      vars["clinic.address"] = clinic.address ?? "";
    }
    if (event.contactId) {
      const contact = await tx.contact.findUnique({ where: { id: event.contactId } });
      if (contact) vars["contact.firstName"] = contact.firstName ?? "";
    }
    return vars;
  });
}

async function finishRun(
  organizationId: string,
  runId: string,
  result: { status: string; nodeId?: string; error?: string },
): Promise<void> {
  if (result.status === "waiting") return; // scheduleTimer ya dejó el run en WAITING
  await withTenant(organizationId, (tx) =>
    tx.workflowRun.update({
      where: { id: runId },
      data: {
        status: result.status === "completed" ? "COMPLETED" : "FAILED",
        error: result.error,
        currentNodeId: result.nodeId,
        finishedAt: new Date(),
      },
    }),
  );
  await emitPlatformEvent(
    organizationId,
    result.status === "completed" ? "workflow.completed" : "workflow.failed",
    { runId, error: result.error ?? null },
  );
}
