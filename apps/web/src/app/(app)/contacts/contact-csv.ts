// Utilidades puras de CSV para la importación (sin React → testeables).

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/** Parser CSV mínimo con soporte de comillas; detecta ; o , como separador. */
export function parseCSV(rawText: string): ParsedCsv {
  const text = rawText.replace(/^﻿/, ""); // BOM de Excel
  const firstLine = text.split(/\r?\n/)[0] ?? "";
  const delim = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) {
      cur.push(field);
      field = "";
    } else if (ch === "\n") {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field.length || cur.length) {
    cur.push(field);
    rows.push(cur);
  }
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows: rows.filter((r) => r.some((c) => c.trim() !== "")) };
}

/** Normaliza el valor de una celda de Excel (texto, número, fecha, fórmula, rich text). */
function cellToString(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as Record<string, any>;
    if (Array.isArray(o.richText)) return o.richText.map((r) => r.text ?? "").join("");
    if (o.text != null) return String(o.text);
    if (o.result != null) return String(o.result);
    if (o.hyperlink != null) return String(o.hyperlink);
    return "";
  }
  return String(v);
}

/**
 * Lee un archivo de base de datos (CSV o Excel .xlsx) a { headers, rows }.
 * Excel se parsea con exceljs cargado bajo demanda (import dinámico → no engorda
 * el bundle inicial). Lo que más envían los clientes es Excel.
 */
export async function parseSpreadsheetFile(file: File): Promise<ParsedCsv> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xlsm")) {
    const mod = await import("exceljs");
    const ExcelJS: any = (mod as any).default ?? mod;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.worksheets[0];
    if (!ws) return { headers: [], rows: [] };
    const colCount: number = ws.columnCount || 0;
    const matrix: string[][] = [];
    ws.eachRow((row: any) => {
      const vals: string[] = [];
      for (let i = 1; i <= colCount; i++) vals.push(cellToString(row.getCell(i).value));
      matrix.push(vals);
    });
    const headers = (matrix.shift() ?? []).map((h) => h.trim());
    return { headers, rows: matrix.filter((r) => r.some((c) => c.trim() !== "")) };
  }
  const text = await file.text();
  return parseCSV(text);
}

/** Adivina el campo destino a partir del nombre de la cabecera. */
export function guessField(header: string): string {
  const h = header.toLowerCase();
  if (/(apellid|last)/.test(h)) return "lastName";
  if (/(nombre|first|name)/.test(h)) return "firstName";
  if (/(tel|phone|celular|whats|móvil|movil)/.test(h)) return "phone";
  if (/(mail|correo)/.test(h)) return "email";
  if (/(pa[ií]s|country)/.test(h)) return "country";
  if (/(idioma|locale|lang)/.test(h)) return "locale";
  if (/(etiqueta|tag)/.test(h)) return "tags";
  if (/(grupo|group|segmento)/.test(h)) return "group";
  if (/(etapa|stage|estado)/.test(h)) return "stage";
  return "";
}

/** Cabeceras base de la plantilla de import (el orden importa para el round-trip). */
export const TEMPLATE_BASE_HEADERS = ["telefono", "nombre", "apellido", "email", "etapa", "etiquetas", "grupos"] as const;

/**
 * Genera la plantilla CSV modelo: columnas base + campos personalizados del
 * tenant + 2 filas de ejemplo ficticias. UTF-8 con BOM (tildes OK en Excel).
 */
export function buildTemplateCsv(customFields: { key: string; label: string }[]): string {
  const headers = [...TEMPLATE_BASE_HEADERS, ...customFields.map((f) => f.key)];
  const example1 = ["+56 9 1234 5678", "María", "Pérez", "maria@ejemplo.cl", "Nuevo lead", "interesado|ortodoncia", "Clientes 2026", ...customFields.map(() => "")];
  const example2 = ["+56 9 8765 4321", "Pedro", "Soto", "", "Reserva", "limpieza", "Clientes 2026|VIP", ...customFields.map(() => "")];
  const esc = (v: string) => (/[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  return "﻿" + [headers, example1, example2].map((r) => r.map(esc).join(",")).join("\n");
}
