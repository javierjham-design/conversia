import { NotFoundException } from "@nestjs/common";
import { MEDIA_EXPIRED } from "@conversia/types";
import { getEnv, withAppSecretProof } from "@conversia/config";

/**
 * BAJAR UN ARCHIVO DE META — un solo camino para los cuatro endpoints de medios.
 *
 * Bajar un media de la Cloud API son SIEMPRE dos llamadas: una al media id para que Meta
 * devuelva una URL firmada y su mime, y otra a esa URL con el mismo Bearer. Ese par estaba
 * copiado en `/audio`, `/image` y `/document`, cada copia con su propio texto de error y su
 * propio `cache-control`. Agregar `/video` habría hecho cuatro.
 *
 * Lo que unifica, además del código: **el 404 por expiración**. Meta borra los medios a los 30
 * días y antes eso llegaba al panel como un texto suelto dentro de un 404 genérico, así que la
 * UI no podía distinguir «este archivo ya no existe» —que es normal y hay que explicarlo con
 * calma— de «algo se rompió». Ahora sale con `code: "MEDIA_EXPIRED"`.
 */

/** 404 que la UI SÍ puede interpretar. */
export class MediaExpiradoError extends NotFoundException {
  constructor(mensaje = "Este archivo ya no está disponible: Meta solo los guarda un tiempo.") {
    super({ code: MEDIA_EXPIRED, message: mensaje });
  }
}

export interface MediaDescargado {
  buffer: Buffer;
  mime: string;
  /** Lo que Meta dice que pesa, cuando lo dice. */
  sizeBytes: number;
}

/**
 * Pide el archivo a Meta y lo devuelve COMPLETO en memoria.
 *
 * En memoria a propósito: los medios de WhatsApp tienen techo duro (16 MB el más grande, el
 * video) y tenerlo entero es lo que permite mandar un `content-length` de verdad. Sin él, el
 * navegador no sabe cuánto dura un audio hasta terminar de bajarlo — de ahí venía el parche
 * `fixStreamedDuration` del panel de TuBot.
 *
 * `limiteBytes` corta ANTES de leer el cuerpo cuando Meta ya declara el tamaño.
 */
export async function descargarMediaDeMeta(
  mediaId: string,
  token: string,
  opts: { limiteBytes?: number } = {},
): Promise<MediaDescargado> {
  const env = getEnv();
  const metaRes = await fetch(
    withAppSecretProof(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, token),
    { headers: { authorization: `Bearer ${token}` } },
  );
  const meta: any = await metaRes.json().catch(() => ({}));
  // Sin URL firmada: o Meta ya lo borró, o el token no alcanza. Para el dueño es lo mismo.
  if (!meta?.url) throw new MediaExpiradoError();

  const declarado = Number(meta?.file_size ?? 0);
  if (opts.limiteBytes && declarado > opts.limiteBytes) {
    throw new NotFoundException(`El archivo pesa más de lo que podemos servir (${Math.round(opts.limiteBytes / 1024 / 1024)} MB).`);
  }

  const archivo = await fetch(meta.url, { headers: { authorization: `Bearer ${token}` } });
  if (!archivo.ok) throw new MediaExpiradoError("No se pudo obtener el archivo desde Meta.");
  const buffer = Buffer.from(await archivo.arrayBuffer());
  if (opts.limiteBytes && buffer.byteLength > opts.limiteBytes) {
    throw new NotFoundException(`El archivo pesa más de lo que podemos servir (${Math.round(opts.limiteBytes / 1024 / 1024)} MB).`);
  }
  return { buffer, mime: String(meta.mime_type ?? "application/octet-stream"), sizeBytes: buffer.byteLength };
}

/**
 * Cabeceras de caché de los cuatro endpoints.
 *
 * Un día e `immutable` porque **el media id de Meta no cambia nunca**: el contenido detrás de
 * ese id es el mismo archivo para siempre. Antes era una hora, lo que hacía que el panel
 * volviera a pedir la misma foto varias veces por sesión.
 */
export const CACHE_DE_MEDIA = "private, max-age=86400, immutable";

/** Techo de cada tipo, el mismo que aplica WhatsApp al recibirlos. */
export const LIMITES_BYTES = {
  image: 5 * 1024 * 1024,
  sticker: 5 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
} as const;
