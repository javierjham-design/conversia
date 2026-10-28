/**
 * CRE 3 — los enlaces de los avisos, POR MARCA.
 *
 * El catálogo de notificaciones nació con TuBot y sus rutas quedaron escritas tal cual:
 * `/inbox`, `/billing`, `/settings/plan`, `/facturacion`, `/contacts`. En conversia-web
 * esas pantallas NO existen —son `/conversaciones`, `/cobros`, `/clientes`—, así que un
 * cliente de Conversia que tocaba "alguien espera respuesta" o "te quedan pocos créditos"
 * terminaba en un 404. Es el mismo hallazgo que ya se corrigió en el checklist de montaje
 * (CTAs a rutas de TuBot), vivo todavía en el camino de los avisos, que es peor: el del
 * checklist lo ve quien está montando; este lo ve quien ya está pagando y le acaba de
 * llegar un aviso de que su bot se va a cortar.
 *
 * El mapa es explícito a propósito: una traducción "inteligente" por heurística se
 * equivocaría en silencio. Lo que no tiene equivalente va a `/inicio`, que existe y desde
 * donde el dueño puede seguir, nunca a una pantalla que no está.
 */

/** Marca del destinatario. */
export type BrandKey = "tubot" | "conversia";

/**
 * Ruta de TuBot → ruta de Conversia. Las claves son la RUTA BASE (sin query), para que
 * `/inbox?c={conversationId}` conserve su query al traducirse.
 */
export const LINK_TUBOT_A_CONVERSIA: Record<string, string> = {
  "/inbox": "/conversaciones",
  "/billing": "/cobros",
  "/facturacion": "/cobros",
  "/settings/plan": "/cobros",
  "/settings/notifications": "/ajustes",
  "/settings/ia": "/ajustes",
  "/settings/export": "/ajustes",
  "/settings/users": "/ajustes",
  "/settings": "/ajustes",
  "/contacts": "/clientes",
  "/agenda": "/agenda",
  "/channels": "/canales",
  "/agents": "/inicio",
  // Sin equivalente en conversia-web: a Inicio, que existe. Mandar a una pantalla que no
  // está es peor que mandar al panel.
  "/integrations": "/inicio",
  "/workflows": "/inicio",
};

/** Pantallas que SÍ existen en conversia-web (el destino tiene que ser una de estas). */
export const RUTAS_CONVERSIA = new Set([
  "/inicio",
  "/conversaciones",
  "/agenda",
  "/clientes",
  "/caja",
  "/canales",
  "/mini-sitio",
  "/cobros",
  "/ajustes",
]);

/**
 * Traduce el enlace de un aviso a la marca del destinatario. Para TuBot devuelve el mismo
 * enlace (su catálogo ya está escrito en sus rutas). Puro y testeable.
 *
 * Conserva la query: `/inbox?c=abc` → `/conversaciones?c=abc`, porque ese parámetro es el
 * que abre la conversación correcta y perderlo deja al dueño en una bandeja vacía.
 */
export function linkParaMarca(link: string | undefined, brand: BrandKey): string | undefined {
  if (!link) return link;
  if (brand !== "conversia") return link;
  const [rutaConSlash, query] = partirQuery(link);
  const ruta = rutaConSlash.replace(/\/+$/, "") || "/";
  // Coincidencia exacta primero; después por prefijo, para `/workflows/{id}` y similares.
  const directo = LINK_TUBOT_A_CONVERSIA[ruta];
  if (directo) return directo + (query ?? "");
  for (const [desde, hacia] of Object.entries(LINK_TUBOT_A_CONVERSIA)) {
    if (ruta.startsWith(desde + "/")) return hacia + (query ?? "");
  }
  // Si ya es una ruta de Conversia, se deja como está.
  if (RUTAS_CONVERSIA.has(ruta)) return link;
  // Desconocida: al panel. Nunca a un 404.
  return "/inicio";
}

function partirQuery(link: string): [string, string | undefined] {
  const i = link.search(/[?#]/);
  return i === -1 ? [link, undefined] : [link.slice(0, i), link.slice(i)];
}
