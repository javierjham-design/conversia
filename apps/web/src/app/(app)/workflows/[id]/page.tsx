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
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowLeft, Bot, Clock, GitBranch, MessageSquare, Pencil, Plus, Redo2, Share2, Square,
  Tag, Tags, Trash2, Undo2, Users, UserRound, XCircle, Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import { Button, Modal, cn, useToast } from "@/components/ui";

// ---------------------------------------------------------------------------
// Catálogo de nodos SOPORTADOS por el motor v0 (mismos que expone
// /workflows/meta/catalog). El canvas serializa exactamente el WorkflowDefinition
// que entiende el motor: { trigger, variables, nodes:[{id,type,config,position}], edges:[{from,to,when}] }.
// ---------------------------------------------------------------------------

interface NodeDef {
  type: string;
  label: string;
  icon: React.ReactNode;
  defaultConfig: Record<string, unknown>;
  branches?: { handle: string; label: string }[];
  terminal?: boolean;
}

const NODE_DEFS: NodeDef[] = [
  { type: "send_text", label: "Enviar mensaje", icon: <MessageSquare size={15} />, defaultConfig: { text: "" } },
  { type: "run_agent", label: "Ejecutar agente IA", icon: <Bot size={15} />, defaultConfig: { agentSlug: "" } },
  { type: "wait", label: "Esperar", icon: <Clock size={15} />, defaultConfig: { minutes: 5, cancelOn: "contact_reply" } },
  {
    type: "condition", label: "¿Sigue sin responder?", icon: <GitBranch size={15} />, defaultConfig: { kind: "no_reply" },
    branches: [{ handle: "true", label: "Sin respuesta" }, { handle: "false", label: "Respondió" }],
  },
  { type: "update_lead_status", label: "Cambiar estado del lead", icon: <Tag size={15} />, defaultConfig: { statusCode: "" } },
  { type: "add_tag", label: "Agregar etiqueta", icon: <Tag size={15} />, defaultConfig: { tag: "" } },
  { type: "remove_tag", label: "Quitar etiqueta", icon: <Tags size={15} />, defaultConfig: { tag: "" } },
  { type: "update_contact", label: "Actualizar datos del contacto", icon: <Pencil size={15} />, defaultConfig: { fields: {} } },
  { type: "assign_user", label: "Asignar a usuario", icon: <UserRound size={15} />, defaultConfig: { userId: "" } },
  { type: "assign_team", label: "Asignar a equipo", icon: <Users size={15} />, defaultConfig: { teamId: "" } },
  { type: "switch_agent", label: "Cambiar agente IA", icon: <Bot size={15} />, defaultConfig: { agentSlug: "" } },
  { type: "transfer_human", label: "Escalar a humano", icon: <UserRound size={15} />, defaultConfig: { reason: "" } },
  { type: "close_conversation", label: "Cerrar conversación", icon: <XCircle size={15} />, defaultConfig: {} },
  { type: "start_workflow", label: "Disparar otro flujo", icon: <Share2 size={15} />, defaultConfig: { workflowName: "" } },
  { type: "stop", label: "Terminar flujo", icon: <Square size={15} />, defaultConfig: {}, terminal: true },
];
const NODE_DEF = (type: string) => NODE_DEFS.find((n) => n.type === type);

const TRIGGER_NODE_ID = "__trigger__";

interface Catalog {
  triggers: { type: string; label: string; description: string; config?: string[] }[];
  nodes: { type: string; label: string; description: string }[];
  leadStatuses: { code: string; name: string }[];
  agents: { slug: string; name: string }[];
  users: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  workflows: { name: string }[];
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
          "w-56 cursor-pointer rounded-xl border-2 bg-white px-3 py-2.5 shadow-card",
          selected ? "border-brand-500" : "border-brand-200",
        )}
      >
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-600">
          <Zap size={13} /> Disparador
        </p>
        <p className="mt-0.5 text-sm font-medium text-navy-900">{label}</p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-brand-400 !bg-white" />
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
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-slate-400 !bg-white" />
      <div
        onClick={() => select(id)}
        title={d.invalid ?? undefined}
        className={cn(
          "w-56 cursor-pointer rounded-xl border bg-white px-3 py-2.5 shadow-card transition-colors",
          d.invalid ? "border-red-400 ring-1 ring-red-200" : selected ? "border-brand-500" : "border-slate-200 hover:border-slate-300",
        )}
      >
        <p className="flex items-center gap-1.5 text-sm font-medium text-navy-900">
          <span className="text-slate-400">{def?.icon}</span>
          {def?.label ?? d.nodeType}
        </p>
        {summary && <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{summary}</p>}
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
                className="!h-2 !w-2 !border-slate-400 !bg-white"
              />
              <span className="mt-1 text-[9px] font-medium text-slate-400">{b.label}</span>
              <AddButton small onClick={() => addFrom(id, b.handle)} />
            </div>
          ))}
        </div>
      ) : def?.terminal ? null : (
        <>
          <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-slate-400 !bg-white" />
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
        "absolute left-1/2 -translate-x-1/2 rounded-full border border-slate-300 bg-white text-slate-400 shadow-sm hover:border-brand-400 hover:text-brand-600",
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
    default: return "";
  }
}

// ---------------------------------------------------------------------------
// Serialización canvas <-> WorkflowDefinition
// ---------------------------------------------------------------------------

interface DefTrigger { type: string; config: Record<string, unknown> }

function defToFlow(def: any): { nodes: Node[]; edges: Edge[]; trigger: DefTrigger } {
  const trigger: DefTrigger = { type: def?.trigger?.type ?? "conversation_started", config: def?.trigger?.config ?? {} };
  const defNodes: any[] = Array.isArray(def?.nodes) ? def.nodes : [];
  const defEdges: any[] = Array.isArray(def?.edges) ? def.edges : [];
  const withIncoming = new Set(defEdges.map((e) => e.to));
  const startId = defNodes.find((n) => !withIncoming.has(n.id))?.id ?? defNodes[0]?.id;

  const nodes: Node[] = defNodes.map((n, i) => ({
    id: n.id,
    type: "stepNode",
    position: n.position ?? { x: 250, y: 140 + i * 130 },
    data: { nodeType: n.type, config: n.config ?? {} },
  }));

  const startPos = nodes.find((n) => n.id === startId)?.position ?? { x: 250, y: 140 };
  nodes.unshift({
    id: TRIGGER_NODE_ID,
    type: "triggerNode",
    position: { x: startPos.x, y: Math.max(startPos.y - 120, 0) },
    data: {},
    draggable: false,
  });

  const edges: Edge[] = defEdges.map((e) => ({
    id: `${e.from}->${e.to}:${e.when ?? ""}`,
    source: e.from,
    target: e.to,
    sourceHandle: e.when ?? undefined,
    ...edgeStyle(e.when),
  }));
  if (startId) {
    edges.unshift({ id: `trigger->${startId}`, source: TRIGGER_NODE_ID, target: startId, ...edgeStyle() });
  }
  return { nodes, edges, trigger };
}

function edgeStyle(when?: string) {
  const label = when === "true" ? "sin respuesta" : when === "false" ? "respondió" : undefined;
  return { label, animated: false, style: { stroke: "#94a3b8" }, labelStyle: { fontSize: 10, fill: "#64748b" } };
}

function flowToDef(nodes: Node[], edges: Edge[], trigger: DefTrigger): any {
  const stepNodes = nodes.filter((n) => n.id !== TRIGGER_NODE_ID);
  return {
    trigger: { type: trigger.type, config: trigger.type === "keyword" ? { keyword: trigger.config.keyword ?? "" } : {} },
    variables: {},
    nodes: stepNodes.map((n) => ({
      id: n.id,
      type: (n.data as any).nodeType,
      config: (n.data as any).config ?? {},
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    })),
    edges: edges
      .filter((e) => e.source !== TRIGGER_NODE_ID)
      .map((e) => ({ from: e.source, to: e.target, ...(e.sourceHandle ? { when: e.sourceHandle } : {}) })),
  };
}

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
    }
    setNodes((ns) => ns.map((n) => (n.id in errors ? { ...n, data: { ...n.data, invalid: errors[n.id] } } : { ...n, data: { ...n.data, invalid: undefined } })));
    if (Object.keys(errors).length) {
      toast.push("Corrige los nodos marcados en rojo", "error");
      return false;
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

  const editorApi = useMemo<EditorApi>(
    () => ({ selectedId, select: setSelectedId, addFrom, catalog, triggerType: trigger.type }),
    [selectedId, addFrom, catalog, trigger.type],
  );

  const selectedNode = nodes.find((n) => n.id === selectedId && n.id !== TRIGGER_NODE_ID);

  if (!detail || !catalog) return <div className="p-6 text-slate-400">Cargando…</div>;

  return (
    <EditorContext.Provider value={editorApi}>
      <div className="flex h-full flex-col">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <button onClick={() => router.push("/workflows")} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" title="Volver">
              <ArrowLeft size={18} />
            </button>
            <div className="min-w-0">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full max-w-xs truncate rounded border border-transparent px-1 text-base font-semibold text-navy-900 hover:border-slate-200 focus:border-slate-300 focus:outline-none"
              />
              <p className="px-1 text-[11px] text-slate-400">
                {detail.publishedVersion ? `v${detail.publishedVersion} publicada` : "sin publicar"}
                {detail.draftVersion ? ` · borrador v${detail.draftVersion}` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={undo} disabled={!history.current.past.length} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30" title="Deshacer"><Undo2 size={16} /></button>
            <button onClick={redo} disabled={!history.current.future.length} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-30" title="Rehacer"><Redo2 size={16} /></button>
            <span className="mx-1 h-5 w-px bg-slate-200" />
            <Button variant="secondary" disabled title="Disponible en la próxima entrega">Probar</Button>
            <Button variant="secondary" onClick={() => void saveDraft()} disabled={busy}>Guardar</Button>
            <Button onClick={() => void publish()} disabled={busy}>Publicar</Button>
          </div>
        </header>

        {/* Canvas + panel */}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 bg-slate-50">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
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

          <aside className="w-96 shrink-0 overflow-y-auto border-l border-slate-200 bg-white">
            {selectedId === TRIGGER_NODE_ID ? (
              <TriggerPanel catalog={catalog} trigger={trigger} onChange={setTrigger} />
            ) : selectedNode ? (
              <NodePanel
                node={selectedNode}
                catalog={catalog}
                onChange={updateSelectedConfig}
                onDelete={() => deleteNode(selectedNode.id)}
              />
            ) : (
              <div className="p-5 text-sm text-slate-400">
                Selecciona el disparador o un paso para configurarlo. Usa el botón + bajo cada nodo para agregar pasos.
              </div>
            )}
          </aside>
        </div>
      </div>

      {/* Menú para agregar paso */}
      <Modal open={!!addFromState} onClose={() => setAddFromState(null)} title="Agregar paso">
        <div className="grid gap-2 sm:grid-cols-2">
          {NODE_DEFS.map((n) => (
            <button
              key={n.type}
              onClick={() => createNode(n.type)}
              className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-brand-300 hover:bg-brand-50"
            >
              <span className="text-slate-400">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </div>
      </Modal>
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

function TriggerPanel({ catalog, trigger, onChange }: { catalog: Catalog; trigger: DefTrigger; onChange: (t: DefTrigger) => void }) {
  const desc = catalog.triggers.find((t) => t.type === trigger.type)?.description;
  return (
    <div className="space-y-3 p-5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-600">
        <Zap size={13} /> Disparador
      </div>
      <label className="block text-sm">
        <span className="text-xs text-slate-500">¿Cuándo se ejecuta el flujo?</span>
        <select
          value={trigger.type}
          onChange={(e) => onChange({ type: e.target.value, config: {} })}
          className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          {catalog.triggers.map((t) => (<option key={t.type} value={t.type}>{t.label}</option>))}
        </select>
      </label>
      {desc && <p className="text-xs text-slate-400">{desc}</p>}
      {trigger.type === "keyword" && (
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Palabra o frase</span>
          <input
            value={String(trigger.config.keyword ?? "")}
            onChange={(e) => onChange({ ...trigger, config: { ...trigger.config, keyword: e.target.value } })}
            placeholder="p. ej. hora, precio, agendar"
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
      )}
    </div>
  );
}

function NodePanel({
  node, catalog, onChange, onDelete,
}: {
  node: Node;
  catalog: Catalog;
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}) {
  const type = (node.data as any).nodeType as string;
  const config = (node.data as any).config as Record<string, any>;
  const def = NODE_DEF(type);
  return (
    <div className="space-y-3 p-5">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-navy-900">
          <span className="text-slate-400">{def?.icon}</span>{def?.label ?? type}
        </p>
        <button onClick={onDelete} className="rounded-lg p-1.5 text-red-500 hover:bg-red-50" title="Eliminar paso"><Trash2 size={15} /></button>
      </div>

      {type === "send_text" && (
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Mensaje</span>
          <textarea
            value={config.text ?? ""}
            onChange={(e) => onChange({ text: e.target.value })}
            rows={4}
            placeholder="Hola {{contact.firstName}} 👋"
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-[10px] text-slate-400">Variables: {"{{contact.firstName}} {{organization.name}} {{clinic.name}} {{clinic.address}}"}</span>
        </label>
      )}

      {type === "run_agent" && (
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Agente</span>
          <select value={config.agentSlug ?? ""} onChange={(e) => onChange({ agentSlug: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">Agente activo de la conversación</option>
            {catalog.agents.map((a) => (<option key={a.slug} value={a.slug}>🤖 {a.name}</option>))}
          </select>
        </label>
      )}

      {type === "wait" && <WaitForm config={config} onChange={onChange} />}

      {type === "condition" && (
        <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
          Si el contacto <b>no ha respondido</b> desde que inició el flujo, sigue por <b>Sin respuesta</b>. Si respondió, sigue por <b>Respondió</b>.
        </p>
      )}

      {type === "update_lead_status" && (
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Nuevo estado del lead</span>
          <select value={config.statusCode ?? ""} onChange={(e) => onChange({ statusCode: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">— elegir —</option>
            {catalog.leadStatuses.map((s) => (<option key={s.code} value={s.code}>{s.name}</option>))}
          </select>
        </label>
      )}

      {(type === "add_tag" || type === "remove_tag") && (
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Etiqueta</span>
          <input value={config.tag ?? ""} onChange={(e) => onChange({ tag: e.target.value })} placeholder="p. ej. interesado" className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
      )}

      {type === "update_contact" && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">Guarda estos datos del contacto (deja vacío lo que no cambie):</p>
          {(["firstName", "lastName", "email"] as const).map((k) => (
            <label key={k} className="block text-sm">
              <span className="text-xs text-slate-500">{k === "firstName" ? "Nombre" : k === "lastName" ? "Apellido" : "Email"}</span>
              <input
                value={(config.fields ?? {})[k] ?? ""}
                onChange={(e) => onChange({ fields: { ...(config.fields ?? {}), [k]: e.target.value } })}
                placeholder="admite {{variables}}"
                className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
          ))}
        </div>
      )}

      {type === "assign_user" && (
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Usuario</span>
          <select value={config.userId ?? ""} onChange={(e) => onChange({ userId: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">— elegir persona —</option>
            {catalog.users.map((u) => (<option key={u.id} value={u.id}>{u.name}</option>))}
          </select>
          <span className="mt-1 block text-[10px] text-slate-400">Al asignar, la IA se pausa en esa conversación.</span>
        </label>
      )}

      {type === "assign_team" && (
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Equipo</span>
          <select value={config.teamId ?? ""} onChange={(e) => onChange({ teamId: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">— elegir equipo —</option>
            {catalog.teams.map((t) => (<option key={t.id} value={t.id}>{t.name}</option>))}
          </select>
          <span className="mt-1 block text-[10px] text-slate-400">Al asignar, la IA se pausa en esa conversación.</span>
        </label>
      )}

      {type === "switch_agent" && (
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Agente IA que toma el control</span>
          <select value={config.agentSlug ?? ""} onChange={(e) => onChange({ agentSlug: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">— elegir agente —</option>
            {catalog.agents.map((a) => (<option key={a.slug} value={a.slug}>🤖 {a.name}</option>))}
          </select>
        </label>
      )}

      {type === "start_workflow" && (
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Flujo a disparar</span>
          <select value={config.workflowName ?? ""} onChange={(e) => onChange({ workflowName: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">— elegir flujo —</option>
            {catalog.workflows.map((w) => (<option key={w.name} value={w.name}>{w.name}</option>))}
          </select>
          <span className="mt-1 block text-[10px] text-slate-400">Debe estar publicado y activo. Un flujo no puede dispararse a sí mismo.</span>
        </label>
      )}

      {type === "transfer_human" && (
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Motivo (interno)</span>
          <input value={config.reason ?? ""} onChange={(e) => onChange({ reason: e.target.value })} placeholder="p. ej. requiere atención humana" className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
      )}

      {(type === "close_conversation" || type === "stop") && (
        <p className="text-xs text-slate-400">Este paso no necesita configuración.</p>
      )}
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
      <span className="text-xs text-slate-500">Esperar</span>
      <div className="flex items-center gap-2">
        <input type="number" min={1} value={value} onChange={(e) => setWait(Number(e.target.value), unit)} className="w-20 rounded-lg border border-slate-300 px-2 py-1.5" />
        <select value={unit} onChange={(e) => setWait(Number(value), e.target.value as any)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5">
          <option value="minutes">minutos</option>
          <option value="hours">horas</option>
          <option value="days">días</option>
        </select>
      </div>
      <label className="flex items-center gap-1.5 text-xs text-slate-500">
        <input type="checkbox" checked={config.cancelOn === "contact_reply"} onChange={(e) => onChange({ cancelOn: e.target.checked ? "contact_reply" : undefined })} />
        Cancelar la espera si el contacto responde
      </label>
    </div>
  );
}
