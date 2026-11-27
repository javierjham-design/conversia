/**
 * Las REDES por las que se separa la bandeja: WhatsApp, Instagram, Messenger…
 *
 * Esto NO es lo mismo que el filtro por `channelId`, que apunta a UNA conexión concreta —
 * un número de WhatsApp—. Un negocio con dos números quiere poder ver «todo WhatsApp»
 * junto, y para eso existe la RED.
 *
 * `tiktok` figura a propósito aunque el canal de DM todavía no exista: lo bloquea la
 * revisión DSPR de TikTok, no nuestro código (docs/TIKTOK.md §2). Es seguro tenerlo acá
 * porque el filtro se resuelve contra las conexiones QUE EL TENANT TIENE —nunca mandándole
 * el tipo a la base de datos—, así que una red sin conexiones devuelve CERO conversaciones
 * en vez de reventar con un valor que el enum de Postgres no conoce. El día que el canal
 * exista, la red aparece sola.
 */
export const REDES_BANDEJA = [
  { clave: "whatsapp", tipo: "WHATSAPP_CLOUD", etiqueta: "WhatsApp" },
  { clave: "instagram", tipo: "INSTAGRAM", etiqueta: "Instagram" },
  { clave: "messenger", tipo: "MESSENGER", etiqueta: "Messenger" },
  { clave: "tiktok", tipo: "TIKTOK", etiqueta: "TikTok" },
  { clave: "pruebas", tipo: "MOCK", etiqueta: "Pruebas" },
] as const;

export type ClaveDeRed = (typeof REDES_BANDEJA)[number]["clave"];

/** Tipo de canal de una clave de red, o `null` si la clave no existe. */
export function tipoDeRed(clave: string): string | null {
  return REDES_BANDEJA.find((r) => r.clave === clave)?.tipo ?? null;
}

/** Clave de red de un tipo de canal, o `null` si ese tipo no tiene red (nunca debería pasar). */
export function redDelTipo(tipo: string): ClaveDeRed | null {
  return REDES_BANDEJA.find((r) => r.tipo === tipo)?.clave ?? null;
}

/**
 * Las conexiones del tenant que pertenecen a una red.
 *
 * Devuelve `null` **solo** si la clave no existe (→ el llamador responde 400). Una red que
 * existe pero que el tenant no tiene conectada devuelve `[]`, que con `{ in: [] }` da cero
 * conversaciones. La diferencia es TODO el asunto: si una clave desconocida se tratara como
 * «sin filtro», pedir Instagram devolvería las conversaciones de WhatsApp sin avisar.
 */
export function idsDeLaRed(clave: string, conexiones: { id: string; type: string }[]): string[] | null {
  const tipo = tipoDeRed(clave);
  if (!tipo) return null;
  return conexiones.filter((c) => c.type === tipo).map((c) => c.id);
}
