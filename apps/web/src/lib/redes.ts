/**
 * Las REDES de la bandeja: por dónde entró cada conversación.
 *
 * Espejo de `apps/api/src/conversations/canales-filtro.ts` — las claves son las que viajan
 * en `GET /conversations?channel=…`, así que si las dos listas se separan el filtro deja de
 * encontrar nada. `bandeja-canales.spec.ts` compara los dos archivos y falla si difieren.
 *
 * TikTok figura aunque su canal de mensajería todavía no exista (lo bloquea la revisión de
 * TikTok, ver docs/TIKTOK.md §2). No molesta: la bandeja solo muestra las redes que el
 * tenant TIENE conectadas, así que hoy simplemente no aparece, y el día que exista el canal
 * aparece sola.
 */
export const REDES_BANDEJA = [
  { clave: "whatsapp", tipo: "WHATSAPP_CLOUD", etiqueta: "WhatsApp", color: "#25D366" },
  { clave: "instagram", tipo: "INSTAGRAM", etiqueta: "Instagram", color: "#DD2A7B" },
  { clave: "messenger", tipo: "MESSENGER", etiqueta: "Messenger", color: "#0084FF" },
  { clave: "tiktok", tipo: "TIKTOK", etiqueta: "TikTok", color: "#111111" },
  { clave: "pruebas", tipo: "MOCK", etiqueta: "Pruebas", color: "#6B7280" },
] as const;

export type Red = (typeof REDES_BANDEJA)[number];

/** La red de un tipo de canal. `null` si es un tipo que no conocemos (no se inventa). */
export function redDelTipo(tipo: string | null | undefined): Red | null {
  return REDES_BANDEJA.find((r) => r.tipo === tipo) ?? null;
}

/**
 * Las redes que ESTE negocio tiene conectadas, en el orden del catálogo.
 *
 * Se devuelven solo las que existen: ofrecerle «Instagram» a quien solo tiene WhatsApp es
 * una pestaña que siempre sale vacía. Y una conexión inactiva igual cuenta — sus
 * conversaciones viejas siguen ahí y hay que poder llegar a ellas.
 */
export function redesConectadas(canales: { type: string }[]): Red[] {
  const tipos = new Set(canales.map((c) => c.type));
  return REDES_BANDEJA.filter((r) => tipos.has(r.tipo));
}

/** La red de una conversación, según la conexión por la que entró. */
export function redDeLaConversacion(channelConnectionId: string | null, porConexion: Map<string, Red>): Red | null {
  return channelConnectionId ? (porConexion.get(channelConnectionId) ?? null) : null;
}

/** Índice conexión → red, para pintar la lista sin recorrer el catálogo en cada fila. */
export function indiceDeConexiones(canales: { id: string; type: string }[]): Map<string, Red> {
  const m = new Map<string, Red>();
  for (const c of canales) {
    const red = redDelTipo(c.type);
    if (red) m.set(c.id, red);
  }
  return m;
}
