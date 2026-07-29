"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreVertical, Search, Workflow as WorkflowIcon } from "lucide-react";
import { api } from "@/lib/api";
import { Button, ConfirmDialog, EmptyState, Modal, PageHeader, StatusBadge, useToast, cn } from "@/components/ui";

interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  status: "draft" | "published" | "stopped";
  publishedVersion: number | null;
  hasDraft: boolean;
  trigger: string | null;
  runsTotal: number;
  runsWaiting: number;
  createdAt: string;
  createdBy: string | null;
  updatedAt: string;
  publishedAt: string | null;
  publishedBy: string | null;
}

const TRIGGER_LABELS: Record<string, string> = {
  conversation_started: "Conversación nueva",
  message_received: "Cada mensaje",
  keyword: "Palabra clave",
  lead_created: "Lead creado",
  tag_added: "Etiqueta agregada",
  manual: "Atajo manual",
  webhook_received: "Webhook entrante",
  conversation_closed: "Conversación cerrada",
  appointment_upcoming: "Cita próxima",
};

const STATUS_BADGE = {
  draft: { kind: "incomplete" as const, label: "Borrador" },
  published: { kind: "connected" as const, label: "Publicado" },
  stopped: { kind: "disconnected" as const, label: "Detenido" },
};

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString("es-CL", { day: "2-digit", month: "short", year: "numeric" });
}

export default function WorkflowsPage() {
  const router = useRouter();
  const toast = useToast();
  const [rows, setRows] = useState<WorkflowRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [renameTarget, setRenameTarget] = useState<WorkflowRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkflowRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setRows(await api<WorkflowRow[]>("/workflows"));
  }, []);

  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function createBlank() {
    if (newName.trim().length < 2) return;
    setBusy(true);
    try {
      const wf = await api<{ id: string }>("/workflows", { method: "POST", body: JSON.stringify({ name: newName.trim() }) });
      router.push(`/workflows/${wf.id}`);
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function duplicate(w: WorkflowRow) {
    try {
      const r = await api<{ id: string }>(`/workflows/${w.id}/duplicate`, { method: "POST" });
      toast.push("Flujo duplicado", "ok");
      router.push(`/workflows/${r.id}`);
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }

  async function toggleActive(w: WorkflowRow) {
    try {
      await api(`/workflows/${w.id}/active`, { method: "POST", body: JSON.stringify({ active: !w.active }) });
      toast.push(w.active ? "Flujo detenido" : "Flujo reanudado", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }

  async function doDelete() {
    if (!deleteTarget) return;
    try {
      await api(`/workflows/${deleteTarget.id}`, { method: "DELETE" });
      toast.push("Flujo eliminado", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }

  const filtered = (rows ?? []).filter((w) => w.name.toLowerCase().includes(query.toLowerCase().trim()));

  return (
    <div className="h-full overflow-y-auto p-6">
      <PageHeader
        title="Flujos de trabajo"
        description="Automatizaciones sin código: seguimientos, respuestas, esperas y acciones sobre leads y conversaciones."
        actions={<Button onClick={() => { setNewName(""); setCreateOpen(true); }}>+ Crear workflow</Button>}
      />

      <div className="mb-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 sm:max-w-xs">
        <Search size={15} className="text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nombre…"
          className="w-full bg-transparent text-sm outline-none"
        />
      </div>

      {rows === null ? (
        <p className="text-sm text-slate-400">Cargando…</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<WorkflowIcon size={28} />}
          title={query ? "Sin resultados" : "Aún no tienes flujos"}
          description={query ? "Prueba con otro nombre." : "Crea tu primer flujo para automatizar respuestas y seguimientos."}
          action={!query && <Button onClick={() => { setNewName(""); setCreateOpen(true); }}>+ Crear workflow</Button>}
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((w) => (
            <WorkflowCard
              key={w.id}
              w={w}
              onOpen={() => router.push(`/workflows/${w.id}`)}
              onRename={() => setRenameTarget(w)}
              onDuplicate={() => duplicate(w)}
              onToggle={() => toggleActive(w)}
              onDelete={() => setDeleteTarget(w)}
            />
          ))}
        </div>
      )}

      {/* Crear */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Crear workflow">
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Nombre del flujo</span>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void createBlank(); }}
            placeholder="p. ej. Seguimiento de leads fríos"
            className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <p className="mt-2 text-xs text-slate-400">Partirás desde un lienzo en blanco. (Las plantillas llegan en la próxima entrega.)</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancelar</Button>
          <Button onClick={() => void createBlank()} disabled={busy || newName.trim().length < 2}>Crear y editar</Button>
        </div>
      </Modal>

      {/* Renombrar */}
      <RenameModal
        target={renameTarget}
        onClose={() => setRenameTarget(null)}
        onSaved={async () => { setRenameTarget(null); await load(); }}
      />

      {/* Eliminar */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={doDelete}
        title="Eliminar flujo"
        description={`¿Eliminar "${deleteTarget?.name}"? Las ejecuciones en curso se detendrán. Esta acción no se puede deshacer.`}
        confirmLabel="Eliminar"
        danger
      />
    </div>
  );
}

function WorkflowCard({
  w, onOpen, onRename, onDuplicate, onToggle, onDelete,
}: {
  w: WorkflowRow;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const badge = STATUS_BADGE[w.status];
  const longDesc = (w.description?.length ?? 0) > 90;
  return (
    <div className="flex items-start justify-between gap-4 rounded-card border border-slate-200 bg-white p-4 shadow-card">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge kind={badge.kind} label={badge.label} />
          {w.hasDraft && w.status !== "draft" && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">cambios sin publicar</span>
          )}
          <h3 className="truncate font-medium text-navy-900">{w.name}</h3>
        </div>
        {w.description && (
          <p className="mt-1 text-sm text-slate-500">
            {longDesc && !expanded ? `${w.description.slice(0, 90)}… ` : w.description}
            {longDesc && (
              <span
                role="button"
                onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
                className="font-medium text-brand-600 hover:underline"
              >
                {expanded ? "Ver menos" : "Ver más"}
              </span>
            )}
          </p>
        )}
        <p className="mt-1.5 text-xs text-slate-400">
          Disparador: {w.trigger ? TRIGGER_LABELS[w.trigger] ?? w.trigger : "—"} · {w.runsTotal} ejecuciones
          {w.runsWaiting > 0 ? ` (${w.runsWaiting} en espera)` : ""}
        </p>
        <p className="mt-0.5 text-[11px] text-slate-400">
          {w.publishedAt
            ? `Publicado ${fmtDate(w.publishedAt)}${w.publishedBy ? ` por ${w.publishedBy}` : ""}`
            : "Nunca publicado"}
          {" · "}
          Creado {fmtDate(w.createdAt)}{w.createdBy ? ` por ${w.createdBy}` : ""}
        </p>
      </button>
      <RowMenu
        items={[
          { label: "Renombrar", onClick: onRename },
          { label: "Duplicar", onClick: onDuplicate },
          ...(w.status !== "draft"
            ? [{ label: w.active ? "Detener" : "Reanudar", onClick: onToggle }]
            : []),
          { label: "Eliminar", onClick: onDelete, danger: true },
        ]}
      />
    </div>
  );
}

function RowMenu({ items }: { items: { label: string; onClick: () => void; danger?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);
  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={() => setOpen((v) => !v)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Acciones">
        <MoreVertical size={18} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-40 rounded-lg border border-slate-200 bg-white py-1 shadow-pop">
          {items.map((it) => (
            <button
              key={it.label}
              onClick={() => { setOpen(false); it.onClick(); }}
              className={cn("block w-full px-3 py-1.5 text-left text-sm hover:bg-slate-50", it.danger ? "text-red-600" : "text-slate-700")}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RenameModal({ target, onClose, onSaved }: { target: WorkflowRow | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (target) { setName(target.name); setDescription(target.description ?? ""); }
  }, [target]);
  async function save() {
    if (!target) return;
    try {
      await api(`/workflows/${target.id}`, { method: "PATCH", body: JSON.stringify({ name, description: description || null }) });
      toast.push("Guardado", "ok");
      onSaved();
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }
  return (
    <Modal open={!!target} onClose={onClose} title="Renombrar flujo">
      <label className="block text-sm">
        <span className="text-xs text-slate-500">Nombre</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      </label>
      <label className="mt-3 block text-sm">
        <span className="text-xs text-slate-500">Descripción (opcional)</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={name.trim().length < 2}>Guardar</Button>
      </div>
    </Modal>
  );
}
