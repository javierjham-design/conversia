/**
 * ADJUNTOS PARA CONVI — las decisiones, separadas del componente para poder probarlas.
 *
 * Lo que el dueño quiere hacer es obvio: en vez de teclear su lista de precios, mandarle la
 * foto; en vez de escribir tres párrafos, dictarlos; en vez de copiar su web, pegar el
 * enlace. Lo que no es obvio es lo que hay que cuidar:
 *
 *  - Una foto de un teléfono moderno pesa 4-8 MB. Subirla entera es caro, lento, y el
 *    modelo la achica igual antes de mirarla. Acá se reduce EN EL NAVEGADOR.
 *  - Un archivo que el servidor va a rechazar hay que atajarlo antes, con una frase que se
 *    entienda, no con un error del servidor.
 *  - El tipo (imagen / audio / documento) lo decide el navegador mirando el mime, no el
 *    nombre: un ".jpg" renombrado a ".pdf" no tiene que romper nada.
 */

/** Mismos topes que el servidor (`apps/api/src/assistant/adjuntos.ts`). */
export const MAX_ADJUNTOS = 3;
export const MAX_BYTES_ADJUNTO = 3 * 1024 * 1024;
/** Lado mayor al que se reducen las fotos. Más que esto el modelo lo descarta igual. */
export const LADO_MAXIMO = 1400;

export type TipoAdjunto = "imagen" | "audio" | "documento";

export interface AdjuntoListo {
  tipo: TipoAdjunto;
  nombre: string;
  mime: string;
  dataBase64: string;
  /** Bytes ya reducidos, para mostrarlos y para el tope. */
  bytes: number;
}

const IMAGEN = /^image\/(jpeg|png|webp|gif)$/i;
const AUDIO = /^(audio\/(ogg|mpeg|mp4|wav|x-wav|webm)|video\/webm)$/i;
const DOCUMENTO =
  /^(application\/pdf|text\/(plain|csv|markdown)|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-excel)$/i;

/** Qué es esto, según el mime que declara el navegador. `null` = no sabemos leerlo. */
export function tipoDeArchivo(mime: string, nombre = ""): TipoAdjunto | null {
  const m = (mime || "").toLowerCase().split(";")[0].trim();
  if (IMAGEN.test(m)) return "imagen";
  if (AUDIO.test(m)) return "audio";
  if (DOCUMENTO.test(m)) return "documento";
  // Algunos navegadores mandan mime vacío para .md o .csv bajados de otro sitio.
  if (!m && /\.(txt|csv|md)$/i.test(nombre)) return "documento";
  return null;
}

/** Lo que se le dice al dueño cuando un archivo no sirve. `null` = sirve. */
export function porQueNoPuedo(archivo: { type: string; name: string; size: number }, yaHay: number): string | null {
  if (yaHay >= MAX_ADJUNTOS) return `Puedo mirar ${MAX_ADJUNTOS} archivos por mensaje. Mándame el resto en el siguiente.`;
  if (!tipoDeArchivo(archivo.type, archivo.name)) {
    return `No sé leer “${archivo.name}”. Puedo con fotos, PDF, planillas, texto y notas de voz.`;
  }
  // Las imágenes se achican antes de subir, así que su tamaño original no manda.
  if (tipoDeArchivo(archivo.type, archivo.name) !== "imagen" && archivo.size > MAX_BYTES_ADJUNTO) {
    return `“${archivo.name}” pesa más de 3 MB. Mándame solo la parte que importa.`;
  }
  return null;
}

/** Nombre corto para la ficha del adjunto (un nombre largo rompe el chat). */
export function nombreCorto(nombre: string, max = 28): string {
  const limpio = nombre.trim() || "archivo";
  if (limpio.length <= max) return limpio;
  const punto = limpio.lastIndexOf(".");
  const ext = punto > 0 && limpio.length - punto <= 6 ? limpio.slice(punto) : "";
  return `${limpio.slice(0, max - ext.length - 1)}…${ext}`;
}

/** "1,2 MB" / "340 KB". */
export function pesoLegible(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Dimensiones reducidas manteniendo la proporción. Nunca agranda. */
export function medidaReducida(ancho: number, alto: number, lado = LADO_MAXIMO): { ancho: number; alto: number } {
  const mayor = Math.max(ancho, alto);
  if (!mayor || mayor <= lado) return { ancho, alto };
  const f = lado / mayor;
  return { ancho: Math.max(1, Math.round(ancho * f)), alto: Math.max(1, Math.round(alto * f)) };
}

/** Quita el prefijo `data:...;base64,` que devuelve FileReader. */
export function soloBase64(dataUrl: string): string {
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}
