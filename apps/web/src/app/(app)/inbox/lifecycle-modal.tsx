"use client";

/**
 * Gestión de las etapas del ciclo de vida (estilo Respond.io): cada tenant
 * renombra las estándar, cambia emoji/categoría/color, reordena, crea y
 * elimina. El código interno queda estable para los workflows.
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Modal, useToast } from "@/components/ui";

interface StageRow {
  id: string;
  code: string;
  name: string;
  emoji: string | null;
  color: string | null;
  category: "OPEN" | "WON" | "LOST" | "FROZEN";
  order: number;
  system: boolean;
  leadsCount: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  OPEN: "En proceso",
  WON: "Ganada (conversión)",
  LOST: "Perdida",
  FROZEN: "Congelada",
};

const EMOJI_SUGGESTIONS = ["🆕", "🔥", "📅", "🤩", "🧊", "💬", "🦷", "⭐", "💰", "🚫", "⏳", "✅"];

export function LifecycleModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [stages, setStages] = useState<StageRow[]>([]);
  const [editing, setEditing] = useState<StageRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setStages(await api<StageRow[]>("/lifecycle-stages").catch(() => []));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function move(idx: number, dir: -1 | 1) {
    const next = [...stages];
    const [row] = next.splice(idx, 1);
    next.splice(idx + dir, 0, row!);
    setStages(next);
    await api("/lifecycle-stages/reorder", { method: "POST", body: JSON.stringify({ ids: next.map((s) => s.id) }) });
    onChanged();
  }

  async function remove(row: StageRow) {
    try {
      await api(`/lifecycle-stages/${row.id}`, { method: "DELETE" });
      toast.push(`Etapa «${row.name}» eliminada`, "info");
      await load();
      onChanged();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }

  return (
    <Modal open onClose={onClose} title="Etapas del ciclo de vida" wide>
      <p className="mb-3 text-xs text-slate-500">
        Define las etapas de TU proceso de venta: cambia nombre, emoji, color y categoría, reordénalas o crea nuevas.
        La categoría <b>Ganada</b> marca conversión (ofrece enviar el evento CAPI). Los flujos siguen funcionando al
        renombrar: el código interno no cambia.
      </p>

      <ul className="space-y-1">
        {stages.map((s, idx) => (
          <li key={s.id} className="flex items-center gap-2 rounded-lg border border-slate-100 px-2 py-1.5">
            <div className="flex flex-col">
              <button onClick={() => idx > 0 && void move(idx, -1)} disabled={idx === 0} className="text-slate-300 hover:text-slate-600 disabled:opacity-30"><ArrowUp size={11} /></button>
              <button onClick={() => idx < stages.length - 1 && void move(idx, 1)} disabled={idx === stages.length - 1} className="text-slate-300 hover:text-slate-600 disabled:opacity-30"><ArrowDown size={11} /></button>
            </div>
            <span className="w-7 text-center text-base">{s.emoji ?? "•"}</span>
            <span className="min-w-0 flex-1">
              <span className="text-sm font-medium" style={s.color ? { color: s.color } : {}}>{s.name}</span>
              <span className="ml-2 font-mono text-[10px] text-slate-400">{s.code}</span>
            </span>
            <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{CATEGORY_LABELS[s.category]}</span>
            <span className="w-16 shrink-0 text-right text-[10px] text-slate-400">{s.leadsCount} lead(s)</span>
            <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => setEditing(s)}>Editar</Button>
            <button
              onClick={() => void remove(s)}
              disabled={s.leadsCount > 0}
              title={s.leadsCount > 0 ? "Tiene leads: muévelos a otra etapa primero" : "Eliminar"}
              className="text-slate-300 hover:text-red-500 disabled:opacity-30"
            >
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ul>

      <div className="mt-3 flex justify-between">
        <Button variant="secondary" onClick={() => setAdding(true)}>
          <Plus size={14} /> Nueva etapa
        </Button>
        <Button variant="ghost" onClick={onClose}>Cerrar</Button>
      </div>

      {(editing || adding) && (
        <StageForm
          stage={editing}
          busy={busy}
          onCancel={() => {
            setEditing(null);
            setAdding(false);
          }}
          onSave={async (data) => {
            setBusy(true);
            try {
              if (editing) {
                await api(`/lifecycle-stages/${editing.id}`, { method: "PATCH", body: JSON.stringify(data) });
              } else {
                await api("/lifecycle-stages", { method: "POST", body: JSON.stringify(data) });
              }
              toast.push(editing ? "Etapa actualizada" : "Etapa creada", "ok");
              setEditing(null);
              setAdding(false);
              await load();
              onChanged();
            } catch (err) {
              toast.push((err as Error).message, "error");
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </Modal>
  );
}

function StageForm({
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

  return (
    <div className="mt-3 rounded-xl border border-cyan-200 bg-cyan-50/50 p-3">
      <p className="mb-2 text-sm font-medium">{stage ? `Editar «${stage.name}»` : "Nueva etapa"}</p>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Presupuesto enviado" className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Categoría</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as StageRow["category"])} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
            {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Emoji</span>
          <div className="mt-1 flex items-center gap-1">
            <input value={emoji} onChange={(e) => setEmoji(e.target.value)} maxLength={4} className="w-14 rounded-lg border border-slate-300 px-2 py-1.5 text-center text-sm" />
            <div className="flex flex-wrap gap-0.5">
              {EMOJI_SUGGESTIONS.map((e) => (
                <button key={e} onClick={() => setEmoji(e)} className="rounded p-0.5 text-sm hover:bg-slate-100">{e}</button>
              ))}
            </div>
          </div>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Color</span>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-slate-300" />
        </label>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button onClick={() => onSave({ name: name.trim(), emoji: emoji.trim() || null, color, category })} disabled={busy || name.trim().length < 2}>
          {stage ? "Guardar cambios" : "Crear etapa"}
        </Button>
      </div>
    </div>
  );
}
