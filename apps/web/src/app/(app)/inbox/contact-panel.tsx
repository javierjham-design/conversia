"use client";

/** Panel derecho: datos del contacto, origen, e indicaciones para la IA. */
import { useState } from "react";
import { ExternalLink, Megaphone, Sparkles, User, X } from "lucide-react";
import { api } from "@/lib/api";
import { StatusBadge, cn, useToast } from "@/components/ui";
import { avatarColor, displayName, initials, type ConvContext } from "./types";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="mb-1 text-2xs font-semibold uppercase tracking-wide text-ink-subtle">{children}</p>;
}

export function ContactPanel({
  conversationId,
  context,
  onClose,
  onChanged,
}: {
  conversationId: string;
  context: ConvContext | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [newNote, setNewNote] = useState("");
  const [busy, setBusy] = useState(false);

  if (!context) {
    return (
      <div className="flex h-full w-72 shrink-0 flex-col gap-3 border-l border-line bg-panel p-3">
        <div className="h-12 shimmer rounded-card bg-line" />
        <div className="h-24 shimmer rounded-card bg-line" />
        <div className="h-32 shimmer rounded-card bg-line" />
      </div>
    );
  }
  const c = context.contact;

  async function addNote() {
    if (newNote.trim().length < 2) return;
    setBusy(true);
    try {
      await api(`/conversations/${conversationId}/ai-notes`, { method: "POST", body: JSON.stringify({ body: newNote.trim() }) });
      setNewNote("");
      toast.push("Indicación guardada — la IA la seguirá en esta conversación", "ok");
      onChanged();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function toggleNote(noteId: string, active: boolean) {
    await api(`/conversations/ai-notes/${noteId}`, { method: "PATCH", body: JSON.stringify({ active }) });
    onChanged();
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-l border-line bg-panel">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-panel px-3 py-2.5">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink"><User size={14} /> Contacto</h3>
        <button onClick={onClose} className="rounded-control p-1 text-ink-subtle transition-colors hover:bg-app hover:text-ink" aria-label="Cerrar panel">
          <X size={15} />
        </button>
      </div>

      <div className="space-y-4 p-3">
        {/* Datos básicos */}
        <div>
          <div className="flex items-center gap-2.5">
            {c.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img referrerPolicy="no-referrer" src={c.avatarUrl} alt="" className="h-11 w-11 rounded-full border border-line object-cover" />
            ) : (
              <div className={cn("flex h-11 w-11 items-center justify-center rounded-full text-sm font-semibold", avatarColor(c))}>
                {initials(c).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-ink">{displayName(c)}</p>
              <p className="truncate text-xs text-ink-subtle tnum">
                {c.phone}
                {c.country ? ` · ${c.country}` : ""}
              </p>
            </div>
          </div>
          <dl className="mt-2.5 space-y-1 text-xs">
            {c.email && (
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-ink-subtle">Email</dt>
                <dd className="min-w-0 truncate text-ink-muted">{c.email}</dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="w-14 shrink-0 text-ink-subtle">Desde</dt>
              <dd className="text-ink-muted">
                {new Date(c.createdAt).toLocaleDateString("es-CL")}
                {c.isReturning ? " · recurrente" : ""}
              </dd>
            </div>
            {c.source && (
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-ink-subtle">Origen</dt>
                <dd className="text-ink-muted">{c.source}</dd>
              </div>
            )}
          </dl>
          {c.blocked && <div className="mt-1.5"><StatusBadge kind="error" label="Bloqueado" /></div>}
          <a href={`/contacts?open=${c.id}`} className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-700 transition-colors hover:text-brand-800 dark:text-brand-400 dark:text-brand-300">
            Ver ficha completa <ExternalLink size={11} />
          </a>
        </div>

        {/* Etapa + tags */}
        <div>
          <SectionTitle>Etapa y etiquetas</SectionTitle>
          {context.stage ? (
            <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: `${context.stage.color ?? "#94a3b8"}1f`, color: context.stage.color ?? "#475569" }}>
              {context.stage.emoji ? <span>{context.stage.emoji}</span> : <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: context.stage.color ?? "#94a3b8" }} />}
              {context.stage.name}
            </span>
          ) : (
            <p className="text-xs text-ink-subtle">Sin etapa aún</p>
          )}
          {context.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {context.tags.map((t) => (
                <span key={t} className="rounded bg-line px-1.5 py-0.5 text-[10px] text-ink-muted">{t}</span>
              ))}
            </div>
          )}
        </div>

        {/* Origen por anuncio / formulario */}
        {context.ad && (
          <div className="rounded-card border border-line border-l-[3px] border-l-violet-400 bg-raised p-2.5 text-xs text-ink dark:border-l-violet-500">
            <p className="flex items-center gap-1 font-medium text-violet-700 dark:text-violet-300"><Megaphone size={12} /> Llegó desde un anuncio</p>
            {(context.ad.campaignName || context.ad.adName) && (
              <p className="mt-1 font-medium text-ink">
                {context.ad.campaignName ?? ""}{context.ad.campaignName && context.ad.adName ? " · " : ""}{context.ad.adName ?? ""}
              </p>
            )}
            {context.ad.headline && <p className="mt-1 text-ink-muted">«{context.ad.headline}»</p>}
            {context.ad.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img referrerPolicy="no-referrer" src={context.ad.imageUrl} alt="Anuncio" className="mt-1.5 max-h-24 rounded-control object-cover" />
            )}
            <p className="mt-1 break-all text-[10px] text-ink-subtle">
              {context.ad.adId ? `ad ${context.ad.adId}` : ""}
              {context.ad.ctwaClid ? ` · ctwa ${context.ad.ctwaClid.slice(0, 18)}…` : ""}
            </p>
            {context.ad.sourceUrl && (
              <a href={context.ad.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-violet-600 underline dark:text-violet-300 ">
                Ver anuncio <ExternalLink size={10} />
              </a>
            )}
          </div>
        )}
        {context.leadForm && (
          <div className="rounded-card border border-line border-l-[3px] border-l-sky-400 bg-raised p-2.5 text-xs text-ink dark:border-l-sky-500">
            <p className="font-medium text-sky-700 dark:text-sky-300">📋 Formulario de Meta</p>
            <dl className="mt-1 space-y-0.5 text-ink-muted">
              {context.leadForm.fields.slice(0, 8).map(([k, v]) => (
                <div key={k} className="flex gap-1">
                  <dt className="shrink-0 text-ink-subtle">{k}:</dt>
                  <dd className="truncate">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {/* Indicaciones para la IA — herramienta, no advertencia */}
        <div className="rounded-card border border-brand-200 bg-brand-soft p-2.5 dark:border-brand-500/30">
          <SectionTitle>
            <span className="flex items-center gap-1 text-brand-700 dark:text-brand-300">
              <Sparkles size={12} /> Indicaciones para la IA
            </span>
          </SectionTitle>
          <p className="text-[10px] text-ink-muted">
            Solo para ESTA conversación. El bot las sigue en cada respuesta, sin saltarse las reglas de seguridad.
          </p>
          <textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            rows={2}
            placeholder="p. ej. Ofrécele el plan con 20% dcto; trátalo de usted"
            className="mt-1.5 w-full rounded-control border border-line-strong bg-panel px-2 py-1.5 text-xs text-ink placeholder:text-ink-subtle"
          />
          <button
            onClick={() => void addNote()}
            disabled={busy || newNote.trim().length < 2}
            className="mt-1 w-full rounded-control bg-brand-600 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Agregar indicación
          </button>

          {context.aiNotes.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {context.aiNotes.map((n) => (
                <li key={n.id} className={cn("rounded-control border p-1.5 text-xs", n.active ? "border-line bg-panel text-ink" : "border-line bg-app opacity-60")}>
                  <p className={n.active ? "" : "line-through"}>{n.body}</p>
                  <div className="mt-1 flex items-center justify-between text-[10px] text-ink-subtle">
                    <span>{n.createdBy ?? "equipo"} · {new Date(n.createdAt).toLocaleDateString("es-CL")}</span>
                    <button onClick={() => void toggleNote(n.id, !n.active)} className="font-medium underline transition-colors hover:text-ink">
                      {n.active ? "Desactivar" : "Reactivar"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}
