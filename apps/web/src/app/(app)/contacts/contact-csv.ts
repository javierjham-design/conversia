// Utilidades puras de CSV para la importación (sin React → testeables).

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/** Parser CSV mínimo con soporte de comillas; detecta ; o , como separador. */
export function parseCSV(text: string): ParsedCsv {
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
  return "";
}
