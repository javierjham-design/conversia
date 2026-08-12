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
  nextNodeId,
  resumeAfterWait,
  resumeWithBranch,
  stepNode,
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
  /** "wait_reply": responder sigue por «Sí», adelantar el tiempo por «No». */
  kind?: "wait" | "wait_reply";
}

export interface SimObjective {
  nodeId: string;
  objective: string;
  agentSlug: string | null;
  turnsLeft: number;
}

/** "waiting": el flujo está en una espera. "agent_chat": el agente activo quedó
 *  a cargo y el contacto puede seguir conversando. "stepping": modo paso a paso,
 *  esperando "siguiente". "done"/"failed": terminó. */
export type SimStatus = "waiting" | "agent_chat" | "stepping" | "done" | "failed";

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
  // ── Paso a paso (probador sobre el canvas) ──
  mode?: "run" | "step";
  cursor?: string | null; // próximo nodo a ejecutar en modo paso a paso
  executed?: string[]; // nodos ya ejecutados (para resaltar en el canvas)
  failedNodeId?: string | null; // nodo que falló (resaltado en rojo)
  varsBefore?: Record<string, string>; // variables ANTES del último paso (inspector)
  lastStep?: { nodeId: string; nodeType: string; branch: string | null } | null;
  /** Transitorio: la config "pending" de un ai_objective; se consume en el mismo paso. */
  _pending?: SimObjective;
}

export interface SimActionInput {
  type: "start" | "advance" | "reply" | "next";
  text?: string;
  mode?: "run" | "step";
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
  // Igual que producción (agent-turn.ts): si la IA está en pausa, NINGÚN agente
  // responde —tampoco un paso «Ejecutar agente IA»—. Antes el simulador sí
  // respondía, y luego en producción quedaba mudo (pie silencioso).
  if (!state.aiEnabled) {
    state.log.push({
      kind: "info",
      text: "⏸️ La IA está en pausa (por un paso «Pausar IA» o una derivación a humano): el agente NO responde, tampoco en producción. Para que responda, agrega «Reanudar IA» —o usa «Cambiar agente IA», que reactiva la IA y fija el agente— antes de este paso.",
    });
    return;
  }
  const history: AIChatMessage[] = state.transcript.map((m) => ({ role: m.role, content: m.content }));
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length) {
    state.log.push({ kind: "info", text: "El agente aún no responde: el contacto todavía no ha escrito nada." });
    return;
  }

  // El agente que PIDIÓ el paso (no el activo por defecto): si se pidió uno
  // concreto y termina respondiendo otro, es una mala configuración y hay que
  // avisarlo (si no, parece que el flujo "no funciona").
  const requestedSlug = opts.agentSlug || null;
  const loaded = await withTenant(orgId, async (tx) => {
    let agent = null as Awaited<ReturnType<typeof tx.agent.findUnique>> | null;
    const slug = opts.agentSlug || state.activeAgentSlug;
    if (slug) {
      agent = await tx.agent.findUnique({ where: { organizationId_slug: { organizationId: orgId, slug } } });
    }
    const requestedInactive = Boolean(requestedSlug && agent && !agent.active);
    if (!agent || !agent.active) {
      // Igual que en producción (agent-turn.ts): si el agente pedido no resuelve,
      // responde el agente por defecto del canal.
      const channel = await tx.channelConnection.findFirst({ where: { status: "active" } });
      if (channel?.defaultAgentId) agent = await tx.agent.findUnique({ where: { id: channel.defaultAgentId } });
    }
    if (!agent || !agent.active) return null;
    const version = await tx.agentVersion.findFirst({
      where: { agentId: agent.id, status: "PUBLISHED" },
      orderBy: { version: "desc" },
    });
    return { agent, version, requestedInactive };
  });

  if (!loaded) {
    state.log.push({ kind: "info", text: "No hay un agente IA activo para responder en este punto." });
    return;
  }
  const [org, clinic] = await withTenant(orgId, (tx) =>
    Promise.all([
      tx.organization.findUnique({ where: { id: orgId } }),
      tx.clinic.findFirst({ where: { active: true, deletedAt: null } }),
    ]),
  );
  const { agent, version } = loaded;
  // Aviso honesto: el paso pedía un agente que no está disponible → responde otro.
  if (requestedSlug && agent.slug !== requestedSlug) {
    state.log.push({
      kind: "info",
      text: `⚠️ El paso pedía el agente «${requestedSlug}», pero ${loaded.requestedInactive ? "está desactivado o sin publicar" : "no existe con ese nombre"}. Responde el agente por defecto del canal («${agent.name}»). En producción pasaría lo mismo: revísalo en Agentes (activo + versión publicada) y vuelve a elegirlo en el paso.`,
    });
  }
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
    } else if (node?.type === "wait_reply") {
      const label = describeWait((node.config ?? {}) as Record<string, any>);
      state.waiting = { nodeId, label, dueAtMs: state.waiting?.dueAtMs ?? Date.now(), cancelOnReply: false, kind: "wait_reply" };
      state.status = "waiting";
      state.log.push({
        kind: "wait",
        text: `⏳ Esperando la respuesta del contacto (hasta ${label}). Responde para seguir por «Sí, respondió», o adelanta el tiempo para «No respondió».`,
      });
    } else {
      const cfg = (node?.config ?? {}) as Record<string, any>;
      const label = describeWait(cfg);
      if (state.waiting) state.waiting.label = label;
      else state.waiting = { nodeId, label, dueAtMs: Date.now(), cancelOnReply: cfg.cancelOn === "contact_reply" };
      state.waiting.kind = "wait";
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
      mode: opts.action.mode ?? "run",
      executed: [],
      failedNodeId: null,
    };
    // Modo paso a paso: NO ejecuta; deja el cursor en el primer nodo listo para "siguiente".
    if (opts.action.mode === "step") {
      const start = findStartNode(def);
      state.cursor = start?.id ?? null;
      state.status = state.cursor ? "stepping" : "done";
      state.log.push({ kind: "info", text: "▶ Modo paso a paso: pulsa «Siguiente» para ejecutar un paso a la vez." });
      return state;
    }
    await runEngine(orgId, def, state, { kind: "start" });
    delete state._pending;
    return state;
  }

  const state = opts.state;
  const action = opts.action;

  // ══════════════ Modo PASO A PASO (probador sobre el canvas) ══════════════
  if (state.mode === "step") {
    if (action.type === "next" && state.cursor) {
      const deps = makeSimDeps(orgId, state);
      const ctx: RunCtx = { organizationId: orgId, runId: "sim", workflowId: "sim", versionId: "sim", conversationId: "sandbox", contactId: "sandbox", variables: state.variables };
      const nodeId = state.cursor;
      const node = def.nodes.find((n) => n.id === nodeId);
      state.varsBefore = { ...state.variables };
      let result: Awaited<ReturnType<typeof stepNode>>;
      try {
        result = await stepNode(deps, ctx, def, nodeId);
      } catch (e) {
        result = { status: "failed", nodeId, error: (e as Error).message };
      }
      state.variables = ctx.variables;
      state.executed = [...(state.executed ?? []), nodeId];
      state.lastStep = { nodeId, nodeType: node?.type ?? "", branch: result.status === "continue" ? result.branch ?? null : null };
      if (result.status === "failed") {
        state.failedNodeId = nodeId;
        state.status = "failed";
        state.cursor = null;
        state.error = result.error;
        state.log.push({ kind: "info", text: `⚠ Falló en «${node?.type ?? nodeId}»: ${result.error}` });
      } else if (result.status === "waiting") {
        const cfg = (node?.config ?? {}) as Record<string, any>;
        const label = describeWait(cfg);
        state.waiting = node?.type === "wait_reply"
          ? { nodeId, label, dueAtMs: Date.now(), cancelOnReply: false, kind: "wait_reply" }
          : { nodeId, label, dueAtMs: Date.now(), cancelOnReply: cfg.cancelOn === "contact_reply", kind: "wait" };
        state.status = "waiting";
        state.cursor = null;
        state.log.push({ kind: "wait", text: node?.type === "wait_reply" ? `⏳ Esperando respuesta (hasta ${label}). Responde o adelanta el tiempo.` : `⏳ Espera de ${label}.` });
      } else if (result.status === "completed") {
        state.status = "done";
        state.cursor = null;
        state.log.push({ kind: "end", text: "✅ Fin del flujo." });
      } else {
        state.cursor = result.nextNodeId ?? null;
        state.status = state.cursor ? "stepping" : "done";
        if (!state.cursor) state.log.push({ kind: "end", text: "✅ Fin del flujo." });
      }
    } else if (action.type === "advance" && state.status === "waiting" && state.waiting) {
      const w = state.waiting;
      state.waiting = null;
      state.cursor = (w.kind === "wait_reply" ? nextNodeId(def, w.nodeId, "no_reply") : nextNodeId(def, w.nodeId)) ?? null;
      state.log.push({ kind: "info", text: w.kind === "wait_reply" ? "⏭️ Sin respuesta → rama «No respondió»." : "⏭️ Adelantaste el tiempo." });
      state.status = state.cursor ? "stepping" : "done";
      if (!state.cursor) state.log.push({ kind: "end", text: "✅ Fin del flujo." });
    } else if (action.type === "reply" && state.status === "waiting" && state.waiting) {
      const text = (action.text ?? "").trim();
      if (text) { state.replied = true; state.transcript.push({ role: "user", content: text }); state.log.push({ kind: "message", from: "contact", text }); }
      const w = state.waiting;
      state.waiting = null;
      if (w.kind === "wait_reply") {
        state.cursor = nextNodeId(def, w.nodeId, "replied") ?? null;
        state.log.push({ kind: "info", text: "✅ Respondió → rama «Sí, respondió»." });
      } else {
        state.cursor = w.cancelOnReply ? null : (nextNodeId(def, w.nodeId) ?? null);
        if (w.cancelOnReply) {
          const deadBranch = nextNodeId(def, w.nodeId) != null;
          state.log.push({
            kind: "info",
            text: deadBranch
              ? "✋ El paso «Esperar» está en «cancelar si responde» → la respuesta DETIENE el flujo. Lo que sigue (incl. una rama «Respondió») no corre. Usa «¿El contacto respondió?» para ramificar."
              : "✋ La espera se canceló por la respuesta.",
          });
        }
      }
      state.status = state.cursor ? "stepping" : "done";
      if (!state.cursor) state.log.push({ kind: "end", text: "✅ Fin del flujo." });
    }
    delete state._pending;
    return state;
  }

  // ----- Adelantar el tiempo / timeout -----
  if (action.type === "advance") {
    if (state.status === "waiting" && state.waiting) {
      const nodeId = state.waiting.nodeId;
      const isWaitReply = state.waiting.kind === "wait_reply";
      state.log.push({ kind: "info", text: isWaitReply ? "⏭️ Adelantaste el tiempo — el contacto no respondió → rama «No respondió»." : "⏭️ Adelantaste el tiempo de espera." });
      state.waiting = null;
      if (isWaitReply) await runEngine(orgId, def, state, { kind: "branch", nodeId, branch: "no_reply" });
      else await runEngine(orgId, def, state, { kind: "wait", nodeId });
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
    } else if (state.status === "waiting" && state.waiting && state.waiting.kind === "wait_reply") {
      // "¿El contacto respondió?": la respuesta continúa por la rama «Sí».
      const nodeId = state.waiting.nodeId;
      state.waiting = null;
      state.log.push({ kind: "info", text: "✅ El contacto respondió → continúa por la rama «Sí, respondió»." });
      await runEngine(orgId, def, state, { kind: "branch", nodeId, branch: "replied" });
    } else if (state.status === "waiting" && state.waiting) {
      if (state.waiting.cancelOnReply) {
        // OJO: en producción esto CANCELA el run (cancelTimersOnReply). Las ramas
        // que vengan después de este «Esperar» NO se ejecutan. Si el flujo tenía
        // una rama «Respondió», es un pie: hay que usar «¿El contacto respondió?».
        const nextAfterWait = nextNodeId(def, state.waiting.nodeId);
        state.waiting = null;
        state.log.push({
          kind: "info",
          text: nextAfterWait
            ? "✋ El contacto respondió y el paso «Esperar» está en «cancelar si responde» → en producción esto DETIENE el flujo aquí. Los pasos que siguen (incl. una rama «Respondió») no se ejecutan. Para ramificar según la respuesta usa «¿El contacto respondió?»."
            : "✋ La espera se canceló porque el contacto respondió.",
        });
        if (state.activeAgentSlug && state.aiEnabled) {
          state.log.push({ kind: "info", text: "En producción, tras cancelarse el flujo, respondería el agente activo del canal:" });
          await runSimAgentTurn(orgId, state, {});
          state.status = "agent_chat";
        } else {
          state.status = "done";
          state.log.push({ kind: "end", text: "✅ Fin del flujo (run cancelado por la respuesta)." });
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
