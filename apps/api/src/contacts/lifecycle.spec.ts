import { describe, expect, it } from "vitest";
import { slugifyStageCode } from "./lifecycle.controller";

/** El code es la clave estable que consumen workflows, reglas CAPI y bandejas. */
describe("slugifyStageCode", () => {
  it("genera codes estables desde nombres en español", () => {
    expect(slugifyStageCode("Presupuesto enviado")).toBe("presupuesto_enviado");
    expect(slugifyStageCode("Reserva")).toBe("reserva");
    expect(slugifyStageCode("Evaluación / 2ª visita")).toBe("evaluacion_2_visita");
  });

  it("normaliza tildes y eñes sin perder información", () => {
    expect(slugifyStageCode("Atención año nuevo")).toBe("atencion_ano_nuevo");
  });

  it("vacío o solo símbolos → string vacío (la API lo rechaza)", () => {
    expect(slugifyStageCode("!!!")).toBe("");
  });
});
