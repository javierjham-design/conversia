import { withTenant } from "@conversia/database";
import {
  ToolRegistry,
  assembleSystemPrompt,
  buildCoreTools,
  createAIRouter,
  orchestrate,
  type AgentRuntime,
} from "@conversia/agents";
import { getEnv } from "@conversia/config";
import {
  executeFrom,
  findStartNode,
  resumeAfterWait,
  resumeWithBranch,
  type EngineDeps,
  type EngineResult,
  type RunCtx,
} from "@conversia/workflows";
import type { AIChatMessage, ToolContext, WorkflowDefinition } from "@conversia/types";
import { buildSandboxServices, type SandboxContact, type SimulatedAction } from "../agents/agent-sandbox";

/**
 * Simulador INTERACTIVO de flujos (botón "Probar"). A diferencia del recorrido
 * estático (workflow-sandbox.ts), este ejecuta el flujo de verdad con el motor
 * puro (@conversia/workflows) y `EngineDeps` de sandbox:
 *
 *  - `Enviar mensaje` → burbuja del bot con las variables ya resueltas.
 *  - `Ejecutar agente IA` / `Agente con objetivo` → LLAMA A LA IA REAL
 *    (mismo camino que el probador de agentes: orchestrate + sandbox), con las
 *    herramientas del agente; las lecturas son reales y las escrituras simuladas.
 *  - `Esperar` → pausa el flujo mostrando la duración real; se puede "adelantar
 *    el tiempo" o (si aplica) cancelar cuando el contacto responde.
 *  - `Condición (sin respuesta)` → ramifica según si el contacto ya respondió.
 *
 * NO envía WhatsApp, NO escribe en la BD del tenant (solo cuenta tokens de IA,
 * marcados como test). El estado viaja de ida y vuelta con el cliente (sin
 * sesión en servidor): cada paso recibe el estado previo + una acción del
 * operador y devuelve el estado nuevo con el registro completo para pintar.
 */

const registry = new ToolRegistry();
for (const tool of buildCoreTools()) registry.register(tool);
const ai = createAIRouter({ anthropicApiKey: getEnv().ANTHROPIC_API_KEY, openaiApiKey: getEnv().OPENAI_API_KEY });

export type SimEvent =
  | { kind: "message"; from: "contact" | "bot"; text: string; agent?: string | null }
  | { kind: "action"; label: string; detail: string }
  | { kind: "wait"; text: string }
  | { kind: "branch"; text: string }
  | { kind: "info"; text: string }
  | { kind: "end"; text: string };

export interface SimWaiting {
  nodeId: string;
  label: string;
  dueAtMs: number;
  cancelOnReply: boolean;
}

export interface SimObjective {
  nodeId: string;
  objective: string;
  agentSlug: string | null;
  turnsLeft: number;
}

/** "waiting": el flujo está en una espera. "agent_chat": el agente activo quedó
 *  a cargo y el contacto puede seguir conversando. "done"/"failed": terminó. */
export type SimStatus = "waiting" | "agent_chat" | "done" | "failed";

export interface LiveSimState {
  variables: Record<string, string>;
  transcript: { role: "user" | "assistant"; content: string }[];
  contact: SandboxContact;
  activeAgentSlug: string | null;
  aiEnabled: boolean;
  replied: boolean;
  simulated: SimulatedAction[];
  log: SimEvent[];
  status: SimStatus;
  waiting: SimWaiting | null;
  objective: SimObjective | null;
  error?: string | null;
  /** Transitorio: la config "pending" de un ai_objective; se consume en el mismo paso. */
  _pending?: SimObjective;
}

export interface SimActionInput {
  type: "start" | "advance" | "reply";
  text?: string;
}

function describeWait(cfg: Record<string, any>): string {
  const d = Number(cfg.days ?? 0);
  const h = Number(cfg.hours ?? 0);
  const m = Number(cfg.minutes ?? 0);
  const parts: string[] = [];
  if (d) parts.push(`${d} día(s)`);
  if (h) parts.push(`${h} hora(s)`);
  if (m) parts.push(`${m} minuto(s)`);
  return parts.join(" ") || "un instante";
}

// ---- Ejecución de un turno del agente con IA REAL (sandbox) ----------------

async function runSimAgentTurn(
  orgId: string,
  state: LiveSimState,
  opts: { agentSlug?: string | null; objective?: string },
): Promise<void> {
  const history: AIChatMessage[] = state.transcript.map((m) => ({ role: m.role, content: m.content }));
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length) {
    state.log.push({ kind: "info", text: "El agente aún no responde: el contacto todavía no ha escrito nada." });
    return;
  }

  const loaded = await withTenant(orgId, async (tx) => {
    let agent = null as Awaited<ReturnType<typeof tx.agent.findUnique>> | null;
    const slug = opts.agentSlug || state.activeAgentSlug;
    if (slug) {
      agent = await tx.agent.findUnique({ where: { organizationId_slug: { organizationId: orgId, slug } } });
    }
    if (!agent) {
      const channel = await tx.channelConnection.findFirst({ where: { status: "active" } });
      if (channel?.defaultAgentId) agent = await tx.agent.findUnique({ where: { id: channel.defaultAgentId } });
    }
    if (!agent || !agent.active) return null;
    const version = await tx.agentVersion.findFirst({
      where: { agentId: agent.id, status: "PUBLISHED" },
      orderBy: { version: "desc" },
    });
    const [org, clinic] = await Promise.all([
      tx.organization.findUnique({ where: { id: orgId } }),
      tx.clinic.findFirst({ where: { active: true, deletedAt: null } }),
    ]);
    return { agent, version, org, clinic };
  });

  if (!loaded) {
    state.log.push({ kind: "info", text: "No hay un agente IA activo para responder en este punto." });
    return;
  }
  const { agent, version, org, clinic } = loaded;
  if (!version) {
    state.log.push({ kind: "info", text: `El agente «${agent.name}» no tiene versión publicada.` });
    return;
  }

  const env = getEnv();
  const orgSettings = (org?.settings ?? {}) as Record<string, any>;
  if (env.AI_GLOBAL_KILL_SWITCH || orgSettings.aiKillSwitch === true) {
    state.log.push({ kind: "info", text: "La IA está pausada (kill switch): el agente no respondería." });
    return;
  }
  if (org?.status === "SUSPENDED" || org?.status === "CANCELLED") {
    state.log.push({ kind: "info", text: `La organización está ${org.status}: la IA está detenida.` });
    return;
  }

  const cfg = (version.config ?? {}) as Record<string, any>;
  const aiCfg = (orgSettings.ai ?? {}) as Record<string, any>;
  const runtime: AgentRuntime = {
    agentId: agent.id,
    agentVersionId: version.id,
    slug: agent.slug,
    name: agent.name,
    systemPrompt:
      assembleSystemPrompt(version.systemPrompt, cfg.actions) +
      (opts.objective ? `\n\n## Objetivo inmediato para esta conversación\n${opts.objective}` : ""),
    model: aiCfg.model ?? env.AI_DEFAULT_MODEL,
    maxTokens: aiCfg.maxTokens ?? 400,
    maxToolRounds: aiCfg.maxToolRounds ?? 5,
    tools: Array.isArray(version.tools) ? (version.tools as string[]) : [],
  };

  const before = state.simulated.length;
  const services = await buildSandboxServices(
    orgId,
    { contact: state.contact, simulated: state.simulated },
    { knowledgeSources: Array.isArray(cfg.knowledgeSources) ? (cfg.knowledgeSources as string[]) : null },
  );
  const toolCtx: ToolContext = {
    organizationId: orgId,
    clinicId: clinic?.id ?? null,
    conversationId: "sandbox",
    contactId: "sandbox",
    agentId: agent.id,
    agentVersionId: version.id,
    services: services as unknown as Record<string, unknown>,
  };
  const vars: Record<string, string> = {
    "organization.name": org?.name ?? "",
    "clinic.name": clinic?.name ?? "",
    "clinic.city": clinic?.city ?? "",
    "clinic.address": clinic?.address ?? "",
    "contact.firstName": state.contact.firstName ?? "",
    "agent.name": agent.name,
  };

  let result;
  try {
    result = await orchestrate(ai, registry, { ctx: toolCtx, agent: runtime, history, vars });
  } catch (e) {
    state.log.push({ kind: "info", text: `Error al ejecutar el agente: ${(e as Error).message}` });
    return;
  }

  // Contabiliza tokens reales (marcado test, no ensucia métricas de producción).
  await withTenant(orgId, (tx) =>
    tx.usageEvent.create({
      data: {
        organizationId: orgId,
        type: "ai_tokens",
        quantity: result.usage.inputTokens + result.usage.outputTokens,
        costUsd: result.usage.costUsd,
        meta: { test: true, source: "workflow_tester", agentSlug: agent.slug, model: runtime.model },
      },
    }),
  );

  state.activeAgentSlug = agent.slug;
  // Acciones que el agente ejecutó (etiquetar, agendar, etc.) — se muestran.
  for (const sim of state.simulated.slice(before)) {
    state.log.push({ kind: "action", label: sim.action, detail: sim.detail });
  }
  if (result.reply) {
    state.transcript.push({ role: "assistant", content: result.reply });
    state.log.push({ kind: "message", from: "bot", text: result.reply, agent: agent.name });
  } else {
    state.log.push({ kind: "info", text: `El agente «${agent.name}» no devolvió texto (quizá solo ejecutó una acción).` });
  }
  if (result.transferToAgentSlug && result.transferToAgentSlug !== agent.slug) {
    state.activeAgentSlug = result.transferToAgentSlug;
    state.log.push({ kind: "info", text: `El agente derivó la conversación a «${result.transferToAgentSlug}».` });
  }
}

/** ¿El objetivo ya se cumplió? (mejor esfuerzo, modelo económico). */
async function evaluateObjectiveSim(state: LiveSimState, objective: string): Promise<boolean> {
  if (!objective.trim()) return false;
  try {
    const transcript = state.transcript
      .slice(-12)
      .map((m) => `${m.role === "user" ? "Cliente" : "Agente"}: ${m.content}`)
      .join("\n");
    const res = await ai.chat({
      model: getEnv().AI_DEFAULT_MODEL,
      system: "Eres un evaluador estricto. Responde ÚNICAMENTE 'SI' o 'NO'.",
      messages: [
        {
          role: "user",
          content: `Objetivo: "${objective}".\n\nConversación:\n${transcript}\n\n¿El objetivo YA se cumplió de forma clara? Responde solo SI o NO.`,
        },
      ],
      maxTokens: 3,
    });
    return /\bs[íi]\b/i.test(res.text ?? "");
  } catch {
    return false;
  }
}

// ---- EngineDeps de sandbox --------------------------------------------------

function makeSimDeps(orgId: string, state: LiveSimState): EngineDeps {
  const action = (label: string, detail: string) => {
    state.simulated.push({ action: label, detail });
    state.log.push({ kind: "action", label, detail });
  };
  return {
    async sendText(_ctx, text) {
      state.transcript.push({ role: "assistant", content: text });
      state.log.push({ kind: "message", from: "bot", text });
    },
    async runAgent(_ctx, agentSlug) {
      await runSimAgentTurn(orgId, state, { agentSlug: agentSlug ?? null });
    },
    async updateLeadStatus(_ctx, statusCode) {
      action("Cambiar etapa del lead", statusCode);
    },
    async addTag(_ctx, tag) {
      action("Etiquetar", `#${tag}`);
    },
    async transferHuman(_ctx, reason) {
      state.aiEnabled = false;
      action("Escalar a un humano", reason || "—");
    },
    async setAiEnabled(_ctx, enabled) {
      state.aiEnabled = enabled;
      state.log.push({ kind: "info", text: enabled ? "La IA quedó activada." : "La IA quedó en pausa." });
    },
    async closeConversation() {
      action("Cerrar la conversación", "—");
    },
    async removeTag(_ctx, tag) {
      action("Quitar etiqueta", `#${tag}`);
    },
    async updateContact(_ctx, fields) {
      const updated: string[] = [];
      const f = fields as Record<string, unknown>;
      if (typeof f.firstName === "string" && f.firstName.trim()) {
        state.contact.firstName = f.firstName.trim();
        state.variables["contact.firstName"] = f.firstName.trim();
        updated.push("nombre");
      }
      if (typeof f.lastName === "string" && f.lastName.trim()) {
        state.contact.lastName = f.lastName.trim();
        updated.push("apellido");
      }
      if (typeof f.email === "string" && f.email.trim()) {
        state.contact.email = f.email.trim();
        updated.push("email");
      }
      if (updated.length) action("Actualizar datos del contacto", updated.join(", "));
    },
    async assignUser(_ctx, userId) {
      state.aiEnabled = false;
      action("Asignar a un usuario", userId);
    },
    async assignTeam(_ctx, teamId) {
      state.aiEnabled = false;
      action("Asignar a un equipo", teamId);
    },
    async switchAgent(_ctx, agentSlug) {
      if (!agentSlug) return;
      state.activeAgentSlug = agentSlug;
      state.aiEnabled = true;
      state.log.push({ kind: "info", text: `El agente «${agentSlug}» toma el control.` });
    },
    async startWorkflow(_ctx, workflowName) {
      action("Disparar otro flujo", `${workflowName} (no se ejecuta en la prueba)`);
    },
    async openConversation() {
      state.log.push({ kind: "info", text: "Se abre/reutiliza una conversación del contacto." });
    },
    async addNote(_ctx, text) {
      action("Nota interna", text.length > 120 ? `${text.slice(0, 120)}…` : text);
    },
    async sendCapiEvent(_ctx, config) {
      action("Evento CAPI (Meta)", `${config.eventName}${config.value ? ` — $${config.value} ${config.currency ?? "CLP"}` : ""}`);
    },
    async sendTemplate(_ctx, config) {
      action("Plantilla WhatsApp", `${String(config.templateId ?? "")} (no se envía en la prueba)`);
    },
    async sendInternalEmail(_ctx, config) {
      action("Correo interno al equipo", `${config.subject} → ${config.to.join(", ") || "(sin destinatarios)"}`);
    },
    async sendGa4Event(_ctx, config) {
      action("Evento GA4", config.eventName);
    },
    async appendGoogleSheetRow(_ctx, config) {
      action("Google Sheets", `${config.values.length} columna(s)`);
    },
    async runAgentWithObjective(_ctx, nodeId, cfg) {
      const objective = String(cfg.objective ?? "");
      const agentSlug = cfg.agentSlug ? String(cfg.agentSlug) : null;
      await runSimAgentTurn(orgId, state, { agentSlug, objective });
      if (!objective.trim()) return "unmet";
      if (await evaluateObjectiveSim(state, objective)) return "met";
      const maxTurns = Math.max(1, Number(cfg.maxTurns ?? 1));
      if (maxTurns <= 1) return "unmet";
      state._pending = { nodeId, objective, agentSlug, turnsLeft: maxTurns - 1 };
      return "pending";
    },
    async callApi(_ctx, config) {
      action("Petición HTTP", `${String((config as any).method ?? "GET")} ${String((config as any).url ?? (config as any).path ?? "")} (no se ejecuta en la prueba)`);
    },
    async scheduleTimer(_ctx, nodeId, dueAt, cancelOn) {
      state.waiting = { nodeId, label: "", dueAtMs: dueAt.getTime(), cancelOnReply: cancelOn === "contact_reply" };
    },
    async evaluateCondition(_ctx, config) {
      if (String(config.kind ?? "") === "no_reply") return !state.replied; // true = NO respondió
      return false;
    },
    async persistStep(_ctx, step) {
      if (step.status !== "COMPLETED") return;
      const out = (step.output ?? {}) as Record<string, unknown>;
      const branch = out.branch;
      if (branch === undefined) return;
      if (step.nodeType === "condition") {
        state.log.push({
          kind: "branch",
          text: branch === "true" ? "Condición: el contacto NO respondió → rama «Sin respuesta»." : "Condición: el contacto respondió → rama «Respondió».",
        });
      } else if (step.nodeType === "business_hours") {
        state.log.push({ kind: "branch", text: branch === "in" ? "Horario: dentro de atención → rama «Dentro»." : "Fuera de horario → rama «Fuera»." });
      }
    },
    now: () => new Date(),
    async getBusinessHoursDefault(_ctx) {
      const org = await withTenant(orgId, (tx) =>
        tx.organization.findUnique({ where: { id: orgId }, select: { timezone: true, settings: true } }),
      );
      const bh = ((org?.settings ?? {}) as Record<string, any>).businessHours;
      if (!bh?.hours) return null;
      return { hours: bh.hours, holidays: bh.holidays ?? [], timezone: org?.timezone ?? "America/Santiago" };
    },
  };
}

// ---- Aplicar el resultado del motor al estado ------------------------------

function applyResult(def: WorkflowDefinition, state: LiveSimState, result: EngineResult): void {
  if (result.status === "failed") {
    state.status = "failed";
    state.error = result.error;
    state.waiting = null;
    state.log.push({ kind: "info", text: `⚠ El flujo falló: ${result.error}` });
    return;
  }
  if (result.status === "waiting") {
    const nodeId = result.nodeId;
    const node = def.nodes.find((n) => n.id === nodeId);
    if (node?.type === "ai_objective") {
      const p = state._pending;
      state.objective = p ?? { nodeId, objective: String((node.config as any)?.objective ?? ""), agentSlug: null, turnsLeft: 0 };
      state._pending = undefined;
      state.waiting = null;
      state.status = "agent_chat";
      state.log.push({ kind: "info", text: `🎯 El agente quedó trabajando el objetivo: “${state.objective.objective}”. Responde como contacto para avanzar.` });
    } else {
      const cfg = (node?.config ?? {}) as Record<string, any>;
      const label = describeWait(cfg);
      if (state.waiting) state.waiting.label = label;
      else state.waiting = { nodeId, label, dueAtMs: Date.now(), cancelOnReply: cfg.cancelOn === "contact_reply" };
      state.status = "waiting";
      state.log.push({
        kind: "wait",
        text: `⏳ Espera de ${label}${state.waiting.cancelOnReply ? " (se cancela si el contacto responde)" : ""}.`,
      });
    }
    return;
  }
  // completed
  state.waiting = null;
  if (state.activeAgentSlug && state.aiEnabled) {
    state.status = "agent_chat";
    state.log.push({ kind: "end", text: "✅ El flujo terminó. El agente activo queda a cargo — puedes seguir conversando como contacto." });
  } else {
    state.status = "done";
    state.log.push({ kind: "end", text: "✅ Fin del flujo." });
  }
}

async function runEngine(
  orgId: string,
  def: WorkflowDefinition,
  state: LiveSimState,
  from: { kind: "start" } | { kind: "wait"; nodeId: string } | { kind: "branch"; nodeId: string; branch: string },
): Promise<void> {
  const deps = makeSimDeps(orgId, state);
  const ctx: RunCtx = {
    organizationId: orgId,
    runId: "sim",
    workflowId: "sim",
    versionId: "sim",
    conversationId: "sandbox",
    contactId: "sandbox",
    variables: state.variables,
  };
  let result: EngineResult;
  try {
    if (from.kind === "start") {
      const start = findStartNode(def);
      result = start ? await executeFrom(deps, ctx, def, start.id) : { status: "completed" };
    } else if (from.kind === "wait") {
      result = await resumeAfterWait(deps, ctx, def, from.nodeId);
    } else {
      result = await resumeWithBranch(deps, ctx, def, from.nodeId, from.branch);
    }
  } catch (e) {
    result = { status: "failed", nodeId: from.kind === "start" ? "" : from.nodeId, error: (e as Error).message };
  }
  state.variables = ctx.variables;
  applyResult(def, state, result);
}

// ---- API pública del módulo -------------------------------------------------

export async function stepWorkflowSim(
  orgId: string,
  def: WorkflowDefinition,
  opts: { contact?: { firstName?: string | null }; state?: LiveSimState | null; action: SimActionInput },
): Promise<LiveSimState> {
  // ----- Inicio -----
  if (opts.action.type === "start" || !opts.state) {
    const seed = await withTenant(orgId, async (tx) => {
      const [org, clinic, channel] = await Promise.all([
        tx.organization.findUnique({ where: { id: orgId } }),
        tx.clinic.findFirst({ where: { active: true, deletedAt: null } }),
        tx.channelConnection.findFirst({ where: { status: "active" } }),
      ]);
      let defaultAgentSlug: string | null = null;
      if (channel?.defaultAgentId) {
        const a = await tx.agent.findUnique({ where: { id: channel.defaultAgentId }, select: { slug: true, active: true } });
        if (a?.active) defaultAgentSlug = a.slug;
      }
      return { org, clinic, defaultAgentSlug };
    });
    const firstName = opts.contact?.firstName || "Prueba";
    const state: LiveSimState = {
      variables: {
        "organization.name": seed.org?.name ?? "",
        "clinic.name": seed.clinic?.name ?? "",
        "clinic.city": seed.clinic?.city ?? "",
        "clinic.address": seed.clinic?.address ?? "",
        "contact.firstName": firstName,
        "contact.lastName": "",
        "contact.phone": "+56 9 0000 0000",
        "appointment.date": "(fecha de la cita)",
        "appointment.time": "(hora)",
        "appointment.service": "(servicio)",
        "appointment.professional": "(profesional)",
      },
      transcript: [],
      contact: { firstName, lastName: null, phone: "+56900000000", email: null },
      activeAgentSlug: seed.defaultAgentSlug,
      aiEnabled: true,
      replied: false,
      simulated: [],
      log: [],
      status: "done",
      waiting: null,
      objective: null,
    };
    await runEngine(orgId, def, state, { kind: "start" });
    delete state._pending;
    return state;
  }

  const state = opts.state;
  const action = opts.action;

  // ----- Adelantar el tiempo / timeout -----
  if (action.type === "advance") {
    if (state.status === "waiting" && state.waiting) {
      const nodeId = state.waiting.nodeId;
      state.log.push({ kind: "info", text: "⏭️ Adelantaste el tiempo de espera." });
      state.waiting = null;
      await runEngine(orgId, def, state, { kind: "wait", nodeId });
    } else if (state.status === "agent_chat" && state.objective) {
      const nodeId = state.objective.nodeId;
      state.objective = null;
      state.log.push({ kind: "info", text: "⏱️ Tiempo del objetivo agotado → rama «No cumplido»." });
      await runEngine(orgId, def, state, { kind: "branch", nodeId, branch: "unmet" });
    }
    delete state._pending;
    return state;
  }

  // ----- Respuesta del contacto -----
  if (action.type === "reply") {
    const text = (action.text ?? "").trim();
    if (!text) return state;
    state.replied = true;
    state.transcript.push({ role: "user", content: text });
    state.log.push({ kind: "message", from: "contact", text });

    if (state.objective) {
      // ai_objective multi-turno: el agente responde con el objetivo y re-evalúa.
      await runSimAgentTurn(orgId, state, { agentSlug: state.objective.agentSlug, objective: state.objective.objective });
      if (await evaluateObjectiveSim(state, state.objective.objective)) {
        const nodeId = state.objective.nodeId;
        state.objective = null;
        state.log.push({ kind: "info", text: "🎯 Objetivo cumplido → continúa por la rama «Cumplido»." });
        await runEngine(orgId, def, state, { kind: "branch", nodeId, branch: "met" });
      } else {
        state.objective.turnsLeft -= 1;
        if (state.objective.turnsLeft <= 0) {
          const nodeId = state.objective.nodeId;
          state.objective = null;
          state.log.push({ kind: "info", text: "Se agotaron los turnos del objetivo → rama «No cumplido»." });
          await runEngine(orgId, def, state, { kind: "branch", nodeId, branch: "unmet" });
        }
      }
    } else if (state.status === "waiting" && state.waiting) {
      if (state.waiting.cancelOnReply) {
        state.log.push({ kind: "info", text: "✋ La espera se canceló porque el contacto respondió." });
        state.waiting = null;
        if (state.activeAgentSlug && state.aiEnabled) {
          await runSimAgentTurn(orgId, state, {});
          state.status = "agent_chat";
        } else {
          state.status = "done";
          state.log.push({ kind: "end", text: "✅ Fin del flujo." });
        }
      } else {
        if (state.activeAgentSlug && state.aiEnabled) await runSimAgentTurn(orgId, state, {});
        state.log.push({ kind: "info", text: "La espera del flujo sigue en curso (no se cancela por respuesta). Usa «Adelantar el tiempo» para continuar." });
      }
    } else {
      // agent_chat / done: el agente activo responde (conversación real).
      if (state.activeAgentSlug && state.aiEnabled) {
        await runSimAgentTurn(orgId, state, {});
        state.status = "agent_chat";
      } else {
        state.log.push({ kind: "info", text: "No hay un agente activo: el mensaje del contacto quedaría para un humano." });
      }
    }
    delete state._pending;
    return state;
  }

  delete state._pending;
  return state;
}
