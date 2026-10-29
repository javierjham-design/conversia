/**
 * UN COBRO A LA VEZ POR SUSCRIPCIÓN.
 *
 * `POST subscription/confirm-card` y `POST subscription/manual-pay` emiten un cobro a la
 * tarjeta guardada del cliente, y ninguno de los dos tenía freno: cada llamada creaba un
 * intento nuevo (el `commerceOrder` lleva `Date.now()`, así que ni la base los veía
 * repetidos) y disparaba su propio `customer/collect`. Dos clics en "Pagar ahora" —o el
 * reintento de un fetch, o volver atrás en el navegador— son **dos cargos a la misma
 * tarjeta por el mismo mes**, con dos comprobantes y un cliente pidiendo la devolución. El
 * motor de cobro del worker sí tenía esta guarda (`pendingSubscriptionIds`); las dos puertas
 * que aprieta el cliente, no.
 *
 * La guarda tiene que ser ATÓMICA, y por eso vive acá y no en un `findFirst` suelto: dos
 * clics llegan a la vez, los dos leen "no hay nada pendiente" y los dos cobran. Se toma el
 * MISMO cerrojo de aviso que usa el cobro de créditos (`pg_advisory_xact_lock`), se mira y
 * se reserva —creando la fila del intento— dentro de la misma transacción. El segundo
 * request espera el cerrojo, ve la reserva del primero y se va sin cobrar.
 */

/**
 * Cuánto dura una reserva de cobro.
 *
 * Es el plazo que se le da a la pasarela para resolver un `collect` antes de permitir otro
 * intento. Si fuera mucho más corto, un doble clic lento colaría el segundo cobro; si fuera
 * mucho más largo, un cobro que quedó colgado dejaría al cliente sin poder pagar a mano
 * justo cuando está por suspendérsele la cuenta. Quince minutos es lo que tarda el tick del
 * worker en reconciliar, así que un intento colgado de verdad ya está resuelto para entonces.
 */
export const VENTANA_COBRO_EN_VUELO_MS = 15 * 60 * 1000;

/** Prefijo del `commerceOrder` de un cobro de SUSCRIPCIÓN (los de recarga usan "rec-"). */
export const PREFIJO_ORDEN_SUSCRIPCION = "sub-";

export interface IntentoEnVuelo {
  commerceOrder: string;
  createdAt: Date;
}

/**
 * ¿Hay un cobro de ESTA suscripción todavía en vuelo? Pura, para poder probar la ventana.
 *
 * Solo cuentan los intentos `pending`: uno `succeeded` es el cobro del mes que ya entró (y a
 * ese lo frena el calendario, no esta guarda) y uno `failed` tiene que poder reintentarse en
 * el momento — es justo lo que el cliente viene a hacer cuando le rebotó la tarjeta.
 */
export function hayCobroEnVuelo(pendientes: IntentoEnVuelo[], now: Date): IntentoEnVuelo | null {
  return pendientes.find((p) => now.getTime() - p.createdAt.getTime() < VENTANA_COBRO_EN_VUELO_MS) ?? null;
}

/** Lo mínimo que la reserva necesita de Prisma (para poder probarla sin base). */
export interface ReservaDb {
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  paymentAttempt: {
    findMany(args: unknown): Promise<Array<{ commerceOrder: string; createdAt: Date }>>;
    create(args: unknown): Promise<unknown>;
  };
}

export interface DatosDelIntento {
  organizationId: string;
  subscriptionId: string;
  commerceOrder: string;
  amount: number;
  currency: string;
  kind: "auto" | "manual";
  attemptNumber: number;
}

export type Reserva = { reservado: true } | { reservado: false; enVuelo: IntentoEnVuelo };

/**
 * Reserva el derecho a cobrar esta suscripción, creando el intento PENDIENTE.
 *
 * Devuelve `reservado: false` si ya había un cobro en vuelo — y en ese caso NO se creó
 * ninguna fila, así que el llamador simplemente no cobra. Todo pasa dentro de una
 * transacción con el cerrojo tomado: dos requests simultáneos no pueden reservar los dos.
 */
export async function reservarCobro(
  db: { $transaction<T>(fn: (tx: ReservaDb) => Promise<T>): Promise<T> },
  datos: DatosDelIntento,
  now: Date = new Date(),
): Promise<Reserva> {
  return db.$transaction(async (tx) => {
    // El cerrojo es por SUSCRIPCIÓN: dos suscripciones distintas pueden cobrar a la vez.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cobro:${datos.subscriptionId}`}))`;
    const pendientes = await tx.paymentAttempt.findMany({
      where: {
        subscriptionId: datos.subscriptionId,
        status: "pending",
        // Los cobros de RECARGA de créditos van a la misma tabla y a la misma tarjeta, pero
        // son otro producto: una recarga en vuelo no puede impedirle pagar la mensualidad.
        commerceOrder: { startsWith: PREFIJO_ORDEN_SUSCRIPCION },
      },
      select: { commerceOrder: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const enVuelo = hayCobroEnVuelo(pendientes, now);
    if (enVuelo) return { reservado: false as const, enVuelo };
    await tx.paymentAttempt.create({
      data: {
        organizationId: datos.organizationId,
        subscriptionId: datos.subscriptionId,
        commerceOrder: datos.commerceOrder,
        amount: datos.amount,
        currency: datos.currency,
        kind: datos.kind,
        attemptNumber: datos.attemptNumber,
        status: "pending",
        provider: "flow",
      },
    });
    return { reservado: true as const };
  });
}
