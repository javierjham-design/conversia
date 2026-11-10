import { describe, expect, it } from "vitest";
import { CashController } from "../src/charging/cash.controller";
import { runWithContext, type RequestContext } from "../src/tenancy/context";

/**
 * F9 CAJA — EL DÍA DE CAJA ES EL DÍA DE CHILE.
 *
 * El mismo defecto que corrió la agenda estaba acá: los límites del día se armaban con un
 * offset escrito a mano ("-03:00") y "hoy" se calculaba restándole 3 horas a UTC. Eso vale
 * medio año. En invierno Chile está en -04:00, y entonces:
 *   · lo cobrado entre las 23:00 y la medianoche caía en la caja del día SIGUIENTE, así que
 *     el cierre no cuadraba y la pantalla no daba ninguna pista de por qué;
 *   · el día del cambio de hora (que dura 23 o 25 horas) se cortaba una hora antes o después.
 *
 * Las horas esperadas están escritas en UTC a propósito: es la frontera real guardada en la
 * base. Chile está en -03:00 de septiembre a abril y en -04:00 el resto del año.
 */

const prismaFalso = () => {
  const prisma: any = {
    withTenant: (_org: string, fn: any) =>
      fn({
        cashLedger: { findMany: async () => [] },
        cashClosure: { findFirst: async () => null },
      }),
    admin: {},
  };
  return prisma;
};
const ctx: RequestContext = { userId: "u1", organizationId: "org1", roleCode: "x", permissions: ["cash:report"] };
const caja = () => new CashController(prismaFalso());
const dia = (fecha: string) => runWithContext(ctx, () => caja().day(fecha)) as Promise<{ from: Date; to: Date }>;

describe("los límites del día de caja siguen el horario de Chile", () => {
  it("en INVIERNO (-04:00) el día va de 04:00Z a 04:00Z", async () => {
    const { from, to } = await dia("2026-07-15");
    expect(from.toISOString()).toBe("2026-07-15T04:00:00.000Z");
    expect(to.toISOString()).toBe("2026-07-16T04:00:00.000Z");
  });

  it("en VERANO (-03:00) el día va de 03:00Z a 03:00Z", async () => {
    const { from, to } = await dia("2026-11-15");
    expect(from.toISOString()).toBe("2026-11-15T03:00:00.000Z");
    expect(to.toISOString()).toBe("2026-11-16T03:00:00.000Z");
  });

  it("una venta de las 23:30 de un día de INVIERNO queda en la caja de ESE día", async () => {
    // Este es el síntoma: con el offset fijo, esta venta se iba a la caja de mañana.
    const venta = new Date("2026-07-16T03:30:00Z"); // = 23:30 del 15-jul en Chile
    const { from, to } = await dia("2026-07-15");
    expect(venta >= from && venta < to).toBe(true);
    const siguiente = await dia("2026-07-16");
    expect(venta >= siguiente.from).toBe(false);
  });

  it("el día que TERMINA el horario de verano dura 25 horas", async () => {
    const { from, to } = await dia("2026-04-04"); // el reloj se atrasa en la madrugada del 5
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(25);
  });

  it("el día que EMPIEZA el horario de verano dura 23 horas", async () => {
    const { from, to } = await dia("2026-09-05"); // el reloj se adelanta en la madrugada del 6
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(23);
  });
});

describe("los rangos de semana y mes cuentan días de calendario", () => {
  const reporte = (rango: string, fecha: string) =>
    runWithContext(ctx, () => caja().report(rango, fecha)) as Promise<{ from: Date; to: Date }>;

  it("la semana arranca en la medianoche local de hace 6 días", async () => {
    const { from, to } = await reporte("week", "2026-11-15");
    expect(from.toISOString()).toBe("2026-11-09T03:00:00.000Z");
    expect(to.toISOString()).toBe("2026-11-16T03:00:00.000Z");
  });

  it("una semana que cruza el cambio de hora sigue arrancando a medianoche local", async () => {
    // Del 31-mar al 6-abr: el horario de verano termina el domingo 5.
    const { from } = await reporte("week", "2026-04-06");
    expect(from.toISOString()).toBe("2026-03-31T03:00:00.000Z"); // 31-mar aún en -03:00
  });

  it("el mes arranca en la medianoche local de hace 29 días", async () => {
    const { from } = await reporte("month", "2026-11-15");
    expect(from.toISOString()).toBe("2026-10-17T03:00:00.000Z");
  });
});
