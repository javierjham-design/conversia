"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  getBezierPath,
  reconnectEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle, ArrowLeft, Bot, CalendarClock, CheckCircle2, Clock, Copy, CornerUpRight, Crosshair, FastForward, FileText, FlaskConical, GitBranch, LayoutGrid, Megaphone, MessageSquare, MessageSquarePlus,
  Pause, Pencil, Play, PlayCircle, Plus, Redo2, Search, Send, Share2, Sheet, Square, StickyNote, Tag, Tags, Target, Trash2, Undo2, Users, UserRound, Webhook, Workflow, XCircle, Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button, Modal, cn, useToast } from "@/components/ui";
import { TRIGGER_NODE_ID, defToFlow, edgeStyle, flowToDef, type DefTrigger } from "@/lib/workflow-serialize";
import { triggerPreview, messageWouldTrigger } from "@/lib/workflow-trigger-preview";
import { QRCodeCanvas } from "qrcode.react";
import { CATEGORIES, NODE_DEF, NODE_DEFS, categoryMeta, type Category, type NodeDef } from "@/lib/workflow-catalog";

// ---------------------------------------------------------------------------
// Catálogo de nodos SOPORTADOS por el motor v0 (mismos que expone
// /workflows/meta/catalog). El canvas serializa exactamente el WorkflowDefinition
// que entiende el motor: { trigger, variables, nodes:[{id,type,config,position}], edges:[{from,to,when}] }.
// ---------------------------------------------------------------------------

// El catálogo de pasos (categorías, iconos, formularios) es fuente ÚNICA en
// @/lib/workflow-catalog — lo comparten editor, probador y detalle de ejecución.

interface Catalog {
  triggers: { type: string; label: string; description: string; config?: string[]; conditions?: string[]; soon?: boolean; hidden?: boolean }[];
  leadStatuses: { code: string; name: string; emoji?: string | null }[];
  appointmentFilters?: {
    services: { id: string; name: string }[];
    professionals: { id: string; name: string }[];
    clinics: { id: string; name: string }[];
  };
  agents: { slug: string; name: string }[];
  users: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  workflows: { name: string }[];
  templates: { id: string; name: string; language: string }[];
  apiPresets?: { id: string; name: string; baseUrl: string }[];
  ga4Connected?: boolean;
  googleConnected?: boolean;
  templatesEnabled?: boolean;
  templatesPlanAllows?: boolean;
  /** Número de WhatsApp del tenant, para armar el enlace/QR del disparador link_scan. */
  waPhone?: string | null;
}

// ---- Contexto para que los nodos custom accedan a acciones/estado ----
interface EditorApi {
  selectedId: string | null;
  select: (id: string | null) => void;
  addFrom: (parentId: string, branch?: string) => void;
  deleteEdge: (id: string) => void;
  duplicateNode: (id: string) => void;
  deleteNode: (id: string) => void;
  toggleDisabled: (id: string) => void;
  /** Estado de depuración del nodo cuando el probador está activo. */
  debugNodeState: (id: string) => "current" | "done" | "failed" | null;
  catalog: Catalog | null;
  triggerType: string;
}
const EditorContext = createContext<EditorApi>({
  selectedId: null, select: () => {}, addFrom: () => {}, deleteEdge: () => {}, duplicateNode: () => {}, deleteNode: () => {}, toggleDisabled: () => {}, debugNodeState: () => null, catalog: null, triggerType: "",
});

// ---- Conexión con botón para eliminarla (y su etiqueta de rama) ----
// Cada conexión trae una "×" para borrar SOLO esa arista, sin desarmar el resto
// del flujo. Se oculta en la del disparador y en las de "saltar" (no editables).
function DeletableEdge({ id, source, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, label, labelStyle }: EdgeProps) {
  const { deleteEdge } = useContext(EditorContext);
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const canDelete = source !== TRIGGER_NODE_ID && !id.startsWith("goto:");
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        {label && (
          <div
            style={{ position: "absolute", transform: `translate(-50%,-50%) translate(${labelX}px,${labelY - 12}px)`, ...(labelStyle as React.CSSProperties), pointerEvents: "none" }}
            className="rounded bg-app px-1 text-[10px]"
          >
            {label}
          </div>
        )}
        {canDelete && (
          <button
            type="button"
            className="nodrag nopan flex h-5 w-5 items-center justify-center rounded-full border border-line bg-panel text-[13px] leading-none text-ink-subtle opacity-60 shadow-sm transition hover:border-red-300 hover:text-red-500 hover:opacity-100"
            style={{ position: "absolute", transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`, pointerEvents: "all" }}
            title="Eliminar esta conexión"
            onClick={(e) => { e.stopPropagation(); deleteEdge(id); }}
          >
            ×
          </button>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
const edgeTypes = { deletable: DeletableEdge };

// ---- Nodo Trigger (inicio) ----
function TriggerNode() {
  const { select, addFrom, selectedId, catalog, triggerType } = useContext(EditorContext);
  const label = catalog?.triggers.find((t) => t.type === triggerType)?.label ?? "Configura el disparador";
  const selected = selectedId === TRIGGER_NODE_ID;
  return (
    <div className="relative">
      <div
        onClick={() => select(TRIGGER_NODE_ID)}
        className={cn(
          "w-56 cursor-pointer rounded-xl border-2 bg-panel px-3 py-2.5 shadow-card",
          selected ? "border-brand-500" : "border-brand-200 dark:border-brand-500/30",
        )}
      >
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
          <Zap size={13} /> Disparador
        </p>
        <p className="mt-0.5 text-sm font-medium text-ink">{label}</p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-brand-400 !bg-panel" />
      <AddButton onClick={() => addFrom(TRIGGER_NODE_ID)} />
    </div>
  );
}

// ---- Nodo de paso ----
function StepNode({ id, data }: NodeProps) {
  const { select, addFrom, selectedId, duplicateNode, deleteNode, toggleDisabled, debugNodeState } = useContext(EditorContext);
  const d = data as { nodeType: string; config: Record<string, any>; invalid?: string };
  const def = NODE_DEF(d.nodeType);
  const meta = categoryMeta(d.nodeType);
  const selected = selectedId === id;
  const summary = nodeSummary(d.nodeType, d.config);
  const disabled = d.config?.disabled === true;
  const dbg = debugNodeState(id);
  const [hover, setHover] = useState(false);

  // Depuración > inválido > seleccionado > normal.
  const border = dbg === "current" ? "border-brand-500 ring-2 ring-brand-300"
    : dbg === "failed" ? "border-red-400 ring-2 ring-red-300"
    : dbg === "done" ? "border-brand-400 bg-brand-soft"
    : d.invalid ? "border-red-400 ring-1 ring-red-200"
    : selected ? "border-brand-500" : "border-line hover:border-line-strong";

  return (
    <div className="relative" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-line-strong !bg-panel" />
      <div
        onClick={() => select(id)}
        title={d.invalid ?? undefined}
        className={cn("w-60 cursor-pointer overflow-hidden rounded-xl border bg-panel shadow-card transition-colors", border, disabled && "opacity-50")}
      >
        {/* Barra superior con el color de la categoría */}
        <div className={cn("h-1 w-full", meta.bar)} />
        <div className="flex items-start gap-2 px-3 py-2.5">
          <span className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", meta.chip, meta.text)}>{def?.icon}</span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
              <span className="truncate">{def?.label ?? d.nodeType}</span>
              {disabled && <span className="shrink-0 rounded bg-app px-1 text-[9px] uppercase text-ink-subtle">apagado</span>}
            </p>
            {summary && <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{summary}</p>}
          </div>
          {d.invalid && <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-500" />}
        </div>
      </div>

      {/* Menú de acciones al pasar el mouse: duplicar / deshabilitar / eliminar */}
      {hover && (
        <div className="nodrag absolute -top-3 right-1 z-10 flex items-center gap-0.5 rounded-lg border border-line bg-panel px-1 py-0.5 shadow-pop">
          <button onClick={(e) => { e.stopPropagation(); duplicateNode(id); }} title="Duplicar" className="rounded p-1 text-ink-subtle hover:bg-app hover:text-ink"><Copy size={12} /></button>
          <button onClick={(e) => { e.stopPropagation(); toggleDisabled(id); }} title={disabled ? "Habilitar" : "Deshabilitar (se salta en la ejecución)"} className="rounded p-1 text-ink-subtle hover:bg-app hover:text-ink">{disabled ? <Play size={12} /> : <Pause size={12} />}</button>
          <button onClick={(e) => { e.stopPropagation(); deleteNode(id); }} title="Eliminar" className="rounded p-1 text-red-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"><Trash2 size={12} /></button>
        </div>
      )}

      {def?.branches ? (
        <div className="flex justify-between px-2">
          {def.branches.map((b, i) => (
            <div key={b.handle} className="relative flex flex-col items-center" style={{ width: "50%" }}>
              <Handle
                id={b.handle}
                type="source"
                position={Position.Bottom}
                style={{ left: `${i === 0 ? 30 : 70}%` }}
                className="!h-2 !w-2 !border-line-strong !bg-panel"
              />
              <span className="mt-1 text-[9px] font-medium text-ink-subtle">{b.label}</span>
              <AddButton small onClick={() => addFrom(id, b.handle)} />
            </div>
          ))}
        </div>
      ) : def?.terminal ? null : d.config?.onError === "branch" ? (
        // Dos salidas: continúa (izq) y "si falla" (der), para los pasos que pueden fallar.
        <div className="flex justify-between px-2">
          <div className="relative flex flex-col items-center" style={{ width: "50%" }}>
            <Handle type="source" position={Position.Bottom} style={{ left: "30%" }} className="!h-2 !w-2 !border-line-strong !bg-panel" />
            <span className="mt-1 text-[9px] font-medium text-ink-subtle">continúa</span>
            <AddButton small onClick={() => addFrom(id)} />
          </div>
          <div className="relative flex flex-col items-center" style={{ width: "50%" }}>
            <Handle id="error" type="source" position={Position.Bottom} style={{ left: "70%" }} className="!h-2 !w-2 !border-red-300 !bg-panel" />
            <span className="mt-1 text-[9px] font-medium text-red-500">si falla</span>
            <AddButton small onClick={() => addFrom(id, "error")} />
          </div>
        </div>
      ) : (
        <>
          <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-line-strong !bg-panel" />
          <AddButton onClick={() => addFrom(id)} />
        </>
      )}
    </div>
  );
}

function AddButton({ onClick, small }: { onClick: () => void; small?: boolean }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        "absolute left-1/2 -translate-x-1/2 rounded-full border border-line-strong bg-panel text-ink-subtle shadow-sm hover:border-brand-400 hover:text-brand-600",
        small ? "-bottom-5 p-0.5" : "-bottom-6 p-1",
      )}
      title="Agregar paso"
    >
      <Plus size={small ? 12 : 14} />
    </button>
  );
}

const nodeTypes = { triggerNode: TriggerNode, stepNode: StepNode };

function nodeSummary(type: string, config: Record<string, any>): string {
  switch (type) {
    case "send_text": return config.text || "(sin mensaje)";
    case "run_agent": return config.agentSlug ? `Agente: ${config.agentSlug}` : "Agente activo";
    case "wait": {
      const v = config.days ?? config.hours ?? config.minutes ?? 0;
      const u = config.days ? "día(s)" : config.hours ? "hora(s)" : "minuto(s)";
      return `Esperar ${v} ${u}${config.cancelOn === "contact_reply" ? " · cancela si responde" : ""}`;
    }
    case "wait_reply": {
      const v = config.days ?? config.hours ?? config.minutes ?? 0;
      const u = config.days ? "día(s)" : config.hours ? "hora(s)" : "minuto(s)";
      return `Espera respuesta hasta ${v} ${u} · Sí / No`;
    }
    case "condition": return "Continúa si el contacto no ha respondido";
    case "update_lead_status": return config.statusCode ? `→ ${config.statusCode}` : "(elige un estado)";
    case "add_tag": return config.tag ? `#${config.tag}` : "(elige una etiqueta)";
    case "remove_tag": return config.tag ? `quitar #${config.tag}` : "(elige una etiqueta)";
    case "update_contact": {
      const keys = Object.keys(config.fields ?? {}).filter((k) => config.fields[k]);
      const es: Record<string, string> = { firstName: "nombre", lastName: "apellido", email: "email" };
      return keys.length ? `Actualiza: ${keys.map((k) => es[k] ?? k).join(", ")}` : "(elige qué guardar)";
    }
    case "assign_user": return config.userId ? "Asignar a una persona" : "(elige usuario)";
    case "assign_team": return config.teamId ? "Asignar a un equipo" : "(elige equipo)";
    case "switch_agent": return config.agentSlug ? `Agente: ${config.agentSlug}` : "(elige agente)";
    case "start_workflow": return config.workflowName ? `→ ${config.workflowName}` : "(elige flujo)";
    case "transfer_human": return config.reason || "Escalar al equipo humano";
    case "pause_ai": return "Detiene las respuestas del agente";
    case "resume_ai": return "Reactiva las respuestas del agente";
    case "open_conversation": return "Abre/reutiliza una conversación del contacto";
    case "add_note": return config.text ? `📝 ${String(config.text).slice(0, 40)}` : "(sin comentario)";
    case "goto": return config.targetNodeId ? "Salta a otro paso del flujo" : "(elige el paso destino)";
    case "business_hours": return "Ramifica: dentro / fuera de horario";
    case "send_capi": return `CAPI: ${config.eventName ?? "Lead"}${config.value ? ` ($${config.value} ${config.currency ?? "CLP"})` : ""}`;
    case "send_tiktok_event": return "(Próximamente)";
    case "ai_objective": return config.objective ? `Objetivo: ${String(config.objective).slice(0, 40)}` : "(define el objetivo)";
    case "send_template": return config.templateName ? `📄 ${config.templateName}` : "(elige la plantilla)";
    case "send_internal_email": return config.subject ? `✉ ${String(config.subject).slice(0, 40)}` : "(configura el correo)";
    case "send_ga4_event": return config.eventName ? `📊 ${config.eventName}` : "(configura el evento)";
    case "call_api": return config.url ? `${config.method ?? "GET"} ${String(config.url).slice(0, 30)}` : "(configura la petición)";
    case "google_sheets_append": return config.spreadsheetId ? `📋 ${config.sheetName || "Hoja 1"} · ${(Array.isArray(config.values) ? config.values.length : 0)} col.` : "(configura la planilla)";
    default: return "";
  }
}

/** Detección de ciclos (DFS) sobre la adyacencia del grafo, incluidos los saltos. */
function hasCycle(start: string, adj: Map<string, string[]>): boolean {
  const state = new Map<string, number>(); // 0 = visitando, 1 = terminado
  function dfs(node: string): boolean {
    const s = state.get(node);
    if (s === 0) return true; // arista de retroceso → ciclo
    if (s === 1) return false;
    state.set(node, 0);
    for (const nx of adj.get(node) ?? []) if (dfs(nx)) return true;
    state.set(node, 1);
    return false;
  }
  return dfs(start);
}

// Simulador interactivo (botón "Probar"): eventos y estado que devuelve el servidor.
interface LiveSimEvt {
  kind: "message" | "action" | "wait" | "branch" | "info" | "end";
  from?: "contact" | "bot";
  text?: string;
  agent?: string | null;
  label?: string;
  detail?: string;
}
interface LiveSim {
  log: LiveSimEvt[];
  status: "waiting" | "agent_chat" | "stepping" | "done" | "failed";
  waiting: { label: string; cancelOnReply: boolean } | null;
  objective: { objective: string } | null;
  error?: string | null;
  // Paso a paso
  cursor?: string | null;
  executed?: string[];
  failedNodeId?: string | null;
  variables?: Record<string, string>;
  varsBefore?: Record<string, string>;
  lastStep?: { nodeId: string; nodeType: string; branch: string | null } | null;
}

/** Una línea del transcript del simulador. */
function SimBubble({ e }: { e: LiveSimEvt }) {
  if (e.kind === "message") {
    const contact = e.from === "contact";
    return (
      <div className={cn("flex", contact ? "justify-end" : "justify-start")}>
        <div className={cn("max-w-[80%] rounded-2xl px-3 py-2 text-sm", contact ? "bg-brand-600 text-white" : "border border-line bg-panel text-ink")}>
          {!contact && e.agent && <p className="mb-0.5 text-[10px] font-medium text-ink-subtle">🤖 {e.agent}</p>}
          <p className="whitespace-pre-wrap">{e.text}</p>
        </div>
      </div>
    );
  }
  if (e.kind === "action") return <p className="text-center text-[11px] text-ink-subtle">⚙ {e.label}: {e.detail}</p>;
  if (e.kind === "end") return <p className="text-center text-xs font-medium text-emerald-600 dark:text-emerald-400">{e.text}</p>;
  return <p className="text-center text-[11px] italic text-ink-subtle">{e.text}</p>;
}

/** Panel lateral de depuración paso a paso (el nodo en curso se resalta en el canvas). */
function DebugPanel({ dbg, busy, contact, setContact, reply, setReply, onNext, onAdvance, onReply, onReset, onClose }: {
  dbg: LiveSim; busy: boolean; contact: string; setContact: (s: string) => void; reply: string; setReply: (s: string) => void;
  onNext: () => void; onAdvance: () => void; onReply: () => void; onReset: () => void; onClose: () => void;
}) {
  const vars = dbg.variables ?? {};
  const before = dbg.varsBefore ?? {};
  const changed = (k: string) => dbg.varsBefore !== undefined && before[k] !== vars[k];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-ink">Depurar paso a paso</p>
          <p className="text-[11px] text-ink-subtle">El nodo en curso se resalta en el canvas. No envía nada real.</p>
        </div>
        <button onClick={onClose} className="rounded-lg p-1.5 text-ink-subtle hover:bg-app" title="Cerrar depuración"><XCircle size={16} /></button>
      </div>
      <div className="space-y-3 p-4">
        <label className="block text-xs text-ink-muted">Contacto de prueba (ficticio)
          <input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Prueba" className="mt-1 block w-full rounded-lg border border-line-strong px-2 py-1.5 text-sm" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {dbg.status === "stepping" && <Button onClick={onNext} disabled={busy}><FastForward size={14} className="mr-1" /> Siguiente paso</Button>}
          {dbg.status === "waiting" && <Button variant="secondary" onClick={onAdvance} disabled={busy}><Clock size={14} className="mr-1" /> Adelantar el tiempo</Button>}
          <Button variant="secondary" onClick={onReset} disabled={busy}>Reiniciar</Button>
        </div>
        {dbg.status === "waiting" && (
          <div className="flex items-end gap-2">
            <input value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && reply.trim() && !busy) onReply(); }} placeholder="Responder como el contacto…" className="flex-1 rounded-lg border border-line-strong px-2 py-1.5 text-sm" />
            <Button onClick={onReply} disabled={busy || !reply.trim()}><Send size={14} /></Button>
          </div>
        )}
        {dbg.status === "done" && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">✅ Fin del flujo. Reinicia para volver a correr.</p>}
        {dbg.status === "failed" && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">⚠ {dbg.error}</p>}

        {dbg.lastStep && (
          <div className="rounded-lg border border-line bg-app p-2 text-xs">
            <p className="font-medium text-ink">Último paso: {NODE_DEF(dbg.lastStep.nodeType)?.label ?? dbg.lastStep.nodeType}</p>
            {dbg.lastStep.branch && <p className="text-ink-subtle">Rama tomada: <b>{dbg.lastStep.branch}</b></p>}
          </div>
        )}

        <div>
          <p className="mb-1 text-xs font-medium text-ink">Variables {dbg.varsBefore !== undefined && <span className="font-normal text-ink-subtle">(cambios resaltados)</span>}</p>
          <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-line p-2">
            {Object.entries(vars).map(([k, v]) => (
              <p key={k} className={cn("truncate font-mono text-[10px]", changed(k) ? "font-semibold text-brand-600 dark:text-brand-300" : "text-ink-muted")}>
                <b>{k}</b>: {String(v).slice(0, 60)}{changed(k) ? " ←" : ""}
              </p>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium text-ink">Recorrido y efectos (lo que haría)</p>
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {dbg.log.map((e, i) => <SimBubble key={i} e={e} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

interface WorkflowIssue { target: string; code: string; message: string }

interface Detail {
  id: string; name: string; description: string | null; active: boolean;
  publishedVersion: number | null; draftVersion: number | null; definition: any; updatedAt?: string;
  publishedIssues?: WorkflowIssue[];
}

function Editor() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView } = useReactFlow();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<DefTrigger>({ type: "conversation_started", config: {} });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addFromState, setAddFromState] = useState<{ parentId: string; branch?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testContact, setTestContact] = useState("");
  const [simState, setSimState] = useState<LiveSim | null>(null);
  const [simBusy, setSimBusy] = useState(false);
  const [replyText, setReplyText] = useState("");
  const simLogRef = useRef<HTMLDivElement | null>(null);
  // Depuración paso a paso SOBRE el canvas (panel lateral + resaltado de nodos).
  const [dbg, setDbg] = useState<LiveSim | null>(null);
  const [dbgBusy, setDbgBusy] = useState(false);
  const [dbgReply, setDbgReply] = useState("");
  // Problemas de validación (servidor): mensajes que apuntan al disparador y
  // aviso del flujo YA publicado que hoy no pasaría la validación.
  const [triggerIssues, setTriggerIssues] = useState<string[]>([]);
  const [brokenBanner, setBrokenBanner] = useState<WorkflowIssue[] | null>(null);

  /** Pinta los problemas del servidor sobre cada nodo y el disparador. */
  const applyIssues = useCallback((issues: WorkflowIssue[]) => {
    const byNode = new Map<string, string>();
    const trig: string[] = [];
    for (const it of issues) {
      if (it.target === "trigger") trig.push(it.message);
      else if (!byNode.has(it.target)) byNode.set(it.target, it.message);
    }
    setTriggerIssues(trig);
    setNodes((ns) => ns.map((n) => ({ ...n, data: { ...n.data, invalid: byNode.get(n.id) ?? (n.data as any).invalid } })));
  }, [setNodes]);

  const history = useRef<{ past: { n: Node[]; e: Edge[] }[]; future: { n: Node[]; e: Edge[] }[] }>({ past: [], future: [] });
  const [, forceRender] = useState(0);

  const snapshot = useCallback(() => {
    history.current.past.push({ n: structuredClone(nodes), e: structuredClone(edges) });
    if (history.current.past.length > 50) history.current.past.shift();
    history.current.future = [];
    forceRender((v) => v + 1);
  }, [nodes, edges]);

  const undo = useCallback(() => {
    const prev = history.current.past.pop();
    if (!prev) return;
    history.current.future.push({ n: structuredClone(nodes), e: structuredClone(edges) });
    setNodes(prev.n);
    setEdges(prev.e);
    forceRender((v) => v + 1);
  }, [nodes, edges, setNodes, setEdges]);

  const redo = useCallback(() => {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push({ n: structuredClone(nodes), e: structuredClone(edges) });
    setNodes(next.n);
    setEdges(next.e);
    forceRender((v) => v + 1);
  }, [nodes, edges, setNodes, setEdges]);

  const load = useCallback(async () => {
    const [d, c] = await Promise.all([api<Detail>(`/workflows/${id}`), api<Catalog>("/workflows/meta/catalog")]);
    setDetail(d);
    setCatalog(c);
    setName(d.name);
    const flow = defToFlow(d.definition);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setTrigger(flow.trigger);
    setTriggerIssues([]);
    // Aviso de flujo YA publicado que hoy no pasaría la validación.
    setBrokenBanner(d.publishedIssues && d.publishedIssues.length ? d.publishedIssues : null);
    history.current = { past: [], future: [] };
  }, [id, setNodes, setEdges]);

  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) return;
      snapshot();
      setEdges((eds) => addEdge({ ...c, ...edgeStyle(c.sourceHandle ?? undefined) }, eds));
    },
    [snapshot, setEdges],
  );

  // Eliminar UNA conexión (botón × del edge) sin desarmar el resto del flujo.
  const deleteEdge = useCallback(
    (id: string) => {
      if (id.startsWith("goto:")) return; // las de "saltar" se quitan cambiando el nodo
      snapshot();
      setEdges((eds) => eds.filter((e) => e.id !== id));
    },
    [snapshot, setEdges],
  );

  // Acciones del nodo (menú al hover): duplicar, eliminar, deshabilitar.
  const duplicateNode = useCallback((nodeId: string) => {
    setNodes((ns) => {
      const n = ns.find((x) => x.id === nodeId);
      if (!n) return ns;
      snapshot();
      const newId = `n${Date.now().toString(36)}`;
      const copy: Node = { ...n, id: newId, selected: false, position: { x: n.position.x + 40, y: n.position.y + 70 }, data: { ...(n.data as any), config: structuredClone((n.data as any).config ?? {}) } };
      setSelectedId(newId);
      return [...ns, copy];
    });
  }, [snapshot, setNodes]);

  const toggleDisabled = useCallback((nodeId: string) => {
    snapshot();
    setNodes((ns) => ns.map((x) => {
      if (x.id !== nodeId) return x;
      const cfg = { ...((x.data as any).config ?? {}) };
      cfg.disabled = !cfg.disabled;
      if (!cfg.disabled) delete cfg.disabled; // habilitar = quitar la marca (config limpia)
      return { ...x, data: { ...(x.data as any), config: cfg } };
    }));
  }, [snapshot, setNodes]);

  // Auto-organizar: layout por capas (BFS desde el disparador siguiendo las aristas).
  const autoLayout = useCallback(() => {
    snapshot();
    const adj = new Map<string, string[]>();
    for (const e of edges) { const a = adj.get(e.source) ?? []; a.push(e.target); adj.set(e.source, a); }
    const depth = new Map<string, number>();
    const roots = nodes.filter((n) => !edges.some((e) => e.target === n.id)).map((n) => n.id);
    const queue = roots.map((id) => ({ id, d: 0 }));
    const seen = new Set<string>();
    while (queue.length) {
      const { id, d } = queue.shift()!;
      depth.set(id, Math.max(depth.get(id) ?? 0, d));
      if (seen.has(id)) continue;
      seen.add(id);
      for (const to of adj.get(id) ?? []) queue.push({ id: to, d: d + 1 });
    }
    const byDepth = new Map<number, string[]>();
    for (const n of nodes) { const d = depth.get(n.id) ?? 0; const a = byDepth.get(d) ?? []; a.push(n.id); byDepth.set(d, a); }
    const pos = new Map<string, { x: number; y: number }>();
    const COL = 270, ROW = 150, X0 = 300;
    for (const [d, ids] of byDepth) ids.forEach((id, i) => pos.set(id, { x: X0 + (i - (ids.length - 1) / 2) * COL, y: 20 + d * ROW }));
    setNodes((ns) => ns.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id)! } : n)));
    window.requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 }));
  }, [nodes, edges, snapshot, setNodes, fitView]);

  // Reconectar: arrastrar un extremo de la conexión a otro nodo (recablear sin borrar/rehacer).
  const onReconnect = useCallback(
    (oldEdge: Edge, newConn: Connection) => {
      if (newConn.source === newConn.target) return;
      snapshot();
      setEdges((eds) => reconnectEdge(oldEdge, newConn, eds));
    },
    [snapshot, setEdges],
  );

  const addFrom = useCallback((parentId: string, branch?: string) => setAddFromState({ parentId, branch }), []);

  const createNode = useCallback(
    (type: string) => {
      if (!addFromState) return;
      const parent = nodes.find((n) => n.id === addFromState.parentId);
      const px = parent?.position.x ?? 250;
      const py = parent?.position.y ?? 120;
      const newId = `n${Date.now().toString(36)}`;
      const def = NODE_DEF(type);
      snapshot();
      const newNode: Node = {
        id: newId,
        type: "stepNode",
        // Rama "derecha" (respondió/fuera/no cumplido/no respondió/si falla) se desplaza para no apilarse.
        position: { x: px + (["false", "out", "unmet", "no_reply", "error"].includes(addFromState.branch ?? "") ? 210 : 0), y: py + 140 },
        data: { nodeType: type, config: structuredClone(def?.defaultConfig ?? {}) },
      };
      const newEdge: Edge = {
        id: `${addFromState.parentId}->${newId}:${addFromState.branch ?? ""}`,
        source: addFromState.parentId,
        target: newId,
        sourceHandle: addFromState.branch,
        ...edgeStyle(addFromState.branch),
      };
      setNodes((ns) => [...ns, newNode]);
      setEdges((es) => [...es, newEdge]);
      setSelectedId(newId);
      setAddFromState(null);
    },
    [addFromState, nodes, snapshot, setNodes, setEdges],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      if (nodeId === TRIGGER_NODE_ID) return;
      snapshot();
      setNodes((ns) => ns.filter((n) => n.id !== nodeId));
      setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedId(null);
    },
    [snapshot, setNodes, setEdges],
  );

  const updateSelectedConfig = useCallback(
    (patch: Record<string, unknown>) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === selectedId ? { ...n, data: { ...n.data, config: { ...(n.data as any).config, ...patch }, invalid: undefined } } : n,
        ),
      );
    },
    [selectedId, setNodes],
  );

  function validate(): boolean {
    const errors: Record<string, string> = {};
    const startEdge = edges.find((e) => e.source === TRIGGER_NODE_ID);
    const stepNodes = nodes.filter((n) => n.id !== TRIGGER_NODE_ID);
    if (!startEdge) {
      toast.push("Conecta el disparador a un primer paso", "error");
      return false;
    }
    if (trigger.type === "keyword" && !String(trigger.config.keyword ?? "").trim()) {
      toast.push("El disparador por palabra clave necesita una palabra", "error");
      return false;
    }
    // Reachability desde el nodo de inicio.
    const adj = new Map<string, string[]>();
    for (const e of edges) {
      if (e.source === TRIGGER_NODE_ID) continue;
      adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
    }
    // Los saltos ("goto") también conectan para efectos de alcance/bucles.
    for (const n of stepNodes) {
      if ((n.data as any).nodeType === "goto") {
        const t = (n.data as any).config?.targetNodeId;
        if (t) adj.set(n.id, [...(adj.get(n.id) ?? []), t]);
      }
    }
    const reachable = new Set<string>([startEdge.target]);
    const stack = [startEdge.target];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nx of adj.get(cur) ?? []) if (!reachable.has(nx)) { reachable.add(nx); stack.push(nx); }
    }
    for (const n of stepNodes) {
      const c = (n.data as any).config ?? {};
      const t = (n.data as any).nodeType;
      if (!reachable.has(n.id)) errors[n.id] = "Nodo sin conexión desde el disparador";
      else if (t === "send_text" && !String(c.text ?? "").trim()) errors[n.id] = "Escribe el mensaje";
      else if (t === "update_lead_status" && !c.statusCode) errors[n.id] = "Elige un estado de lead";
      else if ((t === "add_tag" || t === "remove_tag") && !String(c.tag ?? "").trim()) errors[n.id] = "Indica la etiqueta";
      else if (t === "wait" && !(c.minutes || c.hours || c.days)) errors[n.id] = "Indica cuánto esperar";
      else if (t === "assign_user" && !c.userId) errors[n.id] = "Elige una persona";
      else if (t === "assign_team" && !c.teamId) errors[n.id] = "Elige un equipo";
      else if (t === "switch_agent" && !c.agentSlug) errors[n.id] = "Elige un agente";
      else if (t === "start_workflow" && !String(c.workflowName ?? "").trim()) errors[n.id] = "Elige un flujo";
      else if (t === "update_contact" && !Object.values((c.fields ?? {}) as Record<string, string>).some((v) => String(v).trim())) errors[n.id] = "Indica al menos un dato";
      else if (t === "add_note" && !String(c.text ?? "").trim()) errors[n.id] = "Escribe el comentario";
      else if (t === "goto" && !c.targetNodeId) errors[n.id] = "Elige el paso destino";
      else if (t === "ai_objective" && !String(c.objective ?? "").trim()) errors[n.id] = "Define el objetivo del agente";
      else if (t === "call_api" && !String(c.url ?? "").trim()) errors[n.id] = "Indica la URL de la petición";
    }
    setNodes((ns) => ns.map((n) => (n.id in errors ? { ...n, data: { ...n.data, invalid: errors[n.id] } } : { ...n, data: { ...n.data, invalid: undefined } })));
    if (Object.keys(errors).length) {
      toast.push("Corrige los nodos marcados en rojo", "error");
      return false;
    }
    // Aviso (no bloqueante) de posibles bucles: un ciclo en el grafo (incluye saltos).
    if (hasCycle(startEdge.target, adj)) {
      toast.push("Aviso: hay un posible bucle en el flujo (revisa los saltos). El motor lo acota a 25 saltos.", "info");
    }
    return true;
  }

  async function saveDraft(): Promise<boolean> {
    setBusy(true);
    try {
      await api(`/workflows/${id}/draft`, {
        method: "PUT",
        body: JSON.stringify({ name, definition: flowToDef(nodes, edges, trigger) }),
      });
      toast.push("Borrador guardado", "ok");
      await load();
      return true;
    } catch (e) {
      toast.push((e as Error).message, "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!validate()) return;
    if (!(await saveDraft())) return;
    setBusy(true);
    try {
      // Validación transversal en el servidor (autoritativa): pinta los problemas
      // sobre cada nodo/disparador y bloquea la publicación si los hay.
      const v = await api<{ ok: boolean; issues: WorkflowIssue[] }>(`/workflows/${id}/validate`, {
        method: "POST",
        body: JSON.stringify({ definition: flowToDef(nodes, edges, trigger) }),
      });
      if (!v.ok) {
        applyIssues(v.issues);
        toast.push(`El flujo tiene ${v.issues.length} problema(s): revisa lo marcado en rojo`, "error");
        return;
      }
      const r = await api<{ publishedVersion: number; conflicts?: { id: string; name: string }[] }>(`/workflows/${id}/publish`, { method: "POST" });
      toast.push(`Versión ${r.publishedVersion} publicada y activa`, "ok");
      if (r.conflicts && r.conflicts.length) {
        toast.push(
          `Ojo: ${r.conflicts.length === 1 ? "otro flujo activo reacciona" : `${r.conflicts.length} flujos activos reaccionan`} al mismo evento (${r.conflicts.map((c) => c.name).join(", ")}). Ambos se ejecutarán.`,
          "error",
        );
      }
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  // Simulador interactivo: cada paso ejecuta el motor real + IA real en el
  // servidor. El estado viaja de ida y vuelta (sin sesión en el servidor).
  async function stepSim(action: { type: "start" | "advance" | "reply"; text?: string }) {
    setSimBusy(true);
    try {
      const r = await api<{ state: LiveSim }>(`/workflows/${id}/test/live`, {
        method: "POST",
        body: JSON.stringify({
          definition: flowToDef(nodes, edges, trigger),
          contact: { firstName: testContact || null },
          state: action.type === "start" ? null : simState,
          action,
        }),
      });
      setSimState(r.state);
      if (action.type === "reply") setReplyText("");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setSimBusy(false);
    }
  }

  // ── Depuración paso a paso sobre el canvas ──
  async function dbgAction(action: { type: "start" | "next" | "advance" | "reply"; text?: string; mode?: "run" | "step" }) {
    setDbgBusy(true);
    try {
      const r = await api<{ state: LiveSim }>(`/workflows/${id}/test/live`, {
        method: "POST",
        body: JSON.stringify({
          definition: flowToDef(nodes, edges, trigger),
          contact: { firstName: testContact || null },
          state: action.type === "start" ? null : dbg,
          action,
        }),
      });
      setDbg(r.state);
      if (action.type === "reply") setDbgReply("");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setDbgBusy(false);
    }
  }
  const startDebug = () => { setTestOpen(false); void dbgAction({ type: "start", mode: "step" }); };
  const closeDebug = () => { setDbg(null); setDbgReply(""); };
  const debugNodeState = useCallback((nodeId: string): "current" | "done" | "failed" | null => {
    if (!dbg) return null;
    if (dbg.failedNodeId === nodeId) return "failed";
    if (dbg.cursor === nodeId) return "current";
    if (dbg.executed?.includes(nodeId)) return "done";
    return null;
  }, [dbg]);

  // Auto-scroll del transcript al último evento.
  useEffect(() => {
    const el = simLogRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [simState, simBusy]);

  const editorApi = useMemo<EditorApi>(
    () => ({ selectedId, select: setSelectedId, addFrom, deleteEdge, duplicateNode, deleteNode, toggleDisabled, debugNodeState, catalog, triggerType: trigger.type }),
    [selectedId, addFrom, deleteEdge, duplicateNode, deleteNode, toggleDisabled, debugNodeState, catalog, trigger.type],
  );

  const selectedNode = nodes.find((n) => n.id === selectedId && n.id !== TRIGGER_NODE_ID);

  // Aristas visuales de los "Saltar a otro paso" (punteadas, no se serializan).
  const flowEdges = useMemo<Edge[]>(() => {
    const gotoEdges: Edge[] = nodes
      .filter((n) => (n.data as any).nodeType === "goto" && (n.data as any).config?.targetNodeId)
      .map((n) => ({
        id: `goto:${n.id}`,
        type: "default", // arista integrada (animada); no usa el edge con "×"
        source: n.id,
        target: (n.data as any).config.targetNodeId,
        animated: true,
        selectable: false,
        deletable: false,
        reconnectable: false,
        style: { stroke: "#a855f7", strokeDasharray: "5 5" },
        label: "saltar",
        labelStyle: { fontSize: 10, fill: "#a855f7" },
      }));
    return [...edges, ...gotoEdges];
  }, [edges, nodes]);

  // Ignora cambios sobre las aristas de salto (no viven en el estado `edges`).
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => onEdgesChange(changes.filter((c) => !("id" in c) || !c.id.startsWith("goto:"))),
    [onEdgesChange],
  );

  if (!detail || !catalog) return <div className="p-6 text-ink-subtle">Cargando…</div>;

  return (
    <EditorContext.Provider value={editorApi}>
      <div className="flex h-full flex-col">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-panel px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <button onClick={() => router.push("/workflows")} className="rounded-lg p-1.5 text-ink-subtle hover:bg-app" title="Volver">
              <ArrowLeft size={18} />
            </button>
            <div className="min-w-0">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full max-w-xs truncate rounded border border-transparent px-1 text-base font-semibold text-ink hover:border-line focus:border-line-strong focus:outline-none"
              />
              <p className="px-1 text-[11px] text-ink-subtle">
                {detail.publishedVersion ? `v${detail.publishedVersion} publicada` : "sin publicar"}
                {detail.draftVersion ? ` · borrador v${detail.draftVersion}` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={undo} disabled={!history.current.past.length} className="rounded-lg p-1.5 text-ink-muted hover:bg-app disabled:opacity-30" title="Deshacer"><Undo2 size={16} /></button>
            <button onClick={redo} disabled={!history.current.future.length} className="rounded-lg p-1.5 text-ink-muted hover:bg-app disabled:opacity-30" title="Rehacer"><Redo2 size={16} /></button>
            <span className="mx-1 h-5 w-px bg-line" />
            <button onClick={autoLayout} disabled={busy} className="rounded-lg p-1.5 text-ink-muted hover:bg-app disabled:opacity-30" title="Auto-organizar el diagrama"><LayoutGrid size={16} /></button>
            <Button variant="secondary" onClick={() => router.push(`/workflows/${id}/runs`)} disabled={busy}>Ejecuciones</Button>
            <Button variant="secondary" onClick={startDebug} disabled={busy || dbgBusy}>Depurar</Button>
            <Button variant="secondary" onClick={() => { setSimState(null); setReplyText(""); setTestOpen(true); }} disabled={busy}>Probar</Button>
            <Button variant="secondary" onClick={() => void saveDraft()} disabled={busy}>Guardar</Button>
            <Button onClick={() => void publish()} disabled={busy}>Publicar</Button>
          </div>
        </header>

        {/* Aviso: el flujo YA publicado hoy no pasaría la validación (descubre los rotos). */}
        {brokenBanner && (
          <div className="flex items-start gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">Este flujo está publicado pero hoy no pasaría la validación ({brokenBanner.length} problema{brokenBanner.length > 1 ? "s" : ""}):</p>
              <ul className="mt-0.5 list-disc pl-4">
                {brokenBanner.slice(0, 4).map((it, i) => (<li key={i}>{it.message}</li>))}
                {brokenBanner.length > 4 && <li>…y {brokenBanner.length - 4} más.</li>}
              </ul>
              <p className="mt-0.5 text-amber-700/80 dark:text-amber-200/70">Sigue activo con la versión anterior; corrige y vuelve a publicar.</p>
            </div>
            <button onClick={() => { applyIssues(brokenBanner); setBrokenBanner(null); }} className="shrink-0 rounded px-2 py-0.5 font-medium underline">Marcar en el lienzo</button>
          </div>
        )}

        {/* Canvas + panel */}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 bg-app">
            <ReactFlow
              nodes={nodes}
              edges={flowEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={onConnect}
              onReconnect={onReconnect}
              onNodeDragStart={snapshot}
              onPaneClick={() => setSelectedId(null)}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ type: "deletable", style: { stroke: "#94a3b8" } }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#cbd5e1" />
              <Controls showInteractive={false} />
              <MiniMap
                pannable
                zoomable
                className="!bg-panel"
                maskColor="rgba(100,116,139,0.15)"
                nodeColor={(n) => (n.id === TRIGGER_NODE_ID ? "#2563eb" : "#94a3b8")}
                nodeStrokeWidth={0}
              />
            </ReactFlow>
          </div>

          <aside className="w-96 shrink-0 overflow-y-auto border-l border-line bg-panel">
            {dbg ? (
              <DebugPanel
                dbg={dbg}
                busy={dbgBusy}
                contact={testContact}
                setContact={setTestContact}
                reply={dbgReply}
                setReply={setDbgReply}
                onNext={() => void dbgAction({ type: "next" })}
                onAdvance={() => void dbgAction({ type: "advance" })}
                onReply={() => { if (dbgReply.trim()) void dbgAction({ type: "reply", text: dbgReply.trim() }); }}
                onReset={() => void dbgAction({ type: "start", mode: "step" })}
                onClose={closeDebug}
              />
            ) : selectedId === TRIGGER_NODE_ID ? (
              <TriggerPanel wfId={id} catalog={catalog} trigger={trigger} onChange={setTrigger} issues={triggerIssues} />
            ) : selectedNode ? (
              <NodePanel
                node={selectedNode}
                catalog={catalog}
                steps={nodes
                  .filter((n) => n.id !== TRIGGER_NODE_ID && n.id !== selectedNode.id)
                  .map((n) => ({ id: n.id, label: NODE_DEF((n.data as any).nodeType)?.label ?? String((n.data as any).nodeType) }))}
                onChange={updateSelectedConfig}
                onDelete={() => deleteNode(selectedNode.id)}
              />
            ) : (
              <div className="p-5 text-sm text-ink-subtle">
                Selecciona el disparador o un paso para configurarlo. Usa el botón + bajo cada nodo para agregar pasos.
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* Modo prueba: simulación interactiva (motor real + IA real) */}
      <Modal open={testOpen} onClose={() => setTestOpen(false)} title="Probar flujo" wide>
        {!simState ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-muted">
              Simula el flujo como una <b>conversación real</b>: verás los mensajes que se envían, las respuestas de los agentes de IA (reales),
              las esperas y las ramificaciones. Puedes responder como si fueras el contacto. No envía WhatsApp ni cambia datos reales.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="text-xs text-ink-muted">Nombre del contacto de prueba</span>
                <input value={testContact} onChange={(e) => setTestContact(e.target.value)} placeholder="Prueba" className="mt-1 block w-48 rounded-lg border border-line-strong px-3 py-2 text-sm" />
              </label>
              <Button onClick={() => void stepSim({ type: "start" })} disabled={simBusy}>
                <Play size={15} /> {simBusy ? "Iniciando…" : "Iniciar simulación"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col" style={{ height: "62vh" }}>
            {/* Transcript */}
            <div ref={simLogRef} className="flex-1 space-y-2 overflow-y-auto rounded-lg border border-line bg-app p-3">
              {simState.log.map((e, i) => <SimBubble key={i} e={e} />)}
              {simBusy && <p className="text-center text-xs text-ink-subtle">…</p>}
            </div>

            {/* Controles según el estado */}
            <div className="mt-3 space-y-2">
              {simState.status === "waiting" && simState.waiting && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  <Clock size={14} className="shrink-0" />
                  <span className="flex-1">El flujo espera <b>{simState.waiting.label}</b>{simState.waiting.cancelOnReply ? " (se cancela si el contacto responde)" : ""}.</span>
                  <Button variant="secondary" onClick={() => void stepSim({ type: "advance" })} disabled={simBusy}>
                    <FastForward size={14} /> Adelantar el tiempo
                  </Button>
                </div>
              )}
              {simState.objective && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                  <Target size={14} className="shrink-0" />
                  <span className="flex-1">Objetivo del agente: <b>{simState.objective.objective}</b></span>
                  <Button variant="secondary" onClick={() => void stepSim({ type: "advance" })} disabled={simBusy}>Dar por terminado</Button>
                </div>
              )}
              {simState.status === "failed" && (
                <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">El flujo falló: {simState.error}</p>
              )}

              {(simState.status === "waiting" || simState.status === "agent_chat") && (
                <div className="flex items-end gap-2">
                  <input
                    value={replyText}
                    onChange={(e) => setReplyText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && replyText.trim() && !simBusy) void stepSim({ type: "reply", text: replyText.trim() }); }}
                    placeholder="Escribe como si fueras el contacto…"
                    className="flex-1 rounded-lg border border-line-strong px-3 py-2 text-sm"
                    disabled={simBusy}
                  />
                  <Button onClick={() => { if (replyText.trim()) void stepSim({ type: "reply", text: replyText.trim() }); }} disabled={simBusy || !replyText.trim()}>
                    <Send size={15} />
                  </Button>
                </div>
              )}
              {simState.status === "done" && (
                <p className="text-center text-xs text-ink-subtle">La conversación terminó. Reinicia para volver a probar.</p>
              )}

              <div className="flex items-center justify-between">
                <button onClick={() => { setSimState(null); setReplyText(""); }} className="text-xs text-ink-subtle underline hover:text-ink">↺ Reiniciar</button>
                <span className="text-[10px] text-ink-subtle">Simulación — no envía WhatsApp ni cambia datos reales.</span>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* Menú para agregar paso (categorizado + buscador) */}
      <AddStepModal open={!!addFromState} onClose={() => setAddFromState(null)} onPick={createNode} />
    </EditorContext.Provider>
  );
}

export default function WorkflowEditorPage() {
  // El canvas de flujos necesita pantalla grande. En móvil damos un estado honesto
  // (no una experiencia rota) y no montamos ReactFlow.
  const [large, setLarge] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const upd = () => setLarge(mq.matches);
    upd();
    mq.addEventListener("change", upd);
    return () => mq.removeEventListener("change", upd);
  }, []);

  if (large === false) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
        <Workflow size={36} className="text-ink-subtle" />
        <h2 className="text-base font-semibold text-ink">El editor de flujos necesita una pantalla más grande</h2>
        <p className="max-w-xs text-sm text-ink-muted">
          Ábrelo desde un computador o tablet en horizontal para armar el flujo. Desde el teléfono puedes ver y gestionar el resto del panel.
        </p>
        <a href="/workflows" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700">
          Volver a Flujos
        </a>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}

// ---------------------------------------------------------------------------
// Paneles de configuración (derecha)
// ---------------------------------------------------------------------------

/** Variables del flujo disponibles para {{...}} (mismas que resuelve el motor). */
// `primary` = variables más usadas: se muestran siempre como botones.
// El resto queda plegado bajo "Otras variables".
const FLOW_VARIABLES: { key: string; label: string; primary?: boolean }[] = [
  { key: "contact.firstName", label: "Nombre del contacto", primary: true },
  { key: "contact.lastName", label: "Apellido del contacto" },
  { key: "contact.phone", label: "Teléfono del contacto" },
  { key: "organization.name", label: "Nombre del negocio", primary: true },
  { key: "clinic.name", label: "Nombre de la clínica" },
  { key: "clinic.address", label: "Dirección de la clínica" },
  { key: "appointment.date", label: "Fecha de la cita", primary: true },
  { key: "appointment.time", label: "Hora de la cita", primary: true },
  { key: "appointment.service", label: "Servicio de la cita" },
  { key: "appointment.professional", label: "Profesional" },
];

/**
 * Campo de texto (input o textarea) con autocompletado de variables: al escribir
 * "{{" o "{{par" ofrece las variables del flujo; ↑/↓ navegan, Enter/Tab/clic
 * insertan `{{clave}}`. Funciona en claro y oscuro (tokens del sistema).
 */
function VarField({
  value, onChange, multiline, className, rows, placeholder, chips,
}: {
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  className?: string;
  rows?: number;
  placeholder?: string;
  /** Muestra botones para insertar cada variable en la posición del cursor. */
  chips?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [menu, setMenu] = useState<{ open: boolean; query: string; start: number; index: number }>({ open: false, query: "", start: 0, index: 0 });
  const [showOthers, setShowOthers] = useState(false);
  const matches = useMemo(
    () => (menu.open ? FLOW_VARIABLES.filter((v) => `${v.key} ${v.label}`.toLowerCase().includes(menu.query.toLowerCase())) : []),
    [menu.open, menu.query],
  );

  function detect(el: HTMLTextAreaElement | HTMLInputElement) {
    const pos = el.selectionStart ?? 0;
    const m = value.slice(0, pos).match(/\{\{\s*([\w.]*)$/);
    if (m) setMenu({ open: true, query: m[1], start: pos - m[0].length, index: 0 });
    else setMenu((s) => (s.open ? { ...s, open: false } : s));
  }

  function insert(key: string) {
    const el = ref.current;
    if (!el) return;
    const pos = el.selectionStart ?? value.length;
    const token = `{{${key}}}`;
    onChange(value.slice(0, menu.start) + token + value.slice(pos));
    setMenu((s) => ({ ...s, open: false }));
    const caret = menu.start + token.length;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret, caret); });
  }

  /** Inserta `{{clave}}` en la posición del cursor (o al final si no hay foco). */
  function insertAtCaret(key: string) {
    const token = `{{${key}}}`;
    const el = ref.current;
    if (!el) { onChange(value + token); return; }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    onChange(value.slice(0, start) + token + value.slice(end));
    const caret = start + token.length;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret, caret); });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!menu.open || matches.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setMenu((s) => ({ ...s, index: (s.index + 1) % matches.length })); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setMenu((s) => ({ ...s, index: (s.index - 1 + matches.length) % matches.length })); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); insert(matches[Math.min(menu.index, matches.length - 1)].key); }
    else if (e.key === "Escape") { e.preventDefault(); setMenu((s) => ({ ...s, open: false })); }
  }

  const common = {
    ref: ref as React.Ref<any>,
    value,
    placeholder,
    className,
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => { onChange(e.target.value); detect(e.target); },
    onKeyUp: (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => detect(e.currentTarget),
    onClick: (e: React.MouseEvent<HTMLTextAreaElement | HTMLInputElement>) => detect(e.currentTarget),
    onKeyDown,
    onBlur: () => setTimeout(() => setMenu((s) => ({ ...s, open: false })), 120),
  };

  return (
    <div className="relative">
      {multiline ? <textarea {...common} rows={rows ?? 3} /> : <input {...common} />}
      {chips && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {/* Más usadas: siempre visibles. Se insertan donde esté el cursor del mensaje. */}
          {FLOW_VARIABLES.filter((v) => v.primary).map((v) => (
            <button
              key={v.key}
              type="button"
              // onMouseDown + preventDefault: conserva el cursor del campo al hacer clic.
              onMouseDown={(e) => { e.preventDefault(); insertAtCaret(v.key); }}
              title={`{{${v.key}}}`}
              className="rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-[11px] text-cyan-800 transition-colors hover:bg-cyan-100 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-300"
            >
              + {v.label}
            </button>
          ))}
          {/* Resto: se despliegan bajo "Otras variables". */}
          {!showOthers ? (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); setShowOthers(true); }}
              className="rounded-full border border-line-strong bg-app px-2 py-0.5 text-[11px] font-medium text-ink-muted transition-colors hover:border-brand-300 hover:text-ink"
            >
              Otras variables ▾
            </button>
          ) : (
            <>
              {FLOW_VARIABLES.filter((v) => !v.primary).map((v) => (
                <button
                  key={v.key}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); insertAtCaret(v.key); }}
                  title={`{{${v.key}}}`}
                  className="rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-[11px] text-cyan-800 transition-colors hover:bg-cyan-100 dark:border-cyan-500/30 dark:bg-cyan-500/10 dark:text-cyan-300"
                >
                  + {v.label}
                </button>
              ))}
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); setShowOthers(false); }}
                className="rounded-full border border-line-strong bg-app px-2 py-0.5 text-[11px] font-medium text-ink-muted transition-colors hover:border-brand-300 hover:text-ink"
              >
                Menos ▴
              </button>
            </>
          )}
        </div>
      )}
      {menu.open && matches.length > 0 && (
        <div className="absolute left-0 z-30 mt-1 max-h-52 w-72 overflow-y-auto rounded-lg border border-line bg-panel p-1 text-sm shadow-pop">
          <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-ink-subtle">Variables del flujo</p>
          {matches.map((v, i) => (
            <button
              key={v.key}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); insert(v.key); }}
              className={cn("flex w-full items-baseline gap-2 rounded px-2 py-1 text-left", i === menu.index ? "bg-brand-soft" : "hover:bg-app")}
            >
              <span className="shrink-0 font-mono text-xs text-brand-700 dark:text-brand-300">{`{{${v.key}}}`}</span>
              <span className="truncate text-xs text-ink-subtle">{v.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Selector de anuncios Click-to-Chat (catálogo Meta) ----
interface AdLeaf { id: string; name: string; status: string; isCtwa: boolean; available: boolean }
interface AdsetNode { id: string; name: string; ads: AdLeaf[] }
interface CampaignNode { id: string; name: string; objective: string | null; adsets: AdsetNode[] }
interface AdAccounts { connected: boolean; canReadAds: boolean; accounts: { id: string; externalId: string; name: string; enabled: boolean }[] }
interface AdCatalog { total: number; lastSyncedAt: string | null; campaigns: CampaignNode[] }

function ClickToChatConfig({ trigger, onChange }: { trigger: DefTrigger; onChange: (t: DefTrigger) => void }) {
  const toast = useToast();
  const cfg = trigger.config as Record<string, any>;
  const setCfg = (patch: Record<string, unknown>) => onChange({ ...trigger, config: { ...cfg, ...patch } });
  const [accts, setAccts] = useState<AdAccounts | null>(null);
  const [catalog, setCatalog] = useState<AdCatalog | null>(null);
  const [q, setQ] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const mode: "all" | "selected" = cfg.mode === "selected" ? "selected" : "all";
  const campaignIds: string[] = Array.isArray(cfg.campaignIds) ? cfg.campaignIds.map(String) : [];
  const adIds: string[] = Array.isArray(cfg.adIds) ? cfg.adIds.map(String) : [];
  const adAccountId: string | undefined = cfg.adAccountId ? String(cfg.adAccountId) : accts?.accounts.find((a) => a.enabled)?.externalId;

  useEffect(() => {
    void api<AdAccounts>("/integrations/meta/ads/accounts").then(setAccts).catch(() => setAccts({ connected: false, canReadAds: false, accounts: [] }));
  }, []);
  const loadCatalog = useCallback(() => {
    if (!accts?.canReadAds || !adAccountId) return;
    void api<AdCatalog>(`/integrations/meta/ads/catalog?adAccountId=${encodeURIComponent(adAccountId)}`).then(setCatalog).catch(() => setCatalog({ total: 0, lastSyncedAt: null, campaigns: [] }));
  }, [accts, adAccountId]);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);

  async function syncNow() {
    setSyncing(true);
    try {
      await api("/integrations/meta/ads/sync", { method: "POST" });
      toast.push("Sincronización encolada — recarga en unos segundos", "ok");
      setTimeout(loadCatalog, 4000);
    } catch (e) { toast.push((e as Error).message, "error"); }
    finally { setSyncing(false); }
  }

  // Sin conexión → CTA al hub.
  if (accts && !accts.connected) {
    return (
      <div className="rounded-card border border-line bg-app p-4 text-center">
        <p className="text-sm font-medium text-ink">Conecta tu cuenta de Meta Business</p>
        <p className="mt-1 text-xs text-ink-muted">Para elegir campañas y anuncios necesitas conectar Meta una vez.</p>
        <a href="/integrations/meta" className="mt-3 inline-flex rounded-control bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700">Conectar cuenta de Meta Business</a>
        <AdvancedManual cfg={cfg} setCfg={setCfg} show={showManual} setShow={setShowManual} />
      </div>
    );
  }
  // Conectada pero sin permiso de anuncios (App Review pendiente / no admin).
  if (accts && accts.connected && !accts.canReadAds) {
    return (
      <div className="rounded-card border border-amber-300 bg-amber-50 p-4 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
        <p className="font-medium">No podemos listar tus anuncios todavía</p>
        <p className="mt-1">Falta el permiso <code>ads_read</code>. En desarrollo funciona con cuentas donde eres administrador; en producción requiere aprobación de Meta (App Review). Puedes conectarlo desde <a href="/integrations/meta" className="underline">Integraciones → Centro Meta</a> o pegar un ad_id manualmente.</p>
        <AdvancedManual cfg={cfg} setCfg={setCfg} show={showManual} setShow={setShowManual} />
      </div>
    );
  }

  const acc = accts?.accounts.find((a) => a.externalId === adAccountId);
  const ql = q.trim().toLowerCase();
  const matchesQ = (s: string) => !ql || s.toLowerCase().includes(ql);
  const campaigns = (catalog?.campaigns ?? []).map((c) => ({
    ...c,
    adsets: c.adsets.map((s) => ({ ...s, ads: s.ads.filter((a) => matchesQ(a.name) || matchesQ(s.name) || matchesQ(c.name)) })).filter((s) => s.ads.length > 0),
  })).filter((c) => c.adsets.length > 0 || matchesQ(c.name));

  const isCampaignSel = (id: string) => campaignIds.includes(id);
  const isAdSel = (a: AdLeaf, campId: string) => isCampaignSel(campId) || adIds.includes(a.id);
  const toggleCampaign = (id: string) => setCfg({ mode: "selected", campaignIds: isCampaignSel(id) ? campaignIds.filter((c) => c !== id) : [...campaignIds, id] });
  const toggleAd = (a: AdLeaf) => setCfg({ mode: "selected", adIds: adIds.includes(a.id) ? adIds.filter((x) => x !== a.id) : [...adIds, a.id] });

  // Advertencia: ¿todos los anuncios seleccionados están pausados?
  const selectedAds = (catalog?.campaigns ?? []).flatMap((c) => c.adsets.flatMap((s) => s.ads.filter((a) => isAdSel(a, c.id))));
  const onlyPaused = mode === "selected" && selectedAds.length > 0 && selectedAds.every((a) => a.status !== "ACTIVE");

  return (
    <div className="space-y-3">
      {accts && accts.accounts.length > 1 && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Cuenta publicitaria</span>
          <select value={adAccountId ?? ""} onChange={(e) => setCfg({ adAccountId: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm">
            {accts.accounts.map((a) => <option key={a.externalId} value={a.externalId}>{a.name}</option>)}
          </select>
        </label>
      )}
      <div className="flex items-center justify-between text-[11px] text-ink-subtle">
        <span>{acc?.name ?? "Cuenta"} · <a href="/integrations/meta" className="underline">Administrar</a></span>
        <button onClick={() => void syncNow()} disabled={syncing} className="rounded border border-line-strong px-2 py-0.5 hover:bg-app disabled:opacity-50">{syncing ? "Sincronizando…" : "Sincronizar ahora"}</button>
      </div>

      <div className="flex gap-1 rounded-control bg-app p-0.5 text-xs">
        {(["all", "selected"] as const).map((m) => (
          <button key={m} onClick={() => setCfg({ mode: m })} className={cn("flex-1 rounded px-2 py-1 font-medium transition-colors", mode === m ? "bg-panel text-ink shadow-e1" : "text-ink-muted hover:text-ink")}>
            {m === "all" ? "Todos los anuncios" : "Anuncios seleccionados"}
          </button>
        ))}
      </div>

      {mode === "all" ? (
        <p className="rounded-card border border-line bg-app px-3 py-2 text-xs text-ink-muted">Cualquier anuncio Click-to-WhatsApp de esta cuenta dispara el flujo.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar campaña, conjunto o anuncio…" className="flex-1 rounded-control border border-line-strong bg-panel px-2.5 py-1.5 text-xs" />
            <button onClick={() => setCfg({ mode: "selected", campaignIds: [...new Set([...campaignIds, ...campaigns.map((c) => c.id)])] })} className="whitespace-nowrap rounded border border-line-strong px-2 py-1.5 text-xs hover:bg-app">Seleccionar todo</button>
          </div>
          <p className="text-[11px] text-ink-subtle">{campaignIds.length} campaña(s) + {adIds.length} anuncio(s) seleccionados</p>
          {onlyPaused && <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">⚠ Solo seleccionaste anuncios pausados: no llegarán mensajes hasta reactivarlos.</p>}

          {catalog && catalog.total === 0 ? (
            <div className="rounded-card border border-dashed border-line-strong bg-app p-4 text-center text-xs text-ink-muted">
              Sin anuncios en el catálogo. <button onClick={() => void syncNow()} className="underline">Sincroniza ahora</button> para traerlos de Meta.
            </div>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-card border border-line bg-panel p-1.5">
              {campaigns.map((c) => (
                <div key={c.id}>
                  <label className="flex items-center gap-2 rounded px-1.5 py-1 text-xs font-medium hover:bg-app">
                    <input type="checkbox" checked={isCampaignSel(c.id)} onChange={() => toggleCampaign(c.id)} className="h-3.5 w-3.5" />
                    <span className="truncate text-ink">{c.name}</span>
                  </label>
                  {c.adsets.map((s) => (
                    <div key={s.id} className="ml-4">
                      <p className="px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-subtle">{s.name}</p>
                      {s.ads.map((a) => (
                        <label key={a.id} className={cn("ml-2 flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-app", !a.available && "opacity-50")} title={!a.available ? "Ya no está en Meta" : undefined}>
                          <input type="checkbox" checked={isAdSel(a, c.id)} disabled={isCampaignSel(c.id)} onChange={() => toggleAd(a)} className="h-3.5 w-3.5" />
                          <span className="truncate text-ink-muted">{a.name}</span>
                          <span className={cn("ml-auto shrink-0 rounded px-1 text-[9px]", a.status === "ACTIVE" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-app text-ink-subtle")}>{a.status === "ACTIVE" ? "activo" : "pausado"}</span>
                          {!a.available && <span className="shrink-0 text-[9px] text-amber-600 dark:text-amber-400">no disponible</span>}
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              ))}
              {campaigns.length === 0 && <p className="px-2 py-2 text-xs text-ink-subtle">Sin resultados para «{q}».</p>}
            </div>
          )}
        </div>
      )}
      <AdvancedManual cfg={cfg} setCfg={setCfg} show={showManual} setShow={setShowManual} />
    </div>
  );
}

function AdvancedManual({ cfg, setCfg, show, setShow }: { cfg: Record<string, any>; setCfg: (p: Record<string, unknown>) => void; show: boolean; setShow: (v: boolean) => void }) {
  return (
    <div className="mt-2 text-left">
      <button onClick={() => setShow(!show)} className="text-[11px] text-ink-subtle underline">{show ? "Ocultar" : "Avanzado: pegar un ad_id manual"}</button>
      {show && (
        <input
          value={String(cfg.adId ?? "")}
          onChange={(e) => setCfg({ adId: e.target.value })}
          placeholder="ad_id específico (alternativa avanzada)"
          className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-xs"
        />
      )}
    </div>
  );
}

/** Canales de mensajería para la condición de canal (multi-canal en camino). */
const MSG_CHANNELS = [
  { value: "whatsapp", label: "WhatsApp" },
  { value: "instagram", label: "Instagram (pronto)" },
  { value: "messenger", label: "Messenger (pronto)" },
];

/** Condiciones del disparador «Mensaje recibido»: canal, palabras, contiene/exacto. */
/** Sanea un código de enlace: minúsculas, sin espacios ni símbolos raros. */
function sanitizeLinkCode(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // quita tildes
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

/**
 * Disparador «Enlace / Código QR». Genera un enlace wa.me con un mensaje
 * predefinido que incluye un código único; al ENVIARLO, el mensaje entrante
 * contiene el código y arranca este flujo. El QR es el mismo enlace.
 */
function LinkScanConfig({ waPhone, trigger, onChange }: { waPhone: string | null; trigger: DefTrigger; onChange: (t: DefTrigger) => void }) {
  const cfg = trigger.config;
  const code = String(cfg.code ?? "");
  const message = String(cfg.linkMessage ?? "¡Hola! Quiero más información 🙌");
  const set = (patch: Record<string, unknown>) => onChange({ ...trigger, config: { ...cfg, ...patch } });

  // El texto que la persona termina enviando: su mensaje + el marcador con el código.
  const fullText = code ? `${message} [${code}]` : message;
  const phoneDigits = (waPhone ?? "").replace(/[^0-9]/g, "");
  const link = phoneDigits && code ? `https://wa.me/${phoneDigits}?text=${encodeURIComponent(fullText)}` : "";
  const qrRef = useRef<HTMLDivElement>(null);

  function downloadQR() {
    const canvas = qrRef.current?.querySelector("canvas");
    if (!canvas) return;
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `qr-${code || "flujo"}.png`;
    a.click();
  }

  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <label className="block text-sm">
        <span className="text-xs text-ink-muted">Código del enlace (único)</span>
        <div className="mt-1 flex gap-2">
          <input
            value={code}
            onChange={(e) => set({ code: sanitizeLinkCode(e.target.value) })}
            placeholder="p. ej. promo-implantes"
            className="block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => set({ code: `promo-${Math.random().toString(36).slice(2, 7)}` })}
            className="shrink-0 rounded-lg border border-line-strong px-3 text-xs font-medium text-ink-muted hover:bg-app"
          >
            Generar
          </button>
        </div>
      </label>

      <label className="block text-sm">
        <span className="text-xs text-ink-muted">Mensaje predefinido (lo que la persona enviará)</span>
        <textarea
          value={message}
          onChange={(e) => set({ linkMessage: e.target.value })}
          rows={2}
          className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm"
        />
        <span className="mt-1 block text-[10px] text-ink-subtle">Le agregamos <code>[{code || "código"}]</code> al final para reconocerlo. No lo borres.</span>
      </label>

      {!waPhone ? (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          Conecta tu número de WhatsApp en <b>Canales</b> para generar el enlace y el QR.
        </p>
      ) : !code ? (
        <p className="text-[11px] text-ink-subtle">Genera un código para ver el enlace y el QR.</p>
      ) : (
        <div className="space-y-2">
          <div className="flex items-start gap-3 rounded-lg border border-line bg-app/40 p-3">
            <div ref={qrRef} className="shrink-0 rounded-md bg-white p-1.5">
              <QRCodeCanvas value={link} size={104} marginSize={2} />
            </div>
            <div className="min-w-0 space-y-1.5">
              <p className="text-[11px] text-ink-subtle">Enlace para carteles, redes o el local:</p>
              <p className="truncate rounded bg-panel px-2 py-1 font-mono text-[10px] text-ink-muted" title={link}>{link}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => void navigator.clipboard?.writeText(link)} className="rounded-md border border-line-strong px-2 py-1 text-[11px] font-medium text-ink-muted hover:bg-app">Copiar enlace</button>
                <button type="button" onClick={downloadQR} className="rounded-md border border-line-strong px-2 py-1 text-[11px] font-medium text-ink-muted hover:bg-app">Descargar QR</button>
              </div>
            </div>
          </div>
          <p className="text-[10px] text-ink-subtle">Ojo: el flujo arranca cuando la persona <b>envía</b> el mensaje (toca enviar en WhatsApp), no al escanear. Es propio de WhatsApp: recién ahí sabemos quién es.</p>
        </div>
      )}
    </div>
  );
}

function MessageReceivedConditions({ trigger, onChange }: { trigger: DefTrigger; onChange: (t: DefTrigger) => void }) {
  const cfg = trigger.config;
  const words: string[] = Array.isArray(cfg.keywords) ? (cfg.keywords as string[]) : cfg.keyword ? [String(cfg.keyword)] : [];
  // Al editar migramos el `keyword` legado a `keywords[]`.
  const set = (patch: Record<string, unknown>) => onChange({ ...trigger, config: { ...cfg, ...patch, keyword: undefined } });
  const matchType = cfg.matchType === "exact" ? "exact" : "contains";
  const matchAll = cfg.matchAll === true;
  const showAllAny = matchType !== "exact" && words.length >= 2;
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <p className="text-xs font-medium text-ink-muted">Condiciones (opcionales)</p>

      <label className="block text-sm">
        <span className="text-xs text-ink-muted">Canal</span>
        <select
          value={String(cfg.channel ?? "")}
          onChange={(e) => set({ channel: e.target.value || undefined })}
          className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm"
        >
          <option value="">— cualquier canal —</option>
          {MSG_CHANNELS.map((c) => (<option key={c.value} value={c.value}>{c.label}</option>))}
        </select>
      </label>

      <label className="block text-sm">
        <span className="text-xs text-ink-muted">Palabras o frases (una por línea)</span>
        <textarea
          value={words.join("\n")}
          onChange={(e) => set({ keywords: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
          rows={3}
          placeholder={"hora\nagendar\nprecio"}
          className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm"
        />
        <span className="mt-1 block text-[10px] text-ink-subtle">Vacío = cualquier mensaje.</span>
      </label>

      <div className="flex flex-wrap gap-3 text-xs text-ink-muted">
        <span className="text-ink-subtle">Coincidencia:</span>
        {(["contains", "exact"] as const).map((m) => (
          <label key={m} className="flex items-center gap-1">
            <input type="radio" name="matchType" checked={matchType === m} onChange={() => set({ matchType: m })} />
            {m === "contains" ? "Contiene" : "Exacta"}
          </label>
        ))}
      </div>

      {showAllAny && (
        <div className="flex flex-wrap gap-3 text-xs text-ink-muted">
          <span className="text-ink-subtle">Con varias palabras:</span>
          {([["false", "Cualquiera"], ["true", "Todas"]] as const).map(([v, label]) => (
            <label key={v} className="flex items-center gap-1">
              <input type="radio" name="matchAll" checked={String(matchAll) === v} onChange={() => set({ matchAll: v === "true" })} />
              {label}
            </label>
          ))}
        </div>
      )}

      <label className="flex items-center gap-1.5 text-xs text-ink-muted">
        <input
          type="checkbox"
          checked={cfg.firstMessage === true}
          onChange={(e) => set({ firstMessage: e.target.checked })}
        />
        Solo el primer mensaje de la conversación
      </label>
    </div>
  );
}

/** Triggers de cita que aceptan filtros por servicio/profesional/sede. */
const APPT_FILTERABLE = new Set([
  "appointment_created", "appointment_confirmed", "appointment_rescheduled",
  "appointment_cancelled", "no_show", "appointment_upcoming",
]);

/** Filtros opcionales (servicio / profesional / sede) para los triggers de cita. */
function ApptFilters({ catalog, trigger, onChange }: { catalog: Catalog; trigger: DefTrigger; onChange: (t: DefTrigger) => void }) {
  const opts = catalog.appointmentFilters;
  const dims: { key: string; label: string; items: { id: string; name: string }[] }[] = [
    { key: "serviceIds", label: "Servicio", items: opts?.services ?? [] },
    { key: "professionalIds", label: "Profesional", items: opts?.professionals ?? [] },
    { key: "clinicIds", label: "Sede", items: opts?.clinics ?? [] },
  ];
  const anyOptions = dims.some((d) => d.items.length > 0);
  const toggle = (key: string, id: string) => {
    const cur = Array.isArray(trigger.config[key]) ? (trigger.config[key] as string[]) : [];
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    onChange({ ...trigger, config: { ...trigger.config, [key]: next } });
  };
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <p className="text-xs font-medium text-ink-muted">Filtros (opcionales)</p>
      {!anyOptions ? (
        <p className="text-[11px] text-ink-subtle">
          Aún no hay servicios, profesionales ni sedes en tus citas. Aparecerán aquí cuando la agenda registre citas con esos datos; sin filtros el flujo aplica a todas las citas.
        </p>
      ) : (
        dims.filter((d) => d.items.length > 0).map((d) => {
          const sel = Array.isArray(trigger.config[d.key]) ? (trigger.config[d.key] as string[]) : [];
          return (
            <div key={d.key}>
              <p className="mb-1 text-[11px] font-medium text-ink-subtle">{d.label}{sel.length > 0 ? ` · ${sel.length}` : " · todos"}</p>
              <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-md border border-line-strong bg-panel p-1.5">
                {d.items.map((it) => (
                  <label key={it.id} className="flex items-center gap-2 rounded px-1 py-0.5 text-[13px] hover:bg-app">
                    <input type="checkbox" className="h-3.5 w-3.5" checked={sel.includes(it.id)} onChange={() => toggle(d.key, it.id)} />
                    <span className="truncate">{it.name}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })
      )}
      <p className="text-[10px] text-ink-subtle">Vacío = cualquiera. Se combinan con Y: la cita debe cumplir todos los filtros marcados.</p>
    </div>
  );
}

function TriggerPanel({ wfId, catalog, trigger, onChange, issues = [] }: { wfId: string; catalog: Catalog; trigger: DefTrigger; onChange: (t: DefTrigger) => void; issues?: string[] }) {
  const desc = catalog.triggers.find((t) => t.type === trigger.type)?.description;
  const isMsg = trigger.type === "message_received" || trigger.type === "keyword";
  const preview = triggerPreview(trigger.type, trigger.config, {
    leadStatusName: (c) => catalog.leadStatuses.find((s) => s.code === c)?.name,
    channelName: (id) => MSG_CHANNELS.find((c) => c.value === id)?.label,
  });

  // Conflictos en vivo: otros flujos activos que reaccionan al mismo evento.
  // Se consulta con debounce al cambiar el disparador (no bloquea; avisa).
  const [conflicts, setConflicts] = useState<{ id: string; name: string }[]>([]);
  const trigKey = JSON.stringify({ t: trigger.type, c: trigger.config });
  useEffect(() => {
    let alive = true;
    const h = setTimeout(() => {
      api<{ conflicts: { id: string; name: string }[] }>(`/workflows/${wfId}/trigger-conflicts`, {
        method: "POST",
        body: JSON.stringify({ trigger: { type: trigger.type, config: trigger.config } }),
      })
        .then((r) => { if (alive) setConflicts(r.conflicts ?? []); })
        .catch(() => { if (alive) setConflicts([]); });
    }, 400);
    return () => { alive = false; clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wfId, trigKey]);

  return (
    <div className="space-y-3 p-5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
        <Zap size={13} /> Disparador
      </div>
      {issues.length > 0 && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
          <p className="flex items-center gap-1 font-medium"><AlertTriangle size={13} /> Corrige antes de publicar:</p>
          <ul className="mt-1 list-disc pl-4">{issues.map((m, i) => (<li key={i}>{m}</li>))}</ul>
        </div>
      )}
      <label className="block text-sm">
        <span className="text-xs text-ink-muted">¿Cuándo se ejecuta el flujo?</span>
        <select
          value={trigger.type}
          onChange={(e) => onChange({ type: e.target.value, config: {} })}
          className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm"
        >
          {catalog.triggers
            .filter((t) => !t.hidden || t.type === trigger.type)
            .map((t) => (<option key={t.type} value={t.type}>{t.label}</option>))}
        </select>
      </label>
      {desc && <p className="text-xs text-ink-subtle">{desc}</p>}

      {/* Vista previa en lenguaje natural: qué hará realmente este disparador. */}
      <div className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200">
        <Zap size={13} className="mt-0.5 shrink-0" />
        <p><span className="font-medium">Se activará cuando</span> {preview}</p>
      </div>

      {/* Conflictos: otros flujos activos que reaccionan al mismo evento. */}
      {conflicts.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
          <p className="flex items-center gap-1 font-medium"><AlertTriangle size={13} /> Otros flujos ya reaccionan a este evento</p>
          <ul className="mt-1 list-disc pl-4">{conflicts.map((c) => (<li key={c.id}>{c.name}</li>))}</ul>
          <p className="mt-1 text-[10px]">Si publicas, ambos se ejecutarán con el mismo evento. Afina las condiciones (palabras, canal, etapa…) para separarlos.</p>
        </div>
      )}

      {trigger.type === "keyword" && (
        <div className="space-y-2">
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Palabra o frase</span>
            <input
              value={String(trigger.config.keyword ?? "")}
              onChange={(e) => onChange({ ...trigger, config: { ...trigger.config, keyword: e.target.value } })}
              placeholder="p. ej. hora, precio, agendar"
              className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
            />
          </label>
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            Disparador <b>legado</b>. Cambia a <b>«Mensaje recibido»</b>, que admite varias palabras, «contiene» vs «exacta» y filtro por canal. Los flujos existentes siguen funcionando.
          </div>
        </div>
      )}

      {trigger.type === "message_received" && <MessageReceivedConditions trigger={trigger} onChange={onChange} />}

      {trigger.type === "link_scan" && <LinkScanConfig waPhone={catalog.waPhone ?? null} trigger={trigger} onChange={onChange} />}

      {catalog.triggers.find((t) => t.type === trigger.type)?.soon && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          «Próximamente»: puedes dejar el flujo armado, pero este disparador aún no se ejecuta (falta la fuente del evento).
        </p>
      )}

      {trigger.type === "click_to_chat" && <ClickToChatConfig trigger={trigger} onChange={onChange} />}

      {trigger.type === "lead_status_changed" && (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <p className="text-xs font-medium text-ink-muted">Condiciones (opcionales)</p>
          {(["fromStatus", "toStatus"] as const).map((key) => (
            <label key={key} className="block text-sm">
              <span className="text-xs text-ink-muted">{key === "fromStatus" ? "Desde la etapa" : "Hacia la etapa"}</span>
              <select
                value={String(trigger.config[key] ?? "")}
                onChange={(e) => onChange({ ...trigger, config: { ...trigger.config, [key]: e.target.value } })}
                className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm"
              >
                <option value="">— cualquiera —</option>
                {catalog.leadStatuses.map((s) => (<option key={s.code} value={s.code}>{s.emoji ? `${s.emoji} ` : ""}{s.name}</option>))}
              </select>
            </label>
          ))}
        </div>
      )}

      {trigger.type === "tag_added" && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Etiqueta específica (opcional)</span>
          <input
            value={String(trigger.config.tag ?? "")}
            onChange={(e) => onChange({ ...trigger, config: { ...trigger.config, tag: e.target.value } })}
            placeholder="nombre de la etiqueta — vacío = cualquiera"
            className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-[10px] text-ink-subtle">Se dispara al etiquetar desde el panel, un flujo, la IA o Lead Ads (solo asignaciones nuevas).</span>
        </label>
      )}

      {trigger.type === "appointment_upcoming" && (
        <div className="space-y-2">
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Horas antes de la cita</span>
            <input
              type="number"
              min={1}
              max={168}
              value={Number(trigger.config.hoursBefore ?? 24)}
              onChange={(e) => onChange({ ...trigger, config: { ...trigger.config, hoursBefore: Number(e.target.value) } })}
              className="mt-1 block w-28 rounded-lg border border-line-strong px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-[10px] text-ink-subtle">Se programa el recordatorio al crear la cita.</span>
          </label>
          <label className="flex items-start gap-1.5 text-xs text-ink-muted">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={trigger.config.avoidOffHours !== false}
              onChange={(e) => onChange({ ...trigger, config: { ...trigger.config, avoidOffHours: e.target.checked } })}
            />
            <span>Respetar el horario de atención<span className="block text-[10px] text-ink-subtle">Si el recordatorio cae de madrugada o fuera de horario, se corre al siguiente tramo hábil (salvo que quede después de la cita).</span></span>
          </label>
        </div>
      )}

      {APPT_FILTERABLE.has(trigger.type) && <ApptFilters catalog={catalog} trigger={trigger} onChange={onChange} />}

      {isMsg && <TriggerTester config={trigger.config} />}
    </div>
  );
}

/** Probar el disparador de mensaje: escribes un texto y dice si dispararía. */
function TriggerTester({ config }: { config: Record<string, unknown> }) {
  const [text, setText] = useState("");
  const t = text.trim();
  const fires = t ? messageWouldTrigger(config, text) : null;
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <p className="flex items-center gap-1 text-xs font-medium text-ink-muted"><FlaskConical size={13} /> Probar el disparador</p>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Escribe un mensaje de ejemplo…"
        className="block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm"
      />
      {fires !== null && (
        fires ? (
          <p className="flex items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
            <CheckCircle2 size={14} /> Este mensaje SÍ dispararía el flujo.
          </p>
        ) : (
          <p className="flex items-center gap-1.5 rounded-md bg-red-50 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <XCircle size={14} /> No dispara: el texto no cumple las palabras configuradas.
          </p>
        )
      )}
      <p className="text-[10px] text-ink-subtle">Prueba solo las palabras/coincidencia. El canal y «primer mensaje» se validan en la ejecución real.</p>
    </div>
  );
}

function AddStepModal({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (type: string) => void }) {
  const [q, setQ] = useState("");
  const term = q.trim().toLowerCase();
  const matches = (n: NodeDef) => !term || n.label.toLowerCase().includes(term) || n.description.toLowerCase().includes(term);
  const anyMatch = NODE_DEFS.some(matches);
  return (
    <Modal open={open} onClose={onClose} title="Añadir paso" wide>
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-line px-3 py-2">
        <Search size={15} className="text-ink-subtle" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar un paso…" className="w-full bg-transparent text-sm outline-none" />
      </div>
      <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
        {CATEGORIES.map((cat) => {
          const items = NODE_DEFS.filter((n) => n.category === cat && matches(n));
          if (items.length === 0) return null;
          return (
            <div key={cat}>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">{cat}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {items.map((n) => (
                  <button
                    key={n.type}
                    disabled={n.soon}
                    title={n.soon ? "Próximamente — aún no disponible" : n.description}
                    onClick={() => { if (!n.soon) { onPick(n.type); setQ(""); } }}
                    className={cn(
                      "flex items-start gap-2 rounded-lg border px-3 py-2 text-left",
                      n.soon ? "cursor-not-allowed border-line opacity-50" : "border-line hover:border-brand-300 hover:bg-brand-50",
                    )}
                  >
                    <span className="mt-0.5 shrink-0 text-ink-subtle">{n.icon}</span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                        {n.label}
                        {n.soon && <span className="rounded bg-app px-1 text-[9px] text-ink-muted">Próximamente</span>}
                        {n.premium && !n.soon && <span className="rounded bg-brand-100 px-1 text-[9px] text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">Premium</span>}
                      </span>
                      <span className="block text-xs text-ink-muted">{n.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
        {!anyMatch && <p className="py-6 text-center text-sm text-ink-subtle">Sin resultados para “{q}”.</p>}
      </div>
    </Modal>
  );
}

function NodePanel({
  node, catalog, steps, onChange, onDelete,
}: {
  node: Node;
  catalog: Catalog;
  steps: { id: string; label: string }[];
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const type = (node.data as any).nodeType as string;
  const config = (node.data as any).config as Record<string, any>;
  const def = NODE_DEF(type);
  return (
    <div className="space-y-3 p-5">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <span className="text-ink-subtle">{def?.icon}</span>{def?.label ?? type}
        </p>
        <button onClick={onDelete} className="rounded-lg p-1.5 text-red-500 hover:bg-red-50" title="Eliminar paso"><Trash2 size={15} /></button>
      </div>

      {type === "send_text" && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Mensaje</span>
          <VarField
            multiline
            chips
            value={String(config.text ?? "")}
            onChange={(v) => onChange({ text: v })}
            rows={4}
            placeholder="Hola {{contact.firstName}} 👋"
            className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-[10px] text-ink-subtle">Toca una variable para insertarla, o escribe <code>{"{{"}</code>.</span>
        </label>
      )}

      {type === "run_agent" && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Agente</span>
          <select value={config.agentSlug ?? ""} onChange={(e) => onChange({ agentSlug: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm">
            <option value="">Agente activo de la conversación</option>
            {catalog.agents.map((a) => (<option key={a.slug} value={a.slug}>🤖 {a.name}</option>))}
          </select>
        </label>
      )}

      {type === "wait" && <WaitForm config={config} onChange={onChange} />}

      {type === "wait_reply" && <WaitReplyForm config={config} onChange={onChange} />}

      {type === "condition" && (
        <p className="rounded-lg bg-app p-3 text-xs text-ink-muted">
          Si el contacto <b>no ha respondido</b> desde que inició el flujo, sigue por <b>Sin respuesta</b>. Si respondió, sigue por <b>Respondió</b>.
        </p>
      )}

      {type === "open_conversation" && (
        <p className="rounded-lg bg-app p-3 text-xs text-ink-muted">
          Abre una conversación para el contacto (o reutiliza la que ya tenga abierta) para que los pasos siguientes puedan escribirle. Útil tras un disparo por cita o manual.
        </p>
      )}

      {type === "add_note" && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Comentario interno (el cliente NO lo ve)</span>
          <VarField multiline chips value={String(config.text ?? "")} onChange={(v) => onChange({ text: v })} rows={3} placeholder="p. ej. Lead de campaña {{contact.firstName}}" className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
        </label>
      )}

      {type === "goto" && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Continuar en el paso…</span>
          <select value={config.targetNodeId ?? ""} onChange={(e) => onChange({ targetNodeId: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm">
            <option value="">— elige un paso —</option>
            {steps.map((s) => (<option key={s.id} value={s.id}>{s.label}</option>))}
          </select>
          <span className="mt-1 block text-[10px] text-ink-subtle">Salta a otro paso (se dibuja punteado). Máximo 25 saltos por ejecución para evitar bucles.</span>
        </label>
      )}

      {type === "business_hours" && <BusinessHoursForm config={config} onChange={onChange} />}

      {type === "send_capi" && <CapiForm config={config} onChange={onChange} />}

      {type === "send_tiktok_event" && (
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">Próximamente: requiere integrar TikTok Events API. Puedes dejar el paso, pero aún no envía.</p>
      )}

      {type === "ai_objective" && (
        <div className="space-y-2">
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Agente</span>
            <select value={config.agentSlug ?? ""} onChange={(e) => onChange({ agentSlug: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm">
              <option value="">Agente activo de la conversación</option>
              {catalog.agents.map((a) => (<option key={a.slug} value={a.slug}>🤖 {a.name}</option>))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Objetivo</span>
            <VarField multiline chips value={String(config.objective ?? "")} onChange={(v) => onChange({ objective: v })} rows={2} placeholder="p. ej. Confirmar asistencia a la cita" className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              <span className="text-xs text-ink-muted">Turnos máx. del contacto</span>
              <input type="number" min={1} max={20} value={config.maxTurns ?? 1} onChange={(e) => onChange({ maxTurns: Number(e.target.value) || 1 })} className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-ink-muted">Timeout (horas)</span>
              <input type="number" min={1} max={168} value={config.timeoutHours ?? 24} onChange={(e) => onChange({ timeoutHours: Number(e.target.value) || 24 })} className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
            </label>
          </div>
          <p className="text-[10px] text-ink-subtle">Con 1 turno, evalúa el estado actual y ramifica de inmediato. Con más turnos, el agente sigue conversando: cada respuesta del contacto re-evalúa el objetivo, y si nadie lo resuelve antes del timeout, sigue por «No cumplido».</p>
        </div>
      )}

      {type === "send_template" && (
        <div className="space-y-2">
          {catalog.templatesEnabled === false && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
              {catalog.templatesPlanAllows === false
                ? "Los mensajes de plantilla no están incluidos en tu plan. Sube de plan para poder publicar este flujo."
                : "Requiere activar los mensajes de plantilla en tu cuenta. Contáctanos para habilitarlos."}{" "}
              Mientras no esté activado, <b>no podrás publicar</b> un flujo que use este paso.
            </p>
          )}
          {catalog.templates.length === 0 ? (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
              Requiere conectar WhatsApp y tener plantillas <b>aprobadas</b>. Crea o sincroniza plantillas en{" "}
              <a href="/channels" className="underline">Canales → Plantillas</a> y vuelve a abrir este panel.
            </p>
          ) : (
            <>
              <label className="block text-sm">
                <span className="text-xs text-ink-muted">Plantilla aprobada</span>
                <select
                  value={config.templateId ?? ""}
                  onChange={(e) => {
                    const t = catalog.templates.find((x) => x.id === e.target.value);
                    onChange({ templateId: e.target.value, templateName: t?.name ?? "" });
                  }}
                  className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm"
                >
                  <option value="">— elegir —</option>
                  {catalog.templates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name} · {t.language}</option>
                  ))}
                </select>
              </label>
              <p className="text-[10px] text-ink-subtle">
                Las variables de la plantilla se completan solas con los datos reales del contacto (nombre, cita, etc.)
                según el mapeo definido al crearla. Funciona aunque la ventana de 24 h esté cerrada.
              </p>
            </>
          )}
        </div>
      )}

      {type === "call_api" && <HttpForm config={config} onChange={onChange} presets={catalog.apiPresets ?? []} />}

      {type === "send_ga4_event" && (
        <div className="space-y-2">
          {!catalog.ga4Connected && (
            <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
              Requiere conectar <a href="/integrations" className="underline">Google Analytics</a> — la publicación se bloquea
              hasta conectarlo.
            </p>
          )}
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Nombre del evento (snake_case)</span>
            <input
              value={config.eventName ?? ""}
              onChange={(e) => onChange({ eventName: e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, "_") })}
              placeholder="lead_calificado"
              className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 font-mono text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Parámetros (JSON, admite variables en los valores)</span>
            <textarea
              defaultValue={JSON.stringify(config.params ?? {}, null, 0)}
              onChange={(e) => {
                try {
                  const obj = JSON.parse(e.target.value || "{}");
                  if (obj && typeof obj === "object") onChange({ params: obj });
                } catch {
                  /* JSON incompleto mientras escribe */
                }
              }}
              rows={2}
              placeholder='{"origen": "whatsapp", "nombre": "{{contact.firstName}}"}'
              className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 font-mono text-xs"
            />
          </label>
        </div>
      )}

      {type === "send_internal_email" && (
        <div className="space-y-2">
          <p className="rounded-lg bg-app p-2 text-[10px] text-ink-muted">
            Correo <b>interno al equipo</b> — no es correo masivo a contactos/pacientes (para eso están las plantillas de
            WhatsApp con consentimiento).
          </p>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Destinatarios (emails del equipo, separados por coma)</span>
            <input
              value={(Array.isArray(config.to) ? config.to : []).join(", ")}
              onChange={(e) => onChange({ to: e.target.value.split(",").map((s: string) => s.trim()).filter(Boolean) })}
              placeholder="recepcion@tuclinica.cl, dueno@tuclinica.cl"
              className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Asunto</span>
            <VarField
              chips
              value={String(config.subject ?? "")}
              onChange={(v) => onChange({ subject: v })}
              placeholder="Nuevo lead: {{contact.firstName}}"
              className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Cuerpo (admite variables {"{{contact.firstName}}"}…)</span>
            <VarField
              multiline
              chips
              value={String(config.body ?? "")}
              onChange={(v) => onChange({ body: v })}
              rows={3}
              className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
            />
          </label>
          <p className="text-[10px] text-ink-subtle">
            Usa el remitente configurado en <a href="/integrations" className="underline">Integraciones → Correo electrónico</a>
            {" "}(o el de la plataforma por defecto).
          </p>
        </div>
      )}

      {type === "google_sheets_append" && (
        <div className="space-y-2">
          {!catalog.googleConnected && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
              Para publicar este flujo primero conecta tu cuenta de Google en{" "}
              <a href="/integrations" className="underline">Integraciones → Google Calendar / Sheets</a>.
            </p>
          )}
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">ID de la planilla (de la URL: docs.google.com/spreadsheets/d/<b>ID</b>/…)</span>
            <input
              value={config.spreadsheetId ?? ""}
              onChange={(e) => onChange({ spreadsheetId: e.target.value.trim() })}
              placeholder="1AbC…xyz"
              className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Nombre de la hoja (pestaña)</span>
            <input
              value={config.sheetName ?? ""}
              onChange={(e) => onChange({ sheetName: e.target.value })}
              placeholder="Hoja 1"
              className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Columnas de la fila (una por línea; admiten {"{{variables}}"})</span>
            <textarea
              value={(Array.isArray(config.values) ? config.values : []).join("\n")}
              onChange={(e) => onChange({ values: e.target.value.split("\n") })}
              rows={4}
              placeholder={"{{contact.firstName}}\n{{contact.phone}}\nNuevo lead"}
              className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 font-mono text-xs"
            />
          </label>
          <p className="text-[10px] text-ink-subtle">Cada línea es una columna (A, B, C…). La fila se agrega al final de la hoja.</p>
        </div>
      )}

      {type === "update_lead_status" && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Nuevo estado del lead</span>
          <select value={config.statusCode ?? ""} onChange={(e) => onChange({ statusCode: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm">
            <option value="">— elegir —</option>
            {catalog.leadStatuses.map((s) => (<option key={s.code} value={s.code}>{s.emoji ? `${s.emoji} ` : ""}{s.name}</option>))}
          </select>
        </label>
      )}

      {(type === "add_tag" || type === "remove_tag") && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Etiqueta</span>
          <input value={config.tag ?? ""} onChange={(e) => onChange({ tag: e.target.value })} placeholder="p. ej. interesado" className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
        </label>
      )}

      {type === "update_contact" && (
        <div className="space-y-2">
          <p className="text-xs text-ink-muted">Guarda estos datos del contacto (deja vacío lo que no cambie):</p>
          {(["firstName", "lastName", "email"] as const).map((k) => (
            <label key={k} className="block text-sm">
              <span className="text-xs text-ink-muted">{k === "firstName" ? "Nombre" : k === "lastName" ? "Apellido" : "Email"}</span>
              <input
                value={(config.fields ?? {})[k] ?? ""}
                onChange={(e) => onChange({ fields: { ...(config.fields ?? {}), [k]: e.target.value } })}
                placeholder="admite {{variables}}"
                className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
              />
            </label>
          ))}
        </div>
      )}

      {type === "assign_user" && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Usuario</span>
          <select value={config.userId ?? ""} onChange={(e) => onChange({ userId: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm">
            <option value="">— elegir persona —</option>
            {catalog.users.map((u) => (<option key={u.id} value={u.id}>{u.name}</option>))}
          </select>
          <span className="mt-1 block text-[10px] text-ink-subtle">Al asignar, la IA se pausa en esa conversación.</span>
        </label>
      )}

      {type === "assign_team" && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Equipo</span>
          <select value={config.teamId ?? ""} onChange={(e) => onChange({ teamId: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm">
            <option value="">— elegir equipo —</option>
            {catalog.teams.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
          </select>
          <span className="mt-1 block text-[10px] text-ink-subtle">Al asignar, la IA se pausa en esa conversación.</span>
        </label>
      )}

      {type === "switch_agent" && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Agente IA que toma el control</span>
          <select value={config.agentSlug ?? ""} onChange={(e) => onChange({ agentSlug: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm">
            <option value="">— elegir agente —</option>
            {catalog.agents.map((a) => (<option key={a.slug} value={a.slug}>🤖 {a.name}</option>))}
          </select>
        </label>
      )}

      {type === "start_workflow" && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Flujo a disparar</span>
          <select value={config.workflowName ?? ""} onChange={(e) => onChange({ workflowName: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm">
            <option value="">— elegir flujo —</option>
            {catalog.workflows.map((w) => (<option key={w.name} value={w.name}>{w.name}</option>))}
          </select>
          <span className="mt-1 block text-[10px] text-ink-subtle">Debe estar publicado y activo. Un flujo no puede dispararse a sí mismo.</span>
        </label>
      )}

      {type === "transfer_human" && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Motivo (interno)</span>
          <input value={config.reason ?? ""} onChange={(e) => onChange({ reason: e.target.value })} placeholder="p. ej. requiere atención humana" className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
        </label>
      )}

      {(type === "close_conversation" || type === "stop") && (
        <p className="text-xs text-ink-subtle">Este paso no necesita configuración.</p>
      )}

      {/* Política de errores — pasos que pueden fallar (integraciones, plantilla, agenda). */}
      {["call_api", "send_template", "send_capi", "send_ga4_event", "google_sheets_append", "send_internal_email"].includes(type) && (
        <div className="mt-2 space-y-2 rounded-lg border border-line bg-app p-3">
          <p className="text-xs font-medium text-ink">En caso de error</p>
          <div className="flex items-center gap-2">
            <select
              value={String(config.onError ?? "stop")}
              onChange={(e) => onChange({ onError: e.target.value })}
              className="flex-1 rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-xs"
            >
              <option value="stop">Detener el flujo (por defecto)</option>
              <option value="continue">Continuar al siguiente paso</option>
              <option value="branch">Ramificar por «si falla»</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-ink-muted">
              Reintentos
              <input type="number" min={0} max={5} value={Number(config.retries ?? 0)} onChange={(e) => onChange({ retries: Math.max(0, Math.min(5, Number(e.target.value))) })} className="w-14 rounded-lg border border-line-strong px-2 py-1 text-xs" />
            </label>
          </div>
          {config.onError === "branch" && <p className="text-[11px] text-ink-subtle">Conecta la salida roja «si falla» a lo que quieras hacer cuando el paso falle.</p>}
        </div>
      )}
    </div>
  );
}

const CAPI_EVENTS = ["Lead", "Schedule", "Purchase", "CompleteRegistration", "Contact", "SubmitApplication", "StartTrial"];

function CapiForm({ config, onChange }: { config: Record<string, any>; onChange: (patch: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-2 text-sm">
      <label className="block">
        <span className="text-xs text-ink-muted">Evento estándar de Meta</span>
        <select value={config.eventName ?? "Lead"} onChange={(e) => onChange({ eventName: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm">
          {CAPI_EVENTS.map((ev) => (<option key={ev} value={ev}>{ev}</option>))}
        </select>
      </label>
      <div className="flex gap-2">
        <label className="flex-1">
          <span className="text-xs text-ink-muted">Valor (opcional)</span>
          <input type="number" min={0} value={config.value ?? ""} onChange={(e) => onChange({ value: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong px-2 py-1.5 text-sm" />
        </label>
        <label className="w-24">
          <span className="text-xs text-ink-muted">Moneda</span>
          <input value={config.currency ?? "CLP"} onChange={(e) => onChange({ currency: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong px-2 py-1.5 text-sm" />
        </label>
      </div>
      <p className="text-[10px] text-ink-subtle">Usa el <span className="font-mono">ctwa_clid</span> del contacto (del disparador Click-to-Chat) + el dataset/token del <b>Centro Meta</b>. Se envía con reintentos automáticos.</p>
    </div>
  );
}

function HttpForm({ config, onChange, presets = [] }: { config: Record<string, any>; onChange: (patch: Record<string, unknown>) => void; presets?: { id: string; name: string; baseUrl: string }[] }) {
  const [headersText, setHeadersText] = useState(JSON.stringify(config.headers ?? {}));
  const [mapText, setMapText] = useState(JSON.stringify(config.responseMapping ?? {}));
  const method = config.method ?? "GET";
  function tryJson(text: string, key: string) {
    try {
      const obj = JSON.parse(text || "{}");
      if (obj && typeof obj === "object") onChange({ [key]: obj });
    } catch {
      /* JSON incompleto mientras escribe — no actualiza hasta que sea válido */
    }
  }
  return (
    <div className="space-y-2 text-sm">
      <p className="rounded bg-brand-50 px-2 py-1 text-[10px] text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
        Paso <b>Premium</b>. Con guard SSRF (bloquea IPs internas). Luego tendrás <span className="font-mono">{"{{__http_ok}} {{__http_status}}"}</span> + lo que mapees.
      </p>
      {presets.length > 0 && (
        <label className="block">
          <span className="text-xs text-ink-muted">Preset de API (Integraciones → API personalizada)</span>
          <select
            value={config.presetId ?? ""}
            onChange={(e) => onChange({ presetId: e.target.value || undefined })}
            className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-sm"
          >
            <option value="">— sin preset (URL completa manual) —</option>
            {presets.map((p) => (<option key={p.id} value={p.id}>{p.name} · {p.baseUrl}</option>))}
          </select>
        </label>
      )}
      <div className="flex gap-2">
        <label className="w-28">
          <span className="text-xs text-ink-muted">Método</span>
          <select value={method} onChange={(e) => onChange({ method: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-sm">
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (<option key={m} value={m}>{m}</option>))}
          </select>
        </label>
        <label className="flex-1">
          <span className="text-xs text-ink-muted">{config.presetId ? "Ruta (relativa al preset)" : "URL"}</span>
          <input
            value={(config.presetId ? config.path : config.url) ?? ""}
            onChange={(e) => onChange(config.presetId ? { path: e.target.value } : { url: e.target.value })}
            placeholder={config.presetId ? "/leads" : "https://api.tuservicio.com/…"}
            className="mt-1 block w-full rounded-lg border border-line-strong px-2 py-1.5 text-sm"
          />
        </label>
      </div>
      {config.presetId && (
        <p className="text-[10px] text-ink-subtle">La auth y el dominio permitido vienen del preset — sin tokens en el nodo.</p>
      )}
      <label className="block">
        <span className="text-xs text-ink-muted">Headers (JSON)</span>
        <textarea value={headersText} onChange={(e) => { setHeadersText(e.target.value); tryJson(e.target.value, "headers"); }} rows={2} placeholder='{"Authorization":"Bearer …"}' className="mt-1 block w-full rounded-lg border border-line-strong px-2 py-1.5 font-mono text-xs" />
      </label>
      {method !== "GET" && (
        <label className="block">
          <span className="text-xs text-ink-muted">Body (admite {"{{variables}}"})</span>
          <VarField multiline value={String(config.body ?? "")} onChange={(v) => onChange({ body: v })} rows={3} placeholder='{"nombre":"{{contact.firstName}}"}' className="mt-1 block w-full rounded-lg border border-line-strong px-2 py-1.5 font-mono text-xs" />
        </label>
      )}
      <label className="block">
        <span className="text-xs text-ink-muted">Mapeo respuesta → variables (JSON)</span>
        <textarea value={mapText} onChange={(e) => { setMapText(e.target.value); tryJson(e.target.value, "responseMapping"); }} rows={2} placeholder='{"saldo":"data.balance"}' className="mt-1 block w-full rounded-lg border border-line-strong px-2 py-1.5 font-mono text-xs" />
      </label>
    </div>
  );
}

const BH_DAYS: [string, string][] = [["mon", "Lun"], ["tue", "Mar"], ["wed", "Mié"], ["thu", "Jue"], ["fri", "Vie"], ["sat", "Sáb"], ["sun", "Dom"]];

function BusinessHoursForm({ config, onChange }: { config: Record<string, any>; onChange: (patch: Record<string, unknown>) => void }) {
  const hours = (config.hours ?? {}) as Record<string, { from: string; to: string }[]>;
  function setDay(day: string, patch: { open?: boolean; from?: string; to?: string }) {
    const cur = hours[day]?.[0] ?? { from: "09:00", to: "18:00" };
    const open = patch.open ?? (hours[day]?.length ?? 0) > 0;
    const next = { from: patch.from ?? cur.from, to: patch.to ?? cur.to };
    onChange({ hours: { ...hours, [day]: open ? [next] : [] } });
  }
  return (
    <div className="space-y-2 text-sm">
      <p className="rounded-lg bg-app p-2 text-[10px] text-ink-muted">
        Si no marcas ningún día aquí, el nodo usa el horario de <a href="/settings/hours" className="underline">Configuración → Horario de atención</a>. Define uno propio solo si esta campaña atiende en un horario distinto.
      </p>
      <label className="block">
        <span className="text-xs text-ink-muted">Zona horaria</span>
        <input value={config.timezone ?? "America/Santiago"} onChange={(e) => onChange({ timezone: e.target.value })} className="mt-1 block w-full rounded-lg border border-line-strong px-2 py-1.5 text-sm" />
      </label>
      <div className="space-y-1">
        {BH_DAYS.map(([key, label]) => {
          const iv = hours[key]?.[0];
          const open = (hours[key]?.length ?? 0) > 0;
          return (
            <div key={key} className="flex items-center gap-2">
              <label className="flex w-16 items-center gap-1 text-xs">
                <input type="checkbox" checked={open} onChange={(e) => setDay(key, { open: e.target.checked })} />
                {label}
              </label>
              {open ? (
                <>
                  <input type="time" value={iv?.from ?? "09:00"} onChange={(e) => setDay(key, { from: e.target.value })} className="rounded border border-line-strong px-1 py-0.5 text-xs" />
                  <span className="text-xs text-ink-subtle">a</span>
                  <input type="time" value={iv?.to ?? "18:00"} onChange={(e) => setDay(key, { to: e.target.value })} className="rounded border border-line-strong px-1 py-0.5 text-xs" />
                </>
              ) : (
                <span className="text-xs text-ink-subtle">cerrado</span>
              )}
            </div>
          );
        })}
      </div>
      <label className="block">
        <span className="text-xs text-ink-muted">Feriados (YYYY-MM-DD)</span>
        <textarea
          value={(config.holidays ?? []).join("\n")}
          onChange={(e) => onChange({ holidays: e.target.value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean) })}
          rows={2}
          placeholder="2026-09-18"
          className="mt-1 block w-full rounded-lg border border-line-strong px-2 py-1.5 text-xs"
        />
      </label>
      <p className="text-[10px] text-ink-subtle">Sale por «Dentro de horario» o «Fuera de horario» según la hora actual del tenant.</p>
    </div>
  );
}

function WaitForm({ config, onChange }: { config: Record<string, any>; onChange: (patch: Record<string, unknown>) => void }) {
  const unit: "minutes" | "hours" | "days" = config.days ? "days" : config.hours ? "hours" : "minutes";
  const value = config.days ?? config.hours ?? config.minutes ?? 5;
  function setWait(v: number, u: "minutes" | "hours" | "days") {
    onChange({ minutes: undefined, hours: undefined, days: undefined, [u]: v });
  }
  return (
    <div className="space-y-2 text-sm">
      <span className="text-xs text-ink-muted">Esperar</span>
      <div className="flex items-center gap-2">
        <input type="number" min={1} value={value} onChange={(e) => setWait(Number(e.target.value), unit)} className="w-20 rounded-lg border border-line-strong px-2 py-1.5" />
        <select value={unit} onChange={(e) => setWait(Number(value), e.target.value as any)} className="rounded-lg border border-line-strong bg-panel px-2 py-1.5">
          <option value="minutes">minutos</option>
          <option value="hours">horas</option>
          <option value="days">días</option>
        </select>
      </div>
      <label className="flex items-center gap-1.5 text-xs text-ink-muted">
        <input type="checkbox" checked={config.cancelOn === "contact_reply"} onChange={(e) => onChange({ cancelOn: e.target.checked ? "contact_reply" : undefined })} />
        Cancelar la espera si el contacto responde
      </label>
    </div>
  );
}

/** "¿El contacto respondió?": ventana de espera → rama Sí (respondió) / No (venció). */
function WaitReplyForm({ config, onChange }: { config: Record<string, any>; onChange: (patch: Record<string, unknown>) => void }) {
  const unit: "minutes" | "hours" | "days" = config.days ? "days" : config.hours ? "hours" : config.minutes ? "minutes" : "hours";
  const value = config.days ?? config.hours ?? config.minutes ?? 24;
  const setWait = (v: number, u: "minutes" | "hours" | "days") => onChange({ minutes: undefined, hours: undefined, days: undefined, [u]: v });
  return (
    <div className="space-y-2 text-sm">
      <span className="text-xs text-ink-muted">Esperar la respuesta hasta</span>
      <div className="flex items-center gap-2">
        <input type="number" min={1} value={value} onChange={(e) => setWait(Number(e.target.value), unit)} className="w-20 rounded-lg border border-line-strong px-2 py-1.5" />
        <select value={unit} onChange={(e) => setWait(Number(value), e.target.value as any)} className="rounded-lg border border-line-strong bg-panel px-2 py-1.5">
          <option value="minutes">minutos</option>
          <option value="hours">horas</option>
          <option value="days">días</option>
        </select>
      </div>
      <p className="rounded-lg bg-app p-3 text-xs text-ink-muted">
        Si el contacto responde dentro de ese tiempo, sigue por <b>Sí, respondió</b>. Si vence sin respuesta, sigue por <b>No respondió</b>.
        <b> Ambas ramas continúan el flujo.</b>
      </p>
    </div>
  );
}
