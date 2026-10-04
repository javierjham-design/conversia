import { BadRequestException, NotFoundException } from "@nestjs/common";
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
import type { PrismaService } from "../prisma.service";
import { buildSandboxServices, type SandboxState } from "./agent-sandbox";

/**
 * LÓGICA COMPARTIDA de agentes (schemas + probador). La usan el controller del TENANT
 * (apps/web, vía withTenant del JWT) y el de PLATAFORMA (consola F10, vía withTenant del orgId
 * de la ruta). El probador es agnóstico del llamador: opera SIEMPRE con `withTenant(orgId)`
 * (RLS), así una sola fuente de verdad sirve a ambos mundos sin duplicar ni filtrar tenants.
 */

export const createAgentSchema = z.object({
  name: z.string().min(2).max(60),
  kind: z.string().default("custom"),
  description: z.string().max(300).optional(),
});

export const draftSchema = z.object({
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

const actionStateSchema = z.object({ enabled: z.boolean(), instructions: z.string().max(2000).optional() }).passthrough();

export const testSchema = z.object({
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
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) })).min(1).max(40),
  contact: z
    .object({
      firstName: z.string().max(80).nullable().optional(),
      lastName: z.string().max(80).nullable().optional(),
      email: z.string().max(160).nullable().optional(),
      phone: z.string().max(40).nullable().optional(),
    })
    .optional(),
});
// z.input (no z.infer): acepta el resultado de `parse` tanto del tenant como de plataforma
// (los campos con default quedan opcionales); dentro usamos ?? y casts donde hace falta.
export type AgentTestInput = z.input<typeof testSchema>;

export const DEFAULT_PROMPT = `Eres {{agent.name}}, asistente virtual de {{organization.name}} ({{clinic.name}}). Atiendes por WhatsApp de forma cercana, profesional y breve (máximo 2-3 frases, una pregunta a la vez). Responde SOLO con información obtenida de tus herramientas; si no sabes algo, reconócelo y ofrece que una persona del equipo contacte. Nunca inventes precios, horarios ni disponibilidad, y nunca entregues indicaciones clínicas. Si detectas urgencia, frustración o piden hablar con una persona, usa transferToHuman. SIEMPRE respondes al cliente con un mensaje y un siguiente paso claro: nunca lo dejes sin respuesta. NUNCA prometas una acción que no realizas en el momento ("déjame guardarlo", "ahora lo hago"): hazla con tu herramienta o dile el siguiente paso concreto, sin dejar nada pendiente en el aire.`;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

// Registro de tools compartido para el probador (una sola vez por proceso).
const sandboxRegistry = new ToolRegistry();
for (const tool of buildCoreTools()) sandboxRegistry.register(tool);

/** Slug destino cuando el modelo derivó vía assignConversation (marcador). */
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

/**
 * PROBADOR en vivo: ejecuta un turno con la config ACTUAL (sin publicar) contra un entorno
 * de prueba (lecturas reales, escrituras simuladas). Respeta kill switch / suspensión /
 * vigencia / tope diario de tokens y registra el consumo (meta.source="agent_tester").
 * Parametrizado por orgId → lo llaman tenant y plataforma por igual.
 */
export async function runAgentTest(prisma: PrismaService, orgId: string, agentId: string, input: AgentTestInput) {
  const env = getEnv();

  const loaded = await prisma.withTenant(orgId, async (tx) => {
    const agent = await tx.agent.findFirst({ where: { id: agentId, deletedAt: null } });
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
  const budget = await prisma.withTenant(orgId, async (tx) => {
    const override = (orgSettings.limits as Record<string, number> | undefined)?.aiTokensDaily;
    if (typeof override === "number") return override;
    const sub = await tx.subscription.findFirst({ where: { status: { in: ["ACTIVE", "TRIALING"] } }, orderBy: { createdAt: "desc" } });
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
    const spent = await prisma.withTenant(orgId, (tx) =>
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
    appointmentDurationMin: typeof (input.config as any)?.scheduling?.appointmentDurationMin === "number" ? (input.config as any).scheduling.appointmentDurationMin : null,
  });
  const toolCtx: ToolContext = {
    organizationId: orgId,
    clinicId: clinic?.id ?? null,
    conversationId: `sandbox:${orgId}:${Date.now()}`,
    contactId: "sandbox",
    agentId: agent.id,
    agentName: agent.name,
    agentVersionId: "sandbox",
    services: services as unknown as Record<string, unknown>,
  };

  const aiCfg = (orgSettings.ai ?? {}) as Record<string, any>;
  const nowChile = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
  const hasAgenda = (input.tools ?? []).includes("getAvailability");
  const schedulingRules = hasAgenda
    ? `\n\n## Reglas ESTRICTAS de agendamiento (OBLIGATORIAS)\n` +
      `- Solo puedes ofrecer horarios que getAvailability devolvió EXACTAMENTE (copia su campo "cuando" tal cual). PROHIBIDO mencionar cualquier otra hora, extrapolar ("también a las 18:15") o suponer horarios de atención.\n` +
      `- Si el paciente pide una hora que no está en la lista, di que esa hora no está disponible y ofrece las reales de getAvailability.\n` +
      `- NO afirmes feriados, cierres ni horarios de la clínica que no te consten: consulta getAvailability y responde según lo que devuelva.\n` +
      `- TELÉFONO: en WhatsApp NUNCA lo pidas (ya se usa el número del chat). En Instagram/Messenger el contacto puede NO tener número: si createAppointment responde que falta, pídeselo UNA sola vez y vuelve a llamar createAppointment pasándolo en el campo telefono (se guarda solo).\n` +
      `- FRANJAS: para la clínica "mañana" = 09:00–13:59 y "tarde" = desde las 14:00. Si el paciente pide mañana o tarde, pasa el parámetro franja a getAvailability. NUNCA contradigas la franja de la tool. Si responde sinCupos, aplica SOLO al rango consultado: ofrece la otra franja u otro rango; JAMÁS afirmes que no hay cupos "hasta" una fecha que no consultaste. Si trae "nota", síguela al pie de la letra.\n` +
      `- Si el paciente pide un día o semana DISTINTOS a los de la última lista, vuelve a llamar getAvailability con fromDate/toDate de ESE día antes de ofrecer o agendar. Los ids solo sirven para la ÚLTIMA lista mostrada.\n` +
      `- El id de cada horario codifica día y hora (h0409-1015 = día 04-09 a las 10:15). Al agendar, usa el id cuya hora coincide EXACTAMENTE con la que eligió el paciente; jamás uses otro.\n` +
      `- Al ofrecer horarios, muestra las horas tal cual ("09:15", "10:15"), NUNCA numeres las opciones (1, 2, 3).\n` +
      `- Agenda UNA sola cita por conversación: elige el horario con el paciente y llama a createAppointment UNA vez. Si responde alreadyBooked, la cita YA existe: confírmala, no crees otra.\n` +
      `- Al confirmar la cita, usa EXACTAMENTE el campo "cuando" que devolvió createAppointment. Si no coincide con lo que pidió el paciente, discúlpate y corrige; jamás anuncies otra fecha.`
    : `\n\n## SIN ACCESO A LA AGENDA (OBLIGATORIO)\n` +
      `Este agente NO tiene herramientas de agenda: NO puedes saber qué horas hay disponibles, qué días se atiende, ni si un día es feriado. ` +
      `PROHIBIDO afirmar O NEGAR disponibilidad — todo eso sería inventado. ` +
      `Si el paciente quiere agendar, reagendar o pregunta por horarios: deriva la conversación (assignConversation al agente/equipo que agenda) o dile que el equipo le confirmará el horario a la brevedad. Nada más.`;
  const dayFmt = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", weekday: "long", day: "numeric", month: "long" });
  const calendario14 = Array.from({ length: 14 }, (_, i) => dayFmt.format(new Date(Date.now() + i * 86_400_000))).join(" · ");
  const currentDateBlock =
    `\n\n## Fecha y hora actual (ÚSALA SIEMPRE)\nHoy es ${nowChile} (hora de Chile). Interpreta "hoy", "mañana", "el lunes", "esta semana" con ESTA fecha real.\n` +
    `CALENDARIO de los próximos 14 días — USA ESTA TABLA para convertir día de semana → fecha (JAMÁS lo calcules tú): ${calendario14}.` +
    schedulingRules;
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

    const transferRaw = result.transferToAgentSlug ?? sandboxHandoffSlug(result.toolEvents);
    let transfer: { slug: string; name: string; reply: string | null; toolEvents: unknown[] } | null = null;
    if (transferRaw) {
      const target = await prisma.withTenant(orgId, (tx) => resolveAgentByNameOrSlug(tx, transferRaw));
      if (target && target.active && target.slug !== agent.slug) {
        const tv = await prisma.withTenant(orgId, (tx) =>
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

    await prisma.withTenant(orgId, (tx) =>
      tx.usageEvent.create({
        data: {
          organizationId: orgId,
          type: "ai_tokens",
          quantity: result.usage.inputTokens + result.usage.outputTokens,
          costUsd: result.usage.costUsd,
          // origin "console-test" cuando lo dispara la consola de plataforma; "agent_tester" del panel del tenant.
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
      transferToAgentSlug: transfer?.slug ?? null,
      transfer,
      humanHandoff: result.humanHandoff ?? false,
    };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 300), model: runtime.model };
  }
}
