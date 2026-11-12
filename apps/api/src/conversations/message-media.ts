import type { MessageMedia, MessageMediaKind } from "@conversia/types";

/**
 * DE `type` + `payload` CRUDO A ALGO QUE UNA PANTALLA PUEDE DIBUJAR — puro y testeable.
 *
 * Cada panel tenía que saber por su cuenta que una imagen entrante vive en `payload.image.id`,
 * una saliente en `payload.mediaId`, un sticker en `payload.sticker.id` y la nota de voz en
 * `payload.audio.id` **o** `payload.voice.id`. Esa lógica estaba copiada dentro de los tres
 * endpoints de la API y faltaba entera en la bandeja de Conversia, que por eso mostraba
 * «[imagen]» y nada más.
 *
 * Se DERIVA, no se guarda: nada que migrar y nada que se pueda desincronizar del crudo, que
 * sigue siendo la fuente de verdad y se sigue devolviendo tal cual (TuBot lo usa).
 */

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function numero(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** El `kind` que le corresponde a cada `MessageType`. `null` = no hay medio que mostrar. */
export function kindDeTipo(type: string): MessageMediaKind | null {
  switch (type) {
    case "AUDIO":
      return "audio";
    case "IMAGE":
      return "image";
    case "STICKER":
      return "sticker";
    case "VIDEO":
      return "video";
    case "DOCUMENT":
      return "document";
    case "LOCATION":
      return "location";
    case "CONTACTS":
      return "contacts";
    default:
      return null;
  }
}

/**
 * Qué endpoint sirve cada medio. Los stickers se sirven por `/image` a propósito: para Meta
 * son un media id más y ese endpoint ya los bajaba bien; abrirles una ruta propia sería otro
 * camino que mantener para exactamente el mismo comportamiento.
 */
const RUTA: Record<MessageMediaKind, "audio" | "image" | "video" | "document" | null> = {
  audio: "audio",
  image: "image",
  sticker: "image",
  video: "video",
  document: "document",
  location: null,
  contacts: null,
};

/** El media id de Meta, mire donde mire el payload (entrante, saliente o sticker). */
export function mediaIdDePayload(kind: MessageMediaKind | null, payload: Record<string, unknown>): string | null {
  const p = payload as Record<string, any>;
  switch (kind) {
    case "audio":
      return texto(p?.audio?.id) ?? texto(p?.voice?.id) ?? texto(p?.mediaId);
    case "image":
      return texto(p?.image?.id) ?? texto(p?.mediaId);
    case "sticker":
      return texto(p?.sticker?.id) ?? texto(p?.mediaId);
    case "video":
      return texto(p?.video?.id) ?? texto(p?.mediaId);
    case "document":
      return texto(p?.document?.id) ?? texto(p?.mediaId);
    default:
      return null;
  }
}

function contactos(p: Record<string, any>): MessageMedia["contacts"] {
  const lista = Array.isArray(p?.contacts) ? p.contacts : null;
  if (!lista?.length) return null;
  const out = lista
    .map((c: any) => {
      const name = texto(c?.name?.formatted_name) ?? texto(c?.name?.first_name) ?? null;
      const phones = Array.isArray(c?.phones)
        ? c.phones.map((t: any) => texto(t?.phone) ?? texto(t?.wa_id)).filter((x: string | null): x is string => !!x)
        : [];
      return name || phones.length ? { name: name ?? "Contacto", phones } : null;
    })
    .filter((x): x is { name: string; phones: string[] } => !!x);
  return out.length ? out : null;
}

function reacciones(p: Record<string, any>): MessageMedia["reactions"] {
  const lista = Array.isArray(p?.reactions) ? p.reactions : null;
  if (!lista?.length) return null;
  const out = lista
    .map((r: any) => (texto(r?.emoji) ? { emoji: String(r.emoji), at: texto(r?.at) } : null))
    .filter((x): x is { emoji: string; at: string | null } => !!x);
  return out.length ? out : null;
}

export interface MensajeParaMedia {
  id: string;
  type: string;
  body?: string | null;
  payload?: unknown;
}

/**
 * Arma el objeto `media` de un mensaje.
 *
 * `conversationId` va como argumento porque la URL es relativa a la conversación: el panel la
 * concatena a `apiBase()` y le pone su Bearer. Nunca viaja un token de Meta al navegador — el
 * archivo lo baja la API con el token del canal, como ya hacían los endpoints existentes.
 */
export function derivarMedia(conversationId: string, m: MensajeParaMedia): MessageMedia {
  const p = ((m.payload ?? {}) as Record<string, any>) || {};
  const kind = kindDeTipo(m.type);
  const ruta = kind ? RUTA[kind] : null;
  const mediaId = mediaIdDePayload(kind, p);
  // Sin media id no hay archivo que pedir: una URL que da 404 seguro es peor que ninguna.
  const url = ruta && mediaId ? `/conversations/${conversationId}/messages/${m.id}/${ruta}` : null;

  const transcrito = p?.transcribed === true;
  const loc = p?.location;
  const lat = numero(loc?.latitude);
  const lng = numero(loc?.longitude);

  return {
    kind,
    url,
    mime:
      texto(p?.image?.mime_type) ??
      texto(p?.sticker?.mime_type) ??
      texto(p?.video?.mime_type) ??
      texto(p?.document?.mime_type) ??
      texto(p?.audio?.mime_type) ??
      texto(p?.voice?.mime_type) ??
      texto(p?.mimeType) ??
      null,
    filename: texto(p?.document?.filename),
    caption: texto(p?.image?.caption) ?? texto(p?.video?.caption) ?? texto(p?.document?.caption),
    animated: kind === "sticker" ? p?.sticker?.animated === true : null,
    durationSec: numero(p?.audio?.duration) ?? numero(p?.voice?.duration) ?? numero(p?.durationSec),
    // El transcript ES el body cuando la transcripción corrió: así la UI puede mostrar el
    // reproductor Y el texto sin adivinar cuál de los dos es.
    transcript: kind === "audio" && transcrito ? texto(m.body) : null,
    location:
      kind === "location" && lat !== null && lng !== null
        ? { lat, lng, name: texto(loc?.name), address: texto(loc?.address) }
        : null,
    contacts: kind === "contacts" ? contactos(p) : null,
    reactions: reacciones(p),
  };
}
