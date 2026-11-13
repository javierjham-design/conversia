/**
 * QUÉ TIPO DE MENSAJE LLEGÓ, Y CÓMO SE LLAMA EN CASTELLANO — reglas puras, sin BD ni red.
 *
 * Antes esto vivía en dos ternarios dentro de `inbound.ts` (uno para los mensajes entrantes y
 * otro, copiado, para los ecos de coexistencia) y en un tercero en `messaging-inbound.ts`.
 * Los tres conocían cuatro tipos —audio, imagen, documento, video— y mandaban TODO lo demás a
 * TEXT con el cuerpo `"[" + tipo + "]"`. Consecuencias que se veían en pantalla:
 *
 *  - Un sticker se guardaba como TEXT con body `[sticker]`, aunque el enum STICKER existe
 *    desde siempre. Ningún panel podía dibujarlo y el agente no sabía que era un sticker.
 *  - Una ubicación quedaba como `[location]`: ni el mapa ni la dirección.
 *  - La vista previa de la lista de conversaciones decía `[image]`, en inglés y entre
 *    corchetes, que es la clase de detalle que hace sentir que el producto está a medio hacer.
 *
 * Separarlo acá permite probar el mapeo de CADA tipo con una tabla, que es lo que faltaba:
 * no había un solo test del mapeo entrante.
 */

/** Los valores del enum `MessageType` de Prisma que usamos al recibir. */
export type TipoDeMensaje =
  | "TEXT"
  | "IMAGE"
  | "AUDIO"
  | "DOCUMENT"
  | "VIDEO"
  | "LOCATION"
  | "CONTACTS"
  | "STICKER"
  | "REACTION";

/**
 * Tipo de WhatsApp Cloud (`messages[].type`) → nuestro enum.
 *
 * `interactive` y `button` van a TEXT A PROPÓSITO: el parser ya les saca el título a texto, y
 * para el dueño son un mensaje escrito. `unsupported` es lo que manda Meta cuando el cliente
 * envía algo que la Cloud API no entrega (encuestas, mensajes efímeros): no hay nada que
 * mostrar, pero el mensaje EXISTE en el chat del cliente y ocultarlo descoloca la conversación.
 */
export function mapInboundType(waType: string | null | undefined): TipoDeMensaje {
  switch (String(waType ?? "").toLowerCase()) {
    case "audio":
    case "voice":
      return "AUDIO";
    case "image":
      return "IMAGE";
    case "document":
      return "DOCUMENT";
    case "video":
      return "VIDEO";
    case "sticker":
      return "STICKER";
    case "location":
      return "LOCATION";
    case "contacts":
      return "CONTACTS";
    case "reaction":
      return "REACTION";
    default:
      // text, button, interactive, unsupported, unknown y lo que Meta invente.
      return "TEXT";
  }
}

/**
 * Tipo de adjunto de Instagram/Messenger (`attachments[].type`) → nuestro enum.
 *
 * `like_heart` es el corazón de Instagram: Meta lo manda como un adjunto propio y es, a todos
 * los efectos, un sticker.
 */
export function mapMessagingAttachmentType(tipo: string | null | undefined): TipoDeMensaje {
  switch (String(tipo ?? "").toLowerCase()) {
    case "image":
      return "IMAGE";
    case "audio":
      return "AUDIO";
    case "video":
      return "VIDEO";
    case "file":
      return "DOCUMENT";
    case "sticker":
    case "like_heart":
      return "STICKER";
    case "location":
      return "LOCATION";
    default:
      return "TEXT";
  }
}

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function leer(payload: unknown, ...camino: string[]): unknown {
  let v: unknown = payload;
  for (const k of camino) {
    if (!v || typeof v !== "object") return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/**
 * Lo que se guarda en `body` cuando el mensaje NO trae texto propio.
 *
 * En castellano y con un ícono, porque esto se ve en DOS lugares a la vez: la burbuja del chat
 * y la vista previa de la lista. El ícono es lo que hace legible una lista de conversaciones de
 * un vistazo. NO lleva corchetes: los corchetes eran una marca de depuración que se escapó al
 * producto.
 *
 * El `caption` de una foto o un video manda sobre el placeholder: si el cliente escribió algo,
 * eso es el mensaje.
 */
export function mediaPlaceholder(type: TipoDeMensaje, payload?: unknown): string {
  switch (type) {
    case "AUDIO":
      return "🎤 Nota de voz";
    case "IMAGE": {
      const cap = texto(leer(payload, "image", "caption"));
      return cap ? `📷 ${cap}` : "📷 Foto";
    }
    case "STICKER":
      return "Sticker";
    case "VIDEO": {
      const cap = texto(leer(payload, "video", "caption"));
      return cap ? `🎬 ${cap}` : "🎬 Video";
    }
    case "DOCUMENT": {
      const nombre = texto(leer(payload, "document", "filename"));
      return nombre ? `📄 ${nombre}` : "📄 Documento";
    }
    case "LOCATION": {
      const nombre = texto(leer(payload, "location", "name"));
      const dir = texto(leer(payload, "location", "address"));
      const detalle = nombre && dir && nombre !== dir ? `${nombre} — ${dir}` : (nombre ?? dir);
      return detalle ? `📍 ${detalle}` : "📍 Ubicación";
    }
    case "CONTACTS": {
      const nombre = texto(leer(payload, "contacts", "0", "name", "formatted_name"));
      return nombre ? `👤 ${nombre}` : "👤 Contacto compartido";
    }
    case "REACTION": {
      const emoji = texto(leer(payload, "reaction", "emoji"));
      return emoji ? `Reaccionó ${emoji}` : "Reaccionó";
    }
    default:
      return "Mensaje no compatible";
  }
}

/** Longitud de la vista previa de una transcripción (el resto se corta con «…»). */
export const LARGO_VISTA_PREVIA_TRANSCRIPCION = 60;

/**
 * La línea que se ve en la LISTA de conversaciones.
 *
 * Una nota de voz transcrita es el caso que vale la pena mirar: el `body` pasa a ser el
 * transcript (lo quiere el agente y lo quiere el dueño al abrir el chat), pero en la lista, sin
 * el 🎤, se lee como si el cliente hubiera ESCRITO eso. Por eso la vista previa conserva el
 * ícono y recorta.
 */
export function lastMessagePreview(input: {
  type: TipoDeMensaje;
  body?: string | null;
  payload?: unknown;
  transcribed?: boolean;
}): string {
  const cuerpo = texto(input.body);
  if (input.type === "AUDIO" && input.transcribed && cuerpo) {
    const corto = cuerpo.slice(0, LARGO_VISTA_PREVIA_TRANSCRIPCION);
    return `🎤 ${corto}${cuerpo.length > LARGO_VISTA_PREVIA_TRANSCRIPCION ? "…" : ""}`;
  }
  if (input.type === "TEXT") return cuerpo ?? "Mensaje no compatible";
  // Un caption ya viene dentro del placeholder; un body propio de otro tipo no debería existir.
  return cuerpo && input.type !== "AUDIO" && !cuerpo.startsWith("[") ? cuerpo : mediaPlaceholder(input.type, input.payload);
}

/**
 * Lo que LEE EL AGENTE cuando el mensaje no trae texto.
 *
 * Distinto del placeholder de pantalla a propósito: acá hay que decirle al modelo qué pasó y
 * qué puede hacer. Un sticker NO se le manda a visión —no vale el crédito, decisión del
 * dueño— así que lo único honesto es nombrarlo. Para la ubicación sí van las coordenadas:
 * es información útil y gratis.
 */
export function placeholderParaElAgente(type: TipoDeMensaje, payload?: unknown): string {
  switch (type) {
    case "STICKER":
      return "[el contacto envió un sticker]";
    case "VIDEO":
      return "[el contacto envió un video. No puedes verlo: pídele que te cuente por escrito lo que necesita.]";
    case "AUDIO":
      return "[el contacto envió una nota de voz que no se pudo transcribir. Pídele que te escriba lo que necesita.]";
    case "IMAGE":
      return "[el contacto envió una imagen]";
    case "LOCATION": {
      const nombre = texto(leer(payload, "location", "name"));
      const dir = texto(leer(payload, "location", "address"));
      const lat = leer(payload, "location", "latitude");
      const lng = leer(payload, "location", "longitude");
      const detalle = [nombre, dir].filter(Boolean).join(", ") || (lat != null && lng != null ? `${lat}, ${lng}` : null);
      return detalle ? `[el contacto compartió su ubicación: ${detalle}]` : "[el contacto compartió su ubicación]";
    }
    case "CONTACTS": {
      const nombre = texto(leer(payload, "contacts", "0", "name", "formatted_name"));
      return nombre ? `[el contacto compartió la ficha de ${nombre}]` : "[el contacto compartió una ficha de contacto]";
    }
    case "DOCUMENT": {
      const nombre = texto(leer(payload, "document", "filename"));
      return nombre ? `[el contacto envió un documento llamado "${nombre}"]` : "[el contacto envió un documento]";
    }
    default:
      return "[el contacto envió un mensaje que no se puede mostrar]";
  }
}

/** Una reacción de WhatsApp: a qué mensaje y con qué emoji. `null` si el payload no sirve. */
export function leerReaccion(payload: unknown): { externalId: string; emoji: string | null } | null {
  const id = texto(leer(payload, "reaction", "message_id"));
  if (!id) return null;
  // Quitar la reacción llega con emoji vacío: es un evento válido, no un payload roto.
  return { externalId: id, emoji: texto(leer(payload, "reaction", "emoji")) };
}

/**
 * Agrega (o quita) una reacción sobre el `payload.reactions` del mensaje reaccionado.
 * Pura para poder probar el caso de siempre: la misma persona cambia de emoji.
 */
export function aplicarReaccion(
  payloadDelMensaje: unknown,
  r: { emoji: string | null; from: string; at: string },
): { reactions: Array<{ emoji: string; from: string; at: string }> } {
  const previas = leer(payloadDelMensaje, "reactions");
  const lista = Array.isArray(previas)
    ? (previas as Array<{ emoji?: unknown; from?: unknown; at?: unknown }>)
        .filter((x) => texto(x?.emoji) && texto(x?.from))
        .map((x) => ({ emoji: String(x.emoji), from: String(x.from), at: texto(x.at) ?? "" }))
    : [];
  // Una persona tiene UNA reacción por mensaje: la nueva reemplaza a la suya anterior.
  const sinLaSuya = lista.filter((x) => x.from !== r.from);
  return { reactions: r.emoji ? [...sinLaSuya, { emoji: r.emoji, from: r.from, at: r.at }] : sinLaSuya };
}
