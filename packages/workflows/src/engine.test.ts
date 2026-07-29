import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@conversia/types";
import { evalBusinessHours, executeFrom, findStartNode, matchesTrigger, resumeAfterWait, type EngineDeps, type RunCtx } from "./index.js";

function makeDeps(overrides: Partial<EngineDeps> = {}) {
  const calls: string[] = [];
  const deps: EngineDeps = {
    sendText: async (_c, text) => void calls.push(`send:${text}`),
    runAgent: async (_c, slug) => void calls.push(`agent:${slug}`),
    updateLeadStatus: async (_c, code) => void calls.push(`status:${code}`),
    addTag: async (_c, tag) => void calls.push(`tag:${tag}`),
    transferHuman: async () => void calls.push("human"),
    setAiEnabled: async (_c, on) => void calls.push(`ai:${on}`),
    closeConversation: async () => void calls.push("close"),
    removeTag: async (_c, tag) => void calls.push(`untag:${tag}`),
    updateContact: async (_c, fields) => void calls.push(`contact:${Object.keys(fields).join(",")}`),
    assignUser: async (_c, userId) => void calls.push(`user:${userId}`),
    assignTeam: async (_c, teamId) => void calls.push(`team:${teamId}`),
    switchAgent: async (_c, slug) => void calls.push(`switch:${slug}`),
    startWorkflow: async (_c, name) => void calls.push(`start:${name}`),
    openConversation: async (c) => { (c as any).conversationId = "conv-new"; calls.push("open"); },
    addNote: async (_c, text) => void calls.push(`note:${text}`),
    scheduleTimer: async (_c, nodeId) => void calls.push(`timer:${nodeId}`),
    evaluateCondition: async () => true,
    persistStep: async () => undefined,
    now: () => new Date("2026-01-01T12:00:00Z"),
    ...overrides,
  };
  return { deps, calls };
}

const def: WorkflowDefinition = {
  trigger: { type: "conversation_started", config: {} },
  variables: {},
  nodes: [
    { id: "n1", type: "update_lead_status", config: { statusCode: "nuevo" } },
    { id: "n2", type: "run_agent", config: { agentSlug: "recepcionista" } },
    { id: "n3", type: "wait", config: { minutes: 5, cancelOn: "contact_reply" } },
    { id: "n4", type: "condition", config: { kind: "no_reply" } },
    { id: "n5", type: "send_text", config: { text: "Hola {{contact.firstName}}" } },
  ],
  edges: [
    { from: "n1", to: "n2" },
    { from: "n2", to: "n3" },
    { from: "n3", to: "n4" },
    { from: "n4", to: "n5", when: "true" },
  ],
};

const ctx: RunCtx = {
  organizationId: "org1",
  runId: "run1",
  workflowId: "wf1",
  versionId: "v1",
  variables: { "contact.firstName": "Javier" },
};

describe("motor de workflows v0", () => {
  it("hace match de triggers por tipo", () => {
    expect(matchesTrigger(def, { organizationId: "org1", type: "conversation_started", occurredAt: "" })).toBe(true);
    expect(matchesTrigger(def, { organizationId: "org1", type: "message_received", occurredAt: "" })).toBe(false);
  });

  it("evalúa condiciones de message_received y conversation_closed", () => {
    const kw: WorkflowDefinition = { trigger: { type: "message_received", config: { keyword: "hora" } }, variables: {}, nodes: [{ id: "n1", type: "stop", config: {} }], edges: [] };
    expect(matchesTrigger(kw, { organizationId: "o", type: "message_received", data: { text: "quiero una HORA" }, occurredAt: "" })).toBe(true);
    expect(matchesTrigger(kw, { organizationId: "o", type: "message_received", data: { text: "hola" }, occurredAt: "" })).toBe(false);

    const first: WorkflowDefinition = { trigger: { type: "message_received", config: { firstMessage: true } }, variables: {}, nodes: [{ id: "n1", type: "stop", config: {} }], edges: [] };
    expect(matchesTrigger(first, { organizationId: "o", type: "message_received", data: { isFirstMessage: true }, occurredAt: "" })).toBe(true);
    expect(matchesTrigger(first, { organizationId: "o", type: "message_received", data: { isFirstMessage: false }, occurredAt: "" })).toBe(false);

    const closed: WorkflowDefinition = { trigger: { type: "conversation_closed", config: {} }, variables: {}, nodes: [{ id: "n1", type: "stop", config: {} }], edges: [] };
    expect(matchesTrigger(closed, { organizationId: "o", type: "conversation_closed", occurredAt: "" })).toBe(true);
    expect(matchesTrigger(closed, { organizationId: "o", type: "message_received", occurredAt: "" })).toBe(false);
  });

  it("ejecuta hasta la espera y programa el timer", async () => {
    const { deps, calls } = makeDeps();
    const result = await executeFrom(deps, ctx, def, findStartNode(def)!.id);
    expect(result).toEqual({ status: "waiting", nodeId: "n3" });
    expect(calls).toEqual(["status:nuevo", "agent:recepcionista", "timer:n3"]);
  });

  it("reanuda tras el timer, evalúa condición y renderiza variables", async () => {
    const { deps, calls } = makeDeps();
    const result = await resumeAfterWait(deps, ctx, def, "n3");
    expect(result).toEqual({ status: "completed" });
    expect(calls).toEqual(["send:Hola Javier"]);
  });

  it("toma la rama false y termina si no hay arista", async () => {
    const { deps, calls } = makeDeps({ evaluateCondition: async () => false });
    const result = await resumeAfterWait(deps, ctx, def, "n3");
    expect(result).toEqual({ status: "completed" });
    expect(calls).toEqual([]);
  });

  it("ejecuta los nodos nuevos (etiqueta, contacto, asignación, agente, subflujo)", async () => {
    const { deps, calls } = makeDeps();
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} },
      variables: {},
      nodes: [
        { id: "a", type: "remove_tag", config: { tag: "frio" } },
        { id: "b", type: "update_contact", config: { fields: { firstName: "Ana" } } },
        { id: "c", type: "assign_team", config: { teamId: "t1" } },
        { id: "d", type: "switch_agent", config: { agentSlug: "ventas" } },
        { id: "e", type: "start_workflow", config: { workflowName: "Bienvenida" } },
        { id: "f", type: "stop", config: {} },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "d" },
        { from: "d", to: "e" },
        { from: "e", to: "f" },
      ],
    };
    const result = await executeFrom(deps, ctx, flow, "a");
    expect(result).toEqual({ status: "completed" });
    expect(calls).toEqual(["untag:frio", "contact:firstName", "team:t1", "switch:ventas", "start:Bienvenida"]);
  });
});

describe("Categoría 2 — Conversación + Control de flujo", () => {
  it("abre conversación (setea ctx.conversationId) y deja comentario", async () => {
    const { deps, calls } = makeDeps();
    const c2: RunCtx = { ...ctx, conversationId: undefined };
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} },
      variables: {},
      nodes: [
        { id: "a", type: "open_conversation", config: {} },
        { id: "b", type: "add_note", config: { text: "Contacto desde flujo" } },
        { id: "c", type: "stop", config: {} },
      ],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
    };
    const r = await executeFrom(deps, c2, flow, "a");
    expect(r).toEqual({ status: "completed" });
    expect(calls).toEqual(["open", "note:Contacto desde flujo"]);
    expect(c2.conversationId).toBe("conv-new");
  });

  it("Saltar a otro paso: salta al destino y omite los intermedios", async () => {
    const { deps, calls } = makeDeps();
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} },
      variables: {},
      nodes: [
        { id: "a", type: "add_tag", config: { tag: "ini" } },
        { id: "b", type: "goto", config: { targetNodeId: "d" } },
        { id: "c", type: "add_tag", config: { tag: "omitido" } },
        { id: "d", type: "add_tag", config: { tag: "destino" } },
        { id: "e", type: "stop", config: {} },
      ],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "d", to: "e" }],
    };
    const r = await executeFrom(deps, ctx, flow, "a");
    expect(r).toEqual({ status: "completed" });
    expect(calls).toEqual(["tag:ini", "tag:destino"]);
  });

  it("Saltar a otro paso: corta bucles al superar el máximo de saltos", async () => {
    const { deps } = makeDeps();
    const loop: WorkflowDefinition = {
      trigger: { type: "manual", config: {} },
      variables: {},
      nodes: [{ id: "x", type: "goto", config: { targetNodeId: "x" } }],
      edges: [],
    };
    const r = await executeFrom(deps, ctx, loop, "x");
    expect(r.status).toBe("failed");
    expect((r as any).error).toContain("saltos");
  });

  it("Fecha y hora: dentro, fuera y feriado (zona horaria UTC para el test)", () => {
    const cfg = { timezone: "UTC", hours: { mon: [{ from: "09:00", to: "18:00" }] }, holidays: ["2026-07-27"] };
    // 2026-07-27 es lunes.
    expect(evalBusinessHours({ ...cfg, holidays: [] }, new Date("2026-07-27T11:00:00Z"))).toBe(true); // dentro
    expect(evalBusinessHours({ ...cfg, holidays: [] }, new Date("2026-07-27T20:00:00Z"))).toBe(false); // fuera de hora
    expect(evalBusinessHours({ ...cfg, holidays: [] }, new Date("2026-07-28T11:00:00Z"))).toBe(false); // martes sin horario
    expect(evalBusinessHours(cfg, new Date("2026-07-27T11:00:00Z"))).toBe(false); // feriado
  });
});
