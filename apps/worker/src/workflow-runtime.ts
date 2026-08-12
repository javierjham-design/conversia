import { withTenant } from "@conversia/database";
import {
  executeFrom,
  findStartNode,
  matchesApptFilter,
  matchesTrigger,
  resumeAfterWait,
  resumeWithBranch,
  type EngineDeps,
  type RunCtx,
} from "@conversia/workflows";
import { workflowDefinitionSchema, type PlatformEvent, type WorkflowDefinition } from "@conversia/types";
import { isOrgOperational } from "./billing-dunning";
import { createAIRouter } from "@conversia/agents";
import { getEnv } from "@conversia/config";
import { runAgentTurn } from "./agent-turn";
import { ChannelAuthError, ChannelConfigError, markChannelAuthError, markChannelConfigError, resolveChannelAuth } from "./channel-auth";
import { callHttp, type HttpNodeConfig } from "./http-node";
import { getChannelProvider } from "./channel-providers";
import { resolveApiPreset } from "./api-presets";
import { ga4ClientId, getSyncQueue } from "./ga4";
import { enqueueEscalationEmail, getEmailQueue } from "./mailer";
import { renderTemplateBody, resolveTemplateParams } from "./template-params";
import { chargeTemplateSend } from "./messaging-guard";
import { emitPlatformEvent, enqueueCapiEvent } from "./platform-events";
import { planAppointmentReminder, type BusinessHoursConfig } from "./appointment-reminders";

/**
 * Abre (o reutiliza la abierta más reciente) una conversación para el contacto.
 * Usado por el paso "Abrir conversación" y por "Enviar plantilla" (para que un
 * recordatorio de cita externa, sin conversación previa y fuera de la ventana de
 * 24 h, tenga dónde enviarse). Devuelve el id o null si no se pudo.
 */
async function ensureConversationForContact(organizationId: string, contactId: string): Promise<string | null> {
  return withTenant(organizationId, async (tx) => {
    // Con historial: reutiliza la conversación abierta → sale por el MISMO número
    // con el que el contacto ya habló.
    const existing = await tx.conversation.findFirst({
      where: { contactId, status: { not: "CLOSED" } },
      orderBy: { lastMessageAt: "desc" },
    });
    if (existing) return existing.id;
    // Sin historial (caso común de cita nacida en Cláriva): sale por el número por
    // defecto que fijó el tenant en Configuración; si no configuró, el primero activo.
    const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
    const defaultId = ((org?.settings as any)?.messaging?.defaultReminderChannelId as string | undefined) ?? null;
    let channel = defaultId ? await tx.channelConnection.findFirst({ where: { id: defaultId, status: "active" } }) : null;
    if (!channel) channel = await tx.channelConnection.findFirst({ where: { status: "active" } });
    const created = await tx.conversation.create({
      data: {
        organizationId,
        contactId,
        channelConnectionId: channel?.id ?? null,
        activeAgentId: channel?.defaultAgentId ?? null,
        status: "OPEN",
      },
    });
    return created.id;
  });
}

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
      // Número + token reales del canal de la conversación (antes se enviaba
      // con un id sintético "wf:<org>" que solo funcionaba en mock).
      const auth = await resolveChannelAuth(ctx.organizationId, { channelConnectionId: data.channelConnectionId });
      try {
        const sent = await getChannelProvider().send(auth.phoneNumberId, {
          to: data.phone,
          type: "text",
          text,
        }, { accessToken: auth.accessToken });
        await withTenant(ctx.organizationId, (tx) =>
          tx.message.update({
            where: { id: data.message.id },
            data: { status: "SENT", externalId: sent.externalId, sentAt: new Date() },
          }),
        );
      } catch (err) {
        await withTenant(ctx.organizationId, (tx) =>
          tx.message.update({
            where: { id: data.message.id },
            data: { status: "FAILED", error: (err as Error).message.slice(0, 500) },
          }),
        );
        if (err instanceof ChannelAuthError) {
          await markChannelAuthError(ctx.organizationId, auth.channelConnectionId, err.message);
          return; // el flujo continúa; el mensaje quedó FAILED y el canal marcado
        }
        throw err;
      }
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
      const created = await withTenant(ctx.organizationId, async (tx) => {
        const tag = await tx.tag.upsert({
          where: { organizationId_name: { organizationId: ctx.organizationId, name: tagName } },
          update: {},
          create: { organizationId: ctx.organizationId, name: tagName },
        });
        if (!ctx.conversationId) return false;
        const existing = await tx.tagAssignment.findUnique({
          where: {
            organizationId_tagId_entityType_entityId: {
              organizationId: ctx.organizationId,
              tagId: tag.id,
              entityType: "conversation",
              entityId: ctx.conversationId,
            },
          },
        });
        if (existing) return false;
        await tx.tagAssignment.create({
          data: {
            organizationId: ctx.organizationId,
            tagId: tag.id,
            entityType: "conversation",
            entityId: ctx.conversationId,
          },
        });
        return true;
      });
      // Solo una asignación NUEVA dispara tag_added: re-etiquetar es no-op y
      // corta bucles entre flujos que se etiquetan mutuamente.
      if (created) {
        await emitPlatformEvent(ctx.organizationId, "tag.added", { tag: tagName, conversationId: ctx.conversationId, contactId: ctx.contactId });
        await dispatchEvent({
          organizationId: ctx.organizationId,
          type: "tag_added",
          conversationId: ctx.conversationId,
          contactId: ctx.contactId,
          data: { tag: tagName },
          occurredAt: new Date().toISOString(),
        });
      }
    },

    async transferHuman(ctx, reason) {
      if (!ctx.conversationId) return;
      const handoff = await withTenant(ctx.organizationId, async (tx) => {
        await tx.conversation.update({ where: { id: ctx.conversationId! }, data: { aiEnabled: false } });
        return tx.humanHandoff.create({
          data: {
            organizationId: ctx.organizationId,
            conversationId: ctx.conversationId!,
            requestedBy: "rule",
            reason: reason ?? "workflow",
            status: "PENDING",
          },
        });
      });
      // Aviso por correo si nadie toma la conversación en X min (config del tenant).
      await enqueueEscalationEmail(ctx.organizationId, handoff.id, ctx.conversationId);
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
      const { enqueueHubspotContact } = await import("./hubspot.js");
      await enqueueHubspotContact(ctx.organizationId, ctx.contactId);
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
      const convId = await ensureConversationForContact(ctx.organizationId, ctx.contactId);
      if (convId) ctx.conversationId = convId; // los pasos siguientes escriben aquí
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

    async sendCapiEvent(ctx, config) {
      // Lee el ctwa_clid + teléfono del contacto y encola el evento (reintentos
      // vía BullMQ; si Meta falla, se reintenta sin bloquear el flujo).
      const contact = ctx.contactId
        ? await withTenant(ctx.organizationId, (tx) =>
            tx.contact.findUnique({ where: { id: ctx.contactId! }, select: { phone: true, ctwaClid: true } }),
          )
        : null;
      // El ctwa_clid vive en su columna estructurada (lo captura el inbound al
      // crear/actualizar el contacto desde el referral CTWA).
      const ctwaClid = contact?.ctwaClid ?? undefined;
      await enqueueCapiEvent({
        organizationId: ctx.organizationId,
        source: "workflow",
        occurredAt: new Date().toISOString(),
        contactPhone: contact?.phone ?? null,
        eventName: config.eventName,
        value: config.value ?? null,
        currency: config.currency ?? null,
        ctwaClid: ctwaClid ?? null,
      });
    },

    async sendTemplate(ctx, cfg) {
      // Fuera de la ventana de 24 h una cita puede no tener conversación abierta
      // (agendada hace días / creada por la clínica). Abrimos/reutilizamos una
      // para poder enviar la plantilla HSM.
      if (!ctx.conversationId && ctx.contactId) {
        const convId = await ensureConversationForContact(ctx.organizationId, ctx.contactId);
        if (convId) ctx.conversationId = convId;
      }
      if (!ctx.conversationId) return;
      const templateId = String(cfg.templateId ?? "");
      const data = await withTenant(ctx.organizationId, async (tx) => {
        const conversation = await tx.conversation.findUnique({
          where: { id: ctx.conversationId! },
          include: { contact: true },
        });
        if (!conversation?.contact.phone) return null;
        const template = await tx.whatsappTemplate.findUnique({ where: { id: templateId } });
        return { conversation, template };
      });
      if (!data) return;
      if (!data.template) throw new Error("Plantilla no encontrada — sincroniza las plantillas del canal");
      if (data.template.status !== "APPROVED") {
        throw new Error(`La plantilla «${data.template.name}» no está aprobada por Meta (estado: ${data.template.status})`);
      }
      const body = (data.template.body as Record<string, any>) ?? {};
      const fields: string[] = Array.isArray(body.variableFields) ? body.variableFields : [];
      const params = await resolveTemplateParams(ctx.organizationId, data.conversation.contactId, fields);
      const rendered = renderTemplateBody(body.components ?? [], params);

      const message = await withTenant(ctx.organizationId, async (tx) => {
        const msg = await tx.message.create({
          data: {
            organizationId: ctx.organizationId,
            conversationId: ctx.conversationId!,
            direction: "OUTBOUND",
            type: "TEMPLATE",
            body: rendered || `[plantilla ${data.template!.name}]`,
            authorType: "SYSTEM",
            status: "PENDING",
            payload: { templateId, workflowRunId: ctx.runId },
          },
        });
        await tx.conversation.update({
          where: { id: ctx.conversationId! },
          data: { lastMessageAt: new Date(), lastMessagePreview: (rendered || data.template!.name).slice(0, 120) },
        });
        return msg;
      });

      // Bolsa + fusible/topes de exposición financiera: solo plantillas (las que cuestan).
      const gate = await chargeTemplateSend(ctx.organizationId, message.id, (data.template as any)?.category);
      if (gate.blocked) {
        await withTenant(ctx.organizationId, async (tx) => {
          await tx.message.update({ where: { id: message.id }, data: { status: "FAILED", error: gate.userMessage } });
          await tx.message.create({
            data: {
              organizationId: ctx.organizationId,
              conversationId: ctx.conversationId!,
              direction: "OUTBOUND",
              type: "SYSTEM",
              body: `⚠ Envío no realizado: ${gate.userMessage}`,
              authorType: "SYSTEM",
              status: "SENT",
              visibility: "PUBLIC",
            },
          });
          // Traza para el Super Admin (panel "últimos rechazados"): qué condición bloqueó.
          await tx.integrationEvent.create({
            data: {
              organizationId: ctx.organizationId,
              provider: "messaging",
              type: "template.blocked",
              status: "warning",
              message: gate.userMessage,
              payload: { reason: gate.reason, conversationId: ctx.conversationId, messageId: message.id },
            },
          });
        });
        return; // no se envía ni se reintenta
      }

      const auth = await resolveChannelAuth(ctx.organizationId, { channelConnectionId: data.conversation.channelConnectionId });
      try {
        const sent = await getChannelProvider().send(auth.phoneNumberId, {
          to: data.conversation.contact.phone!,
          type: "template",
          templateName: data.template.name,
          templateLanguage: data.template.language,
          templateParams: params,
        }, { accessToken: auth.accessToken });
        await withTenant(ctx.organizationId, (tx) =>
          tx.message.update({ where: { id: message.id }, data: { status: "SENT", externalId: sent.externalId, sentAt: new Date() } }),
        );
      } catch (err) {
        const failText = err instanceof ChannelConfigError ? err.userMessage : (err as Error).message.slice(0, 500);
        await withTenant(ctx.organizationId, (tx) =>
          tx.message.update({ where: { id: message.id }, data: { status: "FAILED", error: failText } }),
        );
        if (err instanceof ChannelAuthError) {
          await markChannelAuthError(ctx.organizationId, auth.channelConnectionId, err.message);
          return;
        }
        if (err instanceof ChannelConfigError) {
          await markChannelConfigError(ctx.organizationId, auth.channelConnectionId, err.userMessage);
          return;
        }
        throw err;
      }
    },

    async sendInternalEmail(ctx, config) {
      // Correo interno al EQUIPO — nunca a contactos. Cola con reintentos.
      const to = config.to.filter((e) => /.+@.+\..+/.test(e)).slice(0, 10);
      if (!to.length || !config.subject) return;
      await getEmailQueue().add(
        "workflow",
        {
          organizationId: ctx.organizationId,
          kind: "workflow",
          to,
          subject: config.subject,
          html: `<p>${config.body.replace(/\n/g, "<br/>")}</p><p style="color:#94a3b8;font-size:12px">Enviado por un flujo de TuBot</p>`,
        },
        { attempts: 4, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000 },
      );
    },

    async sendGa4Event(ctx, config) {
      if (!config.eventName) return;
      const contact = ctx.contactId
        ? await withTenant(ctx.organizationId, (tx) => tx.contact.findUnique({ where: { id: ctx.contactId! }, select: { phone: true } }))
        : null;
      await getSyncQueue().add(
        "ga4",
        {
          organizationId: ctx.organizationId,
          kind: "ga4_event",
          payload: {
            name: config.eventName,
            params: { ...config.params, source: "workflow" },
            clientId: ga4ClientId(ctx.organizationId, contact?.phone ?? ctx.contactId ?? null),
          },
        },
        { attempts: 4, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000 },
      );
    },

    async appendGoogleSheetRow(ctx, config) {
      if (!config.spreadsheetId || !config.values.length) return;
      await getSyncQueue().add(
        "sheets",
        {
          organizationId: ctx.organizationId,
          kind: "sheets_append",
          payload: { spreadsheetId: config.spreadsheetId, sheetName: config.sheetName, values: config.values },
        },
        { attempts: 5, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000 },
      );
    },

    async runAgentWithObjective(ctx, nodeId, cfg) {
      const agentSlug = String(cfg.agentSlug ?? "");
      const objective = String(cfg.objective ?? "");
      if (!ctx.conversationId) return "unmet";
      // 1) El agente responde con el objetivo inyectado en su prompt.
      await runAgentTurn({
        organizationId: ctx.organizationId,
        conversationId: ctx.conversationId,
        agentSlug: agentSlug || undefined,
        objective,
      });
      if (!objective.trim()) return "unmet";
      // 2) Evalúa si el objetivo ya se cumplió en este primer turno.
      if (await evaluateObjective(ctx.organizationId, ctx.conversationId, objective)) return "met";
      // 3) Multi-turno: deja el objetivo pendiente en la conversación; cada
      //    respuesta del contacto re-corre agente + evaluación (inbound) y el
      //    run espera con timeout (rama "unmet" si nadie lo resuelve).
      const maxTurns = Math.max(1, Number(cfg.maxTurns ?? 1));
      if (maxTurns <= 1) return "unmet"; // v1: un solo turno
      await withTenant(ctx.organizationId, async (tx) => {
        const conv = await tx.conversation.findUnique({ where: { id: ctx.conversationId! }, select: { meta: true } });
        const meta = (conv?.meta as Record<string, unknown>) ?? {};
        await tx.conversation.update({
          where: { id: ctx.conversationId! },
          data: { meta: { ...meta, aiObjective: { runId: ctx.runId, nodeId, objective, agentSlug, turnsLeft: maxTurns - 1 } } as object },
        });
      });
      return "pending";
    },

    async callApi(ctx, config) {
      // Preset de API del tenant (tarjeta "API personalizada"): base URL + auth
      // con secreto cifrado + allowlist — el nodo solo aporta la ruta relativa.
      let effective = { ...(config as HttpNodeConfig) };
      const presetId = String((config as any).presetId ?? "");
      if (presetId) {
        const resolved = await resolveApiPreset(ctx.organizationId, presetId);
        if (!resolved) throw new Error("El preset de API del paso ya no existe — revísalo en Integraciones → API personalizada");
        const path = String((config as any).path ?? (config as any).url ?? "");
        effective = {
          ...effective,
          url: resolved.baseUrl.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`),
          headers: { ...(resolved.headers ?? {}), ...(effective.headers ?? {}) },
          allowlist: resolved.allowlist,
        };
      }
      // Guard SSRF + timeout dentro de callHttp; el resultado (incluye
      // __http_ok/__http_status y el mapeo JSON) queda disponible para los pasos.
      const result = await callHttp(effective, ctx.variables);
      Object.assign(ctx.variables, result);
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

    async getBusinessHoursDefault(ctx) {
      const org = await withTenant(ctx.organizationId, (tx) =>
        tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { timezone: true, settings: true } }),
      );
      const bh = ((org?.settings ?? {}) as Record<string, any>).businessHours;
      if (!bh?.hours) return null;
      return { hours: bh.hours, holidays: bh.holidays ?? [], timezone: org?.timezone ?? "America/Santiago" };
    },
  };
}

const deps = makeDeps();

/** Despacha un evento de plataforma: inicia los workflows cuyo trigger coincide. */
export async function dispatchEvent(event: PlatformEvent): Promise<void> {
  // Suspensión por impago: si la organización no opera, los flujos se detienen
  // (no se inician nuevos runs). Los datos y las definiciones quedan intactos.
  const org = await withTenant(event.organizationId, (tx) =>
    tx.organization.findUnique({ where: { id: event.organizationId }, select: { status: true } }),
  );
  if (!isOrgOperational(org?.status)) return;

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
 * Reintenta una ejecución FALLIDA desde el paso que falló (`currentNodeId`).
 * Vuelve a ejecutar con efectos REALES (envía, agenda, etc.). Idempotencia por
 * paso `(runId, nodeId, attempt)` como en cualquier ejecución.
 */
// Usa el MISMO `deps` (makeDeps) que dispatchEvent/runWorkflowVersion, así los
// envíos de plantilla del reintento pasan por chargeTemplateSend (las 6
// condiciones del guard): no hay camino paralelo.
export async function retryRun(organizationId: string, runId: string): Promise<void> {
  const data = await withTenant(organizationId, async (tx) => {
    const run = await tx.workflowRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== "FAILED" || !run.currentNodeId) return null;
    const versionRow = await tx.workflowVersion.findUnique({ where: { id: run.versionId } });
    if (!versionRow) return null;
    await tx.workflowRun.update({ where: { id: runId }, data: { status: "RUNNING", error: null } });
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
  const result = await executeFrom(deps, ctx, parsed.data, data.run.currentNodeId!);
  await finishRun(organizationId, runId, result);
}

/** Horario de atención del negocio (default de recordatorios y del nodo horario). */
async function loadOrgBusinessHours(tx: any, organizationId: string): Promise<{ bh: BusinessHoursConfig | null; timezone: string }> {
  const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { timezone: true, settings: true } });
  const raw = ((org?.settings ?? {}) as Record<string, any>).businessHours;
  const timezone = org?.timezone ?? "America/Santiago";
  return { bh: raw?.hours ? { hours: raw.hours, holidays: raw.holidays ?? [], timezone } : null, timezone };
}

/**
 * Programa (o reprograma) los recordatorios de cita: por cada workflow activo
 * con trigger "Recordatorio de cita" (appointment_upcoming), materializa un
 * scheduled_job a (inicio − hoursBefore), ajustado a horario de atención.
 *
 * Idempotente por (workflow, id EXTERNO de la cita): reenvíos del webhook no
 * duplican ni resucitan un job ya enviado; al reprogramar la cita re-apunta el
 * job PENDIENTE a la fecha nueva. Ver planAppointmentReminder (lógica y bordes).
 */
export async function scheduleAppointmentReminders(
  organizationId: string,
  appt: { id: string; start: string; serviceId?: string | null; professionalId?: string | null; clinicId?: string | null },
  target: { conversationId?: string; contactId?: string },
): Promise<void> {
  const startsAt = new Date(appt.start);
  const now = new Date();
  await withTenant(organizationId, async (tx) => {
    const { bh, timezone } = await loadOrgBusinessHours(tx, organizationId);
    const wfs = await tx.workflow.findMany({
      where: { active: true, deletedAt: null },
      include: { versions: { where: { status: "PUBLISHED" }, orderBy: { version: "desc" }, take: 1 } },
    });
    for (const wf of wfs) {
      const def = wf.versions[0]?.definition as any;
      if (def?.trigger?.type !== "appointment_upcoming") continue;
      const cfg = def.trigger.config ?? {};
      // Filtros por servicio / profesional / sede: si la cita no encaja, no se
      // programa recordatorio para este flujo.
      if (!matchesApptFilter(cfg, { serviceId: appt.serviceId, professionalId: appt.professionalId, clinicId: appt.clinicId })) continue;
      const uniqueKey = `apptreminder:${wf.id}:${appt.id}`;
      const existing = await tx.scheduledJob.findUnique({
        where: { organizationId_uniqueKey: { organizationId, uniqueKey } },
        select: { id: true, status: true, dueAt: true },
      });
      const plan = planAppointmentReminder({
        now,
        startsAt,
        hoursBefore: Number(cfg.hoursBefore ?? 24),
        existing: existing ? { status: existing.status, dueAt: existing.dueAt } : null,
        businessHours: bh,
        timezone,
        avoidOffHours: cfg.avoidOffHours !== false,
      });
      if (plan.action === "skip") continue;
      if (plan.action === "cancel") {
        if (existing) await tx.scheduledJob.update({ where: { id: existing.id }, data: { status: "CANCELLED" } });
        continue;
      }
      // schedule
      await tx.scheduledJob.upsert({
        where: { organizationId_uniqueKey: { organizationId, uniqueKey } },
        update: { dueAt: plan.dueAt!, status: "PENDING" },
        create: {
          organizationId,
          kind: "appointment_reminder",
          dueAt: plan.dueAt!,
          uniqueKey,
          payload: {
            workflowId: wf.id,
            contactId: target.contactId ?? null,
            conversationId: target.conversationId ?? null,
            appointmentExternalId: appt.id,
            startsAt: startsAt.toISOString(),
          },
        },
      });
    }
  });
}

/**
 * Cancela los recordatorios PENDIENTES de una cita (todos sus workflows) al
 * cancelarse la cita — evita recordatorios huérfanos de una cita inexistente.
 * Clave por id EXTERNO de la cita (mismo que usa el scheduling).
 */
export async function cancelAppointmentReminders(organizationId: string, appointmentExternalId: string): Promise<void> {
  await withTenant(organizationId, (tx) =>
    tx.scheduledJob.updateMany({
      where: {
        kind: "appointment_reminder",
        status: "PENDING",
        uniqueKey: { endsWith: `:${appointmentExternalId}` },
      },
      data: { status: "CANCELLED" },
    }),
  );
}

/** Reanuda un run cuyo timer venció (invocado por el scheduler). */
/** Evalúa (mejor esfuerzo, modelo económico) si el objetivo ya se cumplió. */
export async function evaluateObjective(organizationId: string, conversationId: string, objective: string): Promise<boolean> {
  if (!objective.trim()) return false;
  try {
    const msgs = await withTenant(organizationId, (tx) =>
      tx.message.findMany({
        where: { conversationId, visibility: "PUBLIC", type: { notIn: ["SYSTEM", "NOTE"] } },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
    );
    const transcript = msgs
      .reverse()
      .map((m) => `${m.direction === "INBOUND" ? "Cliente" : "Agente"}: ${m.body ?? ""}`)
      .join("\n");
    const router = createAIRouter({ anthropicApiKey: getEnv().ANTHROPIC_API_KEY, openaiApiKey: getEnv().OPENAI_API_KEY });
    const res = await router.chat({
      model: getEnv().AI_DEFAULT_MODEL,
      system: "Eres un evaluador estricto. Responde ÚNICAMENTE 'SI' o 'NO'.",
      messages: [{ role: "user", content: `Objetivo: "${objective}".\n\nConversación:\n${transcript}\n\n¿El objetivo YA se cumplió de forma clara? Responde solo SI o NO.` }],
      maxTokens: 3,
    });
    return /\bs[íi]\b/i.test(res.text ?? "");
  } catch {
    return false; // ante error → "no cumplido" (rama de escalamiento)
  }
}

/** Quita el objetivo pendiente de la conversación (meta.aiObjective). */
async function clearPendingObjective(organizationId: string, conversationId: string): Promise<void> {
  await withTenant(organizationId, async (tx) => {
    const conv = await tx.conversation.findUnique({ where: { id: conversationId }, select: { meta: true } });
    const meta = { ...((conv?.meta as Record<string, unknown>) ?? {}) };
    if (!("aiObjective" in meta)) return;
    delete meta.aiObjective;
    await tx.conversation.update({ where: { id: conversationId }, data: { meta: meta as object } });
  });
}

/** Carga run+definición (WAITING→RUNNING) para reanudarlo. */
async function loadWaitingRun(organizationId: string, runId: string): Promise<{ ctx: RunCtx; def: WorkflowDefinition } | null> {
  const data = await withTenant(organizationId, async (tx) => {
    const run = await tx.workflowRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== "WAITING") return null;
    const versionRow = await tx.workflowVersion.findUnique({ where: { id: run.versionId } });
    if (!versionRow) return null;
    await tx.workflowRun.update({ where: { id: runId }, data: { status: "RUNNING" } });
    return { run, versionRow };
  });
  if (!data) return null;
  const parsed = workflowDefinitionSchema.safeParse(data.versionRow.definition);
  if (!parsed.success) return null;
  return {
    def: parsed.data,
    ctx: {
      organizationId,
      runId,
      workflowId: data.run.workflowId,
      versionId: data.run.versionId,
      conversationId: data.run.conversationId ?? undefined,
      contactId: data.run.contactId ?? undefined,
      variables: (data.run.variables as Record<string, string>) ?? {},
    },
  };
}

export async function resumeRun(organizationId: string, runId: string, nodeId: string): Promise<void> {
  const loaded = await loadWaitingRun(organizationId, runId);
  if (!loaded) return;
  const node = loaded.def.nodes.find((n) => n.id === nodeId);
  // Timeout de un objetivo multi-turno: nadie lo resolvió → rama "unmet".
  if (node?.type === "ai_objective") {
    if (loaded.ctx.conversationId) await clearPendingObjective(organizationId, loaded.ctx.conversationId);
    const result = await resumeWithBranch(deps, loaded.ctx, loaded.def, nodeId, "unmet");
    await finishRun(organizationId, runId, result);
    return;
  }
  // Timeout de "¿El contacto respondió?": venció sin respuesta → rama "no_reply".
  if (node?.type === "wait_reply") {
    const result = await resumeWithBranch(deps, loaded.ctx, loaded.def, nodeId, "no_reply");
    await finishRun(organizationId, runId, result);
    return;
  }
  const result = await resumeAfterWait(deps, loaded.ctx, loaded.def, nodeId);
  await finishRun(organizationId, runId, result);
}

/** Reanuda un run que esperaba en un nodo con ramas (ai_objective resuelto). */
export async function resumeRunWithBranch(organizationId: string, runId: string, nodeId: string, branch: string): Promise<void> {
  const loaded = await loadWaitingRun(organizationId, runId);
  if (!loaded) return;
  const result = await resumeWithBranch(deps, loaded.ctx, loaded.def, nodeId, branch);
  await finishRun(organizationId, runId, result);
}

/**
 * El contacto respondió: reanuda por la rama "replied" los runs que esperan en un
 * nodo "¿El contacto respondió?" (wait_reply) de esta conversación, cancelando su
 * timeout. A diferencia de cancelTimersOnReply (que cancela el run), aquí el run
 * CONTINÚA por la otra rama. Devuelve true si reanudó algún run.
 */
export async function handleWaitReply(organizationId: string, conversationId: string): Promise<boolean> {
  const jobs = await withTenant(organizationId, (tx) =>
    tx.scheduledJob.findMany({ where: { status: "PENDING", kind: "workflow_timer" } }),
  );
  let handled = false;
  for (const job of jobs) {
    const p = job.payload as Record<string, unknown>;
    if (p.conversationId !== conversationId || !job.runId) continue;
    // Solo los que esperan en un nodo wait_reply (sin tocar el estado del run).
    const info = await withTenant(organizationId, async (tx) => {
      const run = await tx.workflowRun.findUnique({ where: { id: job.runId! } });
      if (!run || run.status !== "WAITING") return null;
      const ver = await tx.workflowVersion.findUnique({ where: { id: run.versionId } });
      return ver ? { def: ver.definition } : null;
    });
    if (!info) continue;
    const parsed = workflowDefinitionSchema.safeParse(info.def);
    if (!parsed.success) continue;
    const node = parsed.data.nodes.find((n) => n.id === String(p.nodeId));
    if (node?.type !== "wait_reply") continue;
    // Cancela el timeout y reanuda por "replied" (respondió).
    await withTenant(organizationId, (tx) => tx.scheduledJob.update({ where: { id: job.id }, data: { status: "CANCELLED" } }));
    await resumeRunWithBranch(organizationId, job.runId, String(p.nodeId), "replied");
    handled = true;
  }
  return handled;
}

/**
 * Multi-turno ai_objective: si la conversación tiene un objetivo pendiente,
 * corre el turno del agente CON el objetivo, re-evalúa y reanuda el run
 * cuando se resuelve (met) o se agotan los turnos (unmet).
 * Devuelve true si manejó el turno del agente (el inbound no debe duplicarlo).
 */
export async function handlePendingObjective(organizationId: string, conversationId: string): Promise<boolean> {
  const conv = await withTenant(organizationId, (tx) =>
    tx.conversation.findUnique({ where: { id: conversationId }, select: { meta: true } }),
  );
  const pending = (conv?.meta as Record<string, any> | null)?.aiObjective;
  if (!pending?.runId || !pending?.nodeId) return false;

  try {
    await runAgentTurn({
      organizationId,
      conversationId,
      agentSlug: pending.agentSlug ? String(pending.agentSlug) : undefined,
      objective: String(pending.objective ?? ""),
    });
  } catch (err) {
    console.error(`✖ Error en turno de agente con objetivo (${conversationId}):`, (err as Error).message);
  }

  const met = await evaluateObjective(organizationId, conversationId, String(pending.objective ?? ""));
  const turnsLeft = Number(pending.turnsLeft ?? 0) - 1;
  if (!met && turnsLeft > 0) {
    await withTenant(organizationId, async (tx) => {
      const c = await tx.conversation.findUnique({ where: { id: conversationId }, select: { meta: true } });
      const meta = (c?.meta as Record<string, unknown>) ?? {};
      await tx.conversation.update({
        where: { id: conversationId },
        data: { meta: { ...meta, aiObjective: { ...pending, turnsLeft } } as object },
      });
    });
    return true;
  }

  // Resuelto (met) o turnos agotados (unmet): limpiar, cancelar el timeout y reanudar.
  await clearPendingObjective(organizationId, conversationId);
  await withTenant(organizationId, (tx) =>
    tx.scheduledJob.updateMany({
      where: { status: "PENDING", kind: "workflow_timer", uniqueKey: `${pending.runId}:${pending.nodeId}` },
      data: { status: "CANCELLED" },
    }),
  );
  await resumeRunWithBranch(organizationId, String(pending.runId), String(pending.nodeId), met ? "met" : "unmet");
  return true;
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
    // Webhook entrante: el payload queda disponible como variables del flujo
    // (webhook.campo, webhook.objeto.campo, …) para usarlas en {{…}}.
    if (event.type === "webhook_received" && event.data && typeof event.data === "object") {
      const flatten = (obj: Record<string, unknown>, prefix: string, depth: number) => {
        if (depth > 2) return;
        for (const [k, v] of Object.entries(obj)) {
          if (v === null || v === undefined) continue;
          const key = `${prefix}.${k}`;
          if (typeof v === "object" && !Array.isArray(v)) flatten(v as Record<string, unknown>, key, depth + 1);
          else if (typeof v !== "object") vars[key] = String(v).slice(0, 500);
        }
      };
      const payload = (event.data as Record<string, unknown>).payload;
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        flatten(payload as Record<string, unknown>, "webhook", 0);
      }
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
