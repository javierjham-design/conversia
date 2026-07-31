/**
 * @conversia/workflows — Motor de ejecución v0.
 *
 * Diseño: el estado vive en Postgres (workflow_runs / workflow_run_steps /
 * scheduled_jobs); este motor es puro y recibe sus efectos por inyección
 * (EngineDeps), lo que permite testearlo sin infraestructura. Las esperas
 * largas se materializan como scheduled_jobs que el worker sondea.
 */
import type { PlatformEvent, WorkflowDefinition, WorkflowEdge, WorkflowNode } from "@conversia/types";

export interface RunCtx {
  organizationId: string;
  runId: string;
  workflowId: string;
  versionId: string;
  conversationId?: string;
  contactId?: string;
  variables: Record<string, string>;
}

export interface EngineDeps {
  sendText(ctx: RunCtx, text: string): Promise<void>;
  runAgent(ctx: RunCtx, agentSlug?: string): Promise<void>;
  updateLeadStatus(ctx: RunCtx, statusCode: string): Promise<void>;
  addTag(ctx: RunCtx, tag: string): Promise<void>;
  transferHuman(ctx: RunCtx, reason?: string): Promise<void>;
  setAiEnabled(ctx: RunCtx, enabled: boolean): Promise<void>;
  closeConversation(ctx: RunCtx): Promise<void>;
  removeTag(ctx: RunCtx, tag: string): Promise<void>;
  updateContact(ctx: RunCtx, fields: Record<string, unknown>): Promise<void>;
  assignUser(ctx: RunCtx, userId: string): Promise<void>;
  assignTeam(ctx: RunCtx, teamId: string): Promise<void>;
  switchAgent(ctx: RunCtx, agentSlug: string): Promise<void>;
  startWorkflow(ctx: RunCtx, workflowName: string): Promise<void>;
  /** Abre (o reutiliza) una conversación para el contacto; setea ctx.conversationId. */
  openConversation(ctx: RunCtx): Promise<void>;
  /** Deja un comentario interno (solo el equipo lo ve) en la conversación. */
  addNote(ctx: RunCtx, text: string): Promise<void>;
  /** Encola un evento de Conversions API (Meta) con el ctwa_clid del contacto. */
  sendCapiEvent(ctx: RunCtx, config: { eventName: string; value?: number; currency?: string }): Promise<void>;
  /** Envía una plantilla HSM aprobada (funciona fuera de la ventana de 24 h). */
  sendTemplate(ctx: RunCtx, config: Record<string, unknown>): Promise<void>;
  /** Correo interno al EQUIPO (nunca masivo a contactos); subject/body ya renderizados. */
  sendInternalEmail(ctx: RunCtx, config: { to: string[]; subject: string; body: string }): Promise<void>;
  /** Entrega la conversación a un agente con un objetivo. "met"/"unmet"
   *  ramifican de inmediato; "pending" (multi-turno) deja al agente
   *  conversando y el run espera: respuestas del contacto lo reanudan con la
   *  rama correcta y el timeout resuelve "unmet". */
  runAgentWithObjective(ctx: RunCtx, nodeId: string, config: Record<string, unknown>): Promise<"met" | "unmet" | "pending">;
  /** Petición HTTP externa (con guard SSRF); mapea la respuesta a ctx.variables. */
  callApi(ctx: RunCtx, config: Record<string, unknown>): Promise<void>;
  /** Persiste el timer (scheduled_jobs). cancelOn: evento que lo cancela. */
  scheduleTimer(ctx: RunCtx, nodeId: string, dueAt: Date, cancelOn?: string): Promise<void>;
  /** Evalúa condiciones (p.ej. no_reply: ¿el contacto respondió desde runStartedAt?). */
  evaluateCondition(ctx: RunCtx, config: Record<string, unknown>): Promise<boolean>;
  persistStep(ctx: RunCtx, step: { nodeId: string; nodeType: string; status: "COMPLETED" | "FAILED" | "SKIPPED"; output?: unknown; error?: string }): Promise<void>;
  now(): Date;
}

export type EngineResult =
  | { status: "completed" }
  | { status: "waiting"; nodeId: string }
  | { status: "failed"; nodeId: string; error: string };

const MAX_NODES_PER_RUN = 50;
// Tope de saltos ("Saltar a otro paso") por ejecución — protección anti-bucle.
const MAX_JUMPS_PER_RUN = 25;

export function renderVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

const WEEKDAY_KEY: Record<string, string> = { Mon: "mon", Tue: "tue", Wed: "wed", Thu: "thu", Fri: "fri", Sat: "sat", Sun: "sun" };

/**
 * ¿`now` cae dentro del horario de atención definido en el nodo "Fecha y hora"?
 * Puro y determinista: usa Intl para resolver día/hora en la zona horaria del
 * tenant. config = { timezone, hours:{ mon:[{from,to}],… }, holidays:[YYYY-MM-DD] }.
 */
export function evalBusinessHours(config: Record<string, any>, now: Date): boolean {
  const tz = String(config.timezone || "America/Santiago");
  let parts: Record<string, string>;
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit",
      hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    });
    parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  } catch {
    return true; // zona horaria inválida → no bloquear el flujo
  }
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  const holidays: string[] = Array.isArray(config.holidays) ? config.holidays : [];
  if (holidays.includes(dateStr)) return false;
  const wd = WEEKDAY_KEY[parts.weekday] ?? "";
  const intervals: { from?: string; to?: string }[] = (config.hours ?? {})[wd] ?? [];
  const nowMin = Number(parts.hour) * 60 + Number(parts.minute);
  for (const iv of intervals) {
    const [fh, fm] = String(iv.from ?? "00:00").split(":").map(Number);
    const [th, tm] = String(iv.to ?? "23:59").split(":").map(Number);
    if (nowMin >= fh * 60 + fm && nowMin < th * 60 + tm) return true;
  }
  return false;
}

/** ¿El evento dispara este workflow? (matching de triggers, sección 16) */
export function matchesTrigger(def: WorkflowDefinition, event: PlatformEvent): boolean {
  const t = def.trigger.type;
  const cfg = def.trigger.config as Record<string, unknown>;
  const data = (event.data ?? {}) as Record<string, unknown>;

  // "keyword" (legado) se comporta como un message_received con palabra clave.
  if (t === "keyword") {
    if (event.type !== "message_received") return false;
    return typeof cfg.keyword === "string"
      ? String(data.text ?? "").toLowerCase().includes(cfg.keyword.toLowerCase())
      : true;
  }

  if (t !== event.type) return false;

  // Condiciones opcionales del mensaje entrante.
  if (t === "message_received") {
    if (typeof cfg.keyword === "string" && cfg.keyword.trim() && !String(data.text ?? "").toLowerCase().includes(cfg.keyword.toLowerCase())) {
      return false;
    }
    if (cfg.firstMessage === true && data.isFirstMessage !== true) return false;
    if (typeof cfg.channel === "string" && cfg.channel && data.channel && data.channel !== cfg.channel) return false;
  }
  // Anuncios Click-to-Chat: cualquier anuncio, o uno específico por ad_id.
  if (t === "click_to_chat") {
    if (typeof cfg.adId === "string" && cfg.adId.trim() && String(data.ad_id ?? "") !== cfg.adId.trim()) return false;
  }
  // Etapa del ciclo de vida: condiciones opcionales origen → destino.
  if (t === "lead_status_changed") {
    if (typeof cfg.toStatus === "string" && cfg.toStatus && String(data.statusCode ?? "") !== cfg.toStatus) return false;
    if (typeof cfg.fromStatus === "string" && cfg.fromStatus && String(data.fromCode ?? "") !== cfg.fromStatus) return false;
  }
  // Etiqueta añadida: opcionalmente restringido a una etiqueta por nombre.
  if (t === "tag_added") {
    if (typeof cfg.tag === "string" && cfg.tag.trim() && String(data.tag ?? "").toLowerCase() !== cfg.tag.trim().toLowerCase()) return false;
  }
  return true;
}

export function findStartNode(def: WorkflowDefinition): WorkflowNode | undefined {
  const withIncoming = new Set(def.edges.map((e: WorkflowEdge) => e.to));
  return def.nodes.find((n) => !withIncoming.has(n.id)) ?? def.nodes[0];
}

export function nextNodeId(def: WorkflowDefinition, from: string, branch?: string): string | undefined {
  const candidates = def.edges.filter((e) => e.from === from);
  if (branch !== undefined) {
    const matched = candidates.find((e) => e.when === branch);
    if (matched) return matched.to;
    // sin rama que coincida → tomar la rama sin condición si existe
    return candidates.find((e) => e.when === undefined)?.to;
  }
  return candidates.find((e) => e.when === undefined)?.to ?? candidates[0]?.to;
}

function computeWaitDue(config: Record<string, unknown>, now: Date): Date {
  const ms =
    (Number(config.minutes ?? 0) * 60 + Number(config.hours ?? 0) * 3600 + Number(config.days ?? 0) * 86400) * 1000;
  return new Date(now.getTime() + Math.max(ms, 1000));
}

async function executeNode(
  deps: EngineDeps,
  ctx: RunCtx,
  node: WorkflowNode,
): Promise<{ branch?: string; wait?: Date; stop?: boolean; goto?: string }> {
  const cfg = node.config as Record<string, any>;
  switch (node.type) {
    case "send_text":
      await deps.sendText(ctx, renderVars(String(cfg.text ?? ""), ctx.variables));
      return {};
    case "run_agent":
      await deps.runAgent(ctx, cfg.agentSlug);
      return {};
    case "update_lead_status":
      await deps.updateLeadStatus(ctx, String(cfg.statusCode));
      return {};
    case "add_tag":
      await deps.addTag(ctx, String(cfg.tag));
      return {};
    case "transfer_human":
      await deps.transferHuman(ctx, cfg.reason);
      return {};
    case "pause_ai":
      await deps.setAiEnabled(ctx, false);
      return {};
    case "resume_ai":
      await deps.setAiEnabled(ctx, true);
      return {};
    case "close_conversation":
      await deps.closeConversation(ctx);
      return {};
    case "remove_tag":
      await deps.removeTag(ctx, String(cfg.tag ?? ""));
      return {};
    case "update_contact":
      await deps.updateContact(ctx, (cfg.fields as Record<string, unknown>) ?? {});
      return {};
    case "assign_user":
      await deps.assignUser(ctx, String(cfg.userId ?? ""));
      return {};
    case "assign_team":
      await deps.assignTeam(ctx, String(cfg.teamId ?? ""));
      return {};
    case "switch_agent":
      await deps.switchAgent(ctx, String(cfg.agentSlug ?? ""));
      return {};
    case "start_workflow":
      await deps.startWorkflow(ctx, String(cfg.workflowName ?? ""));
      return {};
    case "open_conversation":
      await deps.openConversation(ctx);
      return {};
    case "add_note":
      await deps.addNote(ctx, renderVars(String(cfg.text ?? ""), ctx.variables));
      return {};
    case "business_hours":
      // Evaluación pura (determinista dado now()): "in" dentro de horario, "out" fuera.
      return { branch: evalBusinessHours(cfg, deps.now()) ? "in" : "out" };
    case "goto":
      return { goto: String(cfg.targetNodeId ?? "") };
    case "send_capi":
      await deps.sendCapiEvent(ctx, {
        eventName: String(cfg.eventName ?? "Lead"),
        value: cfg.value != null && cfg.value !== "" ? Number(cfg.value) : undefined,
        currency: cfg.currency ? String(cfg.currency) : undefined,
      });
      return {};
    case "ai_objective": {
      const verdict = await deps.runAgentWithObjective(ctx, node.id, cfg);
      if (verdict === "pending") {
        // Multi-turno: el agente sigue a cargo; si nadie resuelve antes,
        // el timeout reanuda el run por la rama "unmet".
        const timeoutHours = Math.max(1, Number(cfg.timeoutHours ?? 24));
        return { wait: new Date(deps.now().getTime() + timeoutHours * 3_600_000) };
      }
      return { branch: verdict };
    }
    case "call_api":
      await deps.callApi(ctx, cfg);
      return {};
    case "send_template":
      await deps.sendTemplate(ctx, cfg);
      return {};
    case "send_internal_email":
      await deps.sendInternalEmail(ctx, {
        to: Array.isArray(cfg.to) ? cfg.to.map(String) : [],
        subject: renderVars(String(cfg.subject ?? ""), ctx.variables),
        body: renderVars(String(cfg.body ?? ""), ctx.variables),
      });
      return {};
    case "send_tiktok_event":
    case "google_sheets_append":
      // "Próximamente": sin integración aún. No-op registrado (no se finge).
      return {};
    case "wait":
      return { wait: computeWaitDue(cfg, deps.now()) };
    case "condition": {
      const result = await deps.evaluateCondition(ctx, cfg);
      return { branch: String(result) };
    }
    case "stop":
      return { stop: true };
    default:
      // Nodo aún no implementado en v0: se registra y se continúa.
      return {};
  }
}

/**
 * Ejecuta el run desde un nodo dado hasta completar, esperar o fallar.
 * Idempotencia: el runtime marca el step (runId, nodeId) antes de re-entrar.
 */
export async function executeFrom(
  deps: EngineDeps,
  ctx: RunCtx,
  def: WorkflowDefinition,
  startNodeId: string,
): Promise<EngineResult> {
  let currentId: string | undefined = startNodeId;
  let executed = 0;
  let jumps = 0;

  while (currentId) {
    const node = def.nodes.find((n) => n.id === currentId);
    if (!node) return { status: "failed", nodeId: currentId, error: `Nodo no encontrado: ${currentId}` };
    if (++executed > MAX_NODES_PER_RUN) {
      return { status: "failed", nodeId: currentId, error: "Límite de nodos por ejecución excedido" };
    }

    try {
      const outcome = await executeNode(deps, ctx, node);
      if (outcome.wait) {
        await deps.scheduleTimer(ctx, node.id, outcome.wait, (node.config as any)?.cancelOn);
        await deps.persistStep(ctx, { nodeId: node.id, nodeType: node.type, status: "COMPLETED", output: { waitUntil: outcome.wait.toISOString() } });
        return { status: "waiting", nodeId: node.id };
      }
      await deps.persistStep(ctx, { nodeId: node.id, nodeType: node.type, status: "COMPLETED", output: outcome.branch !== undefined ? { branch: outcome.branch } : outcome.goto ? { goto: outcome.goto } : undefined });
      if (outcome.stop) return { status: "completed" };
      // "Saltar a otro paso": salta al nodo destino, acotado por MAX_JUMPS_PER_RUN.
      if (outcome.goto !== undefined) {
        if (!outcome.goto) return { status: "failed", nodeId: node.id, error: "Salto sin destino configurado" };
        if (++jumps > MAX_JUMPS_PER_RUN) {
          return { status: "failed", nodeId: node.id, error: `Límite de saltos excedido (${MAX_JUMPS_PER_RUN}) — posible bucle` };
        }
        currentId = outcome.goto;
        continue;
      }
      currentId = nextNodeId(def, node.id, outcome.branch);
    } catch (err) {
      const message = (err as Error).message;
      await deps.persistStep(ctx, { nodeId: node.id, nodeType: node.type, status: "FAILED", error: message });
      return { status: "failed", nodeId: node.id, error: message };
    }
  }
  return { status: "completed" };
}

/** Reanuda un run esperando en un nodo con ramas (p.ej. ai_objective
 *  multi-turno resuelto por respuesta del contacto o por timeout). */
export async function resumeWithBranch(
  deps: EngineDeps,
  ctx: RunCtx,
  def: WorkflowDefinition,
  nodeId: string,
  branch: string,
): Promise<EngineResult> {
  const next = nextNodeId(def, nodeId, branch);
  if (!next) return { status: "completed" };
  return executeFrom(deps, ctx, def, next);
}

/** Reanuda tras un timer vencido: continúa desde el sucesor del nodo wait. */
export async function resumeAfterWait(
  deps: EngineDeps,
  ctx: RunCtx,
  def: WorkflowDefinition,
  waitNodeId: string,
): Promise<EngineResult> {
  const next = nextNodeId(def, waitNodeId);
  if (!next) return { status: "completed" };
  return executeFrom(deps, ctx, def, next);
}
