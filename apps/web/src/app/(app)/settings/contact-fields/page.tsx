"use client";

/** Campos personalizados del contacto (consumidos por la ficha y las columnas de Contactos). */
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Modal, Skeleton, useToast } from "@/components/ui";

interface FieldRow {
  id: string;
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
  order: number;
  showInList: boolean;
  valuesCount: number;
}

const TYPES: [string, string][] = [
  ["text", "Texto"],
  ["number", "Número"],
  ["date", "Fecha"],
  ["select", "Lista de opciones"],
  ["boolean", "Sí / No"],
];

export default function ContactFieldsPage() {
  const toast = useToast();
  const [fields, setFields] = useState<FieldRow[] | null>(null);
  const [editing, setEditing] = useState<FieldRow | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setFields(await api<FieldRow[]>("/contact-fields").catch(() => []));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function move(idx: number, dir: -1 | 1) {
    if (!fields) return;
    const next = [...fields];
    const [row] = next.splice(idx, 1);
    next.splice(idx + dir, 0, row!);
    setFields(next);
    await api("/contact-fields/reorder", { method: "POST", body: JSON.stringify({ ids: next.map((f) => f.id) }) });
  }

  async function toggleColumn(row: FieldRow) {
    await api(`/contact-fields/${row.id}`, { method: "PATCH", body: JSON.stringify({ showInList: !row.showInList }) });
    await load();
  }

  async function remove(row: FieldRow) {
    try {
      await api(`/contact-fields/${row.id}`, { method: "DELETE" });
      toast.push(`Campo «${row.label}» eliminado`, "info");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }

  if (!fields) {
    return (
      <div className="mx-auto max-w-3xl p-6"><Skeleton className="h-64" /></div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Campos de contacto</h2>
        <Button onClick={() => setAdding(true)}><Plus size={14} /> Nuevo campo</Button>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Campos propios de tu negocio para la ficha del contacto (previsión, N° de ficha clínica, etc.). El orden aquí es
        el orden en la ficha; «Columna» los ofrece como columna en el módulo Contactos.
      </p>

      <ul className="mt-4 space-y-1">
        {fields.length === 0 && <p className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-ink-subtle">Aún no hay campos personalizados.</p>}
        {fields.map((f, idx) => (
          <li key={f.id} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-2 py-1.5">
            <div className="flex flex-col">
              <button onClick={() => idx > 0 && void move(idx, -1)} disabled={idx === 0} className="text-ink-subtle hover:text-ink-muted disabled:opacity-30"><ArrowUp size={11} /></button>
              <button onClick={() => idx < fields.length - 1 && void move(idx, 1)} disabled={idx === fields.length - 1} className="text-ink-subtle hover:text-ink-muted disabled:opacity-30"><ArrowDown size={11} /></button>
            </div>
            <span className="min-w-0 flex-1">
              <span className="text-sm font-medium">{f.label}</span>
              <span className="ml-2 font-mono text-[10px] text-ink-subtle">{f.key}</span>
              {f.required && <span className="ml-2 text-[10px] text-amber-600">obligatorio</span>}
            </span>
            <span className="shrink-0 rounded bg-app px-1.5 py-0.5 text-[10px] text-ink-muted">{TYPES.find(([t]) => t === f.type)?.[1] ?? f.type}</span>
            <span className="w-20 shrink-0 text-right text-[10px] text-ink-subtle">{f.valuesCount} con valor</span>
            <label className="flex items-center gap-1 text-[11px] text-ink-muted">
              <input type="checkbox" checked={f.showInList} onChange={() => void toggleColumn(f)} /> Columna
            </label>
            <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setEditing(f)}>Editar</Button>
            <button
              onClick={() => void remove(f)}
              disabled={f.valuesCount > 0}
              title={f.valuesCount > 0 ? "Tiene valores: vacíalos primero" : "Eliminar"}
              className="text-ink-subtle hover:text-red-500 disabled:opacity-30"
            >✕</button>
          </li>
        ))}
      </ul>

      {(editing || adding) && (
        <FieldModal
          field={editing}
          onCancel={() => { setEditing(null); setAdding(false); }}
          onSaved={() => { setEditing(null); setAdding(false); void load(); }}
        />
      )}
    </div>
  );
}

function FieldModal({ field, onCancel, onSaved }: { field: FieldRow | null; onCancel: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [label, setLabel] = useState(field?.label ?? "");
  const [type, setType] = useState(field?.type ?? "text");
  const [options, setOptions] = useState((field?.options ?? []).join(", "));
  const [required, setRequired] = useState(field?.required ?? false);
  const [busy, setBusy] = useState(false);
  const input = "mt-1 w-full rounded-lg border border-line-strong px-2 py-1.5 text-sm";

  async function save() {
    setBusy(true);
    try {
      const body = {
        label: label.trim(),
        type,
        required,
        ...(type === "select" ? { options: options.split(",").map((o) => o.trim()).filter(Boolean) } : {}),
      };
      if (field) await api(`/contact-fields/${field.id}`, { method: "PATCH", body: JSON.stringify(body) });
      else await api("/contact-fields", { method: "POST", body: JSON.stringify(body) });
      toast.push(field ? "Campo actualizado" : "Campo creado", "ok");
      onSaved();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onCancel} title={field ? `Editar «${field.label}»` : "Nuevo campo de contacto"}>
      <div className="space-y-2">
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Nombre del campo</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="p. ej. Previsión" className={input} />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Tipo</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={`${input} bg-panel`} disabled={!!field}>
            {TYPES.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
          </select>
        </label>
        {type === "select" && (
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Opciones (separadas por coma)</span>
            <input value={options} onChange={(e) => setOptions(e.target.value)} placeholder="Fonasa, Isapre, Particular" className={input} />
          </label>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Obligatorio en la ficha
        </label>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={busy || label.trim().length < 2}>{field ? "Guardar" : "Crear campo"}</Button>
      </div>
    </Modal>
  );
}
