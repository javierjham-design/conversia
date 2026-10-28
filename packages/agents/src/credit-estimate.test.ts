import { describe, it, expect } from "vitest";
import {
  CREDITOS_POR_CONVERSACION_POR_DEFECTO,
  MIN_CONVERSACIONES_PARA_PROMEDIO_PROPIO,
  estimarAlcance,
  explicarBase,
  frasePorSaldo,
  promedioPorConversacion,
} from "./credit-estimate";

/**
 * CRE 3 — el estimador. "Te quedan 1.240 créditos" no le dice nada a nadie; "≈ 140
 * conversaciones ≈ 18 días" sí. Lo que se prueba acá es que no mienta: que no use una
 * muestra ridícula como si fuera representativa y que se quede CORTO antes que largo.
 */
describe("promedio por conversación", () => {
  it("es créditos entre conversaciones", () => {
    expect(promedioPorConversacion({ conversaciones: 100, creditos: 900, dias: 30 })).toBe(9);
  });

  it("sin datos devuelve null en vez de 0 (0 significaría 'gratis')", () => {
    expect(promedioPorConversacion({ conversaciones: 0, creditos: 0, dias: 30 })).toBeNull();
    expect(promedioPorConversacion({ conversaciones: 10, creditos: 0, dias: 30 })).toBeNull();
  });
});

describe("de dónde sale el promedio", () => {
  it("con muestra propia suficiente, usa SU consumo", () => {
    const e = estimarAlcance({ restantes: 1000, propio: { conversaciones: 50, creditos: 500, dias: 30 } });
    expect(e.base).toBe("org");
    expect(e.creditosPorConversacion).toBe(10);
    expect(e.conversaciones).toBe(100);
  });

  it("con muestra chica NO usa su promedio: una conversación cara daría un número absurdo", () => {
    // 3 conversaciones, una con un modelo caro: 200 créditos cada una de promedio.
    const e = estimarAlcance({ restantes: 1000, propio: { conversaciones: 3, creditos: 600, dias: 5 }, promedioDelRubro: 8 });
    expect(e.base).toBe("rubro");
    expect(e.conversaciones).toBe(125); // con el rubro: 1000/8, no 1000/200 = 5
  });

  it("el mínimo de muestra es el límite exacto", () => {
    const justo = estimarAlcance({ restantes: 100, propio: { conversaciones: MIN_CONVERSACIONES_PARA_PROMEDIO_PROPIO, creditos: 200, dias: 30 }, promedioDelRubro: 5 });
    const uno_menos = estimarAlcance({ restantes: 100, propio: { conversaciones: MIN_CONVERSACIONES_PARA_PROMEDIO_PROPIO - 1, creditos: 200, dias: 30 }, promedioDelRubro: 5 });
    expect(justo.base).toBe("org");
    expect(uno_menos.base).toBe("rubro");
  });

  it("sin dato del rubro cae en el promedio general", () => {
    const e = estimarAlcance({ restantes: 900, propio: { conversaciones: 0, creditos: 0, dias: 0 } });
    expect(e.base).toBe("defecto");
    expect(e.creditosPorConversacion).toBe(CREDITOS_POR_CONVERSACION_POR_DEFECTO);
  });

  it("un rubro con promedio 0 o negativo no se usa", () => {
    expect(estimarAlcance({ restantes: 100, propio: { conversaciones: 1, creditos: 1, dias: 1 }, promedioDelRubro: 0 }).base).toBe("defecto");
    expect(estimarAlcance({ restantes: 100, propio: { conversaciones: 1, creditos: 1, dias: 1 }, promedioDelRubro: -3 }).base).toBe("defecto");
  });
});

describe("la estimación se queda CORTA, nunca larga", () => {
  it("redondea las conversaciones hacia abajo", () => {
    // 1000 / 7 = 142,8 → 142, no 143.
    const e = estimarAlcance({ restantes: 1000, propio: { conversaciones: 70, creditos: 490, dias: 30 } });
    expect(e.conversaciones).toBe(142);
  });

  it("redondea los días hacia abajo", () => {
    // 300 créditos a 29 por día = 10,3 días → 10.
    const e = estimarAlcance({ restantes: 300, propio: { conversaciones: 100, creditos: 870, dias: 30 } });
    expect(e.dias).toBe(10);
  });

  it("sin saldo no promete nada", () => {
    const e = estimarAlcance({ restantes: 0, propio: { conversaciones: 100, creditos: 900, dias: 30 } });
    expect(e.conversaciones).toBe(0);
    expect(e.dias).toBe(0);
    expect(frasePorSaldo(e)).toBe("Sin créditos disponibles");
  });

  it("un saldo negativo (gracia consumida) se trata como cero", () => {
    expect(estimarAlcance({ restantes: -50, propio: { conversaciones: 100, creditos: 900, dias: 30 } }).restantes).toBe(0);
  });
});

describe("los días salen del ritmo PROPIO, no del rubro", () => {
  it("sin consumo propio no hay días: el rubro dice cuánto cuesta, no cuántas tiene este negocio", () => {
    const e = estimarAlcance({ restantes: 1000, propio: { conversaciones: 0, creditos: 0, dias: 30 }, promedioDelRubro: 8 });
    expect(e.conversaciones).toBe(125);
    expect(e.dias).toBeNull();
  });

  it("con consumo propio pero muestra chica, sí hay días aunque el promedio venga del rubro", () => {
    const e = estimarAlcance({ restantes: 300, propio: { conversaciones: 5, creditos: 150, dias: 30 }, promedioDelRubro: 10 });
    expect(e.base).toBe("rubro");
    expect(e.dias).toBe(60); // 300 / (150/30) = 60
  });

  it("un período de 0 días no divide por cero", () => {
    expect(estimarAlcance({ restantes: 100, propio: { conversaciones: 30, creditos: 300, dias: 0 } }).dias).toBeNull();
  });
});

describe("la frase del medidor", () => {
  it("dice créditos, conversaciones y días", () => {
    const e = estimarAlcance({ restantes: 1240, propio: { conversaciones: 100, creditos: 886, dias: 30 } });
    const f = frasePorSaldo(e);
    expect(f).toContain("1.240 créditos");
    expect(f).toContain("conversaciones");
    expect(f).toContain("días a tu ritmo");
  });

  it("omite los días si no hay ritmo medible (no inventa 'hoy se acaba')", () => {
    const e = estimarAlcance({ restantes: 500, propio: { conversaciones: 0, creditos: 0, dias: 0 }, promedioDelRubro: 10 });
    expect(frasePorSaldo(e)).not.toContain("días");
    expect(frasePorSaldo(e)).toContain("≈ 50 conversaciones");
  });

  it("usa separador de miles de es-CL (un punto, no una coma)", () => {
    const e = estimarAlcance({ restantes: 16000, propio: { conversaciones: 100, creditos: 800, dias: 30 } });
    expect(frasePorSaldo(e)).toContain("16.000 créditos");
  });
});

describe("explicar de dónde sale el número", () => {
  it("con datos propios lo dice y cuántas conversaciones usó", () => {
    const e = estimarAlcance({ restantes: 1000, propio: { conversaciones: 48, creditos: 480, dias: 30 } });
    expect(explicarBase(e)).toMatch(/tus últimas 48 conversaciones/);
  });

  it("con el rubro explica que es un promedio y cuándo pasará al propio", () => {
    const e = estimarAlcance({ restantes: 1000, propio: { conversaciones: 2, creditos: 20, dias: 3 }, promedioDelRubro: 8 });
    expect(explicarBase(e)).toMatch(/negocios como el tuyo/);
    expect(explicarBase(e)).toContain(String(MIN_CONVERSACIONES_PARA_PROMEDIO_PROPIO));
  });

  it("sin historial lo dice sin pretender precisión", () => {
    const e = estimarAlcance({ restantes: 200, propio: { conversaciones: 0, creditos: 0, dias: 0 } });
    expect(explicarBase(e)).toMatch(/todavía no hay historial/);
  });
});
