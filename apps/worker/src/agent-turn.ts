import {
  ToolRegistry,
  buildCoreTools,
  createAIProvider,
  orchestrate,
  type AgentRuntime,
} from "@conversia/agents";
import { getEnv } from "@conversia/config";
import { getPrisma, withTenant } from "@conversia/database";
import type { AIChatMessage, ToolContext } from "@conversia/types";
import { getChannelProvider } from "./channel-providers";
import { emitPlatformEvent } from "./platform-events";
import { buildToolServices } from "./tool-services";

const registry = new ToolRegistry();
for (const tool of buildCoreTools()) registry.register(tool);

const ai = createAIProvider({
  provider: getEnv().AI_PROVIDER,
  anthropicApiKey: getEnv().ANTHROPIC_API_KEY,
});

/**
 * Ejecuta un turno del agente activo de una conversación y envía la
 * respuesta por el canal. Registra trazabilidad completa (agente, versión,
 * tools, tokens, costo) en messages + ai_requests + usage_events.
 */
export async function runAgentTurn(opts: {
  organizationId: string;
  conversationId: string;
  agentSlug?: string;
  depth?: number;
}): Promise<void> {
  const { organizationId, conversationId } = opts;
  const depth = opts.depth ?? 0;

  // 1. Cargar contexto (transacción corta; la llamada al modelo va fuera)
  const loaded = await withTenant(organizationId, async (tx) => {
    const conversation = await tx.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    });
    if (!conversation || !conversation.aiEnabled) return null;

    let agent = null;
    if (opts.agentSlug) {
      agent = await tx.agent.findUnique({
        where: { organizationId_slug: { organizationId, slug: opts.agentSlug } },
      });
    } else if (conversation.activeAgentId) {
      agent = await tx.agent.findUnique({ where: { id: conversation.activeAgentId } });
    }
    if (!agent && conversation.channelConnectionId) {
      const channel = await tx.channelConnection.findUnique({ where: { id: conversation.channelConnectionId } });
      if (channel?.defaultAgentId) {
        agent = await tx.agent.findUnique({ where: { id: channel.defaultAgentId } });
      }
    }
    if (!agent || !agent.active) return null;

    const version = await tx.agentVersion.findFirst({
      where: { agentId: agent.id, status: "PUBLISHED" },
      orderBy: { version: "desc" },
    });
    if (!version) return null;

    const [org, clinic, rawMessages] = await Promise.all([
      tx.organization.findUnique({ where: { id: organizationId } }),
      conversation.clinicId
        ? tx.clinic.findUnique({ where: { id: conversation.clinicId } })
        : tx.clinic.findFirst({ where: { active: true } }),
      tx.message.findMany({
        where: { conversationId, visibility: "PUBLIC", type: { notIn: ["SYSTEM", "NOTE"] } },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);

    return { conversation, agent, version, org, clinic, rawMessages: rawMessages.reverse() };
  });

  if (!loaded) return;
  const { conversation, agent, version, org, clinic, rawMessages } = loaded;

  // Controles de consumo de IA (LLM10 — Unbounded Consumption):
  // 1. Kill switch global (env) o por tenant (org.settings.aiKillSwitch).
  // 2. Tope diario de tokens por organización.
  const env = getEnv();
  const orgSettings = (org?.settings ?? {}) as Record<string, any>;
  if (env.AI_GLOBAL_KILL_SWITCH || orgSettings.aiKillSwitch === true) {
    await withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: {
          organizationId,
          provider: "ai",
          type: "ai.kill_switch",
          status: "warning",
          message: env.AI_GLOBAL_KILL_SWITCH ? "IA pausada globalmente" : "IA pausada por la organización",
        },
      }),
    );
    return;
  }
  if (env.AI_DAILY_TOKEN_BUDGET_PER_ORG > 0) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const spent = await withTenant(organizationId, (tx) =>
      tx.usageEvent.aggregate({
        where: { type: "ai_tokens", occurredAt: { gte: startOfDay } },
        _sum: { quantity: true },
      }),
    );
    if (Number(spent._sum.quantity ?? 0) >= env.AI_DAILY_TOKEN_BUDGET_PER_ORG) {
      await withTenant(organizationId, (tx) =>
        tx.integrationEvent.create({
          data: {
            organizationId,
            provider: "ai",
            type: "ai.budget_exceeded",
            status: "warning",
            message: `Tope diario de tokens IA alcanzado (${env.AI_DAILY_TOKEN_BUDGET_PER_ORG})`,
          },
        }),
      );
      return;
    }
  }

  // 2. Historial ventaneado (el primer mensaje debe ser del usuario)
  const history: AIChatMessage[] = rawMessages.map((m) => ({
    role: m.direction === "INBOUND" ? ("user" as const) : ("assistant" as const),
    content: m.body ?? `[${m.type.toLowerCase()}]`,
  }));
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length) return;

  const cfg = (version.config ?? {}) as Record<string, any>;
  const runtime: AgentRuntime = {
    agentId: agent.id,
    agentVersionId: version.id,
    slug: agent.slug,
    name: agent.name,
    systemPrompt: version.systemPrompt,
    model: cfg.model ?? getEnv().AI_DEFAULT_MODEL,
    maxTokens: cfg.maxTokens ?? 400,
    maxToolRounds: cfg.maxToolRounds ?? 5,
    tools: Array.isArray(version.tools) ? (version.tools as string[]) : [],
  };

  const services = await buildToolServices(organizationId, {
    conversationId,
    contactId: conversation.contactId,
    clinicId: conversation.clinicId,
  });
  const toolCtx: ToolContext = {
    organizationId,
    clinicId: conversation.clinicId,
    conversationId,
    contactId: conversation.contactId,
    agentId: agent.id,
    agentVersionId: version.id,
    services: services as unknown as Record<string, unknown>,
  };

  const vars: Record<string, string> = {
    "organization.name": org?.name ?? "",
    "clinic.name": clinic?.name ?? "",
    "clinic.city": clinic?.city ?? "",
    "clinic.address": clinic?.address ?? "",
    "contact.firstName": conversation.contact.firstName ?? "",
    "agent.name": agent.name,
  };

  // 3. Orquestar (modelo + loop de tools)
  const result = await orchestrate(ai, registry, { ctx: toolCtx, agent: runtime, history, vars });

  // 4. Persistir trazabilidad + respuesta
  const persisted = await withTenant(organizationId, async (tx) => {
    const aiRequest = await tx.aiRequest.create({
      data: {
        organizationId,
        agentId: agent.id,
        agentVersionId: version.id,
        conversationId,
        provider: ai.kind,
        model: runtime.model,
        purpose: "CHAT",
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.usage.costUsd,
        latencyMs: result.latencyMs,
        status: result.stopReason === "refusal" ? "refusal" : "ok",
      },
    });
    await tx.usageEvent.create({
      data: {
        organizationId,
        type: "ai_tokens",
        quantity: result.usage.inputTokens + result.usage.outputTokens,
        costUsd: result.usage.costUsd,
        meta: { conversationId, agentSlug: agent.slug, toolCalls: result.toolEvents.map((e) => e.name) },
      },
    });

    if (!result.reply) return null;
    const message = await tx.message.create({
      data: {
        organizationId,
        conversationId,
        direction: "OUTBOUND",
        type: "TEXT",
        body: result.reply,
        authorType: "AGENT",
        agentId: agent.id,
        agentVersionId: version.id,
        aiRequestId: aiRequest.id,
        status: "PENDING",
        payload: { toolEvents: result.toolEvents as object[] },
      },
    });
    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: result.reply.slice(0, 120),
        activeAgentId: agent.id,
      },
    });
    return message;
  });

  // 5. Enviar por el canal
  if (persisted && conversation.contact.phone) {
    const phoneNumberId = await resolvePhoneNumberId(organizationId, conversation.channelConnectionId);
    try {
      const sent = await getChannelProvider().send(phoneNumberId, {
        to: conversation.contact.phone,
        type: "text",
        text: persisted.body ?? "",
      });
      await withTenant(organizationId, (tx) =>
        tx.message.update({
          where: { id: persisted.id },
          data: { status: "SENT", externalId: sent.externalId, sentAt: new Date() },
        }),
      );
      await emitPlatformEvent(organizationId, "message.sent", {
        conversationId,
        agentSlug: agent.slug,
        text: (persisted.body ?? "").slice(0, 200),
      });
    } catch (err) {
      await withTenant(organizationId, (tx) =>
        tx.message.update({
          where: { id: persisted.id },
          data: { status: "FAILED", error: (err as Error).message.slice(0, 500) },
        }),
      );
    }
  }

  // 6. Transferencia entre agentes (conserva contexto, registra evento)
  if (result.transferToAgentSlug && result.transferToAgentSlug !== agent.slug && depth < 1) {
    await withTenant(organizationId, async (tx) => {
      const target = await tx.agent.findUnique({
        where: { organizationId_slug: { organizationId, slug: result.transferToAgentSlug! } },
      });
      if (!target) return;
      await tx.conversation.update({ where: { id: conversationId }, data: { activeAgentId: target.id } });
      await tx.agentHandoff.create({
        data: {
          organizationId,
          conversationId,
          fromAgentId: agent.id,
          toAgentId: target.id,
          reason: "transferToAgent",
          contextSummary: result.reply?.slice(0, 500) ?? null,
        },
      });
    });
  }
}

async function resolvePhoneNumberId(organizationId: string, channelConnectionId?: string | null): Promise<string> {
  return withTenant(organizationId, async (tx) => {
    if (channelConnectionId) {
      const number = await tx.whatsappPhoneNumber.findFirst({ where: { channelConnectionId } });
      if (number) return number.phoneNumberId;
      const channel = await tx.channelConnection.findUnique({ where: { id: channelConnectionId } });
      if (channel?.type === "MOCK") {
        const org = await tx.organization.findUnique({ where: { id: organizationId } });
        return `mock:${org?.slug ?? organizationId}`;
      }
    }
    const any = await tx.whatsappPhoneNumber.findFirst({ where: { status: "active" } });
    if (any) return any.phoneNumberId;
    const org = await tx.organization.findUnique({ where: { id: organizationId } });
    return `mock:${org?.slug ?? organizationId}`;
  });
}

export function getGlobalPrisma() {
  return getPrisma();
}
