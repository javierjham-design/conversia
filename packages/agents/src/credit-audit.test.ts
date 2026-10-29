import { describe, it, expect } from "vitest";
import { CREDIT_POLICY_SEED } from "./credit-formula";
import {
  auditarTurno,
  costoPorCreditoClp,
  margenSobreCostoPct,
  resumirAuditoria,
  verificarMonedero,
  type AuditoriaTurno,
  type EstadoMonedero,
} from "./credit-audit";

/**
 * La auditoría del contador. Lo que se prueba acá no es la fórmula —esa ya tiene sus
 * tests— sino que la auditoría NOMBRE bien cada forma de perder plata: el turno gratis, el
 * cobro doble, el libro que no explica el saldo. Varios de estos casos no se pueden
 * provocar en un stack real sin romper el código a propósito; por eso se arman a mano.
 */

const turno = (over: Partial<Parameters<typeof auditarTurno>[0]> = {}) => ({
  turnId: "t1",
  organizationId: "o1",
  model: "gpt-4o-mini",
  inputTokens: 1_000,
  outputTokens: 500,
  ...over,
});

describe("auditar un turno contra sus asientos", () => {
  it("cobrado exactamente lo que manda la fórmula → ok", () => {
    const a = auditarTurno(turno(), { deltas: [-1] }, CREDIT_POLICY_SEED);
    expect(a.veredicto).toBe("ok");
    expect(a.esperado).toBe(1);
    expect(a.cobrado).toBe(1);
    expect(a.diferencia).toBe(0);
  });

  it("respeta el peso del modelo y los bloques de tokens", () => {
    // claude-sonnet-4-6 pesa 20 y 45.000 tokens son 3 bloques → 60 créditos.
    const a = auditarTurno(
      turno({ model: "claude-sonnet-4-6", inputTokens: 40_000, outputTokens: 5_000 }),
      { deltas: [-60] },
      CREDIT_POLICY_SEED,
    );
    expect(a.esperado).toBe(60);
    expect(a.veredicto).toBe("ok");
  });

  it("un turno que respondió y no tiene asiento es un REGALO, no un ok", () => {
    const a = auditarTurno(turno(), { deltas: [] }, CREDIT_POLICY_SEED);
    expect(a.veredicto).toBe("sin_cobrar");
    expect(a.diferencia).toBe(-1);
  });

  it("un turno sin tokens y sin cobro es correcto (proveedor caído: no se cobra)", () => {
    const a = auditarTurno(turno({ inputTokens: 0, outputTokens: 0, status: "error" }), { deltas: [] }, CREDIT_POLICY_SEED);
    expect(a.veredicto).toBe("no_cobrable");
    expect(a.esperado).toBe(0);
    expect(a.diferencia).toBe(0);
  });

  it("cobrar un turno sin tokens es cobrarle al cliente una respuesta que no existió", () => {
    const a = auditarTurno(turno({ inputTokens: 0, outputTokens: 0 }), { deltas: [-1] }, CREDIT_POLICY_SEED);
    expect(a.veredicto).toBe("cobrado_de_mas");
    expect(a.diferencia).toBe(1);
  });

  it("de menos y de más se distinguen (no es lo mismo regalar que cobrar de más)", () => {
    const menos = auditarTurno(
      turno({ model: "gpt-4o", inputTokens: 10_000, outputTokens: 0 }),
      { deltas: [-5] },
      CREDIT_POLICY_SEED,
    );
    expect(menos.veredicto).toBe("cobrado_de_menos");
    expect(menos.esperado).toBe(12);
    expect(menos.diferencia).toBe(-7);

    const mas = auditarTurno(turno(), { deltas: [-9] }, CREDIT_POLICY_SEED);
    expect(mas.veredicto).toBe("cobrado_de_mas");
    expect(mas.diferencia).toBe(8);
  });

  it("dos asientos del mismo turno son DOBLE COBRO, aunque el monto parezca de más", () => {
    // Si esto dijera "cobrado_de_mas" se buscaría el error en la fórmula, y el error está
    // en la idempotencia del reintento. El veredicto tiene que apuntar al lugar correcto.
    const a = auditarTurno(turno(), { deltas: [-1, -1] }, CREDIT_POLICY_SEED);
    expect(a.veredicto).toBe("doble_cobro");
    expect(a.cobrado).toBe(2);
    expect(a.asientos).toBe(2);
  });

  it("un modelo desconocido se audita como premium (igual que se cobra)", () => {
    const a = auditarTurno(turno({ model: "modelo-que-nadie-definio" }), { deltas: [-50] }, CREDIT_POLICY_SEED);
    expect(a.esperado).toBe(50);
    expect(a.veredicto).toBe("ok");
  });

  it("tokens negativos o basura no hacen que el turno salga gratis", () => {
    const a = auditarTurno(turno({ inputTokens: -5_000, outputTokens: 1 }), { deltas: [-1] }, CREDIT_POLICY_SEED);
    expect(a.esperado).toBe(1);
    expect(a.veredicto).toBe("ok");
  });
});

describe("cuando el dueño cambia un peso (la política no es eterna)", () => {
  // El dueño ajusta pesos desde platform_settings.aiCredits SIN desplegar: para eso existe
  // esa fila. Si la auditoría recalculara todo con la política de hoy, el día después de
  // subir un peso marcaría como robo cada turno cobrado con el peso de ayer — y al revés,
  // un cobro mal hecho se podría excusar como "cambio de precios". Son dos cosas distintas
  // y la auditoría tiene que decir cuál es cuál.
  const aplicado = { weight: 50, tokensPerCredit: 20_000 };

  it("un turno cobrado con el peso de ayer cuadra, y el cambio se informa aparte", () => {
    const a = auditarTurno(turno(), { deltas: [-50], aplicado }, CREDIT_POLICY_SEED);
    expect(a.veredicto).toBe("ok");
    expect(a.esperado).toBe(50); // con el peso que se aplicó
    expect(a.esperadoVigente).toBe(1); // con el de hoy
    expect(a.pesoCambiado).toBe(true);
    expect(resumirAuditoria([a]).conPesoCambiado).toBe(1);
  });

  it("pero un cobro mal hecho NO se puede excusar con el peso aplicado", () => {
    // Dice que aplicó 50 por bloque y cobró 80: eso no lo explica ningún cambio de precios.
    const a = auditarTurno(turno(), { deltas: [-80], aplicado }, CREDIT_POLICY_SEED);
    expect(a.veredicto).toBe("cobrado_de_mas");
    expect(a.diferencia).toBe(30);
  });

  it("el bloque de tokens aplicado también manda", () => {
    // 30.000 tokens con bloques de 10.000 son 3 bloques, no 2 (los 20.000 de hoy).
    const a = auditarTurno(
      turno({ inputTokens: 30_000, outputTokens: 0 }),
      { deltas: [-3], aplicado: { weight: 1, tokensPerCredit: 10_000 } },
      CREDIT_POLICY_SEED,
    );
    expect(a.esperado).toBe(3);
    expect(a.esperadoVigente).toBe(2);
    expect(a.veredicto).toBe("ok");
  });

  it("un turno sin tokens sigue costando 0 con cualquier peso", () => {
    const a = auditarTurno(turno({ inputTokens: 0, outputTokens: 0 }), { deltas: [], aplicado }, CREDIT_POLICY_SEED);
    expect(a.veredicto).toBe("no_cobrable");
    expect(a.esperado).toBe(0);
    expect(a.pesoCambiado).toBe(false);
  });

  it("sin registro del peso aplicado se usa el vigente (es todo lo que hay)", () => {
    const a = auditarTurno(turno(), { deltas: [-1] }, CREDIT_POLICY_SEED);
    expect(a.esperado).toBe(a.esperadoVigente);
    expect(a.pesoCambiado).toBe(false);
  });

  it("un peso aplicado basura no borra el cobro: cae al vigente", () => {
    const a = auditarTurno(turno(), { deltas: [-1], aplicado: { weight: 0, tokensPerCredit: 0 } }, CREDIT_POLICY_SEED);
    expect(a.esperado).toBe(1);
    expect(a.veredicto).toBe("ok");
  });
});

describe("el cobro topeado por el colchón de gracia", () => {
  // Cuando el turno pide más de lo que queda, se cobra todo lo cobrable y la gracia
  // aterriza en el tope (si no, el gate dejaría pasar respuestas gratis para siempre). Ese
  // turno cobró MENOS de lo que pedía la fórmula, a propósito y con constancia. La
  // auditoría tiene que nombrarlo así y no como un cobro mal hecho: si cada cuenta que se
  // queda sin saldo pusiera el informe en rojo, nadie mira más los rojos de verdad.
  const topeado = { weight: 50, tokensPerCredit: 20_000, alTope: true, pedido: 50 };

  it("se cobró 4 de los 50 que pedía: es tope de gracia, no un cobro de menos", () => {
    const a = auditarTurno(turno(), { deltas: [-4], aplicado: topeado }, CREDIT_POLICY_SEED);
    expect(a.veredicto).toBe("tope_gracia");
    expect(a.esperado).toBe(50);
    expect(a.cobrado).toBe(4);
  });

  it("y los créditos que no entraron se cuentan APARTE, sin poner el informe en rojo", () => {
    const r = resumirAuditoria([auditarTurno(turno(), { deltas: [-4], aplicado: topeado }, CREDIT_POLICY_SEED)]);
    expect(r.porTope).toBe(46);
    expect(r.regalados).toBe(0); // no es un defecto
    expect(r.cuadra).toBe(true);
  });

  it("pero sin NINGÚN cobro sigue siendo servicio regalado, tope o no tope", () => {
    // El agujero original: respuesta enviada, cero asientos. Marcar esto como "tope" lo
    // taparía justo en el caso que importa.
    const a = auditarTurno(turno(), { deltas: [], aplicado: topeado }, CREDIT_POLICY_SEED);
    expect(a.veredicto).toBe("sin_cobrar");
    expect(resumirAuditoria([a]).cuadra).toBe(false);
  });

  it("y cobrar MÁS de lo que pedía no se excusa con el tope", () => {
    const a = auditarTurno(turno(), { deltas: [-80], aplicado: topeado }, CREDIT_POLICY_SEED);
    expect(a.veredicto).toBe("cobrado_de_mas");
    expect(resumirAuditoria([a]).cuadra).toBe(false);
  });

  it("un doble cobro con tope sigue siendo doble cobro", () => {
    const a = auditarTurno(turno(), { deltas: [-2, -2], aplicado: topeado }, CREDIT_POLICY_SEED);
    expect(a.veredicto).toBe("doble_cobro");
  });
});

describe("resumen de la auditoría", () => {
  const items = (vs: Array<[number, number]>): AuditoriaTurno[] =>
    vs.map(([esperado, cobrado], i) =>
      auditarTurno(
        // gpt-4o-mini pesa 1, así que `esperado` bloques = `esperado` créditos.
        turno({ turnId: `t${i}`, inputTokens: Math.max(1, (esperado - 1) * 20_000 + 1), outputTokens: 0 }),
        { deltas: cobrado > 0 ? [-cobrado] : [] },
        CREDIT_POLICY_SEED,
      ),
    );

  it("cuenta cada veredicto y suma esperado contra cobrado", () => {
    const r = resumirAuditoria(items([[1, 1], [1, 1], [2, 2]]));
    expect(r.turnos).toBe(3);
    expect(r.porVeredicto.ok).toBe(3);
    expect(r.esperado).toBe(4);
    expect(r.cobrado).toBe(4);
    expect(r.cuadra).toBe(true);
  });

  it("NO netea lo regalado contra lo cobrado de más: son dos agujeros, no uno", () => {
    // Un turno regalado (−3) y otro cobrado de más (+3). Si se netearan, el total daría
    // cero y los dos problemas desaparecerían del informe.
    const r = resumirAuditoria(items([[3, 0], [1, 4]]));
    expect(r.regalados).toBe(3);
    expect(r.deMas).toBe(3);
    expect(r.esperado).toBe(r.cobrado);
    expect(r.cuadra).toBe(false);
  });

  it("un doble cobro basta para que NO cuadre, aunque los montos sumen bien", () => {
    // 20.001 tokens son 2 bloques → 2 créditos esperados, cobrados en DOS asientos de 1.
    // Los totales cuadran al peso y aun así el reintento cobró dos veces: si el resumen
    // mirara solo los montos, este caso pasaría como sano.
    const uno = auditarTurno(turno({ inputTokens: 20_001, outputTokens: 0 }), { deltas: [-1, -1] }, CREDIT_POLICY_SEED);
    expect(uno.esperado).toBe(2);
    expect(uno.diferencia).toBe(0);
    const r = resumirAuditoria([uno]);
    expect(r.porVeredicto.doble_cobro).toBe(1);
    expect(r.regalados).toBe(0);
    expect(r.deMas).toBe(0);
    expect(r.cuadra).toBe(false);
  });

  it("sin turnos cuadra (no hay nada que cobrar), y no devuelve NaN", () => {
    const r = resumirAuditoria([]);
    expect(r.cuadra).toBe(true);
    expect(r.esperado).toBe(0);
    expect(r.cobrado).toBe(0);
  });
});

describe("invariantes del monedero", () => {
  const monedero = (over: Partial<EstadoMonedero> = {}): EstadoMonedero => ({
    organizationId: "o1",
    lotesVigentes: 180,
    lotesVencidosSinBarrer: 0,
    graciaUsada: 0,
    sumaDelLibro: 180,
    ultimoBalanceAfter: 180,
    lotesNegativos: 0,
    graciaLimite: 100,
    ...over,
  });

  it("un monedero sano cuadra en las cuatro cosas", () => {
    const v = verificarMonedero(monedero());
    expect(v.ok).toBe(true);
    expect(v.saldo).toBe(180);
    expect(v.descuadre).toBe(0);
  });

  it("si el libro no explica el saldo, lo dice y cuánto falta", () => {
    // 20 créditos salieron del saldo sin asiento que lo explique: ahí se va la plata.
    const v = verificarMonedero(monedero({ lotesVigentes: 160 }));
    expect(v.libroCuadra).toBe(false);
    expect(v.descuadre).toBe(20);
    expect(v.ok).toBe(false);
  });

  it("los lotes vencidos sin barrer NO cuentan como descuadre", () => {
    // El lote venció (ya no es saldo) pero el barrido todavía no escribió su asiento de
    // expiración. Es un estado normal entre dos corridas del barrido, no un agujero.
    const v = verificarMonedero(monedero({ lotesVigentes: 100, lotesVencidosSinBarrer: 80 }));
    expect(v.libroCuadra).toBe(true);
    expect(v.saldo).toBe(100);
  });

  it("la gracia usada descuenta del saldo", () => {
    const v = verificarMonedero(monedero({ lotesVigentes: 0, graciaUsada: 40, sumaDelLibro: -40, ultimoBalanceAfter: -40 }));
    expect(v.saldo).toBe(-40);
    expect(v.ok).toBe(true);
  });

  it("pasarse del tope de gracia es operar gratis: no pasa como ok", () => {
    const v = verificarMonedero(monedero({ lotesVigentes: 0, graciaUsada: 140, sumaDelLibro: -140, ultimoBalanceAfter: -140 }));
    expect(v.graciaDentroDelLimite).toBe(false);
    expect(v.ok).toBe(false);
  });

  it("el último asiento tiene que decir el saldo de hoy", () => {
    const v = verificarMonedero(monedero({ ultimoBalanceAfter: 200 }));
    expect(v.ultimoAsientoCuadra).toBe(false);
    expect(v.ok).toBe(false);
  });

  it("un monedero sin un solo asiento no se declara descuadrado por eso", () => {
    const v = verificarMonedero(monedero({ lotesVigentes: 0, sumaDelLibro: 0, ultimoBalanceAfter: null }));
    expect(v.ok).toBe(true);
  });

  it("un lote en negativo es un error de consumo, no un saldo", () => {
    const v = verificarMonedero(monedero({ lotesNegativos: 1 }));
    expect(v.sinLotesNegativos).toBe(false);
    expect(v.ok).toBe(false);
  });
});

describe("costo real de un crédito y margen", () => {
  it("convierte el costo USD del período a pesos por crédito", () => {
    // USD 3 a 950 = $2.850 por 1.000 créditos = $2,85 cada uno.
    expect(costoPorCreditoClp({ costoIaUsd: 3, creditos: 1_000, clpPorUsd: 950 })).toBe(2.85);
  });

  it("sin créditos no inventa un costo (división por cero)", () => {
    expect(costoPorCreditoClp({ costoIaUsd: 3, creditos: 0, clpPorUsd: 950 })).toBe(0);
  });

  it("el margen es sobre el COSTO, que es la meta del ≥300%", () => {
    // La recarga: 420 créditos a $24.990 → $59,5 por crédito. A $2,1 de costo son 2.733%.
    expect(margenSobreCostoPct({ precioCreditoClp: 59.5, costoPorCreditoClp: 2.1 })).toBe(2733);
    // El plan base: 300 créditos a $24.990 → $83,3. Sigue siendo sobre el costo.
    expect(margenSobreCostoPct({ precioCreditoClp: 83.3, costoPorCreditoClp: 2.1 })).toBe(3867);
  });

  it("vender por debajo del costo da margen NEGATIVO, no cero", () => {
    expect(margenSobreCostoPct({ precioCreditoClp: 1, costoPorCreditoClp: 2.1 })).toBe(-52);
  });

  it("sin costo medido devuelve null (no 0%, que se leería como 'sin margen')", () => {
    expect(margenSobreCostoPct({ precioCreditoClp: 59.5, costoPorCreditoClp: 0 })).toBeNull();
  });
});
