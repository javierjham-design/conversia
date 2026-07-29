"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp, GitMerge, Upload } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Modal, cn, useToast } from "@/components/ui";
import { guessField, parseCSV } from "./contact-csv";

const inputCls = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-brand-500";

// Campos destino del import.
const TARGET_FIELDS: { key: string; label: string }[] = [
  { key: "", label: "— Ignorar —" },
  { key: "firstName", label: "Nombre" },
  { key: "lastName", label: "Apellido" },
  { key: "phone", label: "Teléfono" },
  { key: "email", label: "Email" },
  { key: "country", label: "País (ISO-2)" },
  { key: "locale", label: "Idioma" },
  { key: "tags", label: "Etiquetas (coma)" },
];

export function ImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<{ headers: string[]; rows: string[][] } | null>(null);
  const [mapping, setMapping] = useState<Record<number, string>>({});
  const [updateExisting, setUpdateExisting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: number; errors: { row: number; reason: string }[] } | null>(null);

  useEffect(() => {
    if (open) {
      setParsed(null);
      setMapping({});
      setUpdateExisting(false);
      setResult(null);
    }
  }, [open]);

  function onFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const p = parseCSV(String(reader.result ?? ""));
      if (p.headers.length === 0) {
        toast.push("El archivo no tiene cabeceras", "error");
        return;
      }
      setParsed(p);
      setMapping(Object.fromEntries(p.headers.map((h, i) => [i, guessField(h)])));
    };
    reader.readAsText(file, "utf-8");
  }

  const mappedFields = useMemo(() => new Set(Object.values(mapping).filter(Boolean)), [mapping]);
  const canImport = parsed && (mappedFields.has("phone") || mappedFields.has("email") || mappedFields.has("firstName"));

  async function doImport() {
    if (!parsed) return;
    setBusy(true);
    try {
      const rows = parsed.rows.map((r) => {
        const obj: Record<string, string> = {};
        Object.entries(mapping).forEach(([idx, field]) => {
          if (field && r[Number(idx)]) obj[field] = r[Number(idx)].trim();
        });
        return obj;
      });
      const res = await api<typeof result>("/contacts/import", { method: "POST", body: JSON.stringify({ rows, updateExisting }) });
      setResult(res);
      onDone();
    } catch (e: any) {
      toast.push(e.message ?? "Error al importar", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Importar contactos (CSV)" wide>
      {result ? (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Creados" value={result.created} tone="ok" />
            <Stat label="Actualizados" value={result.updated} tone="brand" />
            <Stat label="Omitidos" value={result.skipped} tone="muted" />
          </div>
          {result.errors.length > 0 && (
            <div className="max-h-40 overflow-y-auto rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm">
              <p className="mb-1 font-medium text-amber-700">{result.errors.length} fila(s) con problemas</p>
              {result.errors.slice(0, 30).map((e) => (
                <p key={e.row} className="text-amber-700">Fila {e.row}: {e.reason}</p>
              ))}
            </div>
          )}
          <div className="flex justify-end">
            <Button onClick={onClose}>Listo</Button>
          </div>
        </div>
      ) : !parsed ? (
        <div>
          <button
            onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 py-10 text-slate-500 hover:border-brand-400 hover:text-brand-600"
          >
            <FileUp size={28} />
            <span className="font-medium">Selecciona un archivo CSV</span>
            <span className="text-xs">Primera fila = cabeceras. Separador , o ;</span>
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">{parsed.rows.length} filas detectadas. Asocia cada columna del archivo a un campo:</p>
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {parsed.headers.map((h, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-700">{h || `Columna ${i + 1}`}</p>
                  <p className="truncate text-xs text-slate-400">{parsed.rows[0]?.[i] ?? ""}</p>
                </div>
                <select value={mapping[i] ?? ""} onChange={(e) => setMapping({ ...mapping, [i]: e.target.value })} className={cn(inputCls, "w-48")}>
                  {TARGET_FIELDS.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={updateExisting} onChange={(e) => setUpdateExisting(e.target.checked)} />
            Actualizar contactos existentes (mismo teléfono) rellenando campos vacíos
          </label>
          {!canImport && <p className="text-xs text-amber-600">Mapea al menos Teléfono, Email o Nombre para poder importar.</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setParsed(null)}>Volver</Button>
            <Button onClick={doImport} disabled={busy || !canImport}><Upload size={15} /> {busy ? "Importando…" : `Importar ${parsed.rows.length}`}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: "ok" | "brand" | "muted" }) {
  const c = tone === "ok" ? "text-emerald-600" : tone === "brand" ? "text-brand-600" : "text-slate-500";
  return (
    <div className="rounded-lg border border-slate-200 p-3 text-center">
      <p className={cn("text-2xl font-semibold", c)}>{value}</p>
      <p className="text-xs text-slate-500">{label}</p>
    </div>
  );
}

// ============================= Duplicados / fusión =============================

interface DupItem { id: string; firstName: string | null; lastName: string | null; phone: string | null; email: string | null; profileName: string | null; createdAt: string; lastContactAt: string | null }
interface DupGroup { phone: string; items: DupItem[] }

function dupName(c: DupItem): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.profileName || c.phone || "Sin nombre";
}

export function DuplicatesModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [primary, setPrimary] = useState<Record<string, string>>({}); // phone -> primaryId
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    setGroups(null);
    api<{ groups: DupGroup[] }>("/contacts/duplicates")
      .then((r) => {
        setGroups(r.groups);
        setPrimary(Object.fromEntries(r.groups.map((g) => [g.phone, g.items[0].id])));
      })
      .catch((e) => toast.push(e.message ?? "Error", "error"));
  }
  useEffect(() => {
    if (open) load();
  }, [open]);

  async function mergeGroup(g: DupGroup) {
    const primaryId = primary[g.phone];
    const mergeIds = g.items.map((i) => i.id).filter((id) => id !== primaryId);
    if (mergeIds.length === 0) return;
    setBusy(g.phone);
    try {
      await api("/contacts/merge", { method: "POST", body: JSON.stringify({ primaryId, mergeIds }) });
      toast.push("Contactos fusionados", "ok");
      setGroups((prev) => (prev ? prev.filter((x) => x.phone !== g.phone) : prev));
      onDone();
    } catch (e: any) {
      toast.push(e.message ?? "Error al fusionar", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Contactos duplicados" wide>
      {!groups ? (
        <p className="py-8 text-center text-sm text-slate-400">Buscando duplicados…</p>
      ) : groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-500">No se encontraron contactos con el mismo teléfono. 🎉</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">{groups.length} grupo(s) comparten teléfono. Elige el contacto principal (conserva su ficha) y fusiona el resto.</p>
          {groups.map((g) => (
            <div key={g.phone} className="rounded-xl border border-slate-200 p-3">
              <p className="mb-2 font-mono text-xs text-slate-500">{g.phone}</p>
              <div className="space-y-1.5">
                {g.items.map((c) => (
                  <label key={c.id} className={cn("flex cursor-pointer items-center gap-2 rounded-lg border p-2 text-sm", primary[g.phone] === c.id ? "border-brand-300 bg-brand-50" : "border-slate-200")}>
                    <input type="radio" name={`p-${g.phone}`} checked={primary[g.phone] === c.id} onChange={() => setPrimary({ ...primary, [g.phone]: c.id })} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-slate-700">{dupName(c)}</p>
                      <p className="truncate text-xs text-slate-400">{c.email ?? "sin email"} · creado {new Date(c.createdAt).toLocaleDateString("es-CL")}</p>
                    </div>
                    {primary[g.phone] === c.id && <span className="shrink-0 text-[11px] font-medium text-brand-600">Principal</span>}
                  </label>
                ))}
              </div>
              <div className="mt-2 flex justify-end">
                <Button onClick={() => mergeGroup(g)} disabled={busy === g.phone}>
                  <GitMerge size={15} /> {busy === g.phone ? "Fusionando…" : `Fusionar ${g.items.length - 1} en el principal`}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
