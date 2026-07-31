import { describe, expect, it } from "vitest";
import { renderTemplateBody } from "./template-params";

const components = [
  { type: "HEADER", format: "TEXT", text: "Recordatorio" },
  { type: "BODY", text: "Hola {{1}}, tu cita es el {{2}} a las {{3}}." },
  { type: "FOOTER", text: "Clínica" },
];

describe("renderTemplateBody", () => {
  it("reemplaza las variables {{n}} por los parámetros en orden", () => {
    expect(renderTemplateBody(components, ["María", "martes 5", "15:30"])).toBe(
      "Hola María, tu cita es el martes 5 a las 15:30.",
    );
  });

  it("deja el placeholder si falta un parámetro (no inventa)", () => {
    expect(renderTemplateBody(components, ["María"])).toBe("Hola María, tu cita es el {{2}} a las {{3}}.");
  });

  it("plantilla sin BODY o sin variables no rompe", () => {
    expect(renderTemplateBody([], ["x"])).toBe("");
    expect(renderTemplateBody([{ type: "BODY", text: "Sin variables" }], [])).toBe("Sin variables");
  });
});
