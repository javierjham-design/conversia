/**
 * P4 — MEMORIA POR APARATO del passkey. Gemelo de `apps/conversia-web/src/lib/passkey-aparato.ts`
 * (los dos paneles no comparten librería; si cambia uno, cambia el otro).
 *
 * El navegador NO permite preguntar «¿este aparato tiene un passkey de esta cuenta?»: es a
 * propósito, porque responderlo sería delatar al usuario a cualquier sitio. Y el servidor sabe
 * qué aparatos tiene la CUENTA, no si el que está mirando la pantalla es uno de ellos.
 *
 * Así que se anota acá, en el aparato, cuando se inscribe o se entra con uno. Es una PISTA para
 * la presentación, nunca una decisión de seguridad:
 *  - si la pista existe pero es falsa (se borró el passkey desde otro lado) → se ofrece el botón
 *    de Face ID, la firma falla y se cae al correo y contraseña de siempre;
 *  - si no existe y debería (modo privado, datos del sitio borrados) → se vuelve a sugerir
 *    inscribir, y el servidor rechaza el duplicado o guarda una llave más del mismo aparato.
 * Ninguno de los dos casos deja a nadie afuera ni deja entrar a nadie.
 *
 * Todo lee y escribe dentro de try/catch: en ventana privada el acceso a `localStorage` puede
 * TIRAR EXCEPCIÓN, y una pantalla de login que explota no la arregla nadie desde el teléfono.
 */

const CLAVE_TIENE = "passkeyEnEsteAparato";
const CLAVE_NO_OFRECER = "passkeyNoOfrecerEnEsteAparato";

/** Anota que este aparato ya tiene un passkey (tras inscribirlo o tras entrar con él). */
export function recordarPasskeyEnEsteAparato(): void {
  try {
    localStorage.setItem(CLAVE_TIENE, "1");
    // Inscribirlo responde la sugerencia: no hay por qué seguir ofreciéndola.
    localStorage.removeItem(CLAVE_NO_OFRECER);
  } catch {
    /* sin almacenamiento: se pierde la comodidad, no la función */
  }
}

/**
 * Borra la pista. Se llama cuando la cuenta queda SIN NINGÚN aparato: si no hay ninguno en la
 * cuenta, con seguridad no hay uno en este, y dejar la pista puesta haría que el login siguiera
 * ofreciendo Face ID como puerta principal para después fallar.
 */
export function olvidarPasskeyEnEsteAparato(): void {
  try {
    localStorage.removeItem(CLAVE_TIENE);
  } catch {
    /* sin almacenamiento: no había nada que borrar */
  }
}

/** ¿Este aparato entró alguna vez con passkey? Decide la PRESENTACIÓN, nada más. */
export function hayPasskeyEnEsteAparato(): boolean {
  try {
    return localStorage.getItem(CLAVE_TIENE) === "1";
  } catch {
    return false;
  }
}

/**
 * «Ahora no»: deja de sugerirlo EN ESTE APARATO y para siempre, no por sesión. Preguntar de
 * nuevo en cada visita a quien ya dijo que no es la receta para que deje de leer los avisos.
 */
export function noOfrecerPasskeyEnEsteAparato(): void {
  try {
    localStorage.setItem(CLAVE_NO_OFRECER, "1");
  } catch {
    /* sin almacenamiento: volverá a aparecer; es molesto, no es un error */
  }
}

/** ¿Corresponde sugerir que active Face ID / huella en este aparato? */
export function convieneSugerirPasskey(): boolean {
  if (hayPasskeyEnEsteAparato()) return false;
  try {
    return localStorage.getItem(CLAVE_NO_OFRECER) !== "1";
  } catch {
    return true;
  }
}
