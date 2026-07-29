import { describe, expect, it } from "vitest";
import { defToFlow, flowToDef, TRIGGER_NODE_ID } from "./workflow-serialize";
import { WORKFLOW_TEMPLATES } from "./workflow-templates";

function roundTrip(def: any) {
  const flow = defToFlow(def);
  return flowToDef(flow.nodes, flow.edges, flow.trigger);
}

describe("serialización canvas ↔ WorkflowDefinition", () => {
  it("round-trip sin pérdida en todas las plantillas", () => {
    for (const t of WORKFLOW_TEMPLATES) {
      const out = roundTrip(t.definition);
      expect(out.trigger).toEqual(t.definition.trigger);
      expect(out.nodes).toEqual(t.definition.nodes);
      expect(out.edges).toEqual(t.definition.edges);
    }
  });

  it("el nodo Disparador vive en el canvas pero NO en la definición", () => {
    const flow = defToFlow(WORKFLOW_TEMPLATES[0].definition);
    expect(flow.nodes.some((n) => n.id === TRIGGER_NODE_ID)).toBe(true);
    const out = flowToDef(flow.nodes, flow.edges, flow.trigger);
    expect(out.nodes.some((n: any) => n.id === TRIGGER_NODE_ID)).toBe(false);
    expect(out.edges.some((e: any) => e.from === TRIGGER_NODE_ID)).toBe(false);
  });

  it("preserva las ramas 'when' de las condiciones", () => {
    const seg = WORKFLOW_TEMPLATES.find((t) => t.key === "seguimiento-sin-respuesta")!;
    const out = roundTrip(seg.definition);
    expect(out.edges.filter((e: any) => e.when === "true").length).toBe(2);
  });

  it("redondea posiciones y conserva el conteo de nodos", () => {
    const def = {
      trigger: { type: "conversation_started", config: {} },
      variables: {},
      nodes: [{ id: "a", type: "send_text", config: { text: "hi" }, position: { x: 12.7, y: 30.2 } }],
      edges: [],
    };
    const out = roundTrip(def);
    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0].position).toEqual({ x: 13, y: 30 });
  });
});
