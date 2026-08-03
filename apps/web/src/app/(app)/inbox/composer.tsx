"use client";

/**
 * Compositor: Responder / Comentario interno, snippets con "/", variables con
 * "$", emojis, adjuntos, asistente IA (sugerir/mejorar/traducir), Resumir y
 * CTA de plantillas cuando la ventana de 24 h está cerrada.
 */
import { useEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon, Paperclip, Smile, Sparkles, StickyNote } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Modal, cn, useToast } from "@/components/ui";
import { renderSnippet, type ConversationFull, type Snippet } from "./types";

const EMOJIS = ["😀", "😁", "😂", "🙂", "😉", "😍", "🤗", "🤔", "👍", "👏", "🙏", "💪", "🎉", "✅", "❤️", "😅", "😊", "🙌", "🦷", "✨", "📅", "📍", "☎️", "⏰", "💬", "😷", "🚀", "⭐", "❗", "❓"];

const VARIABLES: { label: string; key: string }[] = [
  { label: "Nombre", key: "contact.firstName" },
  { label: "Apellido", key: "contact.lastName" },
  { label: "Nombre completo", key: "contact.name" },
  { label: "Teléfono", key: "contact.phone" },
  { label: "Email", key: "contact.email" },
];

export function Composer({
  conversation,
  windowOpen,
  windowLabel,
  windowLevel,
  onSent,
  onOpenTemplates,
}: {
  conversation: ConversationFull;
  windowOpen: boolean;
  windowLabel: string;
  windowLevel: "ok" | "warn" | "closed";
  onSent: () => void;
  onOpenTemplates: () => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<"reply" | "note">("reply");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [showSnippets, setShowSnippets] = useState(false);
  const [showVars, setShowVars] = useState(false);
  const [showEmojis, setShowEmojis] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void api<Snippet[]>("/inbox/snippets").then(setSnippets).catch(() => setSnippets([]));
  }, []);

  const canWrite = tab === "note" || windowOpen;
  const snippetFilter = draft.startsWith("/") ? draft.slice(1).toLowerCase() : null;

  function insert(text: string) {
    setDraft((d) => (d.startsWith("/") || d.startsWith("$") ? text : d + text));
    setShowSnippets(false);
    setShowVars(false);
    setShowEmojis(false);
    textareaRef.current?.focus();
  }

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api(`/conversations/${conversation.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, internal: tab === "note" }),
      });
      setDraft("");
      onSent();
      if (tab === "note") toast.push("Comentario interno guardado (no se envió al cliente)", "info");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function attach(kind: "image" | "document", file: File) {
    if (file.size > 5 * 1024 * 1024) {
      toast.push("Máximo 5 MB", "error");
      return;
    }
    setBusy(true);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      await api(`/conversations/${conversation.id}/attachments`, {
        method: "POST",
        body: JSON.stringify({ kind, filename: file.name, mime: file.type, dataBase64, caption: draft.trim() || undefined }),
      });
      setDraft("");
      onSent();
      toast.push(kind === "image" ? "Imagen enviada" : "Documento enviado", "ok");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function assist(mode: "suggest" | "improve" | "translate" | "summarize", extra?: Record<string, string>) {
    setAiBusy(mode);
    try {
      const r = await api<{ text: string }>("/inbox/assist", {
        method: "POST",
        body: JSON.stringify({ conversationId: conversation.id, mode, draft: draft.trim() || undefined, ...extra }),
      });
      if (mode === "summarize") {
        toast.push("Resumen agregado como comentario interno", "ok");
        onSent();
      } else if (r.text) {
        setDraft(r.text);
        textareaRef.current?.focus();
      }
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setAiBusy(null);
    }
  }

  return (
    <footer className="border-t border-slate-200 bg-white">
      {/* Semáforo de la ventana de 24 h */}
      <div
        className={cn(
          "px-4 pt-1.5 text-[10px] font-medium",
          windowLevel === "ok" ? "text-emerald-600" : windowLevel === "warn" ? "text-amber-600" : "text-red-600",
        )}
      >
        ● {windowLabel}
      </div>

      {/* Pestañas Responder / Comentario interno */}
      <div className="flex items-center gap-1 px-4 pt-1">
        <button
          onClick={() => setTab("reply")}
          className={cn("rounded-t-lg px-3 py-1 text-xs font-medium", tab === "reply" ? "bg-cyan-50 text-cyan-800" : "text-slate-400 hover:text-slate-600")}
        >
          Responder
        </button>
        <button
          onClick={() => setTab("note")}
          className={cn("flex items-center gap-1 rounded-t-lg px-3 py-1 text-xs font-medium", tab === "note" ? "bg-amber-50 text-amber-800" : "text-slate-400 hover:text-slate-600")}
        >
          <StickyNote size={11} /> Comentario interno
        </button>
        <div className="ml-auto flex items-center gap-1 pb-0.5">
          <Button variant="ghost" className="!px-2 !py-1 text-[11px]" onClick={() => void assist("suggest")} disabled={aiBusy !== null}>
            <Sparkles size={12} /> {aiBusy === "suggest" ? "Pensando…" : "Sugerir respuesta"}
          </Button>
          <select
            className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-500"
            value=""
            disabled={aiBusy !== null || !draft.trim()}
            onChange={(e) => {
              if (e.target.value) void assist("improve", { tone: e.target.value });
            }}
            title="Mejorar mi borrador con IA"
          >
            <option value="">✨ Mejorar…</option>
            <option value="warmer">Más cálido</option>
            <option value="shorter">Más corto</option>
            <option value="formal">Más formal</option>
          </select>
          <select
            className="rounded-lg border border-slate-200 bg-white px-1.5 py-1 text-[11px] text-slate-500"
            value=""
            disabled={aiBusy !== null || !draft.trim()}
            onChange={(e) => {
              if (e.target.value) void assist("translate", { targetLang: e.target.value });
            }}
            title="Traducir mi borrador"
          >
            <option value="">🌐 Traducir…</option>
            <option value="inglés">Inglés</option>
            <option value="portugués">Portugués</option>
            <option value="español">Español</option>
          </select>
          <Button variant="ghost" className="!px-2 !py-1 text-[11px]" onClick={() => void assist("summarize")} disabled={aiBusy !== null}>
            📋 {aiBusy === "summarize" ? "Resumiendo…" : "Resumir"}
          </Button>
        </div>
      </div>

      <div className={cn("relative border-t p-3", tab === "note" ? "border-amber-100 bg-amber-50/40" : "border-slate-100")}>
        {/* Popup de snippets con "/" */}
        {(showSnippets || snippetFilter !== null) && tab === "reply" && (
          <div className="absolute bottom-full left-3 z-10 mb-1 max-h-52 w-80 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-pop">
            {snippets
              .filter((s) => !snippetFilter || s.shortcut.includes(snippetFilter))
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => insert(renderSnippet(s.body, conversation.contact))}
                  className="block w-full rounded-lg px-2 py-1.5 text-left hover:bg-cyan-50"
                >
                  <span className="font-mono text-[11px] text-cyan-700">/{s.shortcut}</span>
                  <p className="truncate text-xs text-slate-500">{s.body}</p>
                </button>
              ))}
            {snippets.length === 0 && <p className="px-2 py-1.5 text-xs text-slate-400">Aún no hay respuestas rápidas.</p>}
            <a href="/settings/snippets" className="mt-1 block w-full border-t border-slate-100 px-2 py-1.5 text-left text-[11px] text-cyan-700 underline">
              Administrar respuestas rápidas ↗
            </a>
          </div>
        )}
        {/* Popup de variables con "$" */}
        {(showVars || draft === "$") && tab === "reply" && (
          <div className="absolute bottom-full left-3 z-10 mb-1 w-56 rounded-xl border border-slate-200 bg-white p-1 shadow-pop">
            {VARIABLES.map((v) => (
              <button
                key={v.key}
                onClick={() => insert(renderSnippet(`{{${v.key}}}`, conversation.contact))}
                className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs hover:bg-cyan-50"
              >
                <span>{v.label}</span>
                <span className="font-mono text-[10px] text-slate-400">{`{{${v.key}}}`}</span>
              </button>
            ))}
          </div>
        )}
        {/* Emojis */}
        {showEmojis && (
          <div className="absolute bottom-full left-3 z-10 mb-1 grid w-64 grid-cols-10 gap-0.5 rounded-xl border border-slate-200 bg-white p-2 shadow-pop">
            {EMOJIS.map((e) => (
              <button key={e} onClick={() => insert(e)} className="rounded p-0.5 text-base hover:bg-slate-100">
                {e}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="flex shrink-0 items-center gap-0.5 pb-1.5 text-slate-400">
            <button onClick={() => { setShowEmojis(!showEmojis); setShowSnippets(false); setShowVars(false); }} className="rounded p-1 hover:bg-slate-100 hover:text-slate-600" title="Emojis">
              <Smile size={16} />
            </button>
            <button onClick={() => imgRef.current?.click()} disabled={!canWrite || tab === "note"} className="rounded p-1 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30" title="Enviar imagen">
              <ImageIcon size={16} />
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={!canWrite || tab === "note"} className="rounded p-1 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30" title="Enviar documento">
              <Paperclip size={16} />
            </button>
            <input ref={imgRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && void attach("image", e.target.files[0])} />
            <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx" className="hidden" onChange={(e) => e.target.files?.[0] && void attach("document", e.target.files[0])} />
          </div>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setShowSnippets(false);
              setShowVars(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            disabled={!canWrite}
            placeholder={
              tab === "note"
                ? "Comentario para el equipo (el cliente NO lo ve)…"
                : windowOpen
                  ? "Escribe… ( / respuestas rápidas · $ variables )"
                  : "Ventana de 24 h cerrada — usa una plantilla"
            }
            className={cn(
              "flex-1 resize-none rounded-lg border px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-400",
              tab === "note" ? "border-amber-300 bg-white" : "border-slate-300",
            )}
          />
          <div className="flex shrink-0 flex-col gap-1">
            {tab === "reply" && (
              <button
                onClick={onOpenTemplates}
                title="Enviar plantilla aprobada (funciona con la ventana cerrada)"
                className={cn(
                  "rounded-lg px-2.5 py-1.5 text-xs font-medium",
                  windowOpen ? "border border-slate-300 text-slate-600 hover:bg-slate-50" : "bg-amber-500 text-white hover:bg-amber-600",
                )}
              >
                <FileText size={13} className="inline" /> Plantilla
              </button>
            )}
            <button
              onClick={() => void send()}
              disabled={!canWrite || busy || !draft.trim()}
              className={cn(
                "rounded-lg px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40",
                tab === "note" ? "bg-amber-600 hover:bg-amber-700" : "bg-cyan-700 hover:bg-cyan-800",
              )}
            >
              {tab === "note" ? "Guardar" : "Enviar"}
            </button>
          </div>
        </div>
      </div>

    </footer>
  );
}
