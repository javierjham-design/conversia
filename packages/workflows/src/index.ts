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

export function renderVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
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
): Promise<{ branch?: string; wait?: Date; stop?: boolean }> {
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
      await deps.persistStep(ctx, { nodeId: node.id, nodeType: node.type, status: "COMPLETED", output: outcome.branch !== undefined ? { branch: outcome.branch } : undefined });
      if (outcome.stop) return { status: "completed" };
      currentId = nextNodeId(def, node.id, outcome.branch);
    } catch (err) {
      const message = (err as Error).message;
      await deps.persistStep(ctx, { nodeId: node.id, nodeType: node.type, status: "FAILED", error: message });
      return { status: "failed", nodeId: node.id, error: message };
    }
  }
  return { status: "completed" };
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
