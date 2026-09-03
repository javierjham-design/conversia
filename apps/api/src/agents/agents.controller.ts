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
import {
  ToolRegistry,
  assembleSystemPrompt,
  buildCoreTools,
  createAIRouter,
  orchestrate,
  type AgentRuntime,
} from "@conversia/agents";
import { getEnv } from "@conversia/config";
import { resolveAgentByNameOrSlug } from "@conversia/database";
import type { AIChatMessage, ToolContext } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";
import { enforcePlanLimit } from "../common/plan-limits";
import { buildSandboxServices, type SandboxState } from "./agent-sandbox";

// Registro de tools compartido para el probador (una sola vez por proceso).
const sandboxRegistry = new ToolRegistry();
for (const tool of buildCoreTools()) sandboxRegistry.register(tool);

/** Extrae el slug de agente destino cuando el modelo derivó vía assignConversation (marcador). */
function sandboxHandoffSlug(events: ReadonlyArray<{ name: string; output?: unknown; isError?: boolean }> | undefined): string | undefined {
  const ev = events?.find((e) => e.name === "assignConversation" && !e.isError);
  if (!ev || typeof ev.output !== "string") return undefined;
  try {
    const parsed = JSON.parse(ev.output) as { handoffToAgentSlug?: unknown };
    return typeof parsed.handoffToAgentSlug === "string" ? parsed.handoffToAgentSlug : undefined;
  } catch {
    return undefined;
  }
}

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
      model: z.string().default("gpt-4o-mini"),
      maxTokens: z.coerce.number().int().min(50).max(4000).default(400),
      maxToolRounds: z.coerce.number().int().min(0).max(10).default(5),
      language: z.string().default("es"),
    })
    .passthrough(),
  tools: z.array(z.string()).default([]),
  changelog: z.string().max(300).optional(),
});

const actionStateSchema = z
  .object({ enabled: z.boolean(), instructions: z.string().max(2000).optional() })
  .passthrough();

const testSchema = z.object({
  // El probador usa el estado ACTUAL del editor (aún sin guardar), no la BD.
  systemPrompt: z.string().min(1).max(20000),
  config: z
    .object({
      model: z.string().default("gpt-4o-mini"),
      maxTokens: z.coerce.number().int().min(50).max(4000).default(400),
      maxToolRounds: z.coerce.number().int().min(0).max(10).default(5),
    })
    .passthrough(),
  tools: z.array(z.string()).default([]),
  actions: z.record(actionStateSchema).optional(),
  knowledgeSources: z.array(z.string()).optional(),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
    .min(1)
    .max(40),
  contact: z
    .object({
      firstName: z.string().max(80).nullable().optional(),
      lastName: z.string().max(80).nullable().optional(),
      email: z.string().max(160).nullable().optional(),
      phone: z.string().max(40).nullable().optional(),
    })
    .optional(),
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

const DEFAULT_PROMPT = `Eres {{agent.name}}, asistente virtual de {{organization.name}} ({{clinic.name}}). Atiendes por WhatsApp de forma cercana, profesional y breve (máximo 2-3 frases, una pregunta a la vez). Responde SOLO con información obtenida de tus herramientas; si no sabes algo, reconócelo y ofrece que una persona del equipo contacte. Nunca inventes precios, horarios ni disponibilidad, y nunca entregues indicaciones clínicas. Si detectas urgencia, frustración o piden hablar con una persona, usa transferToHuman. SIEMPRE respondes al cliente con un mensaje y un siguiente paso claro: nunca lo dejes sin respuesta. NUNCA prometas una acción que no realizas en el momento ("déjame guardarlo", "ahora lo hago"): hazla con tu herramienta o dile el siguiente paso concreto, sin dejar nada pendiente en el aire.`;

@Controller("agents")
export class AgentsController {
  constructor(private prisma: PrismaService) {}

  /** Catálogo de herramientas disponibles para habilitar por agente. */
  @Get("meta/tools")
  toolCatalog() {
    return buildCoreTools().map((t) => ({ name: t.name, description: t.description }));
  }

  /** Bases de conocimiento del tenant, para elegir cuáles usa cada agente. */
  @Get("meta/knowledge")
  knowledgeBases() {
    const ctx = requirePermission("agents:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const bases = await tx.knowledgeBase.findMany({
        orderBy: { createdAt: "asc" },
        include: { _count: { select: { documents: { where: { status: "PUBLISHED" } } } } },
      });
      return bases.map((b) => ({ id: b.id, name: b.name, description: b.description, publishedDocs: b._count.documents }));
    });
  }

  @Get()
  list() {
    const ctx = requirePermission("agents:read");
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
          avatar: ((published ?? draft)?.config as any)?.emoji ?? null,
        };
      });
    });
  }

  @Post()
  create(@Body() body: unknown) {
    const ctx = requirePermission("agents:write");
    const input = parse(createAgentSchema, body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await enforcePlanLimit(tx, "agents", await tx.agent.count({ where: { deletedAt: null } }));
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
          config: { model: "gpt-4o-mini", maxTokens: 400, maxToolRounds: 5, language: "es" },
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

  /** Lista liviana de agentes activos para asignar en la bandeja (cualquier miembro). */
  @Get("assignable")
  assignable() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.agent.findMany({
        where: { deletedAt: null, active: true },
        select: { id: true, name: true, slug: true },
        orderBy: { name: "asc" },
      }),
    );
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    const ctx = requirePermission("agents:read");
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

  /**
   * Probador en vivo del editor. Ejecuta un turno del agente con la configuración
   * ACTUAL (aún sin publicar) contra un entorno de PRUEBA:
   *  - Lecturas reales (servicios, precios, agenda, conocimiento del tenant).
   *  - Escrituras SIMULADAS: no persiste conversaciones, leads, citas ni notas.
   * Respeta el kill switch, la suspensión, la vigencia y el tope diario de tokens
   * (la prueba consume tokens reales del proveedor), y registra ese consumo.
   */
  @Post(":id/test")
  async test(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("agents:write");
    const input = parse(testSchema, body);
    const orgId = ctx.organizationId;
    const env = getEnv();

    const loaded = await this.prisma.withTenant(orgId, async (tx) => {
      const agent = await tx.agent.findFirst({ where: { id, deletedAt: null } });
      if (!agent) throw new NotFoundException("Agente no encontrado");
      const [org, clinic] = await Promise.all([
        tx.organization.findUnique({ where: { id: orgId } }),
        tx.clinic.findFirst({ where: { active: true, deletedAt: null } }),
      ]);
      return { agent, org, clinic };
    });
    const { agent, org, clinic } = loaded;
    const orgSettings = (org?.settings ?? {}) as Record<string, any>;

    // ---- Controles de consumo (mismos que el worker; aquí solo bloquean) ----
    if (env.AI_GLOBAL_KILL_SWITCH || orgSettings.aiKillSwitch === true) {
      return { ok: false, blocked: true, error: "La IA está pausada (kill switch). Actívala para probar." };
    }
    if (org?.status === "SUSPENDED" || org?.status === "CANCELLED") {
      return { ok: false, blocked: true, error: `La organización está ${org.status}; la IA está detenida.` };
    }
    const validUntil = orgSettings.validUntil;
    if (typeof validUntil === "string" && new Date(validUntil).getTime() < Date.now()) {
      return { ok: false, blocked: true, error: "La vigencia del servicio venció; la IA está detenida." };
    }
    const budget = await this.prisma.withTenant(orgId, async (tx) => {
      const override = (orgSettings.limits as Record<string, number> | undefined)?.aiTokensDaily;
      if (typeof override === "number") return override;
      const sub = await tx.subscription.findFirst({
        where: { status: { in: ["ACTIVE", "TRIALING"] } },
        orderBy: { createdAt: "desc" },
      });
      if (sub) {
        const plan = await tx.plan.findUnique({ where: { id: sub.planId } });
        const planLimit = (plan?.limits as Record<string, number> | undefined)?.aiTokensDaily;
        if (typeof planLimit === "number") return planLimit;
      }
      return env.AI_DAILY_TOKEN_BUDGET_PER_ORG;
    });
    if (budget > 0) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const spent = await this.prisma.withTenant(orgId, (tx) =>
        tx.usageEvent.aggregate({ where: { type: "ai_tokens", occurredAt: { gte: startOfDay } }, _sum: { quantity: true } }),
      );
      if (Number(spent._sum.quantity ?? 0) >= budget) {
        return { ok: false, blocked: true, error: "Se alcanzó el tope diario de tokens de IA. Intenta mañana o súbelo en el plan." };
      }
    }

    // ---- Entorno de prueba: contacto en memoria + escrituras simuladas ----
    const state: SandboxState = {
      contact: {
        firstName: input.contact?.firstName ?? "Prueba",
        lastName: input.contact?.lastName ?? null,
        phone: input.contact?.phone ?? "+56900000000",
        email: input.contact?.email ?? null,
      },
      simulated: [],
    };
    const services = await buildSandboxServices(orgId, state, {
      knowledgeSources: input.knowledgeSources ?? null,
      allowedProfessionalIds: Array.isArray((input.config as any)?.scheduling?.professionalIds) ? (input.config as any).scheduling.professionalIds : null,
    });
    const toolCtx: ToolContext = {
      organizationId: orgId,
      clinicId: clinic?.id ?? null,
      // Por-org y por-corrida: las cachés de slots/reservas de las tools se indexan por
      // conversación; un id fijo compartiría estado entre tenants y entre pruebas.
      conversationId: `sandbox:${orgId}:${Date.now()}`,
      contactId: "sandbox",
      agentId: agent.id,
      agentName: agent.name,
      agentVersionId: "sandbox",
      services: services as unknown as Record<string, unknown>,
    };

    // El modelo/límites los fija el Super Admin por tenant (org.settings.ai);
    // el probador usa esos mismos valores, no los del cuerpo.
    const aiCfg = (orgSettings.ai ?? {}) as Record<string, any>;
    // Fecha/hora reales (Chile) — igual que en producción, para que el probador
    // interprete "hoy/mañana/esta semana" y nombre los días correctamente.
    const nowChile = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
    const currentDateBlock =
      `\n\n## Fecha y hora actual (ÚSALA SIEMPRE)\nHoy es ${nowChile} (hora de Chile). Interpreta "hoy", "mañana", "el lunes", "esta semana" con ESTA fecha real; al ofrecer/confirmar horarios nombra el día y la fecha correctos.` +
      `\n\n## Reglas ESTRICTAS de agendamiento (OBLIGATORIAS)\n` +
      `- Solo puedes ofrecer horarios que getAvailability devolvió EXACTAMENTE (copia su campo "cuando" tal cual). PROHIBIDO mencionar cualquier otra hora, extrapolar ("también a las 18:15") o suponer horarios de atención.\n` +
      `- Si el paciente pide una hora que no está en la lista, di que esa hora no está disponible y ofrece las reales de getAvailability.\n` +
      `- NO afirmes feriados, cierres ni horarios de la clínica que no te consten: consulta getAvailability y responde según lo que devuelva.\n` +
      `- NUNCA pidas el número de teléfono para agendar: ya se usa automáticamente el número de este chat.\n` +
      `- Si el paciente pide un día o semana DISTINTOS a los de la última lista, vuelve a llamar getAvailability con fromDate/toDate de ESE día antes de ofrecer o agendar. Los ids (h1, h2…) solo sirven para la ÚLTIMA lista mostrada.\n` +
      `- Agenda UNA sola cita por conversación: elige el horario con el paciente y llama a createAppointment UNA vez. Si responde alreadyBooked, la cita YA existe: confírmala, no crees otra.\n` +
      `- Al confirmar la cita, usa EXACTAMENTE el campo "cuando" que devolvió createAppointment (esa es la fecha/hora real agendada). Si no coincide con lo que pidió el paciente, discúlpate y corrige; jamás anuncies otra fecha.`;
    const runtime: AgentRuntime = {
      agentId: agent.id,
      agentVersionId: "sandbox",
      slug: agent.slug,
      name: agent.name,
      systemPrompt: assembleSystemPrompt(input.systemPrompt, input.actions) + currentDateBlock,
      model: aiCfg.model ?? env.AI_DEFAULT_MODEL,
      maxTokens: aiCfg.maxTokens ?? 400,
      maxToolRounds: aiCfg.maxToolRounds ?? 5,
      tools: input.tools ?? [],
    };

    const history: AIChatMessage[] = input.messages.map((m) => ({ role: m.role, content: m.content }));
    while (history.length && history[0].role !== "user") history.shift();
    if (!history.length) throw new BadRequestException("El primer mensaje debe ser del usuario");

    const vars: Record<string, string> = {
      "organization.name": org?.name ?? "",
      "clinic.name": clinic?.name ?? "",
      "clinic.city": clinic?.city ?? "",
      "clinic.address": clinic?.address ?? "",
      "contact.firstName": state.contact.firstName ?? "",
      "agent.name": agent.name,
    };

    const ai = createAIRouter({ anthropicApiKey: env.ANTHROPIC_API_KEY, openaiApiKey: env.OPENAI_API_KEY });
    try {
      const result = await orchestrate(ai, sandboxRegistry, { ctx: toolCtx, agent: runtime, history, vars });

      // Paridad con PRODUCCIÓN: si el turno derivó a otro agente (por transferToAgent o por
      // assignConversation con destino-agente), resolvemos el destino IGUAL que el runtime
      // (nombre/slug) y SIMULAMOS su respuesta inmediata. Así el probador no miente: si en prod
      // el destino no existiera, acá tampoco aparece transferencia.
      const transferRaw = result.transferToAgentSlug ?? sandboxHandoffSlug(result.toolEvents);
      let transfer: { slug: string; name: string; reply: string | null; toolEvents: unknown[] } | null = null;
      if (transferRaw) {
        const target = await this.prisma.withTenant(orgId, (tx) => resolveAgentByNameOrSlug(tx, transferRaw));
        if (target && target.active && target.slug !== agent.slug) {
          const tv = await this.prisma.withTenant(orgId, (tx) =>
            tx.agentVersion.findFirst({ where: { agentId: target.id, status: "PUBLISHED" }, orderBy: { version: "desc" } }),
          );
          if (tv) {
            const tRuntime: AgentRuntime = {
              agentId: target.id,
              agentVersionId: "sandbox",
              slug: target.slug,
              name: target.name,
              systemPrompt: assembleSystemPrompt(tv.systemPrompt, (tv.config as { actions?: Record<string, { enabled: boolean; instructions?: string }> } | null)?.actions),
              model: aiCfg.model ?? env.AI_DEFAULT_MODEL,
              maxTokens: aiCfg.maxTokens ?? 400,
              maxToolRounds: aiCfg.maxToolRounds ?? 5,
              tools: Array.isArray(tv.tools) ? (tv.tools as string[]) : [],
            };
            const tResult = await orchestrate(ai, sandboxRegistry, { ctx: toolCtx, agent: tRuntime, history, vars: { ...vars, "agent.name": target.name } });
            result.usage.inputTokens += tResult.usage.inputTokens;
            result.usage.outputTokens += tResult.usage.outputTokens;
            result.usage.costUsd += tResult.usage.costUsd;
            transfer = { slug: target.slug, name: target.name, reply: tResult.reply, toolEvents: tResult.toolEvents };
          }
        }
      }

      // La prueba consumió tokens reales del proveedor: se contabiliza para que
      // el tope diario sea fiel. Se marca como test para no confundir métricas.
      await this.prisma.withTenant(orgId, (tx) =>
        tx.usageEvent.create({
          data: {
            organizationId: orgId,
            type: "ai_tokens",
            quantity: result.usage.inputTokens + result.usage.outputTokens,
            costUsd: result.usage.costUsd,
            meta: { test: true, source: "agent_tester", agentSlug: agent.slug, model: runtime.model },
          },
        }),
      );

      return {
        ok: true,
        reply: result.reply,
        toolEvents: result.toolEvents,
        simulated: state.simulated,
        contact: state.contact,
        usage: result.usage,
        latencyMs: result.latencyMs,
        stopReason: result.stopReason,
        // Slug REAL resuelto del destino (null si no se derivó o el destino no existe).
        transferToAgentSlug: transfer?.slug ?? null,
        // Respuesta del agente destino (lo que el cliente recibiría en el mismo turno).
        transfer,
        humanHandoff: result.humanHandoff ?? false,
      };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e).slice(0, 300), model: runtime.model };
    }
  }

  /** Guarda el borrador: actualiza el DRAFT vigente o crea la versión siguiente. */
  @Put(":id/draft")
  saveDraft(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("agents:write");
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
    const ctx = requirePermission("agents:write");
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
    const ctx = requirePermission("agents:write");
    const input = parse(z.object({ active: z.boolean() }), body);
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.agent.update({ where: { id }, data: { active: input.active } });
      return { ok: true, active: input.active };
    });
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    const ctx = requirePermission("agents:write");
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
