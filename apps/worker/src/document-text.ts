/**
 * Extrae el TEXTO de un documento entrante (PDF, texto plano) para que el agente de IA
 * pueda LEERLO. Modelo-agnóstico: guardamos el TEXTO (no adjuntamos el binario), así lo
 * lee cualquier modelo. Se cae con gracia (null) si el formato no es soportado o falla —
 * el humano igual puede descargar el archivo desde el panel.
 */

const MAX_DOC_TEXT_CHARS = 6000; // tope para no inflar el contexto/costo del agente
const NULL_CHARS = new RegExp(String.fromCharCode(0), "g"); // sanea caracteres nulos del PDF

function clip(s: string): string | null {
  const t = s.replace(NULL_CHARS, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!t) return null;
  return t.length > MAX_DOC_TEXT_CHARS ? t.slice(0, MAX_DOC_TEXT_CHARS) + "\n…[documento recortado]" : t;
}

export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
  filename?: string | null,
): Promise<string | null> {
  const mime = (mimeType || "").toLowerCase();
  const name = (filename ?? "").toLowerCase();
  try {
    if (mime.includes("pdf") || name.endsWith(".pdf")) {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text } = await extractText(pdf, { mergePages: true });
      return clip(Array.isArray(text) ? text.join("\n") : String(text ?? ""));
    }
    if (mime.startsWith("text/") || /\.(txt|csv|md|json|log)$/i.test(name)) {
      return clip(buffer.toString("utf-8"));
    }
    // docx/xlsx/imágenes u otros: no soportado (por ahora) — devolvemos null.
    return null;
  } catch (err) {
    console.error("✖ extractDocumentText:", (err as Error).message);
    return null;
  }
}
