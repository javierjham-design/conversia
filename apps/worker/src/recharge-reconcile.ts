import { VENTANA_EN_VUELO_MS } from "./auto-recharge";
import type { SubscriptionProvider } from "./subscription-billing/provider";

/**
 * CRE — CERRAR LAS RECARGAS QUE QUEDARON A MEDIAS.
 *
 * Una recarga de Créditos IA se cobra a la tarjeta del cliente y los créditos se entregan
 * DESPUÉS, cuando Flow confirma el pago por webhook. Entre esas dos cosas hay un hueco, y
 * ese hueco es plata del cliente:
 *
 *  - **El webhook se pierde.** Flow cobró, llamó a nuestra URL y el POST no llegó (deploy en
 *    curso, 500 nuestro en todos los reintentos, red). El intento queda `pending` para
 *    siempre: **tarjeta cobrada, cero créditos, cero factura y cero alerta**. El motor de
 *    suscripciones no lo recupera porque excluye a propósito los cobros `rec-` (si los viera,
 *    al confirmarse una recarga le renovaría el mes GRATIS al cliente), y no había nada más
 *    mirándolos. Es el peor modo de falla del producto: el cliente paga y su bot se corta.
 *  - **El cobro se emitió sin respuesta.** `charge` revienta por timeout y no sabemos si la
 *    tarjeta quedó cobrada (ver el `catch` de `runAutoRecharge`). Queda pendiente sin token.
 *  - **El webhook llegó, acreditó, y no alcanzó a cerrar el intento.** El cierre del intento
 *    es best-effort dentro del webhook; si falla, los créditos están entregados y el intento
 *    sigue diciendo "pendiente" — y ese pendiente cuenta contra el tope mensual del cliente.
 *
 * Este pase los cierra los tres, y lo hace por el camino más aburrido posible:
 *
 *  - **No acredita nada por su cuenta.** Reaplica el webhook de la pasarela, que es el único
 *    camino que entrega créditos y emite factura. Una segunda forma de acreditar es una
 *    segunda forma de equivocarse, y con el dinero no hay dos.
 *  - **Verifica el libro, no el código de respuesta.** Un 200 del webhook no prueba que se
 *    acreditó: puede devolver OK sin acreditar (metadata perdida, pack fuera del catálogo).
 *    El intento se marca cobrado solo si el asiento está en el libro con el token del pago.
 *  - **Lo que no se puede saber, lo mira una persona.** Un cobro sin respuesta de la pasarela
 *    no se declara fallido ni exitoso: se levanta una excepción crítica con la orden a buscar
 *    en Flow.
 */

/**
 * Lo que se le da al webhook para llegar antes que nosotros.
 *
 * El webhook es el camino normal y resuelve en segundos. Sin esta gracia, este pase le
 * correría por delante a cada cobro del día: acreditaría igual (todo es idempotente) pero
 * consultaría la pasarela una vez por cobro sin necesidad.
 */
export const GRACIA_WEBHOOK_MS = 5 * 60 * 1000;

/**
 * Tras esto, un cobro que la pasarela sigue sin resolver pasa a ser cosa de una persona.
 *
 * Flow resuelve un collect en minutos. Dos días diciendo "pendiente" no es lentitud: es un
 * cobro que quedó colgado, y dejarlo pendiente para siempre le come el tope mensual al
 * cliente (los pendientes cuentan contra el tope, y tienen que contar).
 */
export const VENTANA_ABANDONO_MS = 48 * 60 * 60 * 1000;

/** Un cobro de recarga que todavía no tiene resultado aplicado. */
export interface RecargaPendiente {
  organizationId: string;
  commerceOrder: string;
  /** Token del cobro en la pasarela. null = se emitió el cobro y no hubo respuesta. */
  providerRef: string | null;
  amountClp: number;
  createdAt: Date;
}

export type EstadoPasarela = { settled: boolean; ok: boolean; reason: string | null };

export type CierreRecarga =
  /** Todavía puede resolverse por el camino normal. */
  | "esperar"
  /** La pasarela dice PAGADO: hay que entregar los créditos. */
  | "acreditar"
  /** La pasarela dice rechazado o anulado: no se cobró nada. */
  | "marcar_fallido"
  /** Se emitió el cobro sin saber el resultado y ya pasó la ventana: lo revisa una persona. */
  | "sin_respuesta_alertar"
  /** La pasarela no se decide desde hace demasiado: lo revisa una persona. */
  | "abandonar_alertar";

/** ¿Hace falta preguntarle a la pasarela por este intento? (sin token no hay a quién). */
export function necesitaConsulta(p: RecargaPendiente, now: Date): boolean {
  if (!p.providerRef) return false;
  return now.getTime() - p.createdAt.getTime() >= GRACIA_WEBHOOK_MS;
}

/** Qué hacer con un intento pendiente. Pura: la decisión se prueba sin pasarela ni base. */
export function decidirCierre(input: { pendiente: RecargaPendiente; estado: EstadoPasarela | null; now: Date }): CierreRecarga {
  const edad = input.now.getTime() - input.pendiente.createdAt.getTime();
  if (edad < GRACIA_WEBHOOK_MS) return "esperar";
  // Sin token no hay nada que consultar: este es el cobro que se emitió y del que nunca
  // supimos el resultado. Se le da la misma ventana que dura la guarda de "un cobro a la
  // vez" —si el cobro entró, el webhook llega dentro de ella— y después se alerta.
  if (!input.pendiente.providerRef) {
    return edad >= VENTANA_EN_VUELO_MS ? "sin_respuesta_alertar" : "esperar";
  }
  if (input.estado?.settled) return input.estado.ok ? "acreditar" : "marcar_fallido";
  return edad >= VENTANA_ABANDONO_MS ? "abandonar_alertar" : "esperar";
}

export interface RechargeReconcilePort {
  /** Cobros de recarga con el resultado sin aplicar (los `rec-` en estado pendiente). */
  listPendientes(now: Date): Promise<RecargaPendiente[]>;
  /**
   * Reaplica el webhook de la pasarela, igual que si Flow volviera a llamarnos. Es el ÚNICO
   * camino que acredita un pack y emite la factura, y es idempotente por el sello del pago.
   */
  reaplicarWebhook(input: { providerRef: string; commerceOrder: string }): Promise<void>;
  /** ¿Quedó el pago asentado en el libro con el token de ESTE cobro? */
  creditoAcreditado(organizationId: string, providerRef: string): Promise<boolean>;
  cerrarIntento(commerceOrder: string, status: "succeeded" | "failed", reason: string | null): Promise<void>;
  /** Avisa al cliente (su tarjeta fue rechazada y todavía no lo sabe). */
  notificar(organizationId: string, kind: "recharge_failed", data: Record<string, string | number | null>): Promise<void>;
  raiseOps(
    organizationId: string,
    input: { type: string; title: string; detail: string; dedupeKey: string; severity: "warning" | "critical" },
  ): Promise<void>;
}

export interface ResultadoRecargas {
  revisadas: number;
  /** Cobros confirmados y acreditados por este pase (webhooks que se habían perdido). */
  acreditadas: number;
  /** Cobros que la pasarela declaró rechazados y nadie había cerrado. */
  rechazadas: number;
  /** Pagos confirmados que NO llegaron al libro: el cliente pagó y no recibió nada. */
  pagadasSinAcreditar: number;
  /** Cobros sin respuesta o sin resolver que quedaron en manos de una persona. */
  sinResolver: number;
  /** Intentos que no se pudieron procesar en este pase (se reintentan en el próximo). */
  errores: number;
}

const CLP = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`;

export async function reconciliarRecargas(
  port: RechargeReconcilePort,
  providerFor: (organizationId: string) => Promise<SubscriptionProvider>,
  now: Date,
): Promise<ResultadoRecargas> {
  const out: ResultadoRecargas = { revisadas: 0, acreditadas: 0, rechazadas: 0, pagadasSinAcreditar: 0, sinResolver: 0, errores: 0 };
  const pendientes = await port.listPendientes(now);

  for (const p of pendientes) {
    out.revisadas++;
    try {
      const estado = necesitaConsulta(p, now)
        ? await (await providerFor(p.organizationId)).getChargeStatus(p.providerRef!).catch(() => null)
        : null;

      switch (decidirCierre({ pendiente: p, estado, now })) {
        case "esperar":
          break;

        case "acreditar": {
          // Primero el camino normal (idempotente), después la comprobación en el libro.
          await port.reaplicarWebhook({ providerRef: p.providerRef!, commerceOrder: p.commerceOrder });
          if (await port.creditoAcreditado(p.organizationId, p.providerRef!)) {
            await port.cerrarIntento(p.commerceOrder, "succeeded", "reconciliado");
            out.acreditadas++;
            break;
          }
          // Pago confirmado y nada en el libro. El intento NO se cierra: darlo por cobrado
          // sería declarar entregado lo que no se entregó, y además lo sacaría de este pase.
          // Sigue pendiente, el próximo pase vuelve a intentarlo, y alguien se enteró hoy.
          out.pagadasSinAcreditar++;
          await port
            .raiseOps(p.organizationId, {
              type: "recarga_pagada_sin_acreditar",
              severity: "critical",
              title: "Un cliente pagó una recarga y NO recibió los créditos",
              detail:
                `La pasarela confirma el pago de la orden ${p.commerceOrder} por ${CLP(p.amountClp)} (ref ${p.providerRef}), ` +
                `pero no hay asiento de acreditación en el libro. Hay que acreditar el pack a mano o devolver el cobro. ` +
                `Se reintenta en cada pase, así que el aviso se repite hasta que quede resuelto.`,
              dedupeKey: `pagada_sin_acreditar:${p.commerceOrder}`,
            })
            .catch(() => undefined);
          break;
        }

        case "marcar_fallido": {
          await port.cerrarIntento(p.commerceOrder, "failed", estado?.reason ?? "rechazado");
          out.rechazadas++;
          // El cliente no se enteró: su rechazo no vino por el camino que avisa (el cobro
          // salió "en vuelo" y el resultado llegó recién ahora). Sin este aviso se queda sin
          // saldo mirando una recarga activada que nunca entró.
          await port
            .notificar(p.organizationId, "recharge_failed", { reason: estado?.reason ?? "rechazada", amountClp: p.amountClp })
            .catch(() => undefined);
          break;
        }

        case "sin_respuesta_alertar": {
          out.sinResolver++;
          await port
            .raiseOps(p.organizationId, {
              type: "recarga_sin_respuesta",
              severity: "critical",
              title: "Un cobro de recarga se emitió y nunca supimos el resultado",
              detail:
                `La orden ${p.commerceOrder} por ${CLP(p.amountClp)} se envió a la pasarela y no hubo respuesta ni confirmación. ` +
                `Hay que buscarla en el panel de Flow: si está pagada, acreditar los créditos; si no, no hacer nada.`,
              dedupeKey: `sin_respuesta:${p.commerceOrder}`,
            })
            .catch(() => undefined);
          // Se cierra como fallido DESPUÉS de alertar, y esto es una elección, no un olvido:
          // dejarlo pendiente para siempre le come el tope mensual al cliente y le bloquea
          // las recargas del resto del mes por un cobro que lo más probable es que nunca
          // haya entrado (si hubiera entrado, Flow habría llamado). La alerta es la red; el
          // que decide es el dueño.
          await port.cerrarIntento(p.commerceOrder, "failed", "sin_respuesta");
          break;
        }

        case "abandonar_alertar": {
          out.sinResolver++;
          await port
            .raiseOps(p.organizationId, {
              type: "recarga_sin_resolver",
              severity: "critical",
              title: "Una recarga lleva dos días sin resolverse en la pasarela",
              detail:
                `La orden ${p.commerceOrder} por ${CLP(p.amountClp)} (ref ${p.providerRef}) sigue "pendiente" en la pasarela ` +
                `48 h después. Hay que revisarla en el panel de Flow y acreditar o descartar a mano.`,
              dedupeKey: `sin_resolver:${p.commerceOrder}`,
            })
            .catch(() => undefined);
          await port.cerrarIntento(p.commerceOrder, "failed", "sin_resolver_48h");
          break;
        }
      }
    } catch (err) {
      // Un intento que revienta no puede frenar a los demás: cada uno es la plata de un
      // cliente distinto. Queda pendiente y lo toma el próximo pase.
      out.errores++;
      console.error(`✖ reconciliación de recarga ${p.commerceOrder}:`, (err as Error).message);
    }
  }

  return out;
}
