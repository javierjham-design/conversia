/**
 * RETORNO DE LA PASARELA hacia /cobros. La API arma los URLs de retorno por MARCA de la
 * organización (packages/config/src/brands.ts → billingReturnUrls): una org Conversia
 * vuelve a `/cobros?pago=ok|cancelado` y, tras registrar la tarjeta en Flow, a
 * `/cobros?card=1`. Encima de eso, cada pasarela agrega su propia marca al retorno
 * (`paid=1` en Flow/Stripe/Lemon, `mock_session` en el mock de desarrollo), así que la
 * lectura tiene que tolerar las dos cosas a la vez (`?pago=ok&paid=1`).
 *
 * Función pura (sin `window`) para poder probarla: la pantalla le pasa
 * `window.location.search`.
 */
export type Retorno = "tarjeta" | "pago-ok" | "pago-cancelado" | null;

export function leerRetorno(search: string): Retorno {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  // La tarjeta manda: ese retorno exige confirmar la operación contra la API.
  if (p.get("card") === "1") return "tarjeta";
  const pago = p.get("pago");
  if (pago === "ok") return "pago-ok";
  if (pago === "cancelado") return "pago-cancelado";
  // Sin `pago` explícito: las marcas que agregan las pasarelas al volver de un pago.
  if (p.get("paid") === "1" || p.has("mock_session")) return "pago-ok";
  return null;
}
