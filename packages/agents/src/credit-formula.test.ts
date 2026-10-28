import { describe, expect, it } from "vitest";
import { CREDIT_POLICY_SEED, creditsForTurn, parseCreditPolicy, weightOfModel } from "./credit-formula";
import { MODEL_PRICING } from "./pricing";

/**
 * CRE 1 — la fórmula es lo que le cobra al cliente, así que acá se prueban los BORDES,
 * no el camino feliz: dónde empieza a cobrar un segundo bloque, qué pasa con un modelo
 * que nadie dio de alta, y qué pasa con un turno que no llamó a la IA.
 */

const CLP_PER_USD = 950; // tipo de cambio de referencia del §7

describe("§4 — fórmula: peso × máx(1, techo(tokens / 20.000))", () => {
  it("una respuesta normal cuesta 1 crédito con el modelo estándar", () => {
    const r = creditsForTurn({ model: "gpt-4o-mini", tokens: 9_600 });
    expect(r.credits).toBe(1);
    expect(r.blocks).toBe(1);
    expect(r.level).toBe("standard");
  });

  it("el bloque EXACTO sigue siendo 1 crédito; un token más ya son 2", () => {
    expect(creditsForTurn({ model: "gpt-4o-mini", tokens: 20_000 }).credits).toBe(1);
    expect(creditsForTurn({ model: "gpt-4o-mini", tokens: 20_001 }).credits).toBe(2);
  });

  it("un solo token ya cuesta el piso de una respuesta (1 bloque)", () => {
    expect(creditsForTurn({ model: "gpt-4o-mini", tokens: 1 }).credits).toBe(1);
  });

  it("CERO tokens = CERO créditos: un turno que no llamó al modelo no se cobra", () => {
    // Importa de verdad: con el proveedor caído el worker persiste el turno con
    // usage 0. Cobrar acá sería cobrarle al cliente nuestras caídas.
    for (const tokens of [0, -5, Number.NaN]) {
      const r = creditsForTurn({ model: "gpt-4o-mini", tokens });
      expect(r.credits).toBe(0);
      expect(r.blocks).toBe(0);
    }
  });

  it("el peso del modelo multiplica TODOS los bloques, no solo el primero", () => {
    // claude-haiku (peso 4) con 2 bloques de tokens = 8 créditos.
    const r = creditsForTurn({ model: "claude-haiku-4-5", tokens: 25_000 });
    expect(r.blocks).toBe(2);
    expect(r.weight).toBe(4);
    expect(r.credits).toBe(8);
  });

  it("los pesos del §4 son exactamente los que aprobó el dueño", () => {
    const esperado: Array<[string, number]> = [
      ["gpt-4o-mini", 1],
      ["claude-haiku-4-5", 4],
      ["gpt-4o", 12],
      ["claude-sonnet-4-6", 20],
      ["claude-opus-4-8", 50],
    ];
    for (const [model, credits] of esperado) {
      expect(creditsForTurn({ model, tokens: 1_000 }).credits).toBe(credits);
    }
  });

  it("una conversación tipo (3 respuestas cortas) ronda los 4,2 créditos del §5", () => {
    // El supuesto de los precios: ~4,2 créditos por conversación. Si la fórmula se
    // tocara y esto se disparara, los márgenes del catálogo dejarían de valer.
    const turnos = [9_600, 12_000, 18_000].map((t) => creditsForTurn({ model: "gpt-4o-mini", tokens: t }).credits);
    expect(turnos.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5);
  });
});

describe("§4 — modelo sin nivel: se cobra como premium y se avisa", () => {
  it("un modelo desconocido cae a premium y queda marcado para alertar", () => {
    const r = creditsForTurn({ model: "modelo-que-nadie-dio-de-alta", tokens: 1_000 });
    expect(r.level).toBe("premium");
    expect(r.credits).toBe(CREDIT_POLICY_SEED.unknownModel.credits);
    expect(r.modelKnown).toBe(false);
  });

  it("un modelo conocido NO levanta alerta", () => {
    expect(creditsForTurn({ model: "gpt-4o-mini", tokens: 1_000 }).modelKnown).toBe(true);
  });

  it("nombre vacío o basura no rompe el cobro", () => {
    for (const model of ["", "   "]) {
      expect(weightOfModel(model).known).toBe(false);
    }
  });
});

describe("§4 — todo modelo que la plataforma sabe facturar tiene peso", () => {
  it("ningún modelo de MODEL_PRICING queda sin nivel", () => {
    // El agujero real: alguien agrega un modelo a pricing.ts (para medir su costo),
    // un agente lo usa, y acá cae en "desconocido". Se cobraría premium y el cliente
    // reclamaría. Si este test se cae, hay que ponerle peso al modelo nuevo.
    const sinPeso = Object.keys(MODEL_PRICING).filter((m) => !weightOfModel(m).known);
    expect(sinPeso).toEqual([]);
  });

  it("ningún modelo cuesta más de $2,5 CLP por crédito a la mezcla de tokens mediana", () => {
    // Meta del §5: ~$2,1 por crédito. El tope de $2,5 es ese objetivo más el margen
    // entre la mezcla mediana del §7 (9.600 entrada / 60 salida) y el costo medio
    // medido. Un peso mal puesto (p. ej. sonnet en 4) rompe acá, no en producción.
    const TOPE_CLP_POR_CREDITO = 2.5;
    const caros: string[] = [];
    for (const [model, w] of Object.entries(CREDIT_POLICY_SEED.models)) {
      const p = MODEL_PRICING[model];
      if (!p) continue; // modelo con peso pero sin precio: no es este test
      const costoUsd = (9_600 * p.inputPerMTok + 60 * p.outputPerMTok) / 1_000_000;
      const clpPorCredito = (costoUsd * CLP_PER_USD) / w.credits;
      if (clpPorCredito > TOPE_CLP_POR_CREDITO) caros.push(`${model}: $${clpPorCredito.toFixed(2)}`);
    }
    expect(caros).toEqual([]);
  });
});

describe("política leída de platform_settings", () => {
  it("una fila vacía deja la semilla calibrada (no deja el cobro en 0)", () => {
    const p = parseCreditPolicy({});
    expect(p.tokensPerCredit).toBe(20_000);
    expect(p.graceCredits).toBe(100);
    expect(p.models["gpt-4o-mini"].credits).toBe(1);
  });

  it("el dueño puede cambiar el bloque y la gracia sin tocar código", () => {
    const p = parseCreditPolicy({ tokensPerCredit: 10_000, graceCredits: 40 });
    expect(creditsForTurn({ model: "gpt-4o-mini", tokens: 15_000, policy: p }).credits).toBe(2);
    expect(p.graceCredits).toBe(40);
  });

  it("puede agregar un modelo nuevo con su peso, sin desplegar", () => {
    const p = parseCreditPolicy({ models: { "modelo-nuevo": { level: "plus", credits: 3 } } });
    const r = creditsForTurn({ model: "modelo-nuevo", tokens: 1_000, policy: p });
    expect(r.credits).toBe(3);
    expect(r.modelKnown).toBe(true);
    // Y no se pierden los sembrados.
    expect(creditsForTurn({ model: "gpt-4o", tokens: 1_000, policy: p }).credits).toBe(12);
  });

  it("valores corruptos (0, negativos, texto, null) caen a la semilla", () => {
    const p = parseCreditPolicy({
      tokensPerCredit: 0,
      graceCredits: -3,
      unknownModel: { level: "inventado", credits: "muchos" },
      models: { "gpt-4o-mini": { credits: 0 } },
    });
    expect(p.tokensPerCredit).toBe(20_000);
    expect(p.graceCredits).toBe(100);
    expect(p.unknownModel).toEqual({ level: "premium", credits: 50 });
    expect(p.models["gpt-4o-mini"].credits).toBe(1); // no se regala el servicio
  });

  it("un JSON que no es objeto no rompe nada", () => {
    for (const raw of [null, undefined, 42, "texto", []]) {
      expect(parseCreditPolicy(raw).tokensPerCredit).toBe(20_000);
    }
  });
});
