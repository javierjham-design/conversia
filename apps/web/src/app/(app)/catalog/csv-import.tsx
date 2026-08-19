"use client";

/** Importación de catálogo por CSV: plantilla descargable + mapeo asistido de columnas. */
import { useState } from "react";
import { api } from "@/lib/api";
import { Button, Drawer, useToast } from "@/components/ui";

interface Field { key: string; label: string; required?: boolean; aliases: string[] }
const FIELDS: Field[] = [
  { key: "name", label: "Nombre", required: true, aliases: ["name", "nombre", "producto", "title"] },
  { key: "sku", label: "SKU / código", aliases: ["sku", "codigo", "código", "code"] },
  { key: "price", label: "Precio", aliases: ["price", "precio", "valor"] },
  { key: "category", label: "Categoría", aliases: ["category", "categoria", "categoría", "rubro"] },
  { key: "stock", label: "Stock", aliases: ["stock", "cantidad", "existencia"] },
  { key: "description", label: "Descripción", aliases: ["description", "descripcion", "descripción", "detalle"] },
];

/** Parser CSV básico (comillas + comas dentro de comillas). */
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length);
  const parseLine = (line: string) => {
    const out: string[] = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (c === "," && !q) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const rows = lines.map(parseLine);
  return { headers: rows[0] ?? [], rows: rows.slice(1) };
}

export function CsvImport({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [map, setMap] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  function onFile(f: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const { headers, rows } = parseCsv(String(reader.result ?? ""));
      setHeaders(headers); setRows(rows);
      // Mapeo asistido: detecta columnas por nombre de cabecera.
      const m: Record<string, number> = {};
      for (const field of FIELDS) {
        const idx = headers.findIndex((h) => field.aliases.includes(h.toLowerCase()));
        if (idx >= 0) m[field.key] = idx;
      }
      setMap(m);
    };
    reader.readAsText(f);
  }

  async function importNow() {
    if (map.name == null) { toast.push("Falta mapear la columna Nombre", "error"); return; }
    const items = rows.map((r) => {
      const it: Record<string, unknown> = { name: r[map.name] };
      if (map.sku != null && r[map.sku]) it.sku = r[map.sku];
      if (map.price != null && r[map.price]) it.price = Number(String(r[map.price]).replace(/[^\d.-]/g, ""));
      if (map.category != null && r[map.category]) it.category = r[map.category];
      if (map.stock != null && r[map.stock] !== "") it.stock = Number(r[map.stock]);
      if (map.description != null && r[map.description]) it.description = r[map.description];
      return it;
    }).filter((it) => it.name);
    if (!items.length) { toast.push("No hay filas para importar", "error"); return; }
    setBusy(true);
    try {
      const r = await api<{ created: number; updated: number }>("/integrations/catalog/import-csv", { method: "POST", body: JSON.stringify({ items: items.slice(0, 1000) }) });
      toast.push(`Importados ✔ ${r.created} nuevos, ${r.updated} actualizados`, "ok");
      setHeaders([]); setRows([]); setMap({});
      onDone(); onClose();
    } catch (e) { toast.push((e as Error).message, "error"); } finally { setBusy(false); }
  }

  function downloadTemplate() {
    const csv = "nombre,sku,precio,categoria,stock,descripcion\nAceite de lavanda,LAV-30,6990,Aromaterapia,12,Relaja y ayuda a dormir\n";
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = "plantilla-catalogo.csv"; a.click(); URL.revokeObjectURL(url);
  }

  const sel = "rounded-lg border border-line-strong bg-panel px-2 py-1 text-sm";

  return (
    <Drawer open={open} onClose={onClose} title="Importar catálogo por CSV">
      <p className="text-xs text-ink-muted">Sube tu catálogo en una planilla. Descarga la plantilla, complétala y súbela — detectamos las columnas por ti.</p>
      <button onClick={downloadTemplate} className="mt-2 text-xs font-medium text-brand-600 hover:underline">Descargar plantilla CSV</button>

      <label className="mt-4 block text-sm font-medium">Archivo CSV
        <input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} className="mt-1 block w-full text-sm" />
      </label>

      {headers.length > 0 && (
        <>
          <p className="mt-4 text-xs font-medium text-ink-muted">{rows.length} filas detectadas · asigna cada campo a su columna:</p>
          <div className="mt-2 space-y-2">
            {FIELDS.map((f) => (
              <div key={f.key} className="flex items-center justify-between text-sm">
                <span>{f.label}{f.required && " *"}</span>
                <select value={map[f.key] ?? -1} onChange={(e) => setMap((m) => ({ ...m, [f.key]: Number(e.target.value) }))} className={sel}>
                  <option value={-1}>— ninguna —</option>
                  {headers.map((h, i) => <option key={i} value={i}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          <Button className="mt-4" disabled={busy || map.name == null} onClick={() => void importNow()}>{busy ? "Importando…" : `Importar ${rows.length} productos`}</Button>
          <p className="mt-1 text-[11px] text-ink-subtle">Máximo 1.000 por archivo. Se actualiza por SKU (o nombre) si ya existe.</p>
        </>
      )}
    </Drawer>
  );
}
