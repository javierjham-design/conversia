import { describe, expect, it } from "vitest";
import { WORKFLOW_TEMPLATES, templatesByIndustry } from "./workflow-templates";

// Disparadores y pasos válidos del motor v0 (deben coincidir con el catálogo).
const TRIGGERS = new Set([
  "conversation_started", "conversation_closed", "message_received", "keyword", "click_to_chat",
  "lead_status_changed", "tag_added", "appointment_created", "appointment_confirmed",
  "appointment_rescheduled", "appointment_cancelled", "appointment_upcoming", "no_show", "manual",
]);
const STEPS = new Set([
  "send_text", "send_template", "update_lead_status", "add_tag", "remove_tag", "update_contact",
  "open_conversation", "add_note", "assign_user", "assign_team", "transfer_human", "pause_ai",
  "resume_ai", "close_conversation", "wait", "wait_reply", "condition", "business_hours", "goto",
  "start_workflow", "stop", "send_capi", "send_ga4_event", "run_agent", "switch_agent", "ai_objective",
  "call_api", "send_internal_email", "google_sheets_append",
]);

describe("Galería de plantillas de flujos", () => {
  it("hay plantillas y claves únicas", () => {
    expect(WORKFLOW_TEMPLATES.length).toBeGreaterThan(0);
    const keys = WORKFLOW_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  for (const t of WORKFLOW_TEMPLATES) {
    describe(`plantilla «${t.key}»`, () => {
      it("metadatos completos", () => {
        expect(t.name.length).toBeGreaterThan(2);
        expect(t.description.length).toBeGreaterThan(5);
        expect(t.industry.length).toBeGreaterThan(0);
        expect(t.icon.length).toBeGreaterThan(0);
      });
      it("disparador y pasos soportados por el motor", () => {
        expect(TRIGGERS.has(t.definition.trigger.type)).toBe(true);
        for (const n of t.definition.nodes) expect(STEPS.has(n.type)).toBe(true);
      });
      it("ids de nodo únicos y aristas bien referenciadas", () => {
        const ids = t.definition.nodes.map((n) => n.id);
        expect(new Set(ids).size).toBe(ids.length);
        const set = new Set(ids);
        for (const e of t.definition.edges) {
          expect(set.has(e.from)).toBe(true);
          expect(set.has(e.to)).toBe(true);
        }
      });
      it("tiene exactamente un nodo de inicio (sin aristas entrantes)", () => {
        const withIncoming = new Set(t.definition.edges.map((e) => e.to));
        const starts = t.definition.nodes.filter((n) => !withIncoming.has(n.id));
        expect(starts.length).toBe(1);
      });
    });
  }

  it("agrupa por rubro con Dental primero", () => {
    const groups = templatesByIndustry();
    expect(groups[0].industry).toBe("Dental");
    expect(groups.flatMap((g) => g.items).length).toBe(WORKFLOW_TEMPLATES.length);
  });
});
