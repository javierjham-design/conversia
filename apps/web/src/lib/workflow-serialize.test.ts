import { describe, expect, it } from "vitest";
import { defToFlow, flowToDef, TRIGGER_NODE_ID } from "./workflow-serialize";
import { WORKFLOW_TEMPLATES } from "./workflow-templates";
import { DIGITAL_DENT_FLOWS } from "./__fixtures__/digital-dent-flows";

function roundTrip(def: any) {
  const flow = defToFlow(def);
  return flowToDef(flow.nodes, flow.edges, flow.trigger);
}

/** Contenido semántico que NO puede cambiar al abrir+guardar: disparador,
 *  nodos (id/tipo/config) y aristas (origen/destino/rama). Ignora posiciones
 *  (se prueban aparte por idempotencia). */
function semantic(def: any) {
  return {
    trigger: { type: def.trigger?.type, config: def.trigger?.config ?? {} },
    nodes: [...(def.nodes ?? [])].map((n: any) => ({ id: n.id, type: n.type, config: n.config ?? {} })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...(def.edges ?? [])].map((e: any) => ({ from: e.from, to: e.to, when: e.when ?? null })).sort((a, b) => `${a.from}${a.to}${a.when}`.localeCompare(`${b.from}${b.to}${b.when}`)),
  };
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

  // GUARDIÁN de la reescritura del canvas: abrir + guardar sin editar un flujo
  // de PRODUCCIÓN no debe cambiar su contenido semántico (nodos/aristas/config
  // de nodos NI config del disparador). Si esto falla, abrir y guardar en prod
  // lo corrompe.
  it("round-trip de los flujos PUBLICADOS de Digital Dent (sin pérdida semántica)", () => {
    for (const f of DIGITAL_DENT_FLOWS) {
      const out = roundTrip(f.definition);
      expect(semantic(out), `flujo "${f.name}"`).toEqual(semantic(f.definition));
    }
  });

  it("posiciones idempotentes: guardar dos veces no las mueve", () => {
    for (const f of DIGITAL_DENT_FLOWS) {
      const once = roundTrip(f.definition);
      const twice = roundTrip(once);
      expect(twice.nodes.map((n: any) => n.position), `flujo "${f.name}"`).toEqual(once.nodes.map((n: any) => n.position));
    }
  });

  it("smoke: flujo con nodos de varias categorías + condición con dos ramas sobrevive el round-trip", () => {
    const def = {
      trigger: { type: "message_received", config: { keywords: ["precio"], matchType: "exact" } },
      variables: {},
      nodes: [
        { id: "a", type: "send_text", config: { text: "Hola {{contact.firstName}}" }, position: { x: 250, y: 140 } },
        { id: "b", type: "add_tag", config: { tag: "interesado" }, position: { x: 250, y: 270 } },
        { id: "c", type: "update_lead_status", config: { statusCode: "nuevo" }, position: { x: 250, y: 400 } },
        { id: "d", type: "wait", config: { minutes: 5, cancelOn: "contact_reply" }, position: { x: 250, y: 530 } },
        { id: "e", type: "condition", config: { kind: "no_reply" }, position: { x: 250, y: 660 } },
        { id: "f", type: "run_agent", config: { agentSlug: "ventas" }, position: { x: 120, y: 790 } },
        { id: "g", type: "transfer_human", config: { reason: "sin respuesta" }, position: { x: 380, y: 790 } },
        { id: "h", type: "pause_ai", config: {}, position: { x: 380, y: 920 } },
        { id: "i", type: "send_capi", config: { eventName: "Lead", value: "", currency: "CLP" }, position: { x: 120, y: 920 } },
        { id: "j", type: "call_api", config: { method: "GET", url: "https://api.x/y", headers: {}, body: "", responseMapping: {} }, position: { x: 120, y: 1050 } },
        { id: "k", type: "stop", config: {}, position: { x: 250, y: 1180 } },
      ],
      edges: [
        { from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "d" }, { from: "d", to: "e" },
        { from: "e", to: "f", when: "false" }, { from: "e", to: "g", when: "true" },
        { from: "f", to: "i" }, { from: "g", to: "h" }, { from: "i", to: "j" }, { from: "j", to: "k" },
      ],
    };
    const out = roundTrip(def);
    expect(semantic(out)).toEqual(semantic(def));
    // Las dos ramas de la condición se conservan (true/false).
    expect(out.edges.filter((e: any) => e.from === "e" && e.when === "true")).toHaveLength(1);
    expect(out.edges.filter((e: any) => e.from === "e" && e.when === "false")).toHaveLength(1);
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
