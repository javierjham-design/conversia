import { plazoVencido, sessionActive } from "./api";

/**
 * Qué hacer con la sesión de quien llega a la LANDING PÚBLICA (conversia.cl).
 *
 * Antes la landing redirigía sola al panel en cuanto encontraba algo en localStorage, así que el
 * dueño —y cualquier cliente con sesión— no podía VER su propia página web: entrar a conversia.cl
 * era entrar al panel. La página pública es parte del producto (precios, cómo funciona, FAQ); que
 * sea inalcanzable para quien ya tiene cuenta es un defecto, no una comodidad.
 *
 * Ahora la landing no redirige nunca: solo cambia el botón del menú. "Entrar" para quien no tiene
 * sesión, "Ir a mi panel" para quien sí — y para "sí" ahora también cuenta el plazo máximo de
 * 24 h, no solo que haya algo guardado (ver `estadoDelVisitante`).
 */
export type EstadoVisitante =
  /** Sin sesión. El menú ofrece Entrar / Crear gratis. */
  | "anonimo"
  /** Hay sesión reanudable (access vivo, o refresh con qué renovarlo). El menú ofrece el panel. */
  | "con-sesion"
  /** Access vencido y sin refresh: no se puede reanudar. Hay que limpiar y tratarlo como anónimo. */
  | "muerta";

/**
 * Decide SIN red, leyendo solo el `exp` del JWT y el plazo máximo que guardó el servidor. Que
 * el refresh exista no prueba que siga vivo en Redis —pudo ser revocado—, y por eso esto no es
 * una autorización: solo elige qué botón mostrar. Si el refresh ya no sirve, el panel lo
 * descubre en su primera llamada y manda al login con el aviso de siempre.
 *
 * `plazo` es el techo de 24 h (ms epoch, `getSessionDeadline()`), y es OBLIGATORIO a propósito.
 * El defecto que cierra: la landing ofrecía "Ir a mi panel" con solo encontrar un refresh token
 * guardado, sin mirar de cuándo era, así que el dueño volvía días después y el botón lo metía
 * derecho a la plataforma. Con el parámetro opcional, un llamador nuevo se lo olvidaría y el
 * agujero volvería sin que nada se pusiera rojo. `null` = plazo desconocido, no vencido.
 */
export function estadoDelVisitante(token: string | null, refreshToken: string | null, plazo: number | null): EstadoVisitante {
  if (!token) return "anonimo";
  if (plazoVencido(plazo)) return "muerta";
  if (sessionActive(token) || refreshToken) return "con-sesion";
  return "muerta";
}
