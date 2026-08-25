"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreVertical, Search, Workflow as WorkflowIcon } from "lucide-react";
import { api } from "@/lib/api";
import { Button, ConfirmDialog, EmptyState, Modal, PageHeader, StatusBadge, useToast, cn } from "@/components/ui";
import { templatesByIndustry, type WorkflowTemplate } from "@/lib/workflow-templates";

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

// Etiquetas de RESPALDO: la fuente real es el catálogo del editor
// (/workflows/meta/catalog) que se carga al montar — así la lista y el editor
// muestran SIEMPRE el mismo nombre para cada disparador (B3).
const TRIGGER_LABELS: Record<string, string> = {
  conversation_started: "Conversación nueva",
  message_received: "Mensaje recibido",
  keyword: "Palabra clave",
  lead_created: "Lead creado",
  tag_added: "Etiqueta añadida",
  manual: "Disparo manual",
  webhook_received: "Webhook entrante",
  conversation_closed: "Conversación cerrada",
  appointment_upcoming: "Recordatorio de cita",
  missed_call: "Llamada perdida",
};

const ONBOARDING_KEY = "conversia.workflows.onboarded";

const ONBOARDING_STEPS: { icon: string; title: string; body: string }[] = [
  {
    icon: "⚡",
    title: "¿Qué es un flujo de trabajo?",
    body: "Una automatización que reacciona sola a algo que pasa —un mensaje nuevo, una cita, una etiqueta— y ejecuta una serie de pasos sin que tengas que estar tú. Ideal para bienvenidas, seguimientos y recordatorios.",
  },
  {
    icon: "🎯",
    title: "El disparador decide CUÁNDO arranca",
    body: "Lo eliges en el panel del disparador. Ahí mismo verás, en palabras, «Se activará cuando…» y podrás probarlo con un mensaje de ejemplo. Si otro flujo ya reacciona a lo mismo, te avisamos para que no choquen.",
  },
  {
    icon: "🧩",
    title: "Los pasos son lo que el flujo HACE",
    body: "Enviar un mensaje (con variables como el nombre del contacto), esperar, ramificar según si el contacto responde, escalar a una persona o dejar que responda la IA. Los encadenas arrastrando en el lienzo.",
  },
  {
    icon: "🚀",
    title: "Pruébalo y publícalo con red",
    body: "Antes de publicar, usa «Depurar» para recorrerlo paso a paso con un contacto de prueba. Cuando publiques queda activo; y si un flujo falla en producción, te llega una alerta para que no te enteres por un cliente.",
  },
];

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
  const [hasAgents, setHasAgents] = useState<boolean | null>(null);
  const [triggerLabels, setTriggerLabels] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [renameTarget, setRenameTarget] = useState<WorkflowRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkflowRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  // Onboarding: se abre solo la PRIMERA vez (recordado en el navegador). Se puede
  // reabrir con el botón «¿Cómo funciona?».
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!localStorage.getItem(ONBOARDING_KEY)) setShowHelp(true);
  }, []);
  const closeHelp = () => {
    setShowHelp(false);
    if (typeof window !== "undefined") localStorage.setItem(ONBOARDING_KEY, "1");
  };

  const load = useCallback(async () => {
    setRows(await api<WorkflowRow[]>("/workflows"));
    // Aviso de agentes: los pasos «Ejecutar agente IA» necesitan un agente activo.
    api<{ id: string; name: string }[]>("/agents/assignable")
      .then((a) => setHasAgents(a.length > 0))
      .catch(() => setHasAgents(null));
    // Etiquetas de disparadores desde el MISMO catálogo del editor (fuente única)
    api<{ triggers: { type: string; label: string }[] }>("/workflows/meta/catalog")
      .then((c) => setTriggerLabels(Object.fromEntries(c.triggers.map((t) => [t.type, t.label]))))
      .catch(() => setTriggerLabels({}));
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

  async function createFromTemplate(t: WorkflowTemplate) {
    setBusy(true);
    try {
      const name = newName.trim().length >= 2 ? newName.trim() : t.name;
      const wf = await api<{ id: string }>("/workflows", { method: "POST", body: JSON.stringify({ name }) });
      await api(`/workflows/${wf.id}/draft`, { method: "PUT", body: JSON.stringify({ name, definition: t.definition }) });
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
        title="Flujos"
        description="Automatizaciones sin código: seguimientos, respuestas, esperas y acciones sobre leads y conversaciones."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setShowHelp(true)}>¿Cómo funciona?</Button>
            <Button onClick={() => { setNewName(""); setCreateOpen(true); }}>+ Crear flujo</Button>
          </div>
        }
      />

      <div className="mb-4 flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 sm:max-w-xs">
        <Search size={15} className="text-ink-subtle" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nombre…"
          className="w-full bg-transparent text-sm outline-none"
        />
      </div>

      {rows === null ? (
        <p className="text-sm text-ink-subtle">Cargando…</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<WorkflowIcon size={28} />}
          title={query ? "Sin resultados" : "Aún no tienes flujos"}
          description={query ? "Prueba con otro nombre." : "Automatiza recordatorios, seguimientos y respuestas. Empieza con una plantilla lista para tu rubro y edítala a tu gusto."}
          action={!query && <Button onClick={() => { setNewName(""); setCreateOpen(true); }}>Ver plantillas</Button>}
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((w) => (
            <WorkflowCard
              key={w.id}
              w={w}
              triggerLabels={triggerLabels}
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
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Crear flujo" wide>
        {hasAgents === false && (
          <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200">
            <p className="font-medium">Aún no tienes agentes de IA.</p>
            <p className="mt-0.5 text-xs">
              Puedes crear el flujo igual, pero los pasos «Ejecutar agente IA» no responderán hasta que tengas uno activo.{" "}
              <a href="/agents" className="font-medium underline hover:no-underline">Crear un agente primero →</a>
            </p>
          </div>
        )}
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Nombre del flujo (opcional si eliges una plantilla)</span>
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="p. ej. Seguimiento de leads fríos"
            className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
          />
        </label>

        <div className="mt-4 space-y-4">
          <p className="text-xs font-medium text-ink-muted">Empieza desde una plantilla — la abres y la editas a tu gusto</p>
          {templatesByIndustry().map(({ industry, items }) => (
            <div key={industry}>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400">{industry}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {items.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => void createFromTemplate(t)}
                    disabled={busy}
                    className="flex items-start gap-2.5 rounded-lg border border-line p-3 text-left hover:border-brand-300 hover:bg-brand-50 disabled:opacity-50 dark:hover:bg-brand-500/10"
                  >
                    <span className="text-lg leading-none" aria-hidden>{t.icon}</span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">{t.name}</span>
                      <span className="mt-0.5 block text-xs text-ink-muted">{t.description}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
          <span className="text-xs text-ink-subtle">…o parte desde un lienzo en blanco.</span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancelar</Button>
            <Button onClick={() => void createBlank()} disabled={busy || newName.trim().length < 2}>Crear en blanco</Button>
          </div>
        </div>
      </Modal>

      {/* Onboarding / ayuda */}
      <OnboardingModal open={showHelp} onClose={closeHelp} onCreate={() => { closeHelp(); setNewName(""); setCreateOpen(true); }} />

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

function OnboardingModal({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: () => void }) {
  const [step, setStep] = useState(0);
  useEffect(() => { if (open) setStep(0); }, [open]);
  const s = ONBOARDING_STEPS[step];
  const last = step === ONBOARDING_STEPS.length - 1;
  return (
    <Modal open={open} onClose={onClose} title="Cómo funcionan los flujos" wide>
      <div className="flex items-start gap-4">
        <span className="text-4xl leading-none" aria-hidden>{s.icon}</span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-ink">{s.title}</h3>
          <p className="mt-1.5 text-sm text-ink-muted">{s.body}</p>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between">
        <div className="flex gap-1.5">
          {ONBOARDING_STEPS.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              aria-label={`Paso ${i + 1}`}
              className={cn("h-1.5 rounded-full transition-all", i === step ? "w-6 bg-brand-500" : "w-1.5 bg-line-strong hover:bg-ink-subtle")}
            />
          ))}
        </div>
        <div className="flex gap-2">
          {step > 0 && <Button variant="secondary" onClick={() => setStep((v) => v - 1)}>Atrás</Button>}
          {last ? (
            <Button onClick={onCreate}>Crear mi primer flujo</Button>
          ) : (
            <Button onClick={() => setStep((v) => v + 1)}>Siguiente</Button>
          )}
        </div>
      </div>

      <div className="mt-3 text-center">
        <button onClick={onClose} className="text-xs text-ink-subtle hover:text-ink-muted hover:underline">Entendido, cerrar</button>
      </div>
    </Modal>
  );
}

function WorkflowCard({
  triggerLabels,
  w, onOpen, onRename, onDuplicate, onToggle, onDelete,
}: {
  triggerLabels: Record<string, string>;
  w: WorkflowRow;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const badge = STATUS_BADGE[w.status] ?? { kind: "disconnected" as const, label: w.status ?? "—" };
  const longDesc = (w.description?.length ?? 0) > 90;
  return (
    <div className="flex items-start justify-between gap-4 rounded-card border border-line bg-panel p-4 shadow-card">
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge kind={badge.kind} label={badge.label} />
          {w.hasDraft && w.status !== "draft" && (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">cambios sin publicar</span>
          )}
          <h3 className="truncate font-medium text-ink">{w.name}</h3>
        </div>
        {w.description && (
          <p className="mt-1 text-sm text-ink-muted">
            {longDesc && !expanded ? `${w.description.slice(0, 90)}… ` : w.description}
            {longDesc && (
              <span
                role="button"
                onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
                className="font-medium text-brand-600 hover:underline dark:text-brand-400"
              >
                {expanded ? "Ver menos" : "Ver más"}
              </span>
            )}
          </p>
        )}
        <p className="mt-1.5 text-xs text-ink-subtle">
          Disparador: {w.trigger ? triggerLabels[w.trigger] ?? TRIGGER_LABELS[w.trigger] ?? w.trigger : "—"} · {w.runsTotal} ejecuciones
          {w.runsWaiting > 0 ? ` (${w.runsWaiting} en espera)` : ""}
        </p>
        <p className="mt-0.5 text-[11px] text-ink-subtle">
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
      <button onClick={() => setOpen((v) => !v)} className="rounded-lg p-1.5 text-ink-subtle hover:bg-app hover:text-ink-muted" aria-label="Acciones">
        <MoreVertical size={18} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-40 rounded-lg border border-line bg-panel py-1 shadow-pop">
          {items.map((it) => (
            <button
              key={it.label}
              onClick={() => { setOpen(false); it.onClick(); }}
              className={cn("block w-full px-3 py-1.5 text-left text-sm hover:bg-app", it.danger ? "text-red-600 dark:text-red-400" : "text-ink")}
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
        <span className="text-xs text-ink-muted">Nombre</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
      </label>
      <label className="mt-3 block text-sm">
        <span className="text-xs text-ink-muted">Descripción (opcional)</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={name.trim().length < 2}>Guardar</Button>
      </div>
    </Modal>
  );
}
