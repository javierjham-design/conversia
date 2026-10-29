import { describe, expect, it } from "vitest";
import {
  hayCobroEnVuelo,
  PREFIJO_ORDEN_SUSCRIPCION,
  reservarCobro,
  VENTANA_COBRO_EN_VUELO_MS,
  type DatosDelIntento,
} from "../src/billing/cobro-en-vuelo";

/**
 * DOS CLICS, DOS CARGOS A LA TARJETA.
 *
 * `confirm-card` y `manual-pay` emiten un cobro a la tarjeta guardada del cliente. No tenían
 * ninguna guarda: el `commerceOrder` lleva `Date.now()`, así que cada llamada creaba un
 * intento distinto y disparaba su propio `collect`. Dos clics en "Pagar ahora", el reintento
 * de un fetch o un refresh de la pantalla de retorno de Flow eran dos cargos por el mismo
 * mes, con dos comprobantes y un cliente pidiendo la devolución.
 *
 * Lo que se prueba acá es que la guarda aguanta el caso que importa —los dos requests
 * LLEGANDO A LA VEZ— y que lo que la hace aguantar es el cerrojo, no la suerte.
 */

const AHORA = new Date("2026-10-29T12:00:00.000Z");
const haceMs = (ms: number) => new Date(AHORA.getTime() - ms);

const DATOS: DatosDelIntento = {
  organizationId: "org1",
  subscriptionId: "sub1",
  commerceOrder: `${PREFIJO_ORDEN_SUSCRIPCION}sub1-1000`,
  amount: 24_990,
  currency: "CLP",
  kind: "manual",
  attemptNumber: 1,
};

describe("la ventana: ¿qué cuenta como cobro en vuelo?", () => {
  it("un intento pendiente reciente frena el cobro", () => {
    expect(hayCobroEnVuelo([{ commerceOrder: "sub-sub1-1", createdAt: haceMs(60_000) }], AHORA)).not.toBeNull();
  });

  it("un intento pendiente VIEJO no frena nada (si no, el cliente no podría pagar nunca)", () => {
    // Un `collect` que quedó colgado no puede dejar a un cliente sin poder pagar a mano
    // justo cuando está por suspendérsele la cuenta.
    expect(hayCobroEnVuelo([{ commerceOrder: "sub-sub1-1", createdAt: haceMs(VENTANA_COBRO_EN_VUELO_MS) }], AHORA)).toBeNull();
    expect(hayCobroEnVuelo([{ commerceOrder: "sub-sub1-1", createdAt: haceMs(VENTANA_COBRO_EN_VUELO_MS - 1) }], AHORA)).not.toBeNull();
  });

  it("sin intentos pendientes se cobra", () => {
    expect(hayCobroEnVuelo([], AHORA)).toBeNull();
  });
});

/* ──────────────────── La reserva, con una base de datos de juguete ──────────────────── */

interface Fila {
  subscriptionId: string;
  commerceOrder: string;
  status: string;
  createdAt: Date;
}

/**
 * Base de juguete que respeta `pg_advisory_xact_lock`: la transacción que lo pide espera su
 * turno por clave y lo suelta al terminar. Es lo mínimo para poder escribir el caso que
 * importa (dos requests a la vez) sin levantar Postgres.
 */
function fakeDb(filas: Fila[], opts: { conCerrojo: boolean } = { conCerrojo: true }) {
  const cerrojos = new Map<string, Promise<void>>();

  const tomar = async (clave: string): Promise<() => void> => {
    if (!opts.conCerrojo) return () => undefined;
    const previo = cerrojos.get(clave) ?? Promise.resolve();
    let soltar!: () => void;
    const mio = new Promise<void>((res) => (soltar = res));
    cerrojos.set(clave, previo.then(() => mio));
    await previo;
    return soltar;
  };

  return {
    filas,
    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const sueltas: Array<() => void> = [];
      const tx = {
        $executeRaw: async (_q: TemplateStringsArray, ...vals: unknown[]) => {
          sueltas.push(await tomar(String(vals[0])));
          return 1;
        },
        paymentAttempt: {
          findMany: async (args: any) => {
            const w = args.where ?? {};
            // La lectura se resuelve AHORA y la respuesta llega 5 ms después. Ese desfase es
            // la carrera real —el segundo request leyó antes de que el primero escribiera— y
            // sin él el test pasaría por el orden en que corren los timers, no por el
            // cerrojo. Con el cerrojo tomado, el segundo ni llega a leer hasta que el
            // primero terminó de escribir.
            const vistas = filas
              .filter((f) => f.subscriptionId === w.subscriptionId && f.status === w.status)
              .filter((f) => !w.commerceOrder?.startsWith || f.commerceOrder.startsWith(w.commerceOrder.startsWith))
              .map((f) => ({ commerceOrder: f.commerceOrder, createdAt: f.createdAt }));
            await new Promise((r) => setTimeout(r, 5));
            return vistas;
          },
          create: async (args: any) => {
            filas.push({
              subscriptionId: args.data.subscriptionId,
              commerceOrder: args.data.commerceOrder,
              status: args.data.status,
              createdAt: AHORA,
            });
            return args.data;
          },
        },
      };
      try {
        return await fn(tx);
      } finally {
        for (const s of sueltas) s();
      }
    },
  };
}

describe("la reserva del cobro", () => {
  it("sin nada en vuelo: reserva y crea el intento", async () => {
    const db = fakeDb([]);
    const r = await reservarCobro(db, DATOS, AHORA);
    expect(r.reservado).toBe(true);
    expect(db.filas).toHaveLength(1);
  });

  it("con un cobro en vuelo: NO reserva y NO crea nada", async () => {
    const db = fakeDb([{ subscriptionId: "sub1", commerceOrder: "sub-sub1-1", status: "pending", createdAt: haceMs(30_000) }]);
    const r = await reservarCobro(db, DATOS, AHORA);
    expect(r.reservado).toBe(false);
    expect(db.filas).toHaveLength(1); // la que ya estaba, ninguna nueva
  });

  it("DOS CLICS A LA VEZ: uno cobra, el otro no — un solo cargo a la tarjeta", async () => {
    // El caso real. Sin el cerrojo los dos leen "no hay nada pendiente" y los dos cobran.
    const db = fakeDb([]);
    const [a, b] = await Promise.all([
      reservarCobro(db, { ...DATOS, commerceOrder: "sub-sub1-1000" }, AHORA),
      reservarCobro(db, { ...DATOS, commerceOrder: "sub-sub1-1001" }, AHORA),
    ]);
    expect([a.reservado, b.reservado].filter(Boolean)).toHaveLength(1);
    expect(db.filas).toHaveLength(1);
  });

  it("SIN el cerrojo el doble cobro ocurre (para que el test de arriba no pase por suerte)", async () => {
    const db = fakeDb([], { conCerrojo: false });
    const [a, b] = await Promise.all([
      reservarCobro(db, { ...DATOS, commerceOrder: "sub-sub1-1000" }, AHORA),
      reservarCobro(db, { ...DATOS, commerceOrder: "sub-sub1-1001" }, AHORA),
    ]);
    expect([a.reservado, b.reservado]).toEqual([true, true]);
    expect(db.filas).toHaveLength(2); // dos cargos: el bug, reproducido
  });

  it("una RECARGA de créditos en vuelo no impide pagar la mensualidad", async () => {
    // Van a la misma tabla y a la misma tarjeta, pero son otro producto: si la recarga
    // frenara la mensualidad, un cobro de créditos colgado suspendería la cuenta por impago.
    const db = fakeDb([{ subscriptionId: "sub1", commerceOrder: "rec-org1-1", status: "pending", createdAt: haceMs(30_000) }]);
    const r = await reservarCobro(db, DATOS, AHORA);
    expect(r.reservado).toBe(true);
  });

  it("un intento FALLIDO no frena el reintento (es lo que el cliente viene a hacer)", async () => {
    const db = fakeDb([{ subscriptionId: "sub1", commerceOrder: "sub-sub1-1", status: "failed", createdAt: haceMs(10_000) }]);
    const r = await reservarCobro(db, DATOS, AHORA);
    expect(r.reservado).toBe(true);
  });

  it("el cobro de OTRA suscripción no frena a esta", async () => {
    const db = fakeDb([{ subscriptionId: "sub2", commerceOrder: "sub-sub2-1", status: "pending", createdAt: haceMs(10_000) }]);
    const r = await reservarCobro(db, DATOS, AHORA);
    expect(r.reservado).toBe(true);
  });

  it("el cerrojo es por suscripción: dos clientes distintos cobran a la vez", async () => {
    const db = fakeDb([]);
    const [a, b] = await Promise.all([
      reservarCobro(db, { ...DATOS, subscriptionId: "sub1", commerceOrder: "sub-sub1-1" }, AHORA),
      reservarCobro(db, { ...DATOS, subscriptionId: "sub2", commerceOrder: "sub-sub2-1" }, AHORA),
    ]);
    expect([a.reservado, b.reservado]).toEqual([true, true]);
    expect(db.filas).toHaveLength(2);
  });
});
