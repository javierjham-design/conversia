/**
 * ARNÉS DE PRUEBA FUNCIONAL del módulo de Flujos (Bloque 1).
 * Ejecuta el motor puro de verdad con `EngineDeps` de grabación: cada paso se
 * ejecuta y se verifica QUÉ efecto invoca y con qué datos, qué rama toma y qué
 * registra. Complementa engine.test.ts (triggers/condiciones/validación) con:
 *  - cobertura de TODOS los pasos, incl. wait_reply (nodo nuevo);
 *  - datos válidos / vacíos / inválidos por paso;
 *  - casos borde (nodo inexistente, tope de nodos, variable faltante, paso que
 *    falla, ambas ramas de condición, horario con default del negocio);
 *  - 6 flujos realistas de punta a punta.
 * Ver docs/FLOWS_TEST_MATRIX.md para el mapeo escenario → resultado.
 */
import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@conversia/types";
import { executeFrom, findStartNode, resumeAfterWait, resumeWithBranch, stepNode, type EngineDeps, type RunCtx } from "./index.js";

/** Deps de grabación: apunta cada efecto y sus datos; configurable por escenario. */
function makeDeps(overrides: Partial<EngineDeps> & { objective?: "met" | "unmet" | "pending"; httpVars?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const steps: { nodeId: string; nodeType: string; status: string; output?: any }[] = [];
  const deps: EngineDeps = {
    sendText: async (_c, text) => void calls.push(`send:${text}`),
    runAgent: async (_c, slug) => void calls.push(`agent:${slug ?? ""}`),
    updateLeadStatus: async (_c, code) => void calls.push(`status:${code}`),
    addTag: async (_c, tag) => void calls.push(`tag:${tag}`),
    transferHuman: async (_c, reason) => void calls.push(`human:${reason ?? ""}`),
    setAiEnabled: async (_c, on) => void calls.push(`ai:${on}`),
    closeConversation: async () => void calls.push("close"),
    removeTag: async (_c, tag) => void calls.push(`untag:${tag}`),
    updateContact: async (_c, fields) => void calls.push(`contact:${Object.keys(fields).join(",") || "(vacío)"}`),
    assignUser: async (_c, userId) => void calls.push(`user:${userId}`),
    assignTeam: async (_c, teamId) => void calls.push(`team:${teamId}`),
    switchAgent: async (_c, slug) => void calls.push(`switch:${slug}`),
    startWorkflow: async (_c, name) => void calls.push(`start:${name}`),
    openConversation: async (c) => { (c as any).conversationId = "conv-new"; calls.push("open"); },
    addNote: async (_c, text) => void calls.push(`note:${text}`),
    sendCapiEvent: async (_c, config) => void calls.push(`capi:${config.eventName}:${config.value ?? ""}`),
    sendTemplate: async (_c, config) => void calls.push(`template:${(config as any).templateId ?? ""}`),
    sendInternalEmail: async (_c, config) => void calls.push(`email:${config.subject}->${config.to.join(",")}`),
    sendGa4Event: async (_c, config) => void calls.push(`ga4:${config.eventName}`),
    appendGoogleSheetRow: async (_c, config) => void calls.push(`sheets:${config.spreadsheetId}:${config.values.length}`),
    runAgentWithObjective: async (_c, _nodeId, cfg) => { calls.push(`objective:${(cfg as any).objective}`); return overrides.objective ?? "met"; },
    callApi: async (c, config) => { Object.assign((c as any).variables, overrides.httpVars ?? { __http_ok: "true", __http_status: "200" }); calls.push(`http:${(config as any).method ?? "GET"} ${(config as any).url ?? ""}`); },
    scheduleTimer: async (_c, nodeId) => void calls.push(`timer:${nodeId}`),
    evaluateCondition: async () => false,
    persistStep: async (_c, step) => void steps.push(step),
    now: () => new Date("2026-08-12T14:00:00Z"),
    getBusinessHoursDefault: async () => null,
    ...overrides,
  };
  return { deps, calls, steps };
}

const ctx = (): RunCtx => ({ organizationId: "o", runId: "r", workflowId: "w", versionId: "v", conversationId: "c", contactId: "ct", variables: { "contact.firstName": "Ana", "contact.lastName": "Pérez" } });

/** Helper: flujo lineal de nodos (edges from[i]→from[i+1]). */
function linear(nodes: WorkflowDefinition["nodes"]): WorkflowDefinition {
  const edges = nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1].id }));
  return { trigger: { type: "manual", config: {} }, variables: {}, nodes, edges };
}

// ───────────────────────────── Pasos individuales ─────────────────────────────
describe("Bloque 1 — pasos: datos válidos / vacíos / inválidos", () => {
  it("send_text renderiza variables; con texto vacío envía cadena vacía; variable inexistente → vacío", async () => {
    const okDeps = makeDeps();
    await executeFrom(okDeps.deps, ctx(), linear([{ id: "a", type: "send_text", config: { text: "Hola {{contact.firstName}} {{contact.lastName}}" } }, { id: "z", type: "stop", config: {} }]), "a");
    expect(okDeps.calls).toEqual(["send:Hola Ana Pérez"]);

    const emptyDeps = makeDeps();
    await executeFrom(emptyDeps.deps, ctx(), linear([{ id: "a", type: "send_text", config: { text: "" } }, { id: "z", type: "stop", config: {} }]), "a");
    expect(emptyDeps.calls).toEqual(["send:"]);

    const missDeps = makeDeps();
    await executeFrom(missDeps.deps, ctx(), linear([{ id: "a", type: "send_text", config: { text: "Hola {{contact.noExiste}}!" } }, { id: "z", type: "stop", config: {} }]), "a");
    expect(missDeps.calls).toEqual(["send:Hola !"]); // variable inexistente → ""
  });

  it("pasos de escritura enrutan al efecto con sus datos (etapa, etiqueta, campo, asignación, comentario, cerrar)", async () => {
    const { deps, calls } = makeDeps();
    const flow = linear([
      { id: "a", type: "update_lead_status", config: { statusCode: "calificado" } },
      { id: "b", type: "add_tag", config: { tag: "vip" } },
      { id: "c", type: "remove_tag", config: { tag: "frio" } },
      { id: "d", type: "update_contact", config: { fields: { firstName: "Ana", email: "a@b.cl" } } },
      { id: "e", type: "assign_user", config: { userId: "u1" } },
      { id: "f", type: "assign_team", config: { teamId: "t1" } },
      { id: "g", type: "add_note", config: { text: "Nota {{contact.firstName}}" } },
      { id: "h", type: "close_conversation", config: {} },
      { id: "z", type: "stop", config: {} },
    ]);
    expect(await executeFrom(deps, ctx(), flow, "a")).toEqual({ status: "completed" });
    expect(calls).toEqual(["status:calificado", "tag:vip", "untag:frio", "contact:firstName,email", "user:u1", "team:t1", "note:Nota Ana", "close"]);
  });

  it("pasos de IA: switch_agent, run_agent y transfer_human con motivo", async () => {
    const { deps, calls } = makeDeps();
    const flow = linear([
      { id: "a", type: "switch_agent", config: { agentSlug: "ventas" } },
      { id: "b", type: "run_agent", config: { agentSlug: "ventas" } },
      { id: "c", type: "transfer_human", config: { reason: "cliente enojado" } },
      { id: "z", type: "stop", config: {} },
    ]);
    await executeFrom(deps, ctx(), flow, "a");
    expect(calls).toEqual(["switch:ventas", "agent:ventas", "human:cliente enojado"]);
  });

  it("pasos de integración: correo interno, GA4, Google Sheets y Petición HTTP (mapea variables)", async () => {
    const { deps, calls } = makeDeps({ httpVars: { __http_ok: "true", __http_status: "200", saldo: "999" } });
    const flow = linear([
      { id: "a", type: "call_api", config: { method: "GET", url: "https://api.x/saldo", responseMapping: { saldo: "data.saldo" } } },
      { id: "b", type: "send_internal_email", config: { to: ["eq@x.cl"], subject: "Lead {{contact.firstName}}", body: "cuerpo" } },
      { id: "c", type: "send_ga4_event", config: { eventName: "lead", params: {} } },
      { id: "d", type: "google_sheets_append", config: { spreadsheetId: "sheet1", sheetName: "H1", values: ["{{contact.firstName}}", "x"] } },
      { id: "z", type: "stop", config: {} },
    ]);
    const c = ctx();
    await executeFrom(deps, c, flow, "a");
    expect(calls).toEqual(["http:GET https://api.x/saldo", "email:Lead Ana->eq@x.cl", "ga4:lead", "sheets:sheet1:2"]);
    expect(c.variables.saldo).toBe("999"); // la respuesta HTTP quedó como variable del flujo
  });

  it("send_capi con y sin valor; send_template con y sin plantilla (el motor enruta, no valida)", async () => {
    const withVal = makeDeps();
    await executeFrom(withVal.deps, ctx(), linear([{ id: "a", type: "send_capi", config: { eventName: "Schedule", value: 50000, currency: "CLP" } }, { id: "z", type: "stop", config: {} }]), "a");
    expect(withVal.calls).toEqual(["capi:Schedule:50000"]);

    const tmpl = makeDeps();
    await executeFrom(tmpl.deps, ctx(), linear([{ id: "a", type: "send_template", config: { templateId: "tmpl_1" } }, { id: "z", type: "stop", config: {} }]), "a");
    expect(tmpl.calls).toEqual(["template:tmpl_1"]);

    const noTmpl = makeDeps(); // sin templateId: el motor igual enruta (la validación es al publicar)
    await executeFrom(noTmpl.deps, ctx(), linear([{ id: "a", type: "send_template", config: {} }, { id: "z", type: "stop", config: {} }]), "a");
    expect(noTmpl.calls).toEqual(["template:"]);
  });
});

// ───────────────────────────── Control de flujo ─────────────────────────────
describe("Bloque 1 — control de flujo y ramas", () => {
  it("wait_reply: espera y programa timer; rama 'replied' al responder, 'no_reply' al vencer", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} }, variables: {},
      nodes: [
        { id: "w", type: "wait_reply", config: { hours: 24 } },
        { id: "si", type: "add_tag", config: { tag: "respondio" } },
        { id: "no", type: "send_text", config: { text: "¿Sigues ahí?" } },
      ],
      edges: [{ from: "w", to: "si", when: "replied" }, { from: "w", to: "no", when: "no_reply" }],
    };
    const start = makeDeps();
    expect(await executeFrom(start.deps, ctx(), flow, "w")).toEqual({ status: "waiting", nodeId: "w" });
    expect(start.calls).toEqual(["timer:w"]);

    const replied = makeDeps();
    expect(await resumeWithBranch(replied.deps, ctx(), flow, "w", "replied")).toEqual({ status: "completed" });
    expect(replied.calls).toEqual(["tag:respondio"]);

    const timedOut = makeDeps();
    await resumeWithBranch(timedOut.deps, ctx(), flow, "w", "no_reply");
    expect(timedOut.calls).toEqual(["send:¿Sigues ahí?"]);
  });

  it("condition (no_reply): rama true (sin respuesta) y rama false (respondió) según evaluateCondition", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} }, variables: {},
      nodes: [
        { id: "q", type: "condition", config: { kind: "no_reply" } },
        { id: "t", type: "add_tag", config: { tag: "sin-respuesta" } },
        { id: "f", type: "run_agent", config: { agentSlug: "ventas" } },
      ],
      edges: [{ from: "q", to: "t", when: "true" }, { from: "q", to: "f", when: "false" }],
    };
    const noReply = makeDeps({ evaluateCondition: async () => true });
    await executeFrom(noReply.deps, ctx(), flow, "q");
    expect(noReply.calls).toEqual(["tag:sin-respuesta"]);

    const replied = makeDeps({ evaluateCondition: async () => false });
    await executeFrom(replied.deps, ctx(), flow, "q");
    expect(replied.calls).toEqual(["agent:ventas"]);
  });

  it("business_hours: usa el horario por defecto del negocio cuando el nodo no trae 'hours'", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} }, variables: {},
      nodes: [
        { id: "h", type: "business_hours", config: { timezone: "UTC" } }, // sin hours → cae al default del negocio
        { id: "in", type: "add_tag", config: { tag: "dentro" } },
        { id: "out", type: "send_text", config: { text: "Te contactamos en horario" } },
      ],
      edges: [{ from: "h", to: "in", when: "in" }, { from: "h", to: "out", when: "out" }],
    };
    // now() = miércoles 2026-08-12 14:00 UTC → dentro de 09-18.
    const dentro = makeDeps({ getBusinessHoursDefault: async () => ({ timezone: "UTC", hours: { wed: [{ from: "09:00", to: "18:00" }] }, holidays: [] }) });
    await executeFrom(dentro.deps, ctx(), flow, "h");
    expect(dentro.calls).toEqual(["tag:dentro"]);

    const fuera = makeDeps({ getBusinessHoursDefault: async () => ({ timezone: "UTC", hours: { wed: [{ from: "09:00", to: "12:00" }] }, holidays: [] }) });
    await executeFrom(fuera.deps, ctx(), flow, "h");
    expect(fuera.calls).toEqual(["send:Te contactamos en horario"]);
  });
});

// ───────────────────────────── Paso a paso (probador) ─────────────────────────────
describe("Bloque 2 — stepNode: ejecución nodo a nodo con rama y siguiente", () => {
  it("ejecuta un nodo y devuelve el siguiente; en condición devuelve la rama tomada", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} }, variables: {},
      nodes: [
        { id: "a", type: "send_text", config: { text: "Hola {{contact.firstName}}" } },
        { id: "q", type: "condition", config: { kind: "no_reply" } },
        { id: "t", type: "add_tag", config: { tag: "sin-respuesta" } },
        { id: "f", type: "run_agent", config: { agentSlug: "ventas" } },
      ],
      edges: [{ from: "a", to: "q" }, { from: "q", to: "t", when: "true" }, { from: "q", to: "f", when: "false" }],
    };
    const c = ctx();
    const s1 = makeDeps();
    const r1 = await stepNode(s1.deps, c, flow, "a");
    expect(r1).toEqual({ status: "continue", branch: undefined, nextNodeId: "q" });
    expect(s1.calls).toEqual(["send:Hola Ana"]);
    // La condición devuelve la rama tomada + su siguiente nodo.
    const s2 = makeDeps({ evaluateCondition: async () => true });
    const r2 = await stepNode(s2.deps, c, flow, "q");
    expect(r2).toEqual({ status: "continue", branch: "true", nextNodeId: "t" });
  });

  it("stepNode: wait → waiting; stop → completed; nodo inexistente → failed", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} }, variables: {},
      nodes: [{ id: "w", type: "wait", config: { minutes: 5 } }, { id: "s", type: "stop", config: {} }],
      edges: [{ from: "w", to: "s" }],
    };
    expect(await stepNode(makeDeps().deps, ctx(), flow, "w")).toEqual({ status: "waiting", nodeId: "w" });
    expect(await stepNode(makeDeps().deps, ctx(), flow, "s")).toEqual({ status: "completed" });
    expect((await stepNode(makeDeps().deps, ctx(), flow, "zzz") as any).status).toBe("failed");
  });
});

// ───────────────────────────── Casos borde ─────────────────────────────
describe("Bloque 1 — casos borde", () => {
  it("nodo inexistente (arista a id que no existe) → falla con nodo no encontrado", async () => {
    const { deps } = makeDeps();
    const flow: WorkflowDefinition = { trigger: { type: "manual", config: {} }, variables: {}, nodes: [{ id: "a", type: "add_tag", config: { tag: "x" } }], edges: [{ from: "a", to: "fantasma" }] };
    const r = await executeFrom(deps, ctx(), flow, "a");
    expect(r.status).toBe("failed");
    expect((r as any).error).toContain("fantasma");
  });

  it("un paso que falla (efecto lanza) → status failed, nodeId del paso y persiste el step FAILED", async () => {
    const { deps, steps } = makeDeps({ sendText: async () => { throw new Error("canal caído"); } });
    const flow = linear([{ id: "a", type: "send_text", config: { text: "hola" } }, { id: "z", type: "stop", config: {} }]);
    const r = await executeFrom(deps, ctx(), flow, "a");
    expect(r).toMatchObject({ status: "failed", nodeId: "a" });
    expect((r as any).error).toContain("canal caído");
    expect(steps.at(-1)).toMatchObject({ nodeId: "a", nodeType: "send_text", status: "FAILED" });
  });

  it("tope de nodos por ejecución: una cadena larguísima se corta con error de límite", async () => {
    // 60 nodos lineales (> MAX_NODES_PER_RUN = 50).
    const nodes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, type: "add_tag" as const, config: { tag: `t${i}` } }));
    const { deps } = makeDeps();
    const r = await executeFrom(deps, ctx(), linear(nodes), "n0");
    expect(r.status).toBe("failed");
    expect((r as any).error).toMatch(/nodos/i);
  });

  it("condición sin arista para la rama tomada → termina sin error (no cuelga)", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} }, variables: {},
      nodes: [{ id: "q", type: "condition", config: { kind: "no_reply" } }, { id: "t", type: "add_tag", config: { tag: "x" } }],
      edges: [{ from: "q", to: "t", when: "true" }], // NO hay arista "false"
    };
    const r = await executeFrom(makeDeps({ evaluateCondition: async () => false }).deps, ctx(), flow, "q");
    expect(r).toEqual({ status: "completed" });
  });

  it("contacto sin datos: las variables faltantes se renderizan como vacío y el flujo no rompe", async () => {
    const { deps, calls } = makeDeps();
    const c: RunCtx = { ...ctx(), variables: {} }; // sin ninguna variable
    await executeFrom(deps, c, linear([{ id: "a", type: "send_text", config: { text: "Hola {{contact.firstName}}, tu cita {{appointment.date}}" } }, { id: "z", type: "stop", config: {} }]), "a");
    expect(calls).toEqual(["send:Hola , tu cita "]);
  });
});

// ───────────────────────────── 6 flujos de punta a punta ─────────────────────────────
describe("Bloque 1 — 6 flujos realistas de punta a punta", () => {
  it("1) Captación desde anuncio: abre conversación, etiqueta origen, saluda y deriva al agente", async () => {
    const { deps, calls } = makeDeps();
    const c: RunCtx = { ...ctx(), conversationId: undefined };
    const flow = linear([
      { id: "a", type: "open_conversation", config: {} },
      { id: "b", type: "add_tag", config: { tag: "anuncio-implantes" } },
      { id: "c", type: "send_text", config: { text: "¡Hola {{contact.firstName}}! Vimos tu interés en implantes." } },
      { id: "d", type: "run_agent", config: { agentSlug: "ventas" } },
      { id: "z", type: "stop", config: {} },
    ]);
    (flow.trigger as any) = { type: "click_to_chat", config: { mode: "selected", adIds: ["AD1"] } };
    expect(await executeFrom(deps, c, flow, "a")).toEqual({ status: "completed" });
    expect(calls).toEqual(["open", "tag:anuncio-implantes", "send:¡Hola Ana! Vimos tu interés en implantes.", "agent:ventas"]);
  });

  it("2) Calificación con condición: si no responde en 5 min, recordatorio; si responde, agente", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "message_received", config: { keywords: ["precio"] } }, variables: {},
      nodes: [
        { id: "s", type: "send_text", config: { text: "Te cuento los precios 👇" } },
        { id: "w", type: "wait", config: { minutes: 5, cancelOn: "contact_reply" } },
        { id: "q", type: "condition", config: { kind: "no_reply" } },
        { id: "r", type: "send_text", config: { text: "¿Seguimos?" } },
        { id: "a", type: "run_agent", config: { agentSlug: "ventas" } },
      ],
      edges: [{ from: "s", to: "w" }, { from: "w", to: "q" }, { from: "q", to: "r", when: "true" }, { from: "q", to: "a", when: "false" }],
    };
    // Ejecuta hasta la espera.
    const first = makeDeps();
    expect(await executeFrom(first.deps, ctx(), flow, "s")).toEqual({ status: "waiting", nodeId: "w" });
    expect(first.calls).toEqual(["send:Te cuento los precios 👇", "timer:w"]);
    // Reanuda tras el timer: no respondió → recordatorio.
    const noReply = makeDeps({ evaluateCondition: async () => true });
    await resumeAfterWait(noReply.deps, ctx(), flow, "w");
    expect(noReply.calls).toEqual(["send:¿Seguimos?"]);
  });

  it("3) Agendamiento con objetivo: agente cumple objetivo → etapa Agendado + evento CAPI Schedule", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} }, variables: {},
      nodes: [
        { id: "o", type: "ai_objective", config: { agentSlug: "agendamiento", objective: "agendar una hora" } },
        { id: "s", type: "update_lead_status", config: { statusCode: "agendado" } },
        { id: "capi", type: "send_capi", config: { eventName: "Schedule", value: 0, currency: "CLP" } },
        { id: "no", type: "transfer_human", config: { reason: "no pudo agendar" } },
        { id: "z", type: "stop", config: {} },
      ],
      edges: [{ from: "o", to: "s", when: "met" }, { from: "s", to: "capi" }, { from: "capi", to: "z" }, { from: "o", to: "no", when: "unmet" }],
    };
    const met = makeDeps({ objective: "met" });
    expect(await executeFrom(met.deps, ctx(), flow, "o")).toEqual({ status: "completed" });
    expect(met.calls).toEqual(["objective:agendar una hora", "status:agendado", "capi:Schedule:0"]);
    const unmet = makeDeps({ objective: "unmet" });
    await executeFrom(unmet.deps, ctx(), flow, "o");
    expect(unmet.calls).toEqual(["objective:agendar una hora", "human:no pudo agendar"]);
  });

  it("4) Recordatorio con plantilla + confirmación: envía HSM, espera respuesta, ramifica", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "appointment_upcoming", config: { hoursBefore: 24 } }, variables: {},
      nodes: [
        { id: "t", type: "send_template", config: { templateId: "recordatorio_cita" } },
        { id: "w", type: "wait_reply", config: { hours: 6 } },
        { id: "ok", type: "update_lead_status", config: { statusCode: "confirmado" } },
        { id: "no", type: "add_note", config: { text: "No confirmó el recordatorio" } },
      ],
      edges: [{ from: "t", to: "w" }, { from: "w", to: "ok", when: "replied" }, { from: "w", to: "no", when: "no_reply" }],
    };
    const run = makeDeps();
    expect(await executeFrom(run.deps, ctx(), flow, "t")).toEqual({ status: "waiting", nodeId: "w" });
    expect(run.calls).toEqual(["template:recordatorio_cita", "timer:w"]);
    const confirmo = makeDeps();
    await resumeWithBranch(confirmo.deps, ctx(), flow, "w", "replied");
    expect(confirmo.calls).toEqual(["status:confirmado"]);
  });

  it("5) Reactivación de lead frío: mensaje, espera 3 días, segundo intento y etiqueta", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} }, variables: {},
      nodes: [
        { id: "m1", type: "send_text", config: { text: "Hola {{contact.firstName}}, ¿retomamos?" } },
        { id: "w", type: "wait", config: { days: 3, cancelOn: "contact_reply" } },
        { id: "m2", type: "send_text", config: { text: "Última oportunidad 🙌" } },
        { id: "tag", type: "add_tag", config: { tag: "reactivacion" } },
        { id: "z", type: "stop", config: {} },
      ],
      edges: [{ from: "m1", to: "w" }, { from: "w", to: "m2" }, { from: "m2", to: "tag" }, { from: "tag", to: "z" }],
    };
    const first = makeDeps();
    expect(await executeFrom(first.deps, ctx(), flow, "m1")).toEqual({ status: "waiting", nodeId: "w" });
    const resumed = makeDeps();
    expect(await resumeAfterWait(resumed.deps, ctx(), flow, "w")).toEqual({ status: "completed" });
    expect(resumed.calls).toEqual(["send:Última oportunidad 🙌", "tag:reactivacion"]);
  });

  it("6) Derivación a agente IA y escalamiento a humano cuando no cumple", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "conversation_started", config: {} }, variables: {},
      nodes: [
        { id: "a", type: "run_agent", config: { agentSlug: "recepcion" } },
        { id: "o", type: "ai_objective", config: { agentSlug: "recepcion", objective: "resolver la duda" } },
        { id: "ok", type: "close_conversation", config: {} },
        { id: "esc", type: "transfer_human", config: { reason: "requiere humano" } },
      ],
      edges: [{ from: "a", to: "o" }, { from: "o", to: "ok", when: "met" }, { from: "o", to: "esc", when: "unmet" }],
    };
    const escala = makeDeps({ objective: "unmet" });
    await executeFrom(escala.deps, ctx(), flow, "a");
    expect(escala.calls).toEqual(["agent:recepcion", "objective:resolver la duda", "human:requiere humano"]);
  });
});
