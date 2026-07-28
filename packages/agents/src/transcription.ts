import OpenAI, { toFile } from "openai";

/**
 * Transcribe audio (notas de voz de WhatsApp) con OpenAI. Modelo configurable:
 * `whisper-1` (estable) o `gpt-4o-mini-transcribe`. Devuelve el texto plano.
 */
export async function transcribeAudio(opts: {
  apiKey: string;
  audio: Buffer;
  filename?: string;
  model?: string;
  language?: string;
}): Promise<{ text: string }> {
  const client = new OpenAI({ apiKey: opts.apiKey });
  const file = await toFile(opts.audio, opts.filename ?? "audio.ogg");
  const resp: any = await client.audio.transcriptions.create({
    file,
    model: opts.model ?? "whisper-1",
    language: opts.language,
  });
  return { text: (resp?.text ?? "").trim() };
}
