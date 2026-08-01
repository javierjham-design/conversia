import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { createAIRouter } from "@conversia/agents";
import type { AIChatMessage } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { buildViewWhere, type InboxViewDefinition } from "./conversations.controller";

const viewSchema = z.object({
  name: z.string().min(2).max(60),
  definition: z.object({
    status: z.enum(["open", "pending", "closed", "all"]).optional(),
    channelId: z.string().optional(),
    assigned: z.string().optional(),
    ai: z.enum(["on", "off"]).optional(),
    stageCode: z.string().optional(),
    tags: z.array(z.string()).max(10).optional(),
    hasAd: z.boolean().optional(),
  }),
});

const snippetSchema = z.object({
  shortcut: z
    .string()
    .min(2)
    .max(30)
    .regex(/^[a-z0-9_-]+$/, "Solo minúsculas, números, guion y guion bajo"),
  body: z.string().min(2).max(2000),
});

/**
 * Clasificador de la Bandeja: conteos agregados, bandejas personalizadas,
 * respuestas rápidas y asistente IA del compositor.
 */
@Controller("inbox")
export class InboxController {
  constructor(private prisma: PrismaService) {}

  /**
   * Conteos del sidebar en UNA pasada por grupo (agregaciones, sin N+1):
   * fijos, por agente IA, por etapa (lead más reciente vía lateral join),
   * por equipo, bandejas guardadas y bloqueados.
   */
  @Get("counters")
  counters() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const openWhere = { status: { in: ["OPEN", "PENDING"] as any[] } };
      const [all, mine, unassigned, unanswered, byAgentRaw, byTeamRaw, agents, teams, views, blocked] = await Promise.all([
        tx.conversation.count({ where: openWhere }),
        tx.conversation.count({ where: { ...openWhere, assignedUserId: ctx.userId } }),
        tx.conversation.count({ where: { ...openWhere, assignedUserId: null, assignedTeamId: null } }),
        tx.conversation.count({ where: { ...openWhere, unreadCount: { gt: 0 } } }),
        tx.conversation.groupBy({
          by: ["activeAgentId"],
          where: { ...openWhere, aiEnabled: true, activeAgentId: { not: null } },
          _count: { _all: true },
        }),
        tx.conversation.groupBy({
          by: ["assignedTeamId"],
          where: { ...openWhere, assignedTeamId: { not: null } },
          _count: { _all: true },
        }),
        tx.agent.findMany({ where: { deletedAt: null, active: true }, select: { id: true, name: true } }),
        tx.team.findMany({ select: { id: true, name: true } }),
        tx.inboxView.findMany({ orderBy: { createdAt: "asc" }, take: 30 }),
        tx.conversation.count({ where: { ...openWhere, contact: { blocked: true } } }),
      ]);

      // Etapa ACTUAL (lead más reciente por contacto) de conversaciones abiertas.
      const byStage = await tx.$queryRaw<{ code: string; name: string; color: string | null; count: number }[]>`
        SELECT ls.code, ls.name, ls.color, COUNT(*)::int AS count
        FROM conversations c
        JOIN LATERAL (
          SELECT l.status_id FROM leads l
          WHERE l.contact_id = c.contact_id
          ORDER BY l.created_at DESC LIMIT 1
        ) latest ON true
        JOIN lead_statuses ls ON ls.id = latest.status_id
        WHERE c.status IN ('OPEN', 'PENDING')
        GROUP BY ls.code, ls.name, ls.color, ls."order"
        ORDER BY ls."order"`;

      const agentName = new Map(agents.map((a) => [a.id, a.name]));
      const teamName = new Map(teams.map((t) => [t.id, t.name]));

      // Bandejas guardadas: pocas por tenant (cap 30) → un count each es aceptable.
      const viewCounts = await Promise.all(
        views.map(async (v) => {
          const def = (v.definition as InboxViewDefinition) ?? {};
          let tagContactIds: string[] | undefined;
          if (def.tags?.length) {
            const tags = await tx.tag.findMany({ where: { name: { in: def.tags } } });
            const asg = await tx.tagAssignment.findMany({
              where: { tagId: { in: tags.map((t) => t.id) }, entityType: "contact" },
              select: { entityId: true },
            });
            tagContactIds = [...new Set(asg.map((a) => a.entityId))];
          }
          const where = buildViewWhere(def, ctx.userId, tagContactIds);
          const count = await tx.conversation.count({
            where: { ...(def.status ? {} : openWhere), ...(where as any) },
          });
          return { id: v.id, name: v.name, definition: def, count };
        }),
      );

      return {
        fixed: { all, mine, unassigned, unanswered, blocked },
        agents: byAgentRaw
          .filter((r) => r.activeAgentId && agentName.has(r.activeAgentId))
          .map((r) => ({ id: r.activeAgentId!, name: agentName.get(r.activeAgentId!)!, count: r._count._all })),
        stages: byStage,
        teams: byTeamRaw
          .filter((r) => r.assignedTeamId && teamName.has(r.assignedTeamId))
          .map((r) => ({ id: r.assignedTeamId!, name: teamName.get(r.assignedTeamId!)!, count: r._count._all })),
        allTeams: teams,
        views: viewCounts,
      };
    });
  }

  // ------------------------- Bandejas personalizadas -------------------------

  @Get("views")
  views() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) => tx.inboxView.findMany({ orderBy: { createdAt: "asc" } }));
  }

  @Post("views")
  createView(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = viewSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? "Bandeja inválida");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const exists = await tx.inboxView.findUnique({
        where: { organizationId_name: { organizationId: ctx.organizationId, name: parsed.data.name } },
      });
      if (exists) throw new BadRequestException("Ya existe una bandeja con ese nombre");
      return tx.inboxView.create({
        data: { organizationId: ctx.organizationId, name: parsed.data.name, definition: parsed.data.definition as object, createdById: ctx.userId },
      });
    });
  }

  @Patch("views/:id")
  updateView(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = viewSchema.partial().safeParse(body);
    if (!parsed.success) throw new BadRequestException("Bandeja inválida");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const view = await tx.inboxView.findUnique({ where: { id } });
      if (!view) throw new NotFoundException("Bandeja no encontrada");
      return tx.inboxView.update({
        where: { id },
        data: {
          ...(parsed.data.name ? { name: parsed.data.name } : {}),
          ...(parsed.data.definition ? { definition: parsed.data.definition as object } : {}),
        },
      });
    });
  }

  @Delete("views/:id")
  deleteView(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.inboxView.deleteMany({ where: { id } });
      return { ok: true };
    });
  }

  // ------------------------- Respuestas rápidas (snippets) -------------------------

  @Get("snippets")
  snippets() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) => tx.snippet.findMany({ orderBy: { shortcut: "asc" } }));
  }

  @Post("snippets")
  createSnippet(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = snippetSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? "Respuesta rápida inválida");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const exists = await tx.snippet.findUnique({
        where: { organizationId_shortcut: { organizationId: ctx.organizationId, shortcut: parsed.data.shortcut } },
      });
      if (exists) throw new BadRequestException("Ya existe una respuesta rápida con ese atajo");
      return tx.snippet.create({
        data: { organizationId: ctx.organizationId, shortcut: parsed.data.shortcut, body: parsed.data.body, createdById: ctx.userId },
      });
    });
  }

  @Patch("snippets/:id")
  updateSnippet(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = snippetSchema.partial().safeParse(body);
    if (!parsed.success) throw new BadRequestException("Respuesta rápida inválida");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const snip = await tx.snippet.findUnique({ where: { id } });
      if (!snip) throw new NotFoundException("Respuesta rápida no encontrada");
      return tx.snippet.update({ where: { id }, data: parsed.data });
    });
  }

  @Delete("snippets/:id")
  deleteSnippet(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.snippet.deleteMany({ where: { id } });
      return { ok: true };
    });
  }

  // ------------------------- Asistente IA del compositor -------------------------

  /**
   * (a) sugerir respuesta, (b) mejorar borrador, (c) traducir, (d) resumir.
   * Usa el proveedor IA ya configurado del tenant y registra el costo como uso.
   */
  @Post("assist")
  async assist(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z
      .object({
        conversationId: z.string().min(1),
        mode: z.enum(["suggest", "improve", "translate", "summarize"]),
        draft: z.string().max(4000).optional(),
        tone: z.enum(["warmer", "shorter", "formal"]).optional(),
        targetLang: z.string().max(30).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Petición inválida");
    const { conversationId, mode, draft, tone, targetLang } = parsed.data;
    const env = getEnv();

    const loaded = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id: conversationId }, include: { contact: true } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const [org, messages, knowledge] = await Promise.all([
        tx.organization.findUnique({ where: { id: ctx.organizationId } }),
        tx.message.findMany({
          where: { conversationId, visibility: "PUBLIC", type: { notIn: ["SYSTEM", "NOTE"] } },
          orderBy: { createdAt: "desc" },
          take: 30,
        }),
        mode === "suggest"
          ? tx.knowledgeDocument.findMany({
              where: { status: "PUBLISHED", content: { not: null } },
              take: 12,
              select: { title: true, content: true },
            })
          : ([] as { title: string; content: string | null }[]),
      ]);
      return { conversation, org, messages: messages.reverse(), knowledge };
    });

    // Mismos controles de consumo que el resto de la IA
    const orgSettings = (loaded.org?.settings ?? {}) as Record<string, any>;
    if (env.AI_GLOBAL_KILL_SWITCH || orgSettings.aiKillSwitch === true) {
      throw new BadRequestException("La IA está pausada (kill switch)");
    }
    const aiCfg = (orgSettings.ai ?? {}) as Record<string, any>;
    const model = aiCfg.model ?? env.AI_DEFAULT_MODEL;

    const contactName = [loaded.conversation.contact.firstName, loaded.conversation.contact.lastName].filter(Boolean).join(" ") || "el contacto";
    const transcript = loaded.messages
      .map((m) => `${m.direction === "INBOUND" ? contactName : "Nosotros"}: ${m.body ?? `[${m.type.toLowerCase()}]`}`)
      .join("\n");

    let system = `Eres el asistente del equipo de ${loaded.org?.name ?? "la empresa"} en una bandeja de WhatsApp. Responde SIEMPRE en español chileno neutro, listo para pegar (sin comillas ni preámbulos).`;
    let user = "";
    if (mode === "suggest") {
      const kb = (loaded.knowledge as { title: string; content: string | null }[])
        .map((k) => `- ${k.title}: ${(k.content ?? "").slice(0, 300)}`)
        .join("\n");
      user = `Conversación:\n${transcript}\n\n${kb ? `Base de conocimiento:\n${kb}\n\n` : ""}Redacta LA MEJOR respuesta breve para continuar esta conversación (máx. 3 frases, tono cercano y profesional).`;
    } else if (mode === "improve") {
      const toneLabel = tone === "warmer" ? "más cálido y cercano" : tone === "shorter" ? "más corto y directo" : "más formal (trato de usted)";
      user = `Contexto de la conversación:\n${transcript.slice(-1500)}\n\nReescribe este borrador en tono ${toneLabel}, manteniendo el significado:\n"""${draft ?? ""}"""`;
    } else if (mode === "translate") {
      user = `Traduce este mensaje al ${targetLang || "inglés"} manteniendo el tono:\n"""${draft ?? ""}"""`;
    } else {
      system = `Eres el asistente del equipo de ${loaded.org?.name ?? "la empresa"}. Resumes conversaciones de WhatsApp en español, en viñetas.`;
      user = `Resume esta conversación para el equipo:\n${transcript}\n\nFormato:\n• Puntos clave\n• Qué quiere ${contactName}\n• Compromisos/pendientes`;
    }

    const ai = createAIRouter({ anthropicApiKey: env.ANTHROPIC_API_KEY, openaiApiKey: env.OPENAI_API_KEY });
    const history: AIChatMessage[] = [{ role: "user", content: user }];
    const res = await ai.chat({ model, system, messages: history, maxTokens: mode === "summarize" ? 500 : 300 });

    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.usageEvent.create({
        data: {
          organizationId: ctx.organizationId,
          type: "ai_tokens",
          quantity: res.usage.inputTokens + res.usage.outputTokens,
          costUsd: res.usage.costUsd,
          meta: { source: "inbox_assist", mode, model },
        },
      });
      // El resumen queda como comentario interno en el hilo.
      if (mode === "summarize" && res.text) {
        await tx.message.create({
          data: {
            organizationId: ctx.organizationId,
            conversationId,
            direction: "OUTBOUND",
            type: "NOTE",
            visibility: "INTERNAL",
            body: `📋 Resumen IA:\n${res.text}`,
            authorType: "USER",
            authorUserId: ctx.userId,
            status: "DELIVERED",
          },
        });
      }
    });

    return { text: res.text ?? "", usage: res.usage };
  }
}
