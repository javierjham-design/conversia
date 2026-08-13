import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "@conversia/types";
import { evalBusinessHours, executeFrom, findStartNode, matchesApptFilter, matchesKeywords, matchesTrigger, resumeAfterWait, resumeWithBranch, validateWorkflowDefinition, type EngineDeps, type RunCtx } from "./index.js";

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
    sendCapiEvent: async (_c, config) => void calls.push(`capi:${config.eventName}`),
    sendTemplate: async (_c, config) => void calls.push(`template:${(config as any).templateId ?? ""}`),
    sendInternalEmail: async (_c, config) => void calls.push(`email:${config.subject}`),
    sendGa4Event: async (_c, config) => void calls.push(`ga4:${config.eventName}`),
    appendGoogleSheetRow: async (_c, config) => void calls.push(`sheets:${config.spreadsheetId}`),
    runAgentWithObjective: async (_c, _nodeId, cfg) => { calls.push(`objective:${(cfg as any).objective}`); return "met"; },
    callApi: async (c, config) => { (c as any).variables.__http_ok = "true"; calls.push(`http:${(config as any).url ?? ""}`); },
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

  it("condiciones de click_to_chat (anuncio) y lead_status_changed (origen→destino)", () => {
    const ad: WorkflowDefinition = { trigger: { type: "click_to_chat", config: { adId: "AD123" } }, variables: {}, nodes: [{ id: "n1", type: "stop", config: {} }], edges: [] };
    expect(matchesTrigger(ad, { organizationId: "o", type: "click_to_chat", data: { ad_id: "AD123" }, occurredAt: "" })).toBe(true);
    expect(matchesTrigger(ad, { organizationId: "o", type: "click_to_chat", data: { ad_id: "OTRO" }, occurredAt: "" })).toBe(false);
    const anyAd: WorkflowDefinition = { ...ad, trigger: { type: "click_to_chat", config: {} } };
    expect(matchesTrigger(anyAd, { organizationId: "o", type: "click_to_chat", data: { ad_id: "X" }, occurredAt: "" })).toBe(true);

    // Selección por anuncios y por campaña (catálogo Meta).
    const sel: WorkflowDefinition = { ...ad, trigger: { type: "click_to_chat", config: { mode: "selected", adIds: ["A1", "A2"], campaignIds: ["C9"] } } };
    expect(matchesTrigger(sel, { organizationId: "o", type: "click_to_chat", data: { ad_id: "A2" }, occurredAt: "" })).toBe(true);
    // Anuncio NUEVO (no listado) pero de una campaña seleccionada → cubierto.
    expect(matchesTrigger(sel, { organizationId: "o", type: "click_to_chat", data: { ad_id: "NUEVO", campaign_id: "C9" }, occurredAt: "" })).toBe(true);
    // Anuncio y campaña fuera de la selección → no dispara.
    expect(matchesTrigger(sel, { organizationId: "o", type: "click_to_chat", data: { ad_id: "Z", campaign_id: "C1" }, occurredAt: "" })).toBe(false);

    const life: WorkflowDefinition = { trigger: { type: "lead_status_changed", config: { toStatus: "agendado" } }, variables: {}, nodes: [{ id: "n1", type: "stop", config: {} }], edges: [] };
    expect(matchesTrigger(life, { organizationId: "o", type: "lead_status_changed", data: { statusCode: "agendado", fromCode: "nuevo" }, occurredAt: "" })).toBe(true);
    expect(matchesTrigger(life, { organizationId: "o", type: "lead_status_changed", data: { statusCode: "perdido" }, occurredAt: "" })).toBe(false);
  });

  it("condiciones de tag_added (etiqueta específica, insensible a mayúsculas)", () => {
    const specific: WorkflowDefinition = { trigger: { type: "tag_added", config: { tag: "VIP" } }, variables: {}, nodes: [{ id: "n1", type: "stop", config: {} }], edges: [] };
    expect(matchesTrigger(specific, { organizationId: "o", type: "tag_added", data: { tag: "vip" }, occurredAt: "" })).toBe(true);
    expect(matchesTrigger(specific, { organizationId: "o", type: "tag_added", data: { tag: "urgente" }, occurredAt: "" })).toBe(false);
    const anyTag: WorkflowDefinition = { ...specific, trigger: { type: "tag_added", config: {} } };
    expect(matchesTrigger(anyTag, { organizationId: "o", type: "tag_added", data: { tag: "x" }, occurredAt: "" })).toBe(true);
    expect(matchesTrigger(anyTag, { organizationId: "o", type: "message_received", data: {}, occurredAt: "" })).toBe(false);
  });

  it("condiciones de message_received (canal, contiene/exacto, varias palabras)", () => {
    const base = (config: Record<string, unknown>): WorkflowDefinition => ({ trigger: { type: "message_received", config }, variables: {}, nodes: [{ id: "n1", type: "stop", config: {} }], edges: [] });
    // Canal.
    const ch = base({ channel: "whatsapp" });
    expect(matchesTrigger(ch, { organizationId: "o", type: "message_received", data: { text: "hola", channel: "whatsapp" }, occurredAt: "" })).toBe(true);
    expect(matchesTrigger(ch, { organizationId: "o", type: "message_received", data: { text: "hola", channel: "instagram" }, occurredAt: "" })).toBe(false);
    // Contiene (por defecto), cualquiera.
    const kw = base({ keywords: ["hora", "precio"] });
    expect(matchesTrigger(kw, { organizationId: "o", type: "message_received", data: { text: "quiero una HORA" }, occurredAt: "" })).toBe(true);
    expect(matchesTrigger(kw, { organizationId: "o", type: "message_received", data: { text: "hola" }, occurredAt: "" })).toBe(false);
    // Todas.
    const all = base({ keywords: ["hora", "lunes"], matchAll: true });
    expect(matchesTrigger(all, { organizationId: "o", type: "message_received", data: { text: "una hora el lunes" }, occurredAt: "" })).toBe(true);
    expect(matchesTrigger(all, { organizationId: "o", type: "message_received", data: { text: "una hora" }, occurredAt: "" })).toBe(false);
    // Exacta.
    const exact = base({ keywords: ["hola"], matchType: "exact" });
    expect(matchesTrigger(exact, { organizationId: "o", type: "message_received", data: { text: "  Hola  " }, occurredAt: "" })).toBe(true);
    expect(matchesTrigger(exact, { organizationId: "o", type: "message_received", data: { text: "hola qué tal" }, occurredAt: "" })).toBe(false);
    // Legado: keyword string sigue funcionando y se combina con keywords[].
    expect(matchesKeywords({ keyword: "precio" }, "cuál es el PRECIO")).toBe(true);
    expect(matchesKeywords({}, "cualquier cosa")).toBe(true);
  });

  it("filtros de triggers de cita (servicio / profesional / sede)", () => {
    // Vacío = cualquiera.
    const any: WorkflowDefinition = { trigger: { type: "appointment_created", config: {} }, variables: {}, nodes: [{ id: "n1", type: "stop", config: {} }], edges: [] };
    expect(matchesTrigger(any, { organizationId: "o", type: "appointment_created", data: { serviceId: "s1" }, occurredAt: "" })).toBe(true);
    // Filtro por servicio.
    const svc: WorkflowDefinition = { ...any, trigger: { type: "appointment_created", config: { serviceIds: ["s1", "s2"] } } };
    expect(matchesTrigger(svc, { organizationId: "o", type: "appointment_created", data: { serviceId: "s2" }, occurredAt: "" })).toBe(true);
    expect(matchesTrigger(svc, { organizationId: "o", type: "appointment_created", data: { serviceId: "s9" }, occurredAt: "" })).toBe(false);
    // Combinación con Y: servicio + profesional deben cumplirse ambos.
    const both: WorkflowDefinition = { ...any, trigger: { type: "no_show", config: { serviceIds: ["s1"], professionalIds: ["p1"] } } };
    expect(matchesTrigger(both, { organizationId: "o", type: "no_show", data: { serviceId: "s1", professionalId: "p1" }, occurredAt: "" })).toBe(true);
    expect(matchesTrigger(both, { organizationId: "o", type: "no_show", data: { serviceId: "s1", professionalId: "p2" }, occurredAt: "" })).toBe(false);
  });

  it("matchesApptFilter es puro y trata array vacío como 'todos'", () => {
    expect(matchesApptFilter({}, { serviceId: "x" })).toBe(true);
    expect(matchesApptFilter({ clinicIds: [] }, { clinicId: "c1" })).toBe(true);
    expect(matchesApptFilter({ clinicIds: ["c1"] }, { clinicId: "c1" })).toBe(true);
    expect(matchesApptFilter({ clinicIds: ["c1"] }, { clinicId: "c2" })).toBe(false);
    expect(matchesApptFilter({ clinicIds: ["c1"] }, {})).toBe(false);
  });

  it("validación al publicar: campos requeridos, referencias y nodos sin conectar", () => {
    const ctx = { tags: ["vip"], agentSlugs: ["asesor"], leadStatusCodes: ["nuevo", "agendado"], workflowNames: ["Bienvenida"] };
    // Flujo sano.
    const ok: WorkflowDefinition = {
      trigger: { type: "appointment_upcoming", config: { hoursBefore: 24 } },
      variables: {},
      nodes: [{ id: "n1", type: "send_text", config: { text: "Hola" } }],
      edges: [],
    };
    expect(validateWorkflowDefinition(ok, ctx)).toEqual([]);

    // click_to_chat "seleccionados" vacío.
    const ctwa: WorkflowDefinition = { ...ok, trigger: { type: "click_to_chat", config: { mode: "selected", adIds: [], campaignIds: [] } } };
    expect(validateWorkflowDefinition(ctwa, ctx).some((i) => i.code === "ctwa_empty")).toBe(true);

    // hoursBefore <= 0.
    const hb: WorkflowDefinition = { ...ok, trigger: { type: "appointment_upcoming", config: { hoursBefore: 0 } } };
    expect(validateWorkflowDefinition(hb, ctx).some((i) => i.code === "hours_invalid")).toBe(true);

    // lead_status_changed origen == destino.
    const same: WorkflowDefinition = { ...ok, trigger: { type: "lead_status_changed", config: { fromStatus: "nuevo", toStatus: "nuevo" } } };
    expect(validateWorkflowDefinition(same, ctx).some((i) => i.code === "status_same")).toBe(true);

    // tag_added con etiqueta inexistente.
    const tag: WorkflowDefinition = { ...ok, trigger: { type: "tag_added", config: { tag: "no-existe" } } };
    expect(validateWorkflowDefinition(tag, ctx).some((i) => i.code === "tag_missing")).toBe(true);

    // Nodo sin conectar + mensaje vacío.
    const orphan: WorkflowDefinition = {
      trigger: { type: "conversation_started", config: {} },
      variables: {},
      nodes: [
        { id: "n1", type: "send_text", config: { text: "Hola" } },
        { id: "n2", type: "send_text", config: { text: "" } },
      ],
      edges: [],
    };
    const issues = validateWorkflowDefinition(orphan, ctx);
    expect(issues.some((i) => i.target === "n2" && i.code === "unconnected")).toBe(true);
    expect(issues.some((i) => i.target === "n2" && i.code === "text_required")).toBe(true);
  });

  it("reporta endReason: rama sin conectar («end» + nodeId + branch) vs «Terminar» («stop»)", async () => {
    // Condición cuya rama tomada (false) no tiene arista → end + branch "false".
    const dead: WorkflowDefinition = {
      trigger: { type: "conversation_started", config: {} }, variables: {},
      nodes: [{ id: "c", type: "condition", config: { kind: "no_reply" } }],
      edges: [{ from: "c", to: "c", when: "true" }],
    };
    const r1 = await executeFrom(makeDeps({ evaluateCondition: async () => false }).deps, ctx, dead, "c");
    expect(r1).toMatchObject({ status: "completed", endReason: "end", nodeId: "c", branch: "false" });

    const stopFlow: WorkflowDefinition = {
      trigger: { type: "conversation_started", config: {} }, variables: {},
      nodes: [{ id: "s", type: "stop", config: {} }],
      edges: [],
    };
    const r2 = await executeFrom(makeDeps().deps, ctx, stopFlow, "s");
    expect(r2).toMatchObject({ status: "completed", endReason: "stop", nodeId: "s" });
  });

  it("detecta la rama «Respondió» muerta tras un «Esperar (cancela si responde)»", () => {
    const trap: WorkflowDefinition = {
      trigger: { type: "conversation_started", config: {} },
      variables: {},
      nodes: [
        { id: "w", type: "wait", config: { minutes: 5, cancelOn: "contact_reply" } },
        { id: "c", type: "condition", config: { kind: "no_reply" } },
        { id: "nudge", type: "send_text", config: { text: "¿Sigues ahí?" } },
        { id: "agent", type: "run_agent", config: { agentSlug: "ventas" } },
      ],
      // rama true (sin respuesta) → nudge; rama false (respondió) → agente = MUERTA
      edges: [
        { from: "w", to: "c" },
        { from: "c", to: "nudge", when: "true" },
        { from: "c", to: "agent", when: "false" },
      ],
    };
    const issues = validateWorkflowDefinition(trap, { ...ctx, agentSlugs: ["ventas"] });
    expect(issues.some((i) => i.target === "c" && i.code === "unreachable_replied_branch")).toBe(true);

    // Sin la rama «Respondió» cableada (patrón de recordatorio) NO se marca.
    const ok: WorkflowDefinition = { ...trap, edges: [{ from: "w", to: "c" }, { from: "c", to: "nudge", when: "true" }], nodes: trap.nodes.filter((n) => n.id !== "agent") };
    expect(validateWorkflowDefinition(ok, ctx).some((i) => i.code === "unreachable_replied_branch")).toBe(false);

    // Caso del usuario: «Enviar mensaje» → «¿Sigue sin responder?» → rama «Respondió».
    // La condición es instantánea (0s tras el mensaje) → «Respondió» está muerta.
    const afterSend: WorkflowDefinition = {
      trigger: { type: "conversation_started", config: {} }, variables: {},
      nodes: [
        { id: "m", type: "send_text", config: { text: "Hola" } },
        { id: "c", type: "condition", config: { kind: "no_reply" } },
        { id: "agent", type: "run_agent", config: { agentSlug: "ventas" } },
      ],
      edges: [{ from: "m", to: "c" }, { from: "c", to: "agent", when: "false" }],
    };
    expect(validateWorkflowDefinition(afterSend, { ...ctx, agentSlugs: ["ventas"] }).some((i) => i.code === "unreachable_replied_branch")).toBe(true);

    // Patrón VÁLIDO: «Esperar (sin cancelar)» → condición → «Respondió» sí puede correr.
    const valid: WorkflowDefinition = {
      trigger: { type: "conversation_started", config: {} }, variables: {},
      nodes: [
        { id: "w", type: "wait", config: { minutes: 5 } },
        { id: "c", type: "condition", config: { kind: "no_reply" } },
        { id: "agent", type: "run_agent", config: { agentSlug: "ventas" } },
      ],
      edges: [{ from: "w", to: "c" }, { from: "c", to: "agent", when: "false" }],
    };
    expect(validateWorkflowDefinition(valid, { ...ctx, agentSlugs: ["ventas"] }).some((i) => i.code === "unreachable_replied_branch")).toBe(false);
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
    expect(result).toMatchObject({ status: "completed" });
    expect(calls).toEqual(["send:Hola Javier"]);
  });

  it("toma la rama false y termina si no hay arista", async () => {
    const { deps, calls } = makeDeps({ evaluateCondition: async () => false });
    const result = await resumeAfterWait(deps, ctx, def, "n3");
    expect(result).toMatchObject({ status: "completed" });
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
    expect(result).toMatchObject({ status: "completed" });
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
    expect(r).toMatchObject({ status: "completed" });
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
    expect(r).toMatchObject({ status: "completed" });
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

  it("send_capi encola el evento y el flujo continúa (no bloquea)", async () => {
    const { deps, calls } = makeDeps();
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} },
      variables: {},
      nodes: [
        { id: "a", type: "send_capi", config: { eventName: "Schedule", value: 50000, currency: "CLP" } },
        { id: "b", type: "add_tag", config: { tag: "capi-ok" } },
        { id: "c", type: "stop", config: {} },
      ],
      edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
    };
    const r = await executeFrom(deps, ctx, flow, "a");
    expect(r).toMatchObject({ status: "completed" });
    expect(calls).toEqual(["capi:Schedule", "tag:capi-ok"]);
  });

  it("ai_objective ramifica según el resultado (cumplido / no cumplido)", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} },
      variables: {},
      nodes: [
        { id: "a", type: "ai_objective", config: { agentSlug: "agendamiento", objective: "confirmar" } },
        { id: "ok", type: "add_tag", config: { tag: "confirmado" } },
        { id: "no", type: "transfer_human", config: {} },
      ],
      edges: [{ from: "a", to: "ok", when: "met" }, { from: "a", to: "no", when: "unmet" }],
    };
    const met = makeDeps();
    expect(await executeFrom(met.deps, ctx, flow, "a")).toMatchObject({ status: "completed" });
    expect(met.calls).toEqual(["objective:confirmar", "tag:confirmado"]);

    const unmet = makeDeps({ runAgentWithObjective: async () => "unmet" });
    await executeFrom(unmet.deps, ctx, flow, "a");
    expect(unmet.calls).toContain("human");
  });

  it("ai_objective multi-turno: pending deja el run esperando con timeout; el resume con rama continúa", async () => {
    const flow: WorkflowDefinition = {
      trigger: { type: "manual", config: {} },
      variables: {},
      nodes: [
        { id: "a", type: "ai_objective", config: { agentSlug: "agendamiento", objective: "confirmar", maxTurns: 3, timeoutHours: 12 } },
        { id: "ok", type: "add_tag", config: { tag: "confirmado" } },
        { id: "no", type: "transfer_human", config: {} },
      ],
      edges: [{ from: "a", to: "ok", when: "met" }, { from: "a", to: "no", when: "unmet" }],
    };
    const pending = makeDeps({ runAgentWithObjective: async () => "pending" });
    expect(await executeFrom(pending.deps, ctx, flow, "a")).toEqual({ status: "waiting", nodeId: "a" });
    // timeoutHours=12 desde now() (2026-01-01T12:00Z) → timer a medianoche
    expect(pending.calls).toContain("timer:a");

    // Reanudación con rama explícita (respuesta del contacto la resolvió)
    const resumed = makeDeps();
    expect(await resumeWithBranch(resumed.deps, ctx, flow, "a", "met")).toMatchObject({ status: "completed" });
    expect(resumed.calls).toEqual(["tag:confirmado"]);
    const timedOut = makeDeps();
    await resumeWithBranch(timedOut.deps, ctx, flow, "a", "unmet");
    expect(timedOut.calls).toContain("human");
  });
});
