"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, Send } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";
import { openRealtime, type RealtimeEvent } from "@/lib/sse";

type Contact = { id: string; firstName: string | null; lastName: string | null; profileName: string | null; phone: string | null; avatarUrl: string | null };
type ConvItem = {
  id: string;
  status: "OPEN" | "PENDING" | "CLOSED";
  aiEnabled: boolean;
  unreadCount: number;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  contact: Contact;
};
type Msg = {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  type: string;
  visibility: "PUBLIC" | "INTERNAL";
  body: string | null;
  authorType: "USER" | "AGENT" | "SYSTEM";
  authorName: string | null;
  status: string;
  createdAt: string;
};
type Thread = { conversation: { id: string; aiEnabled: boolean; contact: Contact }; messages: Msg[] };

const STATUSES = [
  { key: "open", label: "Abiertas" },
  { key: "pending", label: "Pendientes" },
  { key: "all", label: "Todas" },
] as const;

function displayName(c: Contact): string {
  const full = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return full || c.profileName || c.phone || "Sin nombre";
}
function initials(c: Contact): string {
  return displayName(c).slice(0, 2).toUpperCase();
}
function shortTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit" });
}

export default function Conversaciones() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]["key"]>("open");
  const [items, setItems] = useState<ConvItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 759px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const loadList = useCallback(async () => {
    try {
      const res = await api<{ items: ConvItem[] }>(`/conversations?status=${status}&order=recent`);
      setItems(res.items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, [status]);

  useEffect(() => {
    setLoadingList(true);
    loadList();
  }, [loadList]);

  // Enlace profundo desde Clientes: /conversaciones?c=<id> abre esa conversación directo.
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("c");
    if (c) openConv(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadThread = useCallback(async (id: string) => {
    try {
      const t = await api<Thread>(`/conversations/${id}/messages`);
      setThread(t);
      setItems((prev) => prev.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)));
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "auto" }), 50);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  function openConv(id: string) {
    setSel(id);
    setThread(null);
    loadThread(id);
  }

  // Tiempo real: refresca el hilo abierto y la lista cuando llegan eventos.
  useEffect(() => {
    const close = openRealtime((e: RealtimeEvent) => {
      if ((e.type === "message.created" || e.type === "message.updated" || e.type === "conversation.updated")) {
        if (e.conversationId && e.conversationId === selRef.current) loadThread(selRef.current);
        loadList();
      }
    });
    return close;
  }, [loadThread, loadList]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || !sel) return;
    setSending(true);
    setError(null);
    try {
      await api(`/conversations/${sel}/messages`, { method: "POST", body: JSON.stringify({ text: body }) });
      setText("");
      await loadThread(sel);
      loadList();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  const showList = !narrow || !sel;
  const showThread = !narrow || !!sel;

  return (
    <AppShell>
      <div style={{ display: "flex", height: narrow ? "calc(100dvh - 62px)" : "100dvh" }}>
        {/* LISTA */}
        {showList ? (
          <div style={{ width: narrow ? "100%" : 340, borderRight: narrow ? "none" : "1px solid var(--hairline)", display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div style={{ padding: "18px 18px 10px" }}>
              <h1 className="display" style={{ fontSize: 24, margin: "0 0 12px" }}>Conversaciones</h1>
              <div style={{ display: "flex", gap: 6 }}>
                {STATUSES.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => setStatus(s.key)}
                    className={status === s.key ? "btn-accent" : ""}
                    style={{
                      padding: "6px 12px",
                      fontSize: 13,
                      borderRadius: 999,
                      cursor: "pointer",
                      border: status === s.key ? "none" : "1px solid var(--line)",
                      background: status === s.key ? undefined : "transparent",
                      color: status === s.key ? undefined : "var(--ink-dim)",
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "0 10px 10px" }}>
              {loadingList ? (
                <p className="text-dim" style={{ padding: 16, fontSize: 14 }}>Cargando…</p>
              ) : items.length === 0 ? (
                <p className="text-dim" style={{ padding: 16, fontSize: 14 }}>No hay conversaciones aquí.</p>
              ) : (
                items.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => openConv(c.id)}
                    style={{
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                      width: "100%",
                      textAlign: "left",
                      padding: "11px 12px",
                      borderRadius: 14,
                      border: "none",
                      cursor: "pointer",
                      background: sel === c.id ? "var(--acc-dim)" : "transparent",
                    }}
                  >
                    <span style={{ width: 42, height: 42, flexShrink: 0, borderRadius: "50%", background: "var(--acc-dim)", color: "var(--acc-deep)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 14, overflow: "hidden" }}>
                      {c.contact.avatarUrl ? <img src={c.contact.avatarUrl} alt="" width={42} height={42} style={{ objectFit: "cover" }} /> : initials(c.contact)}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <b style={{ fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{displayName(c.contact)}</b>
                        <span className="text-dim" style={{ fontSize: 11, flexShrink: 0 }}>{shortTime(c.lastMessageAt)}</span>
                      </span>
                      <span style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginTop: 2 }}>
                        <span className="text-dim" style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.lastMessagePreview ?? "—"}</span>
                        {c.unreadCount > 0 ? (
                          <span style={{ background: "var(--acc)", color: "var(--acc-ink)", borderRadius: 999, fontSize: 11, fontWeight: 700, minWidth: 18, height: 18, display: "grid", placeItems: "center", padding: "0 5px", flexShrink: 0 }}>{c.unreadCount}</span>
                        ) : c.aiEnabled ? (
                          <Bot size={14} className="text-dim" style={{ flexShrink: 0 }} />
                        ) : null}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : null}

        {/* HILO */}
        {showThread ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
            {!sel ? (
              <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
                <p className="text-dim" style={{ fontSize: 14 }}>Elige una conversación para verla.</p>
              </div>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 18px", borderBottom: "1px solid var(--hairline)" }}>
                  {narrow ? (
                    <button onClick={() => setSel(null)} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink)" }} aria-label="Volver">
                      <ArrowLeft size={20} />
                    </button>
                  ) : null}
                  <b style={{ fontSize: 15 }}>{thread ? displayName(thread.conversation.contact) : "…"}</b>
                  {thread?.conversation.aiEnabled ? (
                    <span className="text-accent" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}><Bot size={13} /> IA activa</span>
                  ) : null}
                </div>

                <div style={{ flex: 1, overflowY: "auto", padding: "18px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {!thread ? (
                    <p className="text-dim" style={{ fontSize: 14 }}>Cargando mensajes…</p>
                  ) : (
                    thread.messages
                      .filter((m) => m.visibility !== "INTERNAL" || m.type === "NOTE")
                      .map((m) => {
                        const out = m.direction === "OUTBOUND";
                        const note = m.visibility === "INTERNAL";
                        return (
                          <div key={m.id} style={{ alignSelf: out ? "flex-end" : "flex-start", maxWidth: "76%" }}>
                            <div
                              style={{
                                padding: "9px 13px",
                                borderRadius: 16,
                                fontSize: 14,
                                lineHeight: 1.4,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                                background: note ? "var(--warn)" : out ? "var(--acc)" : "var(--surface-solid)",
                                color: note ? "#2a1c02" : out ? "var(--acc-ink)" : "var(--ink)",
                                border: out || note ? "none" : "1px solid var(--hairline)",
                              }}
                            >
                              {m.body ?? (m.type !== "TEXT" ? `[${m.type.toLowerCase()}]` : "")}
                            </div>
                            <div className="text-dim" style={{ fontSize: 10, marginTop: 2, textAlign: out ? "right" : "left" }}>
                              {m.authorType === "AGENT" ? "🤖 " : ""}
                              {note ? "Nota · " : ""}
                              {shortTime(m.createdAt)}
                              {out && m.status === "FAILED" ? " · ✖ falló" : ""}
                            </div>
                          </div>
                        );
                      })
                  )}
                  <div ref={bottomRef} />
                </div>

                <form onSubmit={send} style={{ display: "flex", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--hairline)" }}>
                  <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Escribe un mensaje…"
                    style={{ flex: 1, padding: "11px 14px", borderRadius: 999, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 }}
                  />
                  <button className="btn-accent" type="submit" disabled={sending || !text.trim()} style={{ borderRadius: "50%", width: 44, height: 44, display: "grid", placeItems: "center", opacity: sending || !text.trim() ? 0.5 : 1 }} aria-label="Enviar">
                    <Send size={18} />
                  </button>
                </form>
              </>
            )}
          </div>
        ) : null}
      </div>
      {error ? <p style={{ color: "var(--danger)", fontSize: 12, position: "fixed", bottom: 8, left: 80 }}>{error}</p> : null}
    </AppShell>
  );
}
