import { getEnv, withAppSecretProof } from "@conversia/config";
import { transcribeAudio } from "@conversia/agents";

const MAX_BYTES = 24 * 1024 * 1024; // límite de Whisper (25MB) con margen

/**
 * Descarga una nota de voz de WhatsApp (por media id) usando el token de Meta y
 * la transcribe con OpenAI. Devuelve el texto o null si no se pudo (sin llaves,
 * error de red, archivo muy grande…) — el llamador degrada a "[audio]".
 */
export async function transcribeWhatsappAudio(
  mediaId: string,
  accessToken?: string | null,
  /**
   * D4.c — si viene, los BYTES ya descargados se guardan al ingreso en vez de esperar al
   * primer uso. No es una excepción caprichosa: acá el archivo ya está en memoria porque
   * hace falta para transcribir, así que guardarlo no cuesta una segunda descarga. Sin esto,
   * la primera vez que el dueño abre la nota de voz la volvemos a pedir a Meta entera.
   */
  guardar?: (bytes: Buffer, mime: string) => Promise<void>,
): Promise<string | null> {
  const env = getEnv();
  // El media pertenece a la WABA receptora → su token; fallback al global.
  const token = accessToken || env.META_ACCESS_TOKEN;
  if (!env.OPENAI_API_KEY || !token) return null;
  try {
    // 1) Resolver la URL temporal del media
    const metaRes = await fetch(withAppSecretProof(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, token), {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) return null;
    const meta: any = await metaRes.json();
    if (!meta?.url) return null;

    // 2) Descargar los bytes (requiere el mismo Bearer)
    const audioRes = await fetch(meta.url, { headers: { authorization: `Bearer ${token}` } });
    if (!audioRes.ok) return null;
    const buf = Buffer.from(await audioRes.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    // Guardar antes de transcribir: si Whisper falla, el audio igual queda a salvo.
    if (guardar) await guardar(buf, String(meta?.mime_type ?? "audio/ogg")).catch(() => undefined);

    // 3) Transcribir
    const { text } = await transcribeAudio({
      apiKey: env.OPENAI_API_KEY,
      audio: buf,
      filename: "audio.ogg",
      model: env.AI_TRANSCRIBE_MODEL,
      language: "es",
    });
    return text || null;
  } catch (err) {
    console.error("✖ transcribeWhatsappAudio:", (err as Error).message);
    return null;
  }
}
