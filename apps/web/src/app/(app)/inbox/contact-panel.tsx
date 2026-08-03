"use client";

/** Panel derecho: datos del contacto, origen, e indicaciones para la IA. */
import { useState } from "react";
import { ExternalLink, Lightbulb, Megaphone, User, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button, StatusBadge, useToast } from "@/components/ui";
import { displayName, type ConvContext } from "./types";

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
      <div className="flex h-full w-72 shrink-0 items-center justify-center border-l border-slate-200 bg-white text-xs text-slate-400">
        Cargando contacto…
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
    <aside className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 p-3">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold"><User size={14} /> Contacto</h3>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600" aria-label="Cerrar panel">
          <X size={15} />
        </button>
      </div>

      <div className="space-y-3 p-3">
        {/* Datos básicos */}
        <div>
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-cyan-100 text-sm font-semibold text-cyan-700">
              {displayName(c).slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{displayName(c)}</p>
              <p className="truncate text-xs text-slate-400">
                {c.phone}
                {c.country ? ` · ${c.country}` : ""}
              </p>
            </div>
          </div>
          <div className="mt-2 space-y-0.5 text-xs text-slate-500">
            {c.email && <p>✉ {c.email}</p>}
            <p>
              Desde {new Date(c.createdAt).toLocaleDateString("es-CL")}
              {c.isReturning ? " · recurrente" : ""}
              {c.source ? ` · vía ${c.source}` : ""}
            </p>
            {c.blocked && <StatusBadge kind="error" label="Bloqueado" />}
          </div>
          <a href={`/contacts?open=${c.id}`} className="mt-1.5 inline-flex items-center gap-1 text-xs text-cyan-700 underline">
            Ver ficha completa <ExternalLink size={11} />
          </a>
        </div>

        {/* Etapa + tags */}
        <div className="rounded-lg border border-slate-100 p-2">
          <p className="text-[11px] font-semibold uppercase text-slate-400">Etapa</p>
          {context.stage ? (
            <span className="mt-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium" style={{ backgroundColor: `${context.stage.color ?? "#94a3b8"}22`, color: context.stage.color ?? "#475569" }}>
              {context.stage.emoji ? <span>{context.stage.emoji}</span> : <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: context.stage.color ?? "#94a3b8" }} />}
              {context.stage.name}
            </span>
          ) : (
            <p className="text-xs text-slate-400">Sin etapa aún</p>
          )}
          {context.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {context.tags.map((t) => (
                <span key={t} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">{t}</span>
              ))}
            </div>
          )}
        </div>

        {/* Origen por anuncio / formulario */}
        {context.ad && (
          <div className="rounded-lg border border-violet-200 bg-violet-50 p-2 text-xs text-violet-800">
            <p className="flex items-center gap-1 font-medium"><Megaphone size={12} /> Llegó desde un anuncio</p>
            {context.ad.headline && <p className="mt-1">«{context.ad.headline}»</p>}
            {context.ad.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={context.ad.imageUrl} alt="Anuncio" className="mt-1.5 max-h-24 rounded-lg object-cover" />
            )}
            <p className="mt-1 break-all text-[10px] text-violet-500">
              {context.ad.adId ? `ad ${context.ad.adId}` : ""}
              {context.ad.ctwaClid ? ` · ctwa ${context.ad.ctwaClid.slice(0, 18)}…` : ""}
            </p>
            {context.ad.sourceUrl && (
              <a href={context.ad.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 underline">
                Ver anuncio <ExternalLink size={10} />
              </a>
            )}
          </div>
        )}
        {context.leadForm && (
          <div className="rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs text-sky-800">
            <p className="font-medium">📋 Formulario de Meta</p>
            <dl className="mt-1 space-y-0.5">
              {context.leadForm.fields.slice(0, 8).map(([k, v]) => (
                <div key={k} className="flex gap-1">
                  <dt className="shrink-0 text-sky-500">{k}:</dt>
                  <dd className="truncate">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {/* Indicaciones para la IA */}
        <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-2">
          <p className="flex items-center gap-1 text-[11px] font-semibold uppercase text-amber-700">
            <Lightbulb size={12} /> Indicaciones para la IA
          </p>
          <p className="mt-0.5 text-[10px] text-amber-600">
            Solo para ESTA conversación. El bot las sigue en cada respuesta (sin saltarse las reglas de seguridad).
          </p>
          <textarea
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            rows={2}
            placeholder="p. ej. Ofrécele el plan con 20% dcto; trátalo de usted"
            className="mt-1.5 w-full rounded-lg border border-amber-200 bg-white px-2 py-1.5 text-xs"
          />
          <Button onClick={() => void addNote()} disabled={busy || newNote.trim().length < 2} className="mt-1 w-full !py-1 text-xs">
            Agregar indicación
          </Button>

          {context.aiNotes.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {context.aiNotes.map((n) => (
                <li key={n.id} className={`rounded-lg border p-1.5 text-xs ${n.active ? "border-amber-300 bg-white" : "border-slate-200 bg-slate-50 opacity-60"}`}>
                  <p className={n.active ? "" : "line-through"}>{n.body}</p>
                  <div className="mt-1 flex items-center justify-between text-[10px] text-slate-400">
                    <span>
                      {n.createdBy ?? "equipo"} · {new Date(n.createdAt).toLocaleDateString("es-CL")}
                    </span>
                    <button onClick={() => void toggleNote(n.id, !n.active)} className="underline hover:text-slate-600">
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
