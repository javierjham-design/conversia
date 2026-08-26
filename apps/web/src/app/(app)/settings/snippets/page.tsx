"use client";

/**
 * Respuestas rápidas (atajo "/" del compositor de la Bandeja): página de
 * gestión con búsqueda, filtro por ámbito, editor con picker de variables y
 * vista previa. Al primer uso se siembran 5 ejemplos genéricos «edítame».
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button, ConfirmDialog, IconButton, Modal, Select, Skeleton, cn, useToast } from "@/components/ui";
import { renderSnippet } from "../../inbox/types";

interface SnippetRow {
  id: string;
  shortcut: string;
  body: string;
  scope: string;
}

const VARIABLES: { label: string; token: string }[] = [
  { label: "Nombre", token: "{{contact.firstName}}" },
  { label: "Apellido", token: "{{contact.lastName}}" },
  { label: "Nombre completo", token: "{{contact.name}}" },
  { label: "Teléfono", token: "{{contact.phone}}" },
  { label: "Email", token: "{{contact.email}}" },
];

const SAMPLE_CONTACT = { id: "x", firstName: "María", lastName: "Pérez", profileName: null, phone: "+56 9 1234 5678", email: "maria@ejemplo.cl" };

export default function SnippetsSettingsPage() {
  const toast = useToast();
  const [items, setItems] = useState<SnippetRow[] | null>(null);
  const [q, setQ] = useState("");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [editing, setEditing] = useState<SnippetRow | null>(null);
  const [creating, setCreating] = useState<Partial<SnippetRow> | null>(null);
  const [deleting, setDeleting] = useState<SnippetRow | null>(null);

  const load = useCallback(async () => {
    setItems(await api<SnippetRow[]>("/inbox/snippets").catch(() => []));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () =>
      (items ?? []).filter(
        (s) =>
          (scopeFilter === "all" || s.scope === scopeFilter) &&
          (!q.trim() || `${s.shortcut} ${s.body}`.toLowerCase().includes(q.trim().toLowerCase())),
      ),
    [items, q, scopeFilter],
  );

  if (!items) return <div className="mx-auto max-w-4xl p-6"><Skeleton className="h-72" /></div>;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Respuestas rápidas</h2>
        <Button onClick={() => setCreating({ scope: "team" })}><Plus size={14} /> Nueva respuesta</Button>
      </div>

      {/* Cómo se usan: mini ejemplo visual */}
      <div className="mt-3 rounded-card border border-brand-100 bg-brand-50/60 p-4 dark:border-brand-500/25">
        <p className="text-sm text-brand-900 dark:text-brand-200">
          Escribe <code className="rounded bg-panel px-1.5 py-0.5 font-mono text-brand-700 dark:text-brand-300">/</code> en el chat de la
          Bandeja y elige tu respuesta — se pega con los datos reales del contacto.
        </p>
        <div className="mt-2 flex items-center gap-2 text-xs">
          <span className="rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-ink-muted">/saludo</span>
          <span className="text-ink-subtle">→</span>
          <span className="rounded-2xl bg-brand-700 px-3 py-1.5 text-white">¡Hola María! 👋 Gracias por escribirnos…</span>
        </div>
      </div>

      <div className="mt-4 flex gap-2">
        <div className="relative flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-2.5 text-ink-subtle" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar por atajo o contenido…" className="w-full rounded-lg border border-line-strong py-1.5 pl-8 pr-3 text-sm" />
        </div>
        <Select value={scopeFilter} onChange={(e) => setScopeFilter(e.target.value)}>
          <option value="all">Todos los ámbitos</option>
          <option value="team">Equipo</option>
          <option value="mine">Solo yo</option>
        </Select>
      </div>

      <ul className="mt-3 space-y-1.5">
        {filtered.length === 0 && (
          <p className="rounded-lg border border-dashed border-line p-6 text-center text-sm text-ink-subtle">
            {items.length === 0 ? "Crea tu primera respuesta rápida con el botón de arriba." : "Nada calza con la búsqueda."}
          </p>
        )}
        {filtered.map((s) => (
          <li key={s.id} className="flex items-center gap-3 rounded-card border border-line bg-panel px-3 py-2.5 shadow-card">
            <span className="w-32 shrink-0 truncate font-mono text-sm text-brand-700 dark:text-brand-300">/{s.shortcut}</span>
            <p className="min-w-0 flex-1 truncate text-sm text-ink-muted" title={s.body}>{s.body}</p>
            <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", s.scope === "mine" ? "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300" : "bg-app text-ink-muted")}>
              {s.scope === "mine" ? "Solo yo" : "Equipo"}
            </span>
            <IconButton label="Editar" onClick={() => setEditing(s)}><Pencil size={14} /></IconButton>
            <IconButton label="Duplicar" onClick={() => setCreating({ shortcut: `${s.shortcut}-copia`, body: s.body, scope: s.scope })}><Copy size={14} /></IconButton>
            <IconButton label="Eliminar" destructive onClick={() => setDeleting(s)}><Trash2 size={14} /></IconButton>
          </li>
        ))}
      </ul>

      {(editing || creating) && (
        <SnippetEditor
          snippet={editing}
          initial={creating ?? undefined}
          onClose={() => {
            setEditing(null);
            setCreating(null);
          }}
          onSaved={() => {
            setEditing(null);
            setCreating(null);
            void load();
          }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          void api(`/inbox/snippets/${deleting.id}`, { method: "DELETE" })
            .then(() => { toast.push("Respuesta eliminada", "info"); setDeleting(null); void load(); })
            .catch((err) => toast.push((err as Error).message, "error"));
        }}
        title={`¿Eliminar /${deleting?.shortcut}?`}
        description="Dejará de aparecer en el compositor de la Bandeja."
        confirmLabel="Eliminar"
        danger
      />
    </div>
  );
}

function SnippetEditor({
  snippet,
  initial,
  onClose,
  onSaved,
}: {
  snippet: SnippetRow | null;
  initial?: Partial<SnippetRow>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [shortcut, setShortcut] = useState(snippet?.shortcut ?? initial?.shortcut ?? "");
  const [body, setBody] = useState(snippet?.body ?? initial?.body ?? "");
  const [scope, setScope] = useState(snippet?.scope ?? initial?.scope ?? "team");
  const [busy, setBusy] = useState(false);
  const shortcutOk = /^[a-z0-9_-]{2,30}$/.test(shortcut);

  async function save() {
    setBusy(true);
    try {
      const payload = { shortcut, body: body.trim(), scope };
      if (snippet) await api(`/inbox/snippets/${snippet.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await api("/inbox/snippets", { method: "POST", body: JSON.stringify(payload) });
      toast.push(snippet ? "Respuesta actualizada" : "Respuesta creada", "ok");
      onSaved();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={snippet ? `Editar /${snippet.shortcut}` : "Nueva respuesta rápida"} wide>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Atajo (minúsculas, sin espacios)</span>
          <div className="mt-1 flex items-center rounded-lg border border-line-strong focus-within:border-brand-400">
            <span className="pl-2 font-mono text-ink-subtle">/</span>
            <input
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
              placeholder="precio-implante"
              className="w-full rounded-lg px-1 py-2 font-mono text-sm outline-none"
            />
          </div>
          {!shortcutOk && shortcut.length > 0 && (
            <span className="text-[10px] text-red-500">2-30 caracteres: letras, números, guion o guion bajo.</span>
          )}
        </label>
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Ámbito</span>
          <Select value={scope} onChange={(e) => setScope(e.target.value)} className="mt-1 w-full">
            <option value="team">Equipo (la ve todo el equipo)</option>
            <option value="mine">Solo yo</option>
          </Select>
        </label>
      </div>

      <label className="mt-3 block text-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-muted">Contenido</span>
          <span className={cn("text-[10px]", body.length > 1900 ? "text-red-500" : "text-ink-subtle")}>{body.length}/2000</span>
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, 2000))}
          rows={4}
          placeholder="Hola {{contact.firstName}}! …"
          className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
        />
      </label>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <span className="text-[10px] text-ink-subtle">Insertar variable:</span>
        {VARIABLES.map((v) => (
          <button key={v.token} onClick={() => setBody((b) => (b + " " + v.token).slice(0, 2000))} className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-muted hover:border-brand-300 hover:text-brand-700">
            {v.label}
          </button>
        ))}
      </div>

      {body.trim() && (
        <div className="mt-3 rounded-lg border border-line bg-app p-3">
          <p className="text-[10px] font-medium uppercase text-ink-subtle">Vista previa (con datos de ejemplo)</p>
          <p className="mt-1 inline-block max-w-md whitespace-pre-wrap rounded-2xl bg-brand-700 px-3 py-2 text-sm text-white">{renderSnippet(body, SAMPLE_CONTACT)}</p>
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={busy || !shortcutOk || body.trim().length < 2}>
          {snippet ? "Guardar cambios" : "Crear respuesta"}
        </Button>
      </div>
    </Modal>
  );
}
