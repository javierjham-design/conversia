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
  /** Evento GA4 vía Measurement Protocol; params ya renderizados. */
  sendGa4Event(ctx: RunCtx, config: { eventName: string; params: Record<string, string> }): Promise<void>;
  /** Horario de atención del negocio (Configuración → Horario) como default del nodo «Fecha y hora». */
  getBusinessHoursDefault?(ctx: RunCtx): Promise<Record<string, unknown> | null>;
  /** Agrega una fila a Google Sheets (valores ya renderizados). */
  appendGoogleSheetRow(ctx: RunCtx, config: { spreadsheetId: string; sheetName: string; values: string[] }): Promise<void>;
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

/**
 * Filtros de los triggers de cita: servicio / profesional / sede. La config
 * guarda arrays de ids (`serviceIds`, `professionalIds`, `clinicIds`); un array
 * vacío o ausente = sin filtro (cualquiera). Puro y reutilizable tanto en el
 * matching de eventos como al programar recordatorios (appointment_upcoming).
 */
export function matchesApptFilter(cfg: Record<string, unknown>, data: Record<string, unknown>): boolean {
  const check = (ids: unknown, val: unknown): boolean => {
    if (!Array.isArray(ids) || ids.length === 0) return true;
    return ids.map(String).includes(String(val ?? ""));
  };
  return (
    check(cfg.serviceIds, data.serviceId) &&
    check(cfg.professionalIds, data.professionalId) &&
    check(cfg.clinicIds, data.clinicId)
  );
}

/** Triggers de cita basados en evento (excluye appointment_upcoming, que es programado). */
const APPOINTMENT_EVENT_TRIGGERS = new Set([
  "appointment_created",
  "appointment_confirmed",
  "appointment_rescheduled",
  "appointment_cancelled",
  "no_show",
]);

/**
 * ¿El texto cumple las condiciones de palabra/frase del disparador? Admite varias
 * palabras (`keywords[]` + `keyword` legado), "contiene" vs "exacto" (`matchType`)
 * y "cualquiera" vs "todas" (`matchAll`). Sin palabras configuradas = cualquiera.
 */
export function matchesKeywords(cfg: Record<string, unknown>, text: string): boolean {
  const words = [
    ...(Array.isArray(cfg.keywords) ? cfg.keywords.map(String) : []),
    ...(typeof cfg.keyword === "string" ? [cfg.keyword] : []),
  ]
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
  if (words.length === 0) return true;
  const haystack = text.toLowerCase().trim();
  const exact = cfg.matchType === "exact";
  const test = (w: string) => (exact ? haystack === w : haystack.includes(w));
  return cfg.matchAll === true ? words.every(test) : words.some(test);
}

/** ¿El evento dispara este workflow? (matching de triggers, sección 16) */
export function matchesTrigger(def: WorkflowDefinition, event: PlatformEvent): boolean {
  const t = def.trigger.type;
  const cfg = def.trigger.config as Record<string, unknown>;
  const data = (event.data ?? {}) as Record<string, unknown>;

  // "keyword" (legado) se comporta como un message_received con palabra clave.
  if (t === "keyword") {
    if (event.type !== "message_received") return false;
    return matchesKeywords(cfg, String(data.text ?? ""));
  }

  if (t !== event.type) return false;

  // Condiciones opcionales del mensaje entrante: canal, primer mensaje y
  // palabras/frases (varias, "contiene" vs "exacto", "cualquiera" vs "todas").
  if (t === "message_received") {
    if (typeof cfg.channel === "string" && cfg.channel && data.channel && data.channel !== cfg.channel) return false;
    if (cfg.firstMessage === true && data.isFirstMessage !== true) return false;
    if (!matchesKeywords(cfg, String(data.text ?? ""))) return false;
  }
  // Anuncios Click-to-Chat: "Todos", por anuncios/campañas seleccionados, o
  // (legado) un ad_id específico. La campaña se resuelve del catálogo antes de
  // despachar (data.campaign_id), así una selección por campaña cubre anuncios
  // nuevos de esa campaña sin editar el flujo.
  if (t === "click_to_chat") {
    const legacyAdId = typeof cfg.adId === "string" ? cfg.adId.trim() : "";
    const adIds = Array.isArray(cfg.adIds) ? cfg.adIds.map(String) : [];
    const campaignIds = Array.isArray(cfg.campaignIds) ? cfg.campaignIds.map(String) : [];
    const adId = String(data.ad_id ?? "");
    const campaignId = String(data.campaign_id ?? "");
    if (cfg.mode === "selected") {
      if (adIds.includes(adId)) return true;
      if (campaignId && campaignIds.includes(campaignId)) return true;
      if (legacyAdId && adId === legacyAdId) return true;
      return false;
    }
    // "Todos" (o legado): un ad_id específico debe coincidir; vacío = cualquiera.
    if (legacyAdId && adId !== legacyAdId) return false;
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
  // Triggers de cita: filtros opcionales por servicio / profesional / sede.
  if (APPOINTMENT_EVENT_TRIGGERS.has(t) && !matchesApptFilter(cfg, data)) return false;
  return true;
}

export function findStartNode(def: WorkflowDefinition): WorkflowNode | undefined {
  const withIncoming = new Set(def.edges.map((e: WorkflowEdge) => e.to));
  return def.nodes.find((n) => !withIncoming.has(n.id)) ?? def.nodes[0];
}

/** Un problema de validación de un flujo, anclado a un nodo o al disparador. */
export interface WorkflowIssue {
  /** "trigger" o el id del nodo con el problema. */
  target: string;
  code: string;
  message: string;
}

/** Contexto del tenant para validar referencias (etiquetas, agentes, etapas, flujos). */
export interface WorkflowValidationContext {
  tags?: string[];
  agentSlugs?: string[];
  leadStatusCodes?: string[];
  workflowNames?: string[];
}

/**
 * Validación transversal de un flujo antes de publicar. Pura y sin acceso a
 * datos: recibe el contexto del tenant. Devuelve TODOS los problemas (no corta
 * en el primero) para pintarlos sobre cada nodo y bloquear la publicación, y
 * para avisar de flujos ya publicados que hoy no pasarían. Los requisitos de
 * integraciones con dependencias externas (plantillas aprobadas, dataset CAPI…)
 * se validan aparte en el endpoint de publicación.
 */
export function validateWorkflowDefinition(def: WorkflowDefinition, ctx: WorkflowValidationContext = {}): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const push = (target: string, code: string, message: string) => issues.push({ target, code, message });
  const tags = new Set((ctx.tags ?? []).map((t) => t.toLowerCase()));
  const agentSlugs = new Set(ctx.agentSlugs ?? []);
  const statusCodes = new Set(ctx.leadStatusCodes ?? []);
  const workflowNames = new Set(ctx.workflowNames ?? []);

  // --- Disparador: campos requeridos por tipo ---
  const t = def.trigger?.type;
  const tc = (def.trigger?.config ?? {}) as Record<string, unknown>;
  if (t === "keyword") {
    const hasKw = String(tc.keyword ?? "").trim() || (Array.isArray(tc.keywords) && tc.keywords.some((w) => String(w).trim()));
    if (!hasKw) push("trigger", "keyword_required", "El disparador «Palabra clave» necesita una palabra o frase.");
  }
  if (t === "click_to_chat" && tc.mode === "selected") {
    const adIds = Array.isArray(tc.adIds) ? tc.adIds : [];
    const campaignIds = Array.isArray(tc.campaignIds) ? tc.campaignIds : [];
    const legacy = String(tc.adId ?? "").trim();
    if (adIds.length === 0 && campaignIds.length === 0 && !legacy) {
      push("trigger", "ctwa_empty", "Elegiste «Anuncios seleccionados» pero no marcaste ninguna campaña ni anuncio. Marca al menos uno o cambia a «Todos los anuncios».");
    }
  }
  if (t === "lead_status_changed") {
    const from = String(tc.fromStatus ?? "");
    const to = String(tc.toStatus ?? "");
    if (from && to && from === to) push("trigger", "status_same", "El origen y el destino de la etapa son iguales: el disparador nunca coincidiría.");
    if (from && statusCodes.size && !statusCodes.has(from)) push("trigger", "status_from_missing", "La etapa de origen ya no existe.");
    if (to && statusCodes.size && !statusCodes.has(to)) push("trigger", "status_to_missing", "La etapa de destino ya no existe.");
  }
  if (t === "tag_added") {
    const tag = String(tc.tag ?? "").trim();
    if (tag && tags.size && !tags.has(tag.toLowerCase())) push("trigger", "tag_missing", `La etiqueta «${tag}» ya no existe: el disparador nunca coincidirá.`);
  }
  if (t === "appointment_upcoming") {
    const hb = Number(tc.hoursBefore ?? 24);
    if (!Number.isFinite(hb) || hb <= 0) push("trigger", "hours_invalid", "«Horas antes de la cita» debe ser un número mayor que 0.");
  }

  // --- Nodos: conectividad y campos requeridos por tipo ---
  const nodes = def.nodes ?? [];
  if (nodes.length === 0) {
    push("trigger", "no_nodes", "El flujo no tiene ningún paso.");
    return issues;
  }
  const start = findStartNode(def);
  const withIncoming = new Set((def.edges ?? []).map((e) => e.to));
  for (const n of nodes) {
    const c = (n.config ?? {}) as Record<string, unknown>;
    if (start && n.id !== start.id && !withIncoming.has(n.id)) {
      push(n.id, "unconnected", "Este paso no está conectado a ningún otro: nunca se ejecutará.");
    }
    switch (n.type) {
      case "send_text":
        if (!String(c.text ?? "").trim()) push(n.id, "text_required", "El mensaje está vacío.");
        break;
      case "run_agent":
      case "switch_agent": {
        const slug = String(c.agentSlug ?? "");
        if (!slug) push(n.id, "agent_required", "No hay agente IA elegido.");
        else if (agentSlugs.size && !agentSlugs.has(slug)) push(n.id, "agent_missing", "El agente IA elegido ya no existe.");
        break;
      }
      case "update_lead_status": {
        const code = String(c.statusCode ?? "");
        if (!code) push(n.id, "status_required", "No hay estado de lead elegido.");
        else if (statusCodes.size && !statusCodes.has(code)) push(n.id, "status_missing", "El estado de lead elegido ya no existe.");
        break;
      }
      case "add_tag":
        if (!String(c.tag ?? "").trim()) push(n.id, "tag_required", "No hay etiqueta indicada.");
        break;
      case "remove_tag": {
        const tag = String(c.tag ?? "").trim();
        if (!tag) push(n.id, "tag_required", "No hay etiqueta indicada.");
        else if (tags.size && !tags.has(tag.toLowerCase())) push(n.id, "tag_missing", `La etiqueta «${tag}» ya no existe.`);
        break;
      }
      case "assign_user":
        if (!String(c.userId ?? "")) push(n.id, "user_required", "No hay usuario elegido.");
        break;
      case "assign_team":
        if (!String(c.teamId ?? "")) push(n.id, "team_required", "No hay equipo elegido.");
        break;
      case "start_workflow": {
        const name = String(c.workflowName ?? "").trim();
        if (!name) push(n.id, "workflow_required", "No hay flujo elegido para disparar.");
        else if (workflowNames.size && !workflowNames.has(name)) push(n.id, "workflow_missing", `El flujo «${name}» ya no existe.`);
        break;
      }
      case "wait":
      case "wait_reply": {
        const total = Number(c.minutes ?? 0) + Number(c.hours ?? 0) + Number(c.days ?? 0);
        if (!(total > 0)) push(n.id, "wait_zero", "La espera es de 0: no pausa nada.");
        break;
      }
    }
  }
  return issues;
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
    case "business_hours": {
      // Sin horario propio en el nodo → usa el de Configuración → Horario de atención.
      let effective = cfg;
      if (!cfg.hours && deps.getBusinessHoursDefault) {
        const orgDefault = await deps.getBusinessHoursDefault(ctx);
        if (orgDefault) effective = { ...orgDefault, ...cfg, timezone: cfg.timezone || (orgDefault as Record<string, any>).timezone };
      }
      return { branch: evalBusinessHours(effective, deps.now()) ? "in" : "out" };
    }
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
    case "send_ga4_event": {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries((cfg.params as Record<string, unknown>) ?? {})) {
        params[k] = renderVars(String(v ?? ""), ctx.variables);
      }
      await deps.sendGa4Event(ctx, { eventName: String(cfg.eventName ?? ""), params });
      return {};
    }
    case "google_sheets_append": {
      const values = (Array.isArray(cfg.values) ? cfg.values : []).map((v) => renderVars(String(v ?? ""), ctx.variables));
      await deps.appendGoogleSheetRow(ctx, {
        spreadsheetId: String(cfg.spreadsheetId ?? ""),
        sheetName: String(cfg.sheetName ?? ""),
        values,
      });
      return {};
    }
    case "send_tiktok_event":
      // "Próximamente": sin integración aún. No-op registrado (no se finge).
      return {};
    case "wait":
      return { wait: computeWaitDue(cfg, deps.now()) };
    case "wait_reply":
      // Espera una respuesta del contacto hasta el timeout. El runtime reanuda por
      // "replied" (si responde) o "no_reply" (si vence). NO usa cancelOn: la
      // respuesta no cancela el run, lo continúa por la rama "replied".
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

export type StepResult =
  | { status: "continue"; branch?: string; goto?: string; nextNodeId?: string }
  | { status: "waiting"; nodeId: string }
  | { status: "completed" }
  | { status: "failed"; nodeId: string; error: string };

/**
 * Ejecuta UN solo nodo (probador paso a paso): aplica el efecto vía deps,
 * persiste el step y devuelve la rama tomada + el siguiente nodo, sin avanzar el
 * resto del flujo. No aplica los topes de nodos/saltos (eso es de executeFrom).
 */
export async function stepNode(deps: EngineDeps, ctx: RunCtx, def: WorkflowDefinition, nodeId: string): Promise<StepResult> {
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) return { status: "failed", nodeId, error: `Nodo no encontrado: ${nodeId}` };
  try {
    const outcome = await executeNode(deps, ctx, node);
    if (outcome.wait) {
      await deps.scheduleTimer(ctx, node.id, outcome.wait, (node.config as any)?.cancelOn);
      await deps.persistStep(ctx, { nodeId: node.id, nodeType: node.type, status: "COMPLETED", output: { waitUntil: outcome.wait.toISOString() } });
      return { status: "waiting", nodeId: node.id };
    }
    await deps.persistStep(ctx, { nodeId: node.id, nodeType: node.type, status: "COMPLETED", output: outcome.branch !== undefined ? { branch: outcome.branch } : outcome.goto ? { goto: outcome.goto } : undefined });
    if (outcome.stop) return { status: "completed" };
    if (outcome.goto !== undefined) {
      if (!outcome.goto) return { status: "failed", nodeId: node.id, error: "Salto sin destino configurado" };
      return { status: "continue", goto: outcome.goto, nextNodeId: outcome.goto };
    }
    return { status: "continue", branch: outcome.branch, nextNodeId: nextNodeId(def, node.id, outcome.branch) };
  } catch (err) {
    const message = (err as Error).message;
    await deps.persistStep(ctx, { nodeId: node.id, nodeType: node.type, status: "FAILED", error: message });
    return { status: "failed", nodeId: node.id, error: message };
  }
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
