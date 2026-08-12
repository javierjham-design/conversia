// Serialización pura entre el grafo del canvas (React Flow) y el
// WorkflowDefinition que entiende el motor v0. Sin dependencias de React para
// poder testear el round-trip. El nodo "Disparador" es sólo del editor (no se
// serializa); el nodo de inicio es el que no tiene aristas entrantes.
import type { Edge, Node } from "@xyflow/react";

export const TRIGGER_NODE_ID = "__trigger__";

export interface DefTrigger {
  type: string;
  config: Record<string, unknown>;
}

export function edgeStyle(when?: string) {
  const label =
    when === "true" || when === "no_reply" ? "sin respuesta"
    : when === "false" || when === "replied" ? "respondió"
    : when === "error" ? "si falla"
    : undefined;
  // type "deletable": edge con botón "×" para borrar una sola conexión (ver page.tsx).
  return { type: "deletable", label, animated: false, style: { stroke: "#94a3b8" }, labelStyle: { fontSize: 10, fill: "#64748b" } };
}

export function defToFlow(def: any): { nodes: Node[]; edges: Edge[]; trigger: DefTrigger } {
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
    // Arista del disparador → primer paso: estructural, no se elimina ni reconecta.
    edges.unshift({ id: `trigger->${startId}`, source: TRIGGER_NODE_ID, target: startId, selectable: false, deletable: false, reconnectable: false, ...edgeStyle() });
  }
  return { nodes, edges, trigger };
}

/**
 * Config del disparador al serializar. Preserva `t.config` TAL CUAL — es la
 * fuente de verdad del editor. Antes descartaba casi todo (solo keyword/
 * firstMessage), así que abrir + guardar un flujo perdía `hoursBefore`,
 * `keywords`/`matchType`/`channel`, `adIds`, `fromStatus`/`toStatus`, `tag`,
 * filtros de cita, etc. → corrupción silenciosa. Cubierto por el round-trip
 * contra los flujos reales de Digital Dent.
 */
function triggerConfigFor(t: DefTrigger): Record<string, unknown> {
  return (t.config ?? {}) as Record<string, unknown>;
}

export function flowToDef(nodes: Node[], edges: Edge[], trigger: DefTrigger): any {
  const stepNodes = nodes.filter((n) => n.id !== TRIGGER_NODE_ID);
  return {
    trigger: { type: trigger.type, config: triggerConfigFor(trigger) },
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
