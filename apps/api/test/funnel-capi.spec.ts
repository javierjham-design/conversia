import { describe, it, expect } from "vitest";
import { CAPI_FUNNEL_PROVIDER, HITOS_CAPI, decidirSenalCapi } from "@conversia/types";

/**
 * COP 4 — las señales del embudo hacia Meta Ads.
 *
 * Esto no es un detalle de marketing: mandarle eventos a Meta es IRREVERSIBLE —entrenan el
 * modelo del conjunto de anuncios— y una señal mal mandada ensucia la cuenta publicitaria
 * de forma que no se limpia. Por eso la decisión está separada del efecto y tiene tests: el
 * candado tiene que ser comprobable, no una buena intención.
 */
const base = { habilitado: true, brand: "conversia", hito: "registro" as const, yaEnviado: false };

describe("el candado principal es la bandera", () => {
  it("apagada no manda NADA, ni siquiera un hito válido", () => {
    expect(decidirSenalCapi({ ...base, habilitado: false })).toEqual({ enviar: false, motivo: "apagado" });
  });

  it("la bandera gana sobre todo lo demás", () => {
    const r = decidirSenalCapi({ ...base, habilitado: false, hito: "plan_activado", valorClp: 18_990 });
    expect(r.enviar).toBe(false);
    expect(r.motivo).toBe("apagado");
  });
});

describe("solo la marca con campaña", () => {
  it("conversia sí", () => {
    expect(decidirSenalCapi(base).enviar).toBe(true);
  });

  it("TuBot NO: no tiene campaña y sus datos no deben entrenar la de Conversia", () => {
    expect(decidirSenalCapi({ ...base, brand: "tubot" })).toEqual({ enviar: false, motivo: "otra_marca" });
  });

  it("una marca desconocida tampoco", () => {
    expect(decidirSenalCapi({ ...base, brand: "" }).enviar).toBe(false);
  });
});

describe("un hito no se informa dos veces", () => {
  it("ya enviado → no se repite", () => {
    expect(decidirSenalCapi({ ...base, yaEnviado: true })).toEqual({ enviar: false, motivo: "ya_enviado" });
  });

  it("vale para el Purchase, que es el que más duele duplicar", () => {
    // Un valor contado dos veces le enseña a Meta que ese público paga el doble.
    const r = decidirSenalCapi({ ...base, hito: "plan_activado", valorClp: 18_990, yaEnviado: true });
    expect(r.motivo).toBe("ya_enviado");
  });
});

describe("Purchase sin valor no se manda", () => {
  it("sin valor", () => {
    expect(decidirSenalCapi({ ...base, hito: "plan_activado" })).toEqual({ enviar: false, motivo: "sin_valor" });
  });

  it("con valor 0 tampoco: le enseñaría a Meta que ese público no vale nada", () => {
    expect(decidirSenalCapi({ ...base, hito: "plan_activado", valorClp: 0 }).motivo).toBe("sin_valor");
  });

  it("con valor negativo tampoco", () => {
    expect(decidirSenalCapi({ ...base, hito: "plan_activado", valorClp: -1 }).motivo).toBe("sin_valor");
  });

  it("con valor real sí", () => {
    expect(decidirSenalCapi({ ...base, hito: "plan_activado", valorClp: 18_990 }).enviar).toBe(true);
  });

  it("los hitos SIN valor no lo exigen", () => {
    expect(decidirSenalCapi({ ...base, hito: "registro" }).enviar).toBe(true);
    expect(decidirSenalCapi({ ...base, hito: "bot_activo" }).enviar).toBe(true);
  });
});

describe("el catálogo de hitos", () => {
  it("cubre los tres momentos del embudo que pide la etapa", () => {
    expect(Object.keys(HITOS_CAPI).sort()).toEqual(["bot_activo", "plan_activado", "registro"]);
  });

  it("usa los nombres estándar de Meta donde existen", () => {
    expect(HITOS_CAPI.registro.evento).toBe("CompleteRegistration");
    expect(HITOS_CAPI.plan_activado.evento).toBe("Purchase");
  });

  it("SOLO el Purchase lleva valor", () => {
    expect(HITOS_CAPI.plan_activado.conValor).toBe(true);
    expect(HITOS_CAPI.registro.conValor).toBe(false);
    expect(HITOS_CAPI.bot_activo.conValor).toBe(false);
  });

  it("el sello de idempotencia tiene un proveedor propio (no se mezcla con los eventos de funnel)", () => {
    expect(CAPI_FUNNEL_PROVIDER).toBe("capi_funnel");
    expect(CAPI_FUNNEL_PROVIDER).not.toBe("funnel");
  });
});
