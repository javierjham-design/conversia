import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@conversia/types";
import { executeFrom, findStartNode, matchesTrigger, resumeAfterWait, type EngineDeps, type RunCtx } from "./index.js";

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
});
