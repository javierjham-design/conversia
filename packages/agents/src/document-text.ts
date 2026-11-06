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
    if (mime.includes("spreadsheetml") || mime.includes("ms-excel") || /\.(xlsx|xlsm)$/i.test(name)) {
      // Excel moderno (.xlsx/.xlsm) vía exceljs. El .xls legado no lo lee exceljs → cae a null.
      return clip(await extractXlsx(buffer));
    }
    if (mime.startsWith("text/") || /\.(txt|csv|md|json|log)$/i.test(name)) {
      return clip(buffer.toString("utf-8"));
    }
    // docx/imágenes-como-doc/.xls u otros: no soportado (por ahora) — devolvemos null.
    return null;
  } catch (err) {
    console.error("✖ extractDocumentText:", (err as Error).message);
    return null;
  }
}

/** Serializa una celda de exceljs a texto plano (maneja fechas, fórmulas, richText, links). */
function cellToText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if ("result" in o) return o.result == null ? "" : String(o.result);
    if (Array.isArray(o.richText)) return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? "").join("");
    if ("hyperlink" in o) return String(o.text ?? o.hyperlink ?? "");
    if ("error" in o) return String(o.error);
    return "";
  }
  return String(v);
}

/** Lee un .xlsx/.xlsm y devuelve su contenido como texto (una sección por hoja, filas en TSV). */
async function extractXlsx(buffer: Buffer): Promise<string> {
  const mod = await import("exceljs");
  const ExcelJS = ((mod as any).default ?? mod) as typeof import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const parts: string[] = [];
  wb.eachSheet((ws) => {
    const rows: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const raw = Array.isArray(row.values) ? row.values.slice(1) : [];
      const vals = raw.map((c) => cellToText(c));
      if (vals.some((x) => x !== "")) rows.push(vals.join("\t"));
    });
    if (rows.length) parts.push(`# Hoja: ${ws.name}\n${rows.join("\n")}`);
  });
  return parts.join("\n\n");
}
