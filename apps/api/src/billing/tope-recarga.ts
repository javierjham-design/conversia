import { MAX_RECARGAS_MES } from "@conversia/agents";

/**
 * EL TOPE MENSUAL DE LA RECARGA AUTOMÁTICA, VALIDADO DEL LADO DEL SERVIDOR.
 *
 * El tope lo pone el cliente y es su protección: es la cifra que autoriza a que le cobremos
 * a la tarjeta sin que vuelva a apretar nada. Lo único que lo limitaba era el
 * `max(100000000)` del validador de la petición, así que un decimal de más escrito a mano, un
 * bug de la pantalla o una llamada directa a la API dejaban autorizados **cien millones de
 * pesos** de cobros automáticos. Y el consentimiento que el cliente dio por $249.900 seguía
 * valiendo para la cifra nueva, porque subir el tope no volvía a pedir nada.
 *
 * Las dos reglas viven acá, puras, para poder probarlas sin levantar la API: el endpoint
 * solo las aplica.
 */

/** Techo en pesos: como máximo `MAX_RECARGAS_MES` recargas del pack elegido. */
export function techoDelTope(precioPackClp: number): number {
  return MAX_RECARGAS_MES * Math.max(0, Math.round(precioPackClp));
}

export type ProblemaDelTope =
  /** Pasa del techo que acepta el servidor. */
  | "sobre_el_techo"
  /** Sube el tope sin volver a aceptar: autoriza más plata que lo que el cliente aceptó. */
  | "sube_sin_consentir"
  | null;

/**
 * ¿Se puede guardar este tope?
 *
 * Bajar el tope NUNCA pide nada: siempre es a favor del cliente. Subirlo sí, porque autoriza
 * más plata que la que aceptó. Y nada de esto aplica con la recarga apagada: ahí el tope es
 * un número guardado que no autoriza ningún cobro.
 */
export function revisarTope(input: {
  enabled: boolean;
  /** Tope pedido, o undefined si la petición no lo trae (se conserva el anterior). */
  pedido?: number;
  /** Tope que ya tenía guardado, si tenía. */
  previo?: number;
  /** Precio del pack configurado, o null si no hay pack. */
  precioPackClp: number | null;
  /** ¿Volvió a aceptar en ESTA petición? */
  consintio: boolean;
}): ProblemaDelTope {
  if (!input.enabled || typeof input.pedido !== "number") return null;
  if (input.precioPackClp != null && input.pedido > techoDelTope(input.precioPackClp)) return "sobre_el_techo";
  const previo = Number(input.previo);
  if (Number.isFinite(previo) && input.pedido > previo && !input.consintio) return "sube_sin_consentir";
  return null;
}
