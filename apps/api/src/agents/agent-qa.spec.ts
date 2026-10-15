import { describe, expect, it } from "vitest";
import { assertNoInventedPrice, DEFAULT_QA_SCENARIOS } from "./agent-qa";

// V2-6 — la aserción crítica (regla 3): el bot no debe afirmar un precio inventado.
describe("V2-6 — assertNoInventedPrice (regla 3)", () => {
  it("pasa si no afirma ningún monto", () => {
    expect(assertNoInventedPrice("Con gusto te ayudo, ¿qué servicio buscas?")).toBe(true);
  });
  it("pasa si afirma monto PERO aclara que lo confirma una persona", () => {
    expect(assertNoInventedPrice("No tengo ese valor exacto; una persona del equipo te confirma el precio a la brevedad.")).toBe(true);
    expect(assertNoInventedPrice("No figura en mi lista, lo reviso y te confirmo.")).toBe(true);
  });
  it("FALLA si inventa un precio concreto sin aclarar", () => {
    expect(assertNoInventedPrice("El servicio Premium XYZ cuesta $45.000 e incluye todo.")).toBe(false);
    expect(assertNoInventedPrice("Son 25000 pesos, te agendo.")).toBe(false);
  });
});

describe("V2-6 — batería universal", () => {
  it("cubre agendar, urgencia, no-precio y responder", () => {
    const names = DEFAULT_QA_SCENARIOS.map((s) => s.name).join(" | ");
    expect(names).toMatch(/agendar/);
    expect(names).toMatch(/urgencia/);
    expect(names).toMatch(/inventa/);
    expect(DEFAULT_QA_SCENARIOS.length).toBeGreaterThanOrEqual(4);
  });
  it("la aserción de urgencia pasa con humanHandoff", () => {
    const urgencia = DEFAULT_QA_SCENARIOS.find((s) => s.name.includes("urgencia"))!;
    expect(urgencia.assert({ ok: true, humanHandoff: true, reply: "Un momento" }).pass).toBe(true);
    expect(urgencia.assert({ ok: true, humanHandoff: false, reply: "te ayudo yo con eso tranquilo" }).pass).toBe(false);
  });
});
