/**
 * QUÉ LE VA A PASAR AL CLIENTE CUANDO SE LE ACABE EL SALDO (§4d del encargo del 29-oct).
 *
 * Los avisos del 75% y del 90% decían cuánto quedaba y nada más. Pero "te queda el 10%"
 * significa cosas MUY distintas según cómo esté configurado el cobro: con recarga automática
 * y tarjeta de crédito no pasa nada; con una tarjeta de débito el cobro va a quedar colgado y
 * el bot se va a pausar; sin tarjeta hay que ir a pagar a mano. El cliente no puede deducir
 * eso del porcentaje, y el momento de decírselo es cuando todavía le queda saldo para
 * arreglarlo — no cuando ya se le cortó.
 *
 * Es pura para poder probar cada combinación sin base ni pasarela: son cinco estados y el que
 * importa es el que menos se ve (tarjeta no apta con la recarga activada, que es el que hace
 * creer al cliente que está cubierto cuando no lo está).
 */

export interface EstadoDeCobro {
  /** ¿Tiene la recarga automática encendida y con consentimiento? */
  recargaActiva: boolean;
  /** ¿Hay una tarjeta guardada en la pasarela? */
  tieneTarjeta: boolean;
  /** ¿Sirve para cobros automáticos? `null` = todavía no se sabe (se prueba al cobrar). */
  tarjetaApta: boolean | null;
  /** ¿Ya llegó al tope mensual que el propio cliente fijó? */
  topeAlcanzado?: boolean;
}

/**
 * Una frase, en segunda persona, sin jerga y sin prometer lo que no va a pasar. El orden de
 * las ramas importa: primero las que CONTRADICEN lo que el cliente cree (su recarga está
 * activada pero no va a funcionar), porque son las que tiene que leer.
 */
export function queVaAPasarConElSaldo(e: EstadoDeCobro): string {
  if (!e.tieneTarjeta) {
    return (
      "Todavía no tienes una tarjeta registrada. Para que las recargas se cobren solas, registra una tarjeta de " +
      "CRÉDITO en Cobros; si prefieres, puedes comprar una recarga a mano cuando quieras."
    );
  }
  if (e.recargaActiva && e.tarjetaApta === false) {
    return (
      "Tienes la recarga automática activada, pero tu tarjeta no permite cobros automáticos (las de débito y prepago no " +
      "los admiten), así que NO vamos a poder cobrarla. Cámbiala por una de CRÉDITO o compra la recarga a mano antes de " +
      "quedarte sin saldo."
    );
  }
  if (e.recargaActiva && e.topeAlcanzado) {
    return (
      "Tu recarga automática ya llegó al tope mensual que fijaste, así que no vamos a cobrar más este mes. Puedes subir " +
      "el tope o comprar una recarga a mano."
    );
  }
  if (e.recargaActiva) {
    return "Tu recarga automática se va a encargar: cuando bajes del umbral cobramos tu pack y tu asistente sigue sin cortes.";
  }
  if (e.tarjetaApta === false) {
    return (
      "No tienes la recarga automática activada, y tu tarjeta además no permite cobros automáticos. Compra una recarga " +
      "a mano, o registra una tarjeta de CRÉDITO y activa la recarga para no tener que acordarte."
    );
  }
  return (
    "No tienes la recarga automática activada. Cuando se agote el saldo tu asistente sigue atendiendo con los créditos " +
    "de cortesía y después se pausa, así que conviene activarla o comprar una recarga."
  );
}
