/**
 * M0 — CONSENTIMIENTO DE MEDICIÓN. La compuerta del Pixel de Meta.
 *
 * Puro y sin React a propósito: lo lee el aviso de cookies, lo leerá `<MarketingPixel/>` en
 * M1 y lo leerá el captador de atribución. Si cada uno interpretara la cookie por su cuenta,
 * bastaría una diferencia de criterio para que el Pixel cargue con el consentimiento
 * rechazado — que es exactamente la infracción que esto viene a evitar.
 *
 * Decisiones que importan:
 *
 * - **Sin respuesta ≠ aceptado.** `estadoConsentimiento()` devuelve `"sin-respuesta"` y
 *   `puedeMedir()` es `false`. La Ley 21.719 (vigente desde diciembre de 2026) pide
 *   consentimiento PREVIO: cargar el Pixel mientras el visitante no contestó es cargarlo sin
 *   permiso. Por eso el default es no.
 * - **Vive en una cookie propia, no en localStorage**, porque la decisión tiene que viajar
 *   entre el servidor y el navegador (las páginas de rubro de M2 se renderizan en el
 *   servidor) y porque `localStorage` no existe durante el render del servidor.
 * - **La Conversions API no depende de esto.** Corre en el servidor y no usa cookies; lo que
 *   el rechazo le quita son los identificadores `_fbp`/`_fbc`. Está declarado así en la
 *   política de privacidad, sección 12.
 */

export type Consentimiento = "aceptado" | "solo-necesarias" | "sin-respuesta";

export const COOKIE_CONSENTIMIENTO = "cv_consent";
/** 180 días: más que los 90 de `_fbp`/`_fbc`, para no re-preguntar a quien ya decidió. */
export const DIAS_CONSENTIMIENTO = 180;

/** Lee una cookie por nombre. Devuelve null en el servidor o si no está. */
export function leerCookie(nombre: string): string | null {
  if (typeof document === "undefined") return null;
  const partes = `; ${document.cookie}`.split(`; ${nombre}=`);
  if (partes.length !== 2) return null;
  return decodeURIComponent(partes[1]!.split(";")[0] ?? "") || null;
}

export function estadoConsentimiento(): Consentimiento {
  const v = leerCookie(COOKIE_CONSENTIMIENTO);
  return v === "aceptado" || v === "solo-necesarias" ? v : "sin-respuesta";
}

/**
 * ¿Se puede cargar el Pixel y escribir cookies de medición?
 *
 * SOLO con un "aceptado" explícito. Un visitante que no contestó todavía NO cuenta.
 */
export function puedeMedir(): boolean {
  return estadoConsentimiento() === "aceptado";
}

export function guardarConsentimiento(valor: "aceptado" | "solo-necesarias"): void {
  if (typeof document === "undefined") return;
  const vence = new Date(Date.now() + DIAS_CONSENTIMIENTO * 86_400_000).toUTCString();
  // `SameSite=Lax` y no `None`: la decisión no tiene por qué viajar en peticiones de terceros.
  // Sin `Secure` en local (http) para que el aviso también funcione en desarrollo.
  const seguro = typeof location !== "undefined" && location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${COOKIE_CONSENTIMIENTO}=${valor}; Path=/; Max-Age=${DIAS_CONSENTIMIENTO * 86_400}; Expires=${vence}; SameSite=Lax${seguro}`;
}

/**
 * Borra las cookies de medición ya instaladas.
 *
 * Hace falta cuando alguien que había aceptado cambia a "solo necesarias": dejar `_fbp` vivo
 * sería seguir identificando el navegador después de que retiró el permiso. `cv_attr` es
 * nuestra (M1); `_fbp`/`_fbc` las escribe el Pixel en nuestro propio dominio, así que las
 * podemos expirar. Se intenta en el dominio exacto y en el dominio padre, porque el Pixel
 * puede haberlas escrito en `.conversia.cl`.
 */
export function borrarCookiesDeMedicion(): void {
  if (typeof document === "undefined") return;
  const host = typeof location !== "undefined" ? location.hostname : "";
  const padre = host.split(".").slice(-2).join(".");
  const dominios = [undefined, host, `.${host}`, padre ? `.${padre}` : undefined].filter(Boolean) as (string | undefined)[];
  for (const nombre of ["_fbp", "_fbc", "cv_attr"]) {
    for (const dominio of dominios) {
      document.cookie = `${nombre}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${dominio ? `; Domain=${dominio}` : ""}`;
    }
  }
}

/**
 * Rutas donde se pregunta por el consentimiento y donde puede cargar el Pixel.
 *
 * Lista blanca y no lista negra: una ruta nueva nace SIN medición, que es el lado seguro. El
 * panel (`/inicio`, `/cobros`, …), el mini-sitio público de cada cliente (`/n/*`) y el super
 * admin (`/admin/*`) no están y no pueden estar: ahí el visitante es el cliente final de
 * nuestro cliente, no alguien que llegó por un anuncio nuestro.
 */
export const RUTAS_DE_MARKETING = ["/", "/crear", "/registro", "/precios", "/barberias", "/dental", "/estetica", "/kinesiologia"] as const;

export function esRutaDeMarketing(pathname: string): boolean {
  const limpio = pathname.replace(/\/+$/, "") || "/";
  return RUTAS_DE_MARKETING.some((r) => limpio === r);
}
