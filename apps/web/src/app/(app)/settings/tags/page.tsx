"use client";

/** Etiquetas del tenant: CRUD, conteo de uso, fusión de duplicadas y borrado. */
import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { api } from "@/lib/api";
import { Button, ConfirmDialog, Modal, Select, Skeleton, useToast } from "@/components/ui";

interface TagRow {
  id: string;
  name: string;
  color: string | null;
  usage: number;
}

export default function TagsSettingsPage() {
  const toast = useToast();
  const [tags, setTags] = useState<TagRow[] | null>(null);
  const [newName, setNewName] = useState("");
  const [merging, setMerging] = useState<TagRow | null>(null);
  const [mergeTarget, setMergeTarget] = useState("");
  const [deleting, setDeleting] = useState<TagRow | null>(null);

  const load = useCallback(async () => {
    setTags(await api<TagRow[]>("/tags").catch(() => []));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (newName.trim().length < 1) return;
    try {
      await api("/tags", { method: "POST", body: JSON.stringify({ name: newName.trim() }) });
      setNewName("");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }

  async function rename(tag: TagRow, name: string) {
    if (!name.trim() || name.trim() === tag.name) return;
    try {
      await api(`/tags/${tag.id}`, { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
      await load();
    }
  }

  async function setColor(tag: TagRow, color: string) {
    await api(`/tags/${tag.id}`, { method: "PATCH", body: JSON.stringify({ color }) });
    await load();
  }

  if (!tags) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-64" /></div>;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Etiquetas</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Las etiquetas se usan en Contactos, la Bandeja (bandejas personalizadas), workflows (disparador «Etiqueta
        agregada») y las herramientas de los agentes IA. Fusiona duplicadas para mantener el orden.
      </p>

      <div className="mt-4 flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void create()}
          placeholder="Nueva etiqueta…"
          className="flex-1 rounded-lg border border-line-strong px-3 py-1.5 text-sm"
        />
        <Button onClick={() => void create()} disabled={newName.trim().length < 1}><Plus size={14} /> Crear</Button>
      </div>

      <ul className="mt-3 space-y-1">
        {tags.length === 0 && <p className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-ink-subtle">Sin etiquetas aún.</p>}
        {tags.map((t) => (
          <li key={t.id} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-2 py-1.5">
            <input
              type="color"
              value={t.color ?? "#94a3b8"}
              onChange={(e) => void setColor(t, e.target.value)}
              className="h-6 w-6 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
              title="Color"
            />
            <input
              defaultValue={t.name}
              onBlur={(e) => void rename(t, e.target.value)}
              className="min-w-0 flex-1 rounded border border-transparent px-1 py-0.5 text-sm hover:border-line focus:border-brand-400"
            />
            <span className="w-24 shrink-0 text-right text-[11px] text-ink-subtle">{t.usage} uso(s)</span>
            <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => { setMerging(t); setMergeTarget(""); }}>Fusionar</Button>
            <button onClick={() => setDeleting(t)} className="text-ink-subtle hover:text-red-500" title="Eliminar">✕</button>
          </li>
        ))}
      </ul>

      {merging && (
        <Modal open onClose={() => setMerging(null)} title={`Fusionar «${merging.name}»`}>
          <p className="text-sm text-ink-muted">
            Todos los usos de <b>{merging.name}</b> ({merging.usage}) pasarán a la etiqueta que elijas, y «{merging.name}» se eliminará.
          </p>
          <Select value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)} className="mt-2 w-full">
            <option value="">— etiqueta destino —</option>
            {tags.filter((t) => t.id !== merging.id).map((t) => (
              <option key={t.id} value={t.id}>{t.name} ({t.usage})</option>
            ))}
          </Select>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMerging(null)}>Cancelar</Button>
            <Button
              disabled={!mergeTarget}
              onClick={() => {
                void api("/tags/merge", { method: "POST", body: JSON.stringify({ sourceId: merging.id, targetId: mergeTarget }) })
                  .then(() => { toast.push("Etiquetas fusionadas ✔", "ok"); setMerging(null); void load(); })
                  .catch((err) => toast.push((err as Error).message, "error"));
              }}
            >
              Fusionar
            </Button>
          </div>
        </Modal>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          void api(`/tags/${deleting.id}`, { method: "DELETE" })
            .then(() => { toast.push("Etiqueta eliminada", "info"); setDeleting(null); void load(); })
            .catch((err) => toast.push((err as Error).message, "error"));
        }}
        title={`¿Eliminar «${deleting?.name}»?`}
        description={`Se quitará de ${deleting?.usage ?? 0} contacto(s)/entidad(es). Esta acción no se puede deshacer.`}
        confirmLabel="Eliminar"
        danger
      />
    </div>
  );
}
