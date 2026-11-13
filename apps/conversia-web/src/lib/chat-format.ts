/**
 * LO DECIDIBLE DEL CHAT — sin React, sin DOM, sin red.
 *
 * Separar esto de las burbujas es lo que permite probar de verdad las reglas que hacen que un
 * hilo se lea como un chat y no como una lista de filas: cuándo empieza un día nuevo, cuándo
 * dos mensajes son del mismo bloque, qué tick corresponde a cada estado, cómo se lee una
 * duración. Son todas reglas con casos de borde (la medianoche, el cambio de autor, el audio
 * de más de una hora) y ninguna necesita un navegador para comprobarse.
 */

/** Tipos de mensaje que NO son del cliente ni del equipo: no llevan burbuja normal. */
export const TIPOS_SIN_BURBUJA = new Set(["SYSTEM"]);

/** `0:42`, `1:05:30`. Nunca `NaN:NaN`, que es lo que se ve si el audio aún no cargó. */
export function formatearDuracion(segundos: number | null | undefined): string {
  if (typeof segundos !== "number" || !Number.isFinite(segundos) || segundos < 0) return "0:00";
  const s = Math.floor(segundos % 60);
  const m = Math.floor((segundos / 60) % 60);
  const h = Math.floor(segundos / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

function mismaFecha(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * «Hoy», «Ayer» o «lunes 10 de noviembre».
 *
 * `ahora` se inyecta para poder probarlo: una etiqueta que dice «Hoy» es correcta o no según
 * el día en que se mire, y un test con `new Date()` dentro deja de valer mañana — que es
 * exactamente cómo un test con una fecha escrita a mano tumbó `main` el 10-nov.
 */
export function etiquetaDeDia(iso: string, ahora: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (mismaFecha(d, ahora)) return "Hoy";
  const ayer = new Date(ahora);
  ayer.setDate(ayer.getDate() - 1);
  if (mismaFecha(d, ayer)) return "Ayer";
  const mismoAño = d.getFullYear() === ahora.getFullYear();
  return new Intl.DateTimeFormat("es-CL", {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(mismoAño ? {} : { year: "numeric" }),
  }).format(d);
}

/** ¿Hay que dibujar un separador de día ANTES de este mensaje? */
export function abreDia(actual: string, anterior: string | null | undefined): boolean {
  if (!anterior) return true;
  const a = new Date(actual);
  const b = new Date(anterior);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return false;
  return !mismaFecha(a, b);
}

export const MINUTOS_DE_AGRUPACION = 3;

export interface MensajeAgrupable {
  direction: "INBOUND" | "OUTBOUND";
  authorType?: string | null;
  authorName?: string | null;
  visibility?: string | null;
  createdAt: string;
}

/**
 * ¿Este mensaje sigue el bloque del anterior?
 *
 * Mismo autor y dentro de 3 minutos. «Mismo autor» no es solo la dirección: una nota interna
 * del equipo y una respuesta de la IA son los dos OUTBOUND y no pueden quedar en el mismo
 * bloque, porque uno lo ve el cliente y el otro no.
 */
export function siguenJuntos(actual: MensajeAgrupable, anterior: MensajeAgrupable | null | undefined): boolean {
  if (!anterior) return false;
  if (actual.direction !== anterior.direction) return false;
  if ((actual.authorType ?? null) !== (anterior.authorType ?? null)) return false;
  if ((actual.visibility ?? null) !== (anterior.visibility ?? null)) return false;
  if ((actual.authorName ?? null) !== (anterior.authorName ?? null)) return false;
  const a = new Date(actual.createdAt).getTime();
  const b = new Date(anterior.createdAt).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (abreDia(actual.createdAt, anterior.createdAt)) return false;
  return Math.abs(a - b) <= MINUTOS_DE_AGRUPACION * 60_000;
}

export interface Tick {
  simbolo: string;
  etiqueta: string;
  /** true = se pinta en color de acento (leído). */
  destacado: boolean;
}

/** El tick de un mensaje SALIENTE. `null` para los entrantes: nadie acusa recibo al revés. */
export function tickDeEstado(status: string, direction: "INBOUND" | "OUTBOUND"): Tick | null {
  if (direction !== "OUTBOUND") return null;
  switch (status) {
    case "PENDING":
    case "SUGGESTED":
      return { simbolo: "🕐", etiqueta: "Pendiente", destacado: false };
    case "SENDING":
      return { simbolo: "🕐", etiqueta: "Enviando", destacado: false };
    case "SENT":
      return { simbolo: "✓", etiqueta: "Enviado", destacado: false };
    case "DELIVERED":
      return { simbolo: "✓✓", etiqueta: "Entregado", destacado: false };
    case "READ":
      return { simbolo: "✓✓", etiqueta: "Leído", destacado: true };
    case "FAILED":
      return { simbolo: "⚠", etiqueta: "No se envió", destacado: false };
    default:
      return null;
  }
}

/**
 * Traduce los `[tipo]` que quedaron en la base antes de D1.
 *
 * El script de reparación corrige los mensajes, pero a propósito NO toca
 * `lastMessagePreview` histórico. Y aunque lo corrigiera, siempre puede quedar una fila vieja:
 * la pantalla tiene que saber leerlas igual. Si no reconoce el texto, lo devuelve tal cual —
 * nunca se inventa un contenido.
 */
const VIEJOS: Record<string, string> = {
  "[image]": "📷 Foto",
  "[imagen]": "📷 Foto",
  "[audio]": "🎤 Nota de voz",
  "[audio de voz]": "🎤 Nota de voz",
  "[voice]": "🎤 Nota de voz",
  "[video]": "🎬 Video",
  "[document]": "📄 Documento",
  "[documento]": "📄 Documento",
  "[sticker]": "Sticker",
  "[location]": "📍 Ubicación",
  "[contacts]": "👤 Contacto compartido",
  "[adjunto]": "Adjunto",
};

export function traducirPlaceholderViejo(texto: string | null | undefined): string {
  const t = (texto ?? "").trim();
  if (!t) return "";
  return VIEJOS[t.toLowerCase()] ?? t;
}

/** Familia de un documento, para elegir ícono sin una librería entera. */
export type FamiliaDocumento = "pdf" | "word" | "excel" | "imagen" | "comprimido" | "otro";

export function familiaDeMime(mime: string | null | undefined, filename?: string | null): FamiliaDocumento {
  const m = (mime ?? "").toLowerCase();
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  if (m.includes("pdf") || ext === "pdf") return "pdf";
  if (m.includes("word") || m.includes("msword") || ["doc", "docx", "odt"].includes(ext)) return "word";
  if (m.includes("excel") || m.includes("spreadsheet") || ["xls", "xlsx", "csv", "ods"].includes(ext)) return "excel";
  if (m.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "imagen";
  if (m.includes("zip") || m.includes("compressed") || ["zip", "rar", "7z"].includes(ext)) return "comprimido";
  return "otro";
}

export const ICONO_DOCUMENTO: Record<FamiliaDocumento, string> = {
  pdf: "📕",
  word: "📘",
  excel: "📗",
  imagen: "🖼️",
  comprimido: "🗜️",
  otro: "📄",
};

/** «1,2 MB». null cuando no sabemos el tamaño: inventarlo sería peor que no mostrarlo. */
export function formatearTamaño(bytes: number | null | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

/**
 * ¿El mensaje es SOLO emojis (hasta tres)? Entonces se pintan grandes y sin burbuja, como en
 * cualquier chat. Se cuenta por puntos de código: un emoji puede ocupar varios `char`.
 */
export function esSoloEmojis(texto: string | null | undefined): boolean {
  const t = (texto ?? "").trim();
  if (!t) return false;
  const sinVariantes = t.replace(/[️‍]/g, "");
  const puntos = [...sinVariantes];
  if (!puntos.length || puntos.length > 3) return false;
  return puntos.every((c) => /\p{Extended_Pictographic}/u.test(c));
}

export interface Trozo {
  tipo: "texto" | "enlace";
  valor: string;
}

/**
 * Parte un texto en trozos para volver clicables los enlaces, SIN meter HTML en el DOM.
 *
 * Devolver trozos y que React los pinte es lo que evita un `dangerouslySetInnerHTML` sobre
 * texto que escribió un desconocido por WhatsApp.
 */
export function trozosConEnlaces(texto: string): Trozo[] {
  const out: Trozo[] = [];
  const re = /(https?:\/\/[^\s<>"']+)/gi;
  let ultimo = 0;
  for (const m of texto.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > ultimo) out.push({ tipo: "texto", valor: texto.slice(ultimo, i) });
    // Un punto o una coma final casi nunca son parte del enlace.
    let url = m[0];
    let cola = "";
    while (/[.,;:!?)]$/.test(url)) {
      cola = url.slice(-1) + cola;
      url = url.slice(0, -1);
    }
    out.push({ tipo: "enlace", valor: url });
    if (cola) out.push({ tipo: "texto", valor: cola });
    ultimo = i + m[0].length;
  }
  if (ultimo < texto.length) out.push({ tipo: "texto", valor: texto.slice(ultimo) });
  return out.length ? out : [{ tipo: "texto", valor: texto }];
}

/** Texto accesible de cada burbuja, para lectores de pantalla. */
export function etiquetaAccesible(kind: string | null, durationSec?: number | null): string {
  switch (kind) {
    case "audio":
      return durationSec ? `Nota de voz de ${formatearDuracion(durationSec)}` : "Nota de voz";
    case "image":
      return "Foto";
    case "sticker":
      return "Sticker";
    case "video":
      return "Video";
    case "document":
      return "Documento";
    case "location":
      return "Ubicación";
    case "contacts":
      return "Contacto compartido";
    default:
      return "Mensaje";
  }
}
