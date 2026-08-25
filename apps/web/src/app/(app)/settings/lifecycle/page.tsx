"use client";

/**
 * Etapas del ciclo de vida (fuente única de verdad; /settings/lifecycle).
 * Consumidores: dropdown de la cabecera de la Bandeja, clasificador, panel de
 * contacto, workflows (trigger «Etapa actualizada» y paso «Actualizar etapa»)
 * y la oferta de evento CAPI (etapas de categoría «Ganada» = conversión).
 */
import { useCallback, useEffect, useState } from "react";
import { GripVertical, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button, IconButton, Modal, Select, Skeleton, cn, useToast } from "@/components/ui";

interface StageRow {
  id: string;
  code: string;
  name: string;
  emoji: string | null;
  color: string | null;
  category: "OPEN" | "WON" | "LOST" | "FROZEN";
  order: number;
  system: boolean;
  active: boolean;
  leadsCount: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  OPEN: "En proceso",
  WON: "Ganada (conversión)",
  LOST: "Perdida",
  FROZEN: "Congelada",
};

const EMOJI_SUGGESTIONS = ["🆕", "🔥", "📅", "🤩", "🧊", "💬", "🦷", "⭐", "💰", "🚫", "⏳", "✅"];

export default function LifecycleSettingsPage() {
  const toast = useToast();
  const [stages, setStages] = useState<StageRow[] | null>(null);
  const [editing, setEditing] = useState<StageRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<StageRow | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setStages(await api<StageRow[]>("/lifecycle-stages").catch(() => []));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function persistOrder(next: StageRow[]) {
    setStages(next);
    await api("/lifecycle-stages/reorder", { method: "POST", body: JSON.stringify({ ids: next.map((s) => s.id) }) });
  }

  function onDrop(targetId: string) {
    if (!stages || !dragId || dragId === targetId) return;
    const next = [...stages];
    const fromIdx = next.findIndex((s) => s.id === dragId);
    const toIdx = next.findIndex((s) => s.id === targetId);
    const [row] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, row!);
    void persistOrder(next);
    setDragId(null);
  }

  async function toggleActive(row: StageRow) {
    await api(`/lifecycle-stages/${row.id}`, { method: "PATCH", body: JSON.stringify({ active: !row.active }) });
    toast.push(row.active ? `«${row.name}» desactivada (no aparecerá en selectores)` : `«${row.name}» reactivada`, "info");
    await load();
  }

  if (!stages) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Skeleton className="h-72" />
      </div>
    );
  }

  const activeStages = stages.filter((s) => s.category === "OPEN" || s.category === "WON");
  const lostStages = stages.filter((s) => s.category === "LOST" || s.category === "FROZEN");

  const renderRow = (s: StageRow) => (
    <li
      key={s.id}
      draggable
      onDragStart={() => setDragId(s.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={() => onDrop(s.id)}
      className={cn(
        "flex items-center gap-2 rounded-lg border bg-panel px-2 py-2",
        dragId === s.id ? "border-brand-400 opacity-60" : "border-line",
        !s.active && "opacity-50",
      )}
    >
      <GripVertical size={14} className="shrink-0 cursor-grab text-ink-subtle" />
      <span className="w-7 text-center text-base">{s.emoji ?? "•"}</span>
      <span className="min-w-0 flex-1">
        {/* El slug es dato de desarrollador → tooltip, no fila (B3) */}
        <span className={cn("text-sm font-medium", !s.active && "line-through")} style={s.color ? { color: s.color } : {}} title={`Clave interna: ${s.code}`}>{s.name}</span>
        {s.category === "WON" && <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">Conversión → CAPI</span>}
      </span>
      <span className="shrink-0 rounded bg-app px-1.5 py-0.5 text-[10px] text-ink-muted">{CATEGORY_LABELS[s.category]}</span>
      <span className="w-16 shrink-0 text-right text-[10px] text-ink-subtle">{s.leadsCount === 1 ? '1 lead' : `${s.leadsCount} leads`}</span>
      <button onClick={() => void toggleActive(s)} className="text-[11px] text-ink-subtle underline hover:text-ink-muted">
        {s.active ? "Desactivar" : "Activar"}
      </button>
      <IconButton label="Editar" onClick={() => setEditing(s)}><Pencil size={14} /></IconButton>
      <IconButton label="Eliminar" destructive onClick={() => setDeleting(s)}><Trash2 size={14} /></IconButton>
    </li>
  );

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Etapas del ciclo de vida</h2>
        <Button onClick={() => setAdding(true)}><Plus size={14} /> Nueva etapa</Button>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Define TU proceso de venta: arrastra para reordenar, edita nombre/emoji/color, desactiva sin borrar. Las etapas de
        categoría <b>Ganada</b> cuentan como conversión (la Bandeja ofrece enviar el evento CAPI al marcarlas). Consumen
        esta definición: Bandeja, Contactos, Workflows y Agentes IA.
      </p>

      <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Etapas del ciclo</h3>
      <ul className="mt-1.5 space-y-1">{activeStages.map(renderRow)}</ul>

      {lostStages.length > 0 && (
        <>
          <h3 className="mt-5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Etapas perdidas / congeladas</h3>
          <ul className="mt-1.5 space-y-1">{lostStages.map(renderRow)}</ul>
        </>
      )}

      {(editing || adding) && (
        <StageFormModal
          stage={editing}
          busy={busy}
          onCancel={() => {
            setEditing(null);
            setAdding(false);
          }}
          onSave={async (data) => {
            setBusy(true);
            try {
              if (editing) await api(`/lifecycle-stages/${editing.id}`, { method: "PATCH", body: JSON.stringify(data) });
              else await api("/lifecycle-stages", { method: "POST", body: JSON.stringify(data) });
              toast.push(editing ? "Etapa actualizada" : "Etapa creada", "ok");
              setEditing(null);
              setAdding(false);
              await load();
            } catch (err) {
              toast.push((err as Error).message, "error");
            } finally {
              setBusy(false);
            }
          }}
        />
      )}

      {deleting && (
        <DeleteStageModal
          stage={deleting}
          others={stages.filter((s) => s.id !== deleting.id)}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function StageFormModal({
  stage,
  busy,
  onSave,
  onCancel,
}: {
  stage: StageRow | null;
  busy: boolean;
  onSave: (data: { name: string; emoji: string | null; color: string | null; category: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(stage?.name ?? "");
  const [emoji, setEmoji] = useState(stage?.emoji ?? "");
  const [color, setColor] = useState(stage?.color ?? "#0891b2");
  const [category, setCategory] = useState(stage?.category ?? "OPEN");
  const input = "mt-1 w-full rounded-lg border border-line-strong px-2 py-1.5 text-sm";

  return (
    <Modal open onClose={onCancel} title={stage ? `Editar «${stage.name}»` : "Nueva etapa"}>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Presupuesto enviado" className={input} />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Categoría</span>
          <Select value={category} onChange={(e) => setCategory(e.target.value as StageRow["category"])} className="mt-1 w-full">
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </Select>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Emoji</span>
          <div className="mt-1 flex items-center gap-1">
            <input value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={4} className="w-14 rounded-lg border border-line-strong px-2 py-1.5 text-center text-sm" />
            <div className="flex flex-wrap gap-0.5">
              {EMOJI_SUGGESTIONS.map((e) => (
                <button key={e} onClick={() => setEmoji(e)} className="rounded p-0.5 text-sm hover:bg-app">{e}</button>
              ))}
            </div>
          </div>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Color</span>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-line-strong" />
        </label>
      </div>
      <p className="mt-2 text-[10px] text-ink-subtle">
        La categoría «Ganada» marca conversión (oferta CAPI en la Bandeja y métricas de reportes). El código interno no
        cambia al renombrar: tus flujos siguen funcionando.
      </p>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button onClick={() => onSave({ name: name.trim(), emoji: emoji.trim() || null, color, category })} disabled={busy || name.trim().length < 2}>
          {stage ? "Guardar cambios" : "Crear etapa"}
        </Button>
      </div>
    </Modal>
  );
}

function DeleteStageModal({
  stage,
  others,
  onClose,
  onDeleted,
}: {
  stage: StageRow;
  others: StageRow[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [migrateTo, setMigrateTo] = useState("");
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      const qs = stage.leadsCount > 0 && migrateTo ? `?migrateTo=${migrateTo}` : "";
      await api(`/lifecycle-stages/${stage.id}${qs}`, { method: "DELETE" });
      toast.push(`Etapa «${stage.name}» eliminada`, "info");
      onDeleted();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`¿Eliminar «${stage.name}»?`}>
      {stage.leadsCount > 0 ? (
        <>
          <p className="text-sm text-ink-muted">
            Esta etapa tiene <b>{stage.leadsCount === 1 ? "1 lead" : `${stage.leadsCount} leads`}</b>. Elige a qué etapa migrarlos antes de eliminarla:
          </p>
          <Select value={migrateTo} onChange={(e) => setMigrateTo(e.target.value)} className="mt-2 w-full">
            <option value="">— elegir etapa destino —</option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>{s.emoji ? `${s.emoji} ` : ""}{s.name}</option>
            ))}
          </Select>
        </>
      ) : (
        <p className="text-sm text-ink-muted">No tiene leads asociados. Esta acción no se puede deshacer.</p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void confirm()} disabled={busy || (stage.leadsCount > 0 && !migrateTo)}>
          {stage.leadsCount > 0 ? "Migrar y eliminar" : "Eliminar"}
        </Button>
      </div>
    </Modal>
  );
}
