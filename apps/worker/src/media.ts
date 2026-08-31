import { getEnv, withAppSecretProof } from "@conversia/config";

/** Tope de imagen a descargar para visión (los modelos la reescalan igual). */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface DownloadedMedia {
  dataBase64: string;
  mimeType: string;
}

/** Tope de documento a descargar para extraer su texto (PDF, etc.). */
const MAX_DOC_BYTES = 15 * 1024 * 1024;

/**
 * Descarga un media de WhatsApp (por media id) SIN restricción de formato — para
 * documentos (PDF, texto…) de los que luego extraemos texto para que el bot los lea.
 * Devuelve los bytes crudos + mime, o null si no se pudo (sin token, error, muy grande).
 */
export async function downloadWhatsappMedia(
  mediaId: string,
  accessToken?: string | null,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const env = getEnv();
  const token = accessToken || env.META_ACCESS_TOKEN;
  if (!token || !mediaId) return null;
  try {
    const metaRes = await fetch(
      withAppSecretProof(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, token),
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!metaRes.ok) return null;
    const meta: any = await metaRes.json();
    if (!meta?.url) return null;
    const mimeType = String(meta.mime_type ?? "application/octet-stream").split(";")[0].trim();
    const bytesRes = await fetch(meta.url, { headers: { authorization: `Bearer ${token}` } });
    if (!bytesRes.ok) return null;
    const buf = Buffer.from(await bytesRes.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_DOC_BYTES) return null;
    return { buffer: buf, mimeType };
  } catch (err) {
    console.error("✖ downloadWhatsappMedia:", (err as Error).message);
    return null;
  }
}

/**
 * Descarga un media de WhatsApp (por media id) y lo devuelve en base64 + mime,
 * para pasarlo a un modelo con visión. Igual patrón que el audio: resolver la URL
 * temporal con el token de la WABA receptora y bajar los bytes con el mismo Bearer.
 * Devuelve null si no se pudo (sin token, error, formato no soportado, muy grande).
 */
export async function downloadWhatsappImage(mediaId: string, accessToken?: string | null): Promise<DownloadedMedia | null> {
  const env = getEnv();
  const token = accessToken || env.META_ACCESS_TOKEN;
  if (!token || !mediaId) return null;
  try {
    const metaRes = await fetch(
      withAppSecretProof(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, token),
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!metaRes.ok) return null;
    const meta: any = await metaRes.json();
    if (!meta?.url) return null;
    const mimeType = String(meta.mime_type ?? "image/jpeg").split(";")[0].trim();
    if (!ALLOWED_IMAGE_MIME.has(mimeType)) return null;

    const bytesRes = await fetch(meta.url, { headers: { authorization: `Bearer ${token}` } });
    if (!bytesRes.ok) return null;
    const buf = Buffer.from(await bytesRes.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
    return { dataBase64: buf.toString("base64"), mimeType };
  } catch (err) {
    console.error("✖ downloadWhatsappImage:", (err as Error).message);
    return null;
  }
}
