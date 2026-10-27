import { describe, expect, it } from "vitest";
import { classifyQaFailure, explainQaResults, qaHeadline } from "./qa-report";
import { DEFAULT_QA_SCENARIOS } from "./agent-qa";

/**
 * ETAPA 0 — el dueño del negocio no es técnico: cada escenario de la batería tiene que salir
 * traducido a "qué pasó" y "qué toco para arreglarlo". Si alguien agrega un escenario a la
 * batería universal, este test avisa si no está traducido (cae en "tecnico").
 */
describe("qa-report — traducción a lenguaje simple", () => {
  it("clasifica los motivos de la batería universal", () => {
    expect(classifyQaFailure("ofrece agendar", "no ofreció agendar")).toBe("agenda");
    expect(classifyQaFailure("deriva urgencia a humano", "no derivó la urgencia")).toBe("urgencia");
    expect(classifyQaFailure("no inventa precios (regla 3)", "inventó un precio que no está en el catálogo")).toBe("precio");
    expect(classifyQaFailure("responde (una respuesta por turno)", "no respondió")).toBe("silencio");
  });

  it("un fallo del probador o del proveedor es técnico, no culpa de las instrucciones", () => {
    expect(classifyQaFailure("ofrece agendar", "error del probador")).toBe("tecnico");
    expect(classifyQaFailure("responde (una respuesta por turno)", "Error: 429 Too Many Requests")).toBe("tecnico");
  });

  it("TODO escenario de la batería universal tiene traducción propia (ninguno cae en 'tecnico')", () => {
    for (const s of DEFAULT_QA_SCENARIOS) {
      expect(classifyQaFailure(s.name, undefined), s.name).not.toBe("tecnico");
    }
  });

  it("explica cada fallo con qué significa y cómo arreglarlo, sin repetir el mismo consejo", () => {
    const problemas = explainQaResults([
      { name: "ofrece agendar", pass: false, reason: "no ofreció agendar" },
      { name: "pide hora para control", pass: false, reason: "no ofreció agendar" },
      { name: "deriva urgencia a humano", pass: false, reason: "no derivó la urgencia" },
      { name: "responde (una respuesta por turno)", pass: true },
    ]);
    expect(problemas).toHaveLength(2); // el consejo de agenda no se repite
    expect(problemas[0]).toMatchObject({ kind: "agenda", escenario: "ofrece agendar" });
    expect(problemas[1].titulo).toBe("No avisó a una persona ante una urgencia");
    for (const p of problemas) {
      expect(p.queSignifica.length).toBeGreaterThan(30);
      expect(p.comoArreglarlo.length).toBeGreaterThan(30);
    }
  });

  it("titular: cuenta los problemas en singular/plural y celebra cuando publica", () => {
    expect(qaHeadline({ passed: false, published: false, corrected: false }, 1)).toMatch(/1 cosa por corregir/);
    expect(qaHeadline({ passed: false, published: false, corrected: false }, 3)).toMatch(/3 cosas por corregir/);
    expect(qaHeadline({ passed: true, published: true, corrected: false }, 0)).toMatch(/ya está publicado/);
    expect(qaHeadline({ passed: true, published: true, corrected: true }, 0)).toMatch(/Afinamos/);
    expect(qaHeadline({ passed: true, published: false, corrected: false }, 0)).toMatch(/ya estaba publicado/);
  });
});
