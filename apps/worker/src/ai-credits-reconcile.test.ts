import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CRE — reconciliación de los cobros de IA que se perdieron.
 *
 * Por qué existe: el cobro de un turno NO frena la respuesta (decisión de diseño: el bot no
 * se calla por un problema nuestro), así que un reinicio del worker o un timeout de base se
 * llevaba el cargo para siempre, sin deuda anotada y sin aviso. La prueba de carga lo midió
 * matando el worker en vuelo: 30 respuestas enviadas, 29 cobradas.
 *
 * Lo que se prueba acá es que recupere SOLO lo que corresponde y que no pueda cobrar dos
 * veces, porque un reconciliador que cobra de más es peor que la fuga que viene a tapar.
 */

const turnos: any[] = [];
const cobros: any[] = [];
const excepciones: any[] = [];
let planCobraCreditos = true;
let fallarDebito = false;
let turnoQueFalla: string | null = null;

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => ({
    $queryRaw: async () => turnos,
  }),
  raiseException: async (_db: unknown, e: any) => {
    excepciones.push(e);
  },
}));

vi.mock("./ai-credits", () => ({
  planDebitsAiCredits: async () => planCobraCreditos,
  debitAiCreditsForTurn: async (orgId: string, usage: any) => {
    if (fallarDebito || usage.turnId === turnoQueFalla) throw new Error("base caída");
    // Idempotencia real del camino de producción: el sello es el id del turno.
    if (cobros.some((c) => c.turnId === usage.turnId)) return { charged: false, reason: "ya_debitado" };
    const credits = Math.max(1, Math.ceil((usage.inputTokens + usage.outputTokens) / 20_000));
    cobros.push({ orgId, turnId: usage.turnId, credits, model: usage.model, costUsd: usage.costUsd });
    return { charged: true, credits, balanceAfter: 0, inGrace: false, graceUsed: 0, detail: {} };
  },
}));

import { cobrarTurnosSinCobrar, SOSPECHOSO } from "./ai-credits-reconcile";

function turno(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    organizationId: "o1",
    conversationId: `c-${id}`,
    model: "gpt-4o-mini",
    inputTokens: 1_000,
    outputTokens: 500,
    costUsd: 0.0012,
    agentId: "a1",
    ...over,
  };
}

beforeEach(() => {
  turnos.length = 0;
  cobros.length = 0;
  excepciones.length = 0;
  planCobraCreditos = true;
  fallarDebito = false;
  turnoQueFalla = null;
});

describe("cobrar los turnos que quedaron sin asiento", () => {
  it("cobra cada respuesta huérfana con los tokens y el modelo que quedaron guardados", async () => {
    turnos.push(turno("t1"), turno("t2", { model: "claude-haiku-4-5", inputTokens: 30_000 }));
    const r = await cobrarTurnosSinCobrar();
    expect(r.encontrados).toBe(2);
    expect(r.cobrados).toBe(2);
    expect(cobros[0]).toMatchObject({ turnId: "t1", model: "gpt-4o-mini" });
    // El precio sale del MISMO camino que el cobro en vivo, con los datos del turno: no hay
    // una segunda fórmula que pueda quedar desfasada.
    expect(cobros[1]).toMatchObject({ turnId: "t2", model: "claude-haiku-4-5" });
    expect(cobros[1].credits).toBe(2); // 30.500 tokens = 2 bloques
  });

  it("y arrastra el costo real del turno, para que el margen siga saliendo", async () => {
    turnos.push(turno("t1"));
    await cobrarTurnosSinCobrar();
    expect(cobros[0].costUsd).toBe(0.0012);
  });

  it("NO cobra dos veces: el sello del turno manda aunque el pase se repita", async () => {
    turnos.push(turno("t1"));
    await cobrarTurnosSinCobrar();
    await cobrarTurnosSinCobrar(); // el mismo turno sigue en la lista
    expect(cobros).toHaveLength(1);
  });

  it("no toca los turnos de una cuenta que NO cobra por crédito", async () => {
    // Un turno viejo de cuando la cuenta cobraba por conversación ya se cobró en la otra
    // unidad: cobrarlo acá sería cobrárselo dos veces en dos monedas distintas.
    planCobraCreditos = false;
    turnos.push(turno("t1"), turno("t2"));
    const r = await cobrarTurnosSinCobrar();
    expect(r.encontrados).toBe(0);
    expect(cobros).toHaveLength(0);
  });

  it("un turno que no se puede cobrar (sin saldo) se cuenta, no se pierde en silencio", async () => {
    fallarDebito = true;
    turnos.push(turno("t1"));
    const r = await cobrarTurnosSinCobrar();
    expect(r.cobrados).toBe(0);
    expect(r.sinCobrar).toBe(1);
  });

  it("un fallo de un turno no aborta el pase: los demás se cobran igual", async () => {
    // Si un timeout cortara el pase, bastaría una cuenta rota para que nunca se recuperen
    // los cargos de las demás — y el pase siguiente encontraría la misma cuenta primero.
    turnoQueFalla = "malo";
    turnos.push(turno("malo"), turno("bueno"));
    const r = await cobrarTurnosSinCobrar();
    expect(r.cobrados).toBe(1);
    expect(r.sinCobrar).toBe(1);
    expect(cobros.map((c) => c.turnId)).toEqual(["bueno"]);
  });

  it("muchos turnos sin cobrar levantan una excepción: un puñado es un reinicio, cientos es el cobro roto", async () => {
    for (let i = 0; i < SOSPECHOSO; i++) turnos.push(turno(`t${i}`));
    await cobrarTurnosSinCobrar();
    const e = excepciones.find((x) => x.type === "cobros_de_ia_sin_asiento");
    expect(e).toBeTruthy();
    expect(e.severity).toBe("critical");
  });

  it("pocos turnos no levantan nada (un reinicio no es una alerta)", async () => {
    turnos.push(turno("t1"), turno("t2"));
    await cobrarTurnosSinCobrar();
    expect(excepciones).toHaveLength(0);
  });

  it("sin turnos huérfanos no hace nada y no devuelve NaN", async () => {
    const r = await cobrarTurnosSinCobrar();
    expect(r).toMatchObject({ encontrados: 0, cobrados: 0, creditos: 0, sinCobrar: 0 });
  });
});
