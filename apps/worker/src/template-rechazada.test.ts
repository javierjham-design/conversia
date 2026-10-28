import { describe, expect, it } from "vitest";
import { plantillasRechazadas } from "./template-sync";

/**
 * V2-8 — detección de plantillas RECHAZADAS por Meta.
 *
 * Una plantilla rechazada no es un detalle de catálogo: es un recordatorio de cita o una
 * difusión que NO va a salir, y el cliente no se entera. El flujo busca la plantilla
 * APROBADA, no la encuentra y omite el envío en silencio. Por eso el sync levanta una
 * excepción en la consola de operación, y por eso lo que se prueba acá son los bordes del
 * payload de Meta: lo que NO es un rechazo no puede generar ruido, y un rechazo sin motivo
 * tampoco puede perderse.
 */
describe("plantillas rechazadas por Meta", () => {
  it("detecta la rechazada y conserva el motivo que dio Meta", () => {
    const r = plantillasRechazadas([
      { name: "recordatorio_cita", language: "es", status: "APPROVED" },
      { name: "recaptura_noshow", language: "es", status: "REJECTED", rejected_reason: "ABUSIVE_CONTENT" },
    ]);
    expect(r).toEqual([{ name: "recaptura_noshow", language: "es", reason: "ABUSIVE_CONTENT" }]);
  });

  it("ningún otro estado cuenta como rechazo", () => {
    const estados = ["APPROVED", "PENDING", "PAUSED", "DISABLED", "IN_APPEAL", "", undefined];
    const r = plantillasRechazadas(estados.map((status, i) => ({ name: `t${i}`, status })));
    expect(r).toEqual([]);
  });

  it("un rechazo SIN motivo informado igual se reporta (es lo que pasa seguido)", () => {
    const r = plantillasRechazadas([{ name: "promo", status: "REJECTED" }]);
    expect(r).toEqual([{ name: "promo", language: "es", reason: "sin motivo informado" }]);
  });

  it("sin nombre no se reporta: no habría nada que ir a mirar en Meta", () => {
    expect(plantillasRechazadas([{ status: "REJECTED", rejected_reason: "x" }])).toEqual([]);
    expect(plantillasRechazadas([{ name: "   ", status: "REJECTED" }])).toEqual([]);
  });

  it("varias rechazadas se reportan por separado (una excepción por plantilla)", () => {
    const r = plantillasRechazadas([
      { name: "a", language: "es", status: "REJECTED", rejected_reason: "INVALID_FORMAT" },
      { name: "a", language: "en", status: "REJECTED", rejected_reason: "INVALID_FORMAT" },
    ]);
    // La misma plantilla en dos idiomas son dos revisiones distintas en Meta.
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.language)).toEqual(["es", "en"]);
  });

  it("una lista vacía o basura no revienta", () => {
    expect(plantillasRechazadas([])).toEqual([]);
    expect(plantillasRechazadas([null, undefined, 0, "x"] as unknown[])).toEqual([]);
  });
});
