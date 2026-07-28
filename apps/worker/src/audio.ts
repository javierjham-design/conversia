import { getEnv } from "@conversia/config";
import { transcribeAudio } from "@conversia/agents";

const MAX_BYTES = 24 * 1024 * 1024; // límite de Whisper (25MB) con margen

/**
 * Descarga una nota de voz de WhatsApp (por media id) usando el token de Meta y
 * la transcribe con OpenAI. Devuelve el texto o null si no se pudo (sin llaves,
 * error de red, archivo muy grande…) — el llamador degrada a "[audio]".
 */
export async function transcribeWhatsappAudio(mediaId: string): Promise<string | null> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY || !env.META_ACCESS_TOKEN) return null;
  try {
    // 1) Resolver la URL temporal del media
    const metaRes = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(mediaId)}`, {
      headers: { authorization: `Bearer ${env.META_ACCESS_TOKEN}` },
    });
    if (!metaRes.ok) return null;
    const meta: any = await metaRes.json();
    if (!meta?.url) return null;

    // 2) Descargar los bytes (requiere el mismo Bearer)
    const audioRes = await fetch(meta.url, { headers: { authorization: `Bearer ${env.META_ACCESS_TOKEN}` } });
    if (!audioRes.ok) return null;
    const buf = Buffer.from(await audioRes.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;

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
