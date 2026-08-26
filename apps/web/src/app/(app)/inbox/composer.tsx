"use client";

/**
 * Compositor: Responder / Comentario interno, snippets con "/", variables con
 * "$", emojis, adjuntos, asistente IA (sugerir/mejorar/traducir), Resumir y
 * CTA de plantillas cuando la ventana de 24 h está cerrada.
 */
import { useEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon, Paperclip, Send, Smile, Sparkles, StickyNote } from "lucide-react";
import { api } from "@/lib/api";
import { cn, useToast } from "@/components/ui";
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

  const aiTool = "inline-flex items-center gap-1 rounded-control px-2 py-1 text-2xs font-medium text-ink-muted transition-colors hover:bg-panel hover:text-ink disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <footer className="border-t border-line bg-panel">
      {/* Fila superior: pestañas + barra de IA cohesiva */}
      <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTab("reply")}
            className={cn("rounded-control px-3 py-1 text-xs font-medium transition-colors", tab === "reply" ? "bg-brand-soft text-brand-700 dark:text-brand-300" : "text-ink-subtle hover:text-ink")}
          >
            Responder
          </button>
          <button
            onClick={() => setTab("note")}
            className={cn("flex items-center gap-1 rounded-control px-3 py-1 text-xs font-medium transition-colors", tab === "note" ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" : "text-ink-subtle hover:text-ink")}
          >
            <StickyNote size={11} /> Comentario interno
          </button>
        </div>
        {/* Set cohesivo de asistente IA */}
        <div className="ml-auto flex items-center gap-0.5 rounded-control border border-line bg-app p-0.5">
          <button className={aiTool} onClick={() => void assist("suggest")} disabled={aiBusy !== null} title="Sugerir una respuesta con IA">
            <Sparkles size={12} /> {aiBusy === "suggest" ? "Pensando…" : "Sugerir"}
          </button>
          <span className="relative inline-flex">
            <button className={aiTool} disabled={aiBusy !== null || !draft.trim()} title="Mejorar mi borrador">Mejorar ▾</button>
            <select
              className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
              value=""
              disabled={aiBusy !== null || !draft.trim()}
              onChange={(e) => { if (e.target.value) void assist("improve", { tone: e.target.value }); }}
              aria-label="Mejorar borrador"
            >
              <option value="">Mejorar…</option>
              <option value="warmer">Más cálido</option>
              <option value="shorter">Más corto</option>
              <option value="formal">Más formal</option>
            </select>
          </span>
          <span className="relative inline-flex">
            <button className={aiTool} disabled={aiBusy !== null || !draft.trim()} title="Traducir mi borrador">Traducir ▾</button>
            <select
              className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
              value=""
              disabled={aiBusy !== null || !draft.trim()}
              onChange={(e) => { if (e.target.value) void assist("translate", { targetLang: e.target.value }); }}
              aria-label="Traducir borrador"
            >
              <option value="">Traducir…</option>
              <option value="inglés">Inglés</option>
              <option value="portugués">Portugués</option>
              <option value="español">Español</option>
            </select>
          </span>
          <button className={aiTool} onClick={() => void assist("summarize")} disabled={aiBusy !== null} title="Resumir la conversación">
            <FileText size={12} /> {aiBusy === "summarize" ? "Resumiendo…" : "Resumir"}
          </button>
        </div>
      </div>

      <div className={cn("relative border-t p-3 transition-colors", tab === "note" ? "border-amber-200/60 bg-amber-50/50 dark:border-amber-500/20 dark:bg-amber-500/[0.05]" : "border-line")}>
        {/* Popup de snippets con "/" */}
        {(showSnippets || snippetFilter !== null) && tab === "reply" && (
          <div className="absolute bottom-full left-3 z-10 mb-1 max-h-52 w-80 overflow-y-auto rounded-card border border-line bg-raised p-1 shadow-e3">
            {snippets
              .filter((s) => !snippetFilter || s.shortcut.includes(snippetFilter))
              .map((s) => (
                <button
                  key={s.id}
                  onClick={() => insert(renderSnippet(s.body, conversation.contact))}
                  className="block w-full rounded-control px-2 py-1.5 text-left transition-colors hover:bg-brand-soft"
                >
                  <span className="font-mono text-2xs text-brand-700 dark:text-brand-300">/{s.shortcut}</span>
                  <p className="truncate text-xs text-ink-muted">{s.body}</p>
                </button>
              ))}
            {snippets.length === 0 && <p className="px-2 py-1.5 text-xs text-ink-subtle">Aún no hay respuestas rápidas.</p>}
            <a href="/settings/snippets" className="mt-1 block w-full border-t border-line px-2 py-1.5 text-left text-2xs text-brand-700 underline dark:text-brand-300">
              Administrar respuestas rápidas ↗
            </a>
          </div>
        )}
        {/* Popup de variables con "$" */}
        {(showVars || draft === "$") && tab === "reply" && (
          <div className="absolute bottom-full left-3 z-10 mb-1 w-56 rounded-card border border-line bg-raised p-1 shadow-e3">
            {VARIABLES.map((v) => (
              <button
                key={v.key}
                onClick={() => insert(renderSnippet(`{{${v.key}}}`, conversation.contact))}
                className="flex w-full items-center justify-between rounded-control px-2 py-1.5 text-xs text-ink transition-colors hover:bg-brand-soft"
              >
                <span>{v.label}</span>
                <span className="font-mono text-[10px] text-ink-subtle">{`{{${v.key}}}`}</span>
              </button>
            ))}
          </div>
        )}
        {/* Emojis */}
        {showEmojis && (
          <div className="absolute bottom-full left-3 z-10 mb-1 grid w-64 grid-cols-10 gap-0.5 rounded-card border border-line bg-raised p-2 shadow-e3">
            {EMOJIS.map((e) => (
              <button key={e} onClick={() => insert(e)} className="rounded-control p-0.5 text-base transition-colors hover:bg-app">
                {e}
              </button>
            ))}
          </div>
        )}

        {/* Ventana cerrada en modo Responder: estado elegante con CTA de plantilla */}
        {!windowOpen && tab === "reply" ? (
          <div className="flex flex-col items-center gap-2 rounded-card border border-amber-200 bg-amber-50/60 px-4 py-4 text-center dark:border-amber-500/30 dark:bg-amber-500/5">
            <p className="text-xs text-ink-muted">
              La ventana de 24 h está cerrada. Solo puedes escribir con una <b className="text-ink">plantilla aprobada</b>.
            </p>
            <button onClick={onOpenTemplates} className="inline-flex items-center gap-1.5 rounded-control bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-brand-700">
              <FileText size={14} /> Enviar plantilla
            </button>
          </div>
        ) : (
          <div className="flex items-end gap-2">
            <div className="flex shrink-0 items-center gap-0.5 pb-1.5 text-ink-subtle">
              <button onClick={() => { setShowEmojis(!showEmojis); setShowSnippets(false); setShowVars(false); }} className="rounded-control p-1 transition-colors hover:bg-app hover:text-ink" title="Emojis">
                <Smile size={16} />
              </button>
              <button onClick={() => imgRef.current?.click()} disabled={tab === "note"} className="rounded-control p-1 transition-colors hover:bg-app hover:text-ink disabled:opacity-30" title="Enviar imagen">
                <ImageIcon size={16} />
              </button>
              <button onClick={() => fileRef.current?.click()} disabled={tab === "note"} className="rounded-control p-1 transition-colors hover:bg-app hover:text-ink disabled:opacity-30" title="Enviar documento">
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
              placeholder={
                tab === "note"
                  ? "Comentario para el equipo (el cliente NO lo ve)…"
                  : "Escribe… ( / respuestas rápidas · $ variables )"
              }
              className={cn(
                "flex-1 resize-none rounded-control border px-3 py-2 text-sm text-ink placeholder:text-ink-subtle",
                tab === "note" ? "border-amber-300 bg-panel dark:border-amber-500/40" : "border-line-strong bg-panel",
              )}
            />
            <div className="flex shrink-0 flex-col gap-1">
              {tab === "reply" && (
                <button
                  onClick={onOpenTemplates}
                  title="Enviar plantilla aprobada (funciona con la ventana cerrada)"
                  className="rounded-control border border-line-strong px-2.5 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-app hover:text-ink"
                >
                  <FileText size={13} className="inline" /> Plantilla
                </button>
              )}
              <button
                onClick={() => void send()}
                disabled={busy || !draft.trim()}
                className={cn(
                  "inline-flex items-center gap-1 rounded-control px-4 py-1.5 text-sm font-semibold text-white transition-colors disabled:opacity-40",
                  tab === "note" ? "bg-amber-600 hover:bg-amber-700" : "bg-brand-600 hover:bg-brand-700",
                )}
              >
                <Send size={14} /> {tab === "note" ? "Guardar" : "Enviar"}
              </button>
            </div>
          </div>
        )}
      </div>
    </footer>
  );
}
