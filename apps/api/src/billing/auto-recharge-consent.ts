/**
 * CRE 2 (§6) — CONSENTIMIENTO de la recarga automática.
 *
 * Activarla es autorizarnos a cobrarle a su tarjeta sin que vuelva a apretar nada, así que
 * la autorización se guarda con fecha y usuario. La regla está acá, separada del
 * controlador, porque es la que decide si un cobro futuro es legítimo: merece su test.
 *
 * Criterios:
 *  - Para activar hace falta consentimiento: el de ahora, o uno ya registrado antes (no se
 *    le pide dos veces a quien solo está ajustando el umbral).
 *  - Al desactivar se BORRA: volver a encenderla exige aceptar de nuevo. Si se conservara,
 *    un "activar" accidental meses después cobraría con un permiso viejo.
 */
export function resolveConsent(input: {
  enabled: boolean;
  /** `consentAt` que ya estaba guardado, si había. */
  previo: unknown;
  /** La casilla que vino en esta petición. */
  consent?: boolean;
  now?: Date;
}): string | null {
  if (!input.enabled) return null;
  const previo = typeof input.previo === "string" && input.previo.trim() ? input.previo : null;
  if (previo) return previo;
  return input.consent ? (input.now ?? new Date()).toISOString() : null;
}
