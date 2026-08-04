"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft, Bot, CalendarClock, Clock, CornerUpRight, Crosshair, FileText, GitBranch, Megaphone, MessageSquare, MessageSquarePlus,
  Pencil, Plus, Redo2, Search, Share2, Sheet, Square, StickyNote, Tag, Tags, Target, Trash2, Undo2, Users, UserRound, Webhook, XCircle, Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button, Modal, cn, useToast } from "@/components/ui";
import { TRIGGER_NODE_ID, defToFlow, edgeStyle, flowToDef, type DefTrigger } from "@/lib/workflow-serialize";

// ---------------------------------------------------------------------------
// Catálogo de nodos SOPORTADOS por el motor v0 (mismos que expone
// /workflows/meta/catalog). El canvas serializa exactamente el WorkflowDefinition
// que entiende el motor: { trigger, variables, nodes:[{id,type,config,position}], edges:[{from,to,when}] }.
// ---------------------------------------------------------------------------

// Categorías del menú "Añadir pasos" (orden de aparición).
const CATEGORIES = ["Mensajes", "Contacto", "Conversación", "Control de flujo", "Marketing", "Integraciones", "IA", "Agenda"] as const;
type Category = (typeof CATEGORIES)[number];

interface NodeDef {
  type: string;
  label: string;
  description: string;
  category: Category;
  icon: React.ReactNode;
  defaultConfig: Record<string, unknown>;
  branches?: { handle: string; label: string }[];
  terminal?: boolean;
  soon?: boolean; // "Próximamente" — deshabilitado, no lo ejecuta el motor
  premium?: boolean; // requiere plan superior (se valida al publicar)
}

const NODE_DEFS: NodeDef[] = [
  // Mensajes
  { type: "send_text", label: "Enviar mensaje", description: "Envía un texto (admite variables {{...}})", category: "Mensajes", icon: <MessageSquare size={15} />, defaultConfig: { text: "" } },
  // Contacto
  { type: "update_lead_status", label: "Cambiar etapa del lead", description: "Mueve el lead a otra etapa del ciclo de vida", category: "Contacto", icon: <Tag size={15} />, defaultConfig: { statusCode: "" } },
  { type: "add_tag", label: "Agregar etiqueta", description: "Etiqueta la conversación/contacto", category: "Contacto", icon: <Tag size={15} />, defaultConfig: { tag: "" } },
  { type: "remove_tag", label: "Quitar etiqueta", description: "Quita una etiqueta", category: "Contacto", icon: <Tags size={15} />, defaultConfig: { tag: "" } },
  { type: "update_contact", label: "Actualizar datos del contacto", description: "Guarda nombre, apellido o email", category: "Contacto", icon: <Pencil size={15} />, defaultConfig: { fields: {} } },
  // Conversación
  { type: "open_conversation", label: "Abrir conversación", description: "Abre una conversación para el contacto si no hay una activa", category: "Conversación", icon: <MessageSquarePlus size={15} />, defaultConfig: {} },
  { type: "add_note", label: "Añadir comentario", description: "Comentario interno, solo lo ve el equipo", category: "Conversación", icon: <StickyNote size={15} />, defaultConfig: { text: "" } },
  { type: "assign_user", label: "Asignar a usuario", description: "Asigna a una persona (pausa la IA)", category: "Conversación", icon: <UserRound size={15} />, defaultConfig: { userId: "" } },
  { type: "assign_team", label: "Asignar a equipo", description: "Asigna a un equipo (pausa la IA)", category: "Conversación", icon: <Users size={15} />, defaultConfig: { teamId: "" } },
  { type: "transfer_human", label: "Escalar a humano", description: "Pausa la IA y notifica al equipo", category: "Conversación", icon: <UserRound size={15} />, defaultConfig: { reason: "" } },
  { type: "close_conversation", label: "Cerrar conversación", description: "Marca la conversación como cerrada", category: "Conversación", icon: <XCircle size={15} />, defaultConfig: {} },
  // Control de flujo
  { type: "wait", label: "Esperar", description: "Pausa el flujo; opcional cancelar si el contacto responde", category: "Control de flujo", icon: <Clock size={15} />, defaultConfig: { minutes: 5, cancelOn: "contact_reply" } },
  {
    type: "condition", label: "¿Sigue sin responder?", description: "Ramifica según si el contacto ya respondió", category: "Control de flujo", icon: <GitBranch size={15} />, defaultConfig: { kind: "no_reply" },
    branches: [{ handle: "true", label: "Sin respuesta" }, { handle: "false", label: "Respondió" }],
  },
  {
    type: "business_hours", label: "Fecha y hora", description: "Ramifica según el horario de atención del negocio", category: "Control de flujo", icon: <CalendarClock size={15} />,
    defaultConfig: { timezone: "America/Santiago", hours: { mon: [{ from: "09:00", to: "18:00" }], tue: [{ from: "09:00", to: "18:00" }], wed: [{ from: "09:00", to: "18:00" }], thu: [{ from: "09:00", to: "18:00" }], fri: [{ from: "09:00", to: "18:00" }], sat: [], sun: [] }, holidays: [] },
    branches: [{ handle: "in", label: "Dentro de horario" }, { handle: "out", label: "Fuera de horario" }],
  },
  { type: "goto", label: "Saltar a otro paso", description: "Continúa en cualquier otro paso del flujo", category: "Control de flujo", icon: <CornerUpRight size={15} />, defaultConfig: { targetNodeId: "" } },
  { type: "start_workflow", label: "Disparar otro flujo", description: "Inicia otro workflow por su nombre", category: "Control de flujo", icon: <Share2 size={15} />, defaultConfig: { workflowName: "" } },
  { type: "stop", label: "Terminar flujo", description: "Finaliza la ejecución", category: "Control de flujo", icon: <Square size={15} />, defaultConfig: {}, terminal: true },
  // Marketing
  { type: "send_capi", label: "Enviar evento CAPI (Meta)", description: "Envía un evento de conversión a Meta (Lead, Schedule, Purchase…)", category: "Marketing", icon: <Target size={15} />, defaultConfig: { eventName: "Lead", value: "", currency: "CLP" } },
  { type: "send_ga4_event", label: "Enviar evento GA4", description: "Envía un evento a Google Analytics con parámetros y variables", category: "Marketing", icon: <Target size={15} />, defaultConfig: { eventName: "", params: {} } },
  { type: "send_tiktok_event", label: "Enviar evento TikTok", description: "Evento a TikTok Events API", category: "Marketing", icon: <Megaphone size={15} />, defaultConfig: {}, soon: true },
  // IA
  { type: "run_agent", label: "Ejecutar agente IA", description: "El agente elegido responde la conversación", category: "IA", icon: <Bot size={15} />, defaultConfig: { agentSlug: "" } },
  { type: "switch_agent", label: "Cambiar agente IA", description: "Otro agente IA toma el control", category: "IA", icon: <Bot size={15} />, defaultConfig: { agentSlug: "" } },
  {
    type: "ai_objective", label: "Agente IA con objetivo", description: "Entrega la conversación a un agente con un objetivo y ramifica según el resultado",
    category: "IA", icon: <Crosshair size={15} />, defaultConfig: { agentSlug: "", objective: "", maxTurns: 1, timeoutHours: 24 },
    branches: [{ handle: "met", label: "Objetivo cumplido" }, { handle: "unmet", label: "No cumplido / escalado" }],
  },
  // Integraciones
  { type: "call_api", label: "Petición HTTP", description: "Llama a un endpoint externo y mapea la respuesta a variables", category: "Integraciones", icon: <Webhook size={15} />, premium: true, defaultConfig: { method: "GET", url: "", headers: {}, body: "", responseMapping: {} } },
  { type: "send_internal_email", label: "Enviar correo interno", description: "Aviso por correo al equipo (nunca a contactos), con variables", category: "Integraciones", icon: <FileText size={15} />, defaultConfig: { to: [], subject: "", body: "" } },
  { type: "google_sheets_append", label: "Añadir fila a Google Sheets", description: "Agrega una fila a una hoja de cálculo (requiere conectar Google en Integraciones)", category: "Integraciones", icon: <Sheet size={15} />, defaultConfig: { spreadsheetId: "", sheetName: "", values: [] } },
  // Agenda
  { type: "send_template", label: "Enviar plantilla WhatsApp", description: "Mensaje con plantilla HSM aprobada (funciona fuera de la ventana de 24h)", category: "Agenda", icon: <FileText size={15} />, defaultConfig: {} },
];
const NODE_DEF = (type: string) => NODE_DEFS.find((n) => n.type === type);

interface Catalog {
  triggers: { type: string; label: string; description: string; config?: string[]; conditions?: string[]; soon?: boolean }[];
  nodes: { type: string; label: string; description: string }[];
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
}

// ---- Contexto para que los nodos custom accedan a acciones/estado ----
interface EditorApi {
  selectedId: string | null;
  select: (id: string | null) => void;
  addFrom: (parentId: string, branch?: string) => void;
  catalog: Catalog | null;
  triggerType: string;
}
const EditorContext = createContext<EditorApi>({
  selectedId: null, select: () => {}, addFrom: () => {}, catalog: null, triggerType: "",
});

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
  const { select, addFrom, selectedId } = useContext(EditorContext);
  const d = data as { nodeType: string; config: Record<string, any>; invalid?: string };
  const def = NODE_DEF(d.nodeType);
  const selected = selectedId === id;
  const summary = nodeSummary(d.nodeType, d.config);
  return (
    <div className="relative">
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-line-strong !bg-panel" />
      <div
        onClick={() => select(id)}
        title={d.invalid ?? undefined}
        className={cn(
          "w-56 cursor-pointer rounded-xl border bg-panel px-3 py-2.5 shadow-card transition-colors",
          d.invalid ? "border-red-400 ring-1 ring-red-200" : selected ? "border-brand-500" : "border-line hover:border-line-strong",
        )}
      >
        <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
          <span className="text-ink-subtle">{def?.icon}</span>
          {def?.label ?? d.nodeType}
        </p>
        {summary && <p className="mt-0.5 line-clamp-2 text-xs text-ink-muted">{summary}</p>}
      </div>

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
      ) : def?.terminal ? null : (
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

interface SimStep { nodeId: string; nodeType: string; label: string; detail: string }

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

interface Detail {
  id: string; name: string; description: string | null; active: boolean;
  publishedVersion: number | null; draftVersion: number | null; definition: any; updatedAt?: string;
}

function Editor() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<DefTrigger>({ type: "conversation_started", config: {} });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [addFromState, setAddFromState] = useState<{ parentId: string; branch?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testContact, setTestContact] = useState("");
  const [assumeNoReply, setAssumeNoReply] = useState(true);
  const [testTrace, setTestTrace] = useState<SimStep[] | null>(null);
  const [testBusy, setTestBusy] = useState(false);

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
        position: { x: px + (addFromState.branch === "false" ? 210 : 0), y: py + 140 },
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
      const r = await api<{ publishedVersion: number }>(`/workflows/${id}/publish`, { method: "POST" });
      toast.push(`Versión ${r.publishedVersion} publicada y activa`, "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setTestBusy(true);
    setTestTrace(null);
    try {
      const r = await api<{ trace: SimStep[] }>(`/workflows/${id}/test`, {
        method: "POST",
        body: JSON.stringify({
          definition: flowToDef(nodes, edges, trigger),
          contact: { firstName: testContact || null },
          assumeNoReply,
        }),
      });
      setTestTrace(r.trace);
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setTestBusy(false);
    }
  }

  const editorApi = useMemo<EditorApi>(
    () => ({ selectedId, select: setSelectedId, addFrom, catalog, triggerType: trigger.type }),
    [selectedId, addFrom, catalog, trigger.type],
  );

  const selectedNode = nodes.find((n) => n.id === selectedId && n.id !== TRIGGER_NODE_ID);

  // Aristas visuales de los "Saltar a otro paso" (punteadas, no se serializan).
  const flowEdges = useMemo<Edge[]>(() => {
    const gotoEdges: Edge[] = nodes
      .filter((n) => (n.data as any).nodeType === "goto" && (n.data as any).config?.targetNodeId)
      .map((n) => ({
        id: `goto:${n.id}`,
        source: n.id,
        target: (n.data as any).config.targetNodeId,
        animated: true,
        selectable: false,
        deletable: false,
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
            <Button variant="secondary" onClick={() => { setTestTrace(null); setTestOpen(true); }} disabled={busy}>Probar</Button>
            <Button variant="secondary" onClick={() => void saveDraft()} disabled={busy}>Guardar</Button>
            <Button onClick={() => void publish()} disabled={busy}>Publicar</Button>
          </div>
        </header>

        {/* Canvas + panel */}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 bg-app">
            <ReactFlow
              nodes={nodes}
              edges={flowEdges}
              onNodesChange={onNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={onConnect}
              onNodeDragStart={snapshot}
              onPaneClick={() => setSelectedId(null)}
              nodeTypes={nodeTypes}
              fitView
              proOptions={{ hideAttribution: true }}
              defaultEdgeOptions={{ style: { stroke: "#94a3b8" } }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#cbd5e1" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>

          <aside className="w-96 shrink-0 overflow-y-auto border-l border-line bg-panel">
            {selectedId === TRIGGER_NODE_ID ? (
              <TriggerPanel catalog={catalog} trigger={trigger} onChange={setTrigger} />
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

      {/* Modo prueba */}
      <Modal open={testOpen} onClose={() => setTestOpen(false)} title="Probar flujo" wide>
        <p className="mb-3 text-sm text-ink-muted">
          Recorre el flujo con un contacto ficticio y muestra qué haría cada paso. No envía nada ni cambia datos reales.
        </p>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="text-xs text-ink-muted">Nombre del contacto de prueba</span>
            <input value={testContact} onChange={(e) => setTestContact(e.target.value)} placeholder="Prueba" className="mt-1 block w-48 rounded-lg border border-line-strong px-3 py-2 text-sm" />
          </label>
          <label className="flex items-center gap-1.5 pb-2 text-xs text-ink-muted">
            <input type="checkbox" checked={assumeNoReply} onChange={(e) => setAssumeNoReply(e.target.checked)} />
            En las condiciones, asumir que el contacto no respondió
          </label>
          <Button onClick={() => void runTest()} disabled={testBusy}>{testBusy ? "Ejecutando…" : "Ejecutar prueba"}</Button>
        </div>

        {testTrace && (
          testTrace.length === 0 ? (
            <p className="text-sm text-ink-subtle">El flujo no tiene pasos para recorrer.</p>
          ) : (
            <ol className="space-y-2">
              {testTrace.map((s, i) => (
                <li key={i} className="flex gap-3 rounded-lg border border-line p-3">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">{i + 1}</span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">{s.label}</p>
                    <p className="whitespace-pre-wrap text-xs text-ink-muted">{s.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          )
        )}
      </Modal>

      {/* Menú para agregar paso (categorizado + buscador) */}
      <AddStepModal open={!!addFromState} onClose={() => setAddFromState(null)} onPick={createNode} />
    </EditorContext.Provider>
  );
}

export default function WorkflowEditorPage() {
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
const FLOW_VARIABLES: { key: string; label: string }[] = [
  { key: "contact.firstName", label: "Nombre del contacto" },
  { key: "contact.lastName", label: "Apellido del contacto" },
  { key: "contact.phone", label: "Teléfono del contacto" },
  { key: "organization.name", label: "Nombre del negocio" },
  { key: "clinic.name", label: "Nombre de la clínica" },
  { key: "clinic.address", label: "Dirección de la clínica" },
  { key: "appointment.date", label: "Fecha de la cita" },
  { key: "appointment.time", label: "Hora de la cita" },
  { key: "appointment.service", label: "Servicio de la cita" },
  { key: "appointment.professional", label: "Profesional" },
];

/**
 * Campo de texto (input o textarea) con autocompletado de variables: al escribir
 * "{{" o "{{par" ofrece las variables del flujo; ↑/↓ navegan, Enter/Tab/clic
 * insertan `{{clave}}`. Funciona en claro y oscuro (tokens del sistema).
 */
function VarField({
  value, onChange, multiline, className, rows, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
  className?: string;
  rows?: number;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [menu, setMenu] = useState<{ open: boolean; query: string; start: number; index: number }>({ open: false, query: "", start: 0, index: 0 });
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

function TriggerPanel({ catalog, trigger, onChange }: { catalog: Catalog; trigger: DefTrigger; onChange: (t: DefTrigger) => void }) {
  const desc = catalog.triggers.find((t) => t.type === trigger.type)?.description;
  return (
    <div className="space-y-3 p-5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">
        <Zap size={13} /> Disparador
      </div>
      <label className="block text-sm">
        <span className="text-xs text-ink-muted">¿Cuándo se ejecuta el flujo?</span>
        <select
          value={trigger.type}
          onChange={(e) => onChange({ type: e.target.value, config: {} })}
          className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm"
        >
          {catalog.triggers.map((t) => (<option key={t.type} value={t.type}>{t.label}</option>))}
        </select>
      </label>
      {desc && <p className="text-xs text-ink-subtle">{desc}</p>}

      {trigger.type === "keyword" && (
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Palabra o frase</span>
          <input
            value={String(trigger.config.keyword ?? "")}
            onChange={(e) => onChange({ ...trigger, config: { ...trigger.config, keyword: e.target.value } })}
            placeholder="p. ej. hora, precio, agendar"
            className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
          />
        </label>
      )}

      {trigger.type === "message_received" && (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <p className="text-xs font-medium text-ink-muted">Condiciones (opcionales)</p>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Contiene la palabra/frase</span>
            <input
              value={String(trigger.config.keyword ?? "")}
              onChange={(e) => onChange({ ...trigger, config: { ...trigger.config, keyword: e.target.value } })}
              placeholder="dejar vacío = cualquier mensaje"
              className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={trigger.config.firstMessage === true}
              onChange={(e) => onChange({ ...trigger, config: { ...trigger.config, firstMessage: e.target.checked } })}
            />
            Solo el primer mensaje de la conversación
          </label>
        </div>
      )}

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
      )}

      {APPT_FILTERABLE.has(trigger.type) && <ApptFilters catalog={catalog} trigger={trigger} onChange={onChange} />}
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
            value={String(config.text ?? "")}
            onChange={(v) => onChange({ text: v })}
            rows={4}
            placeholder="Hola {{contact.firstName}} 👋"
            className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-[10px] text-ink-subtle">Escribe <code>{"{{"}</code> para insertar variables.</span>
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
          <VarField multiline value={String(config.text ?? "")} onChange={(v) => onChange({ text: v })} rows={3} placeholder="p. ej. Lead de campaña {{contact.firstName}}" className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
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
            <VarField multiline value={String(config.objective ?? "")} onChange={(v) => onChange({ objective: v })} rows={2} placeholder="p. ej. Confirmar asistencia a la cita" className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
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
