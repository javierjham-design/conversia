"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Bot, BotOff, CalendarPlus, CheckCircle2, CreditCard, Lock, MessageSquareText, Paperclip, Plus, RotateCcw, Send, StickyNote, UserRound, X } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { OperationBar, Avatar, type OpState, type OpStage } from "@/components/OperationBar";
import { FichaPanel } from "@/components/FichaPanel";
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
  // B1 — estado de operación que el backend ya expone por chat (pintado sin llamadas extra).
  activeAgentId: string | null;
  activeAgentName: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  assignedTeamId: string | null;
  assignedTeamName: string | null;
  stage: OpStage;
  contact: Contact;
};
type ConvContext = { tags: string[] };
type Snippet = { id: string; shortcut: string; body: string };
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
type Thread = { conversation: { id: string; status: "OPEN" | "PENDING" | "CLOSED"; aiEnabled: boolean; contact: Contact }; messages: Msg[] };

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
// B2 — estilo de los chips de acción del redactor (activo = acento).
function composerChip(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    fontSize: 12,
    padding: "5px 10px",
    borderRadius: 999,
    cursor: "pointer",
    border: active ? "none" : "1px solid var(--line)",
    background: active ? "var(--acc-dim)" : "transparent",
    color: active ? "var(--acc-deep)" : "var(--ink-dim)",
  };
}

export default function Conversaciones() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]["key"]>("open");
  const [items, setItems] = useState<ConvItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [ctx, setCtx] = useState<ConvContext | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [internal, setInternal] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showFicha, setShowFicha] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // B2 — acciones del redactor
  const [snips, setSnips] = useState<Snippet[]>([]);
  const [showSnips, setShowSnips] = useState(false);
  const [showAgendar, setShowAgendar] = useState(false);
  const [showPago, setShowPago] = useState(false);
  const [templateFor, setTemplateFor] = useState<string | null>(null); // teléfono para enviar plantilla (fuera de 24h)
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 619px)"); // M8 — alineado con el riel/tabs (620)
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

  // B1 — contexto del chat (etiquetas del contacto) para la barra de operación.
  const loadContext = useCallback(async (id: string) => {
    try {
      const c = await api<ConvContext>(`/conversations/${id}/context`);
      setCtx({ tags: c.tags ?? [] });
    } catch {
      setCtx({ tags: [] }); // la barra sigue operable aunque falle la carga de etiquetas
    }
  }, []);

  function openConv(id: string) {
    setSel(id);
    setThread(null);
    setCtx(null);
    loadThread(id);
    loadContext(id);
  }

  // Tiempo real: refresca el hilo abierto, su contexto y la lista cuando llegan eventos.
  useEffect(() => {
    const close = openRealtime((e: RealtimeEvent) => {
      if ((e.type === "message.created" || e.type === "message.updated" || e.type === "conversation.updated")) {
        if (e.conversationId && e.conversationId === selRef.current) {
          loadThread(selRef.current);
          loadContext(selRef.current);
        }
        loadList();
      }
    });
    return close;
  }, [loadThread, loadContext, loadList]);

  // B1 — tras una operación de la barra: refresca lista + hilo + contexto del chat abierto.
  const refreshOpen = useCallback(() => {
    loadList();
    if (selRef.current) {
      loadThread(selRef.current);
      loadContext(selRef.current);
    }
  }, [loadList, loadThread, loadContext]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || !sel) return;
    setSending(true);
    setError(null);
    try {
      await api(`/conversations/${sel}/messages`, { method: "POST", body: JSON.stringify({ text: body, internal }) });
      setText("");
      await loadThread(sel);
      loadList();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  // Adjuntar imagen o documento (se lee como base64 y se envía por la API).
  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !sel) return;
    if (file.size > 5 * 1024 * 1024) {
      setError("El archivo supera 5 MB.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
        r.onerror = () => reject(new Error("No se pudo leer el archivo"));
        r.readAsDataURL(file);
      });
      const kind = file.type.startsWith("image/") ? "image" : "document";
      await api(`/conversations/${sel}/attachments`, {
        method: "POST",
        body: JSON.stringify({ kind, filename: file.name, mime: file.type, dataBase64, caption: text.trim() || undefined }),
      });
      setText("");
      await loadThread(sel);
      loadList();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function action(path: string) {
    if (!sel) return;
    setBusyAction(true);
    setError(null);
    try {
      await api(`/conversations/${sel}/${path}`, { method: "POST" });
      await loadThread(sel);
      loadList();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyAction(false);
    }
  }

  // B2 — respuestas rápidas (snippets): se cargan una vez (semilla al primer uso en el backend).
  useEffect(() => {
    api<Snippet[]>("/inbox/snippets").then(setSnips).catch(() => setSnips([]));
  }, []);

  // B2 — "/atajo" abre el buscador de respuestas rápidas; elegir una reemplaza el texto.
  function onComposerChange(v: string) {
    setText(v);
    setShowSnips(v.startsWith("/") && !internal);
  }
  const snipQuery = text.startsWith("/") ? text.slice(1).toLowerCase() : "";
  const snipMatches = showSnips ? snips.filter((s) => s.shortcut.toLowerCase().includes(snipQuery) || s.body.toLowerCase().includes(snipQuery)).slice(0, 6) : [];
  function pickSnippet(s: Snippet) {
    setText(s.body);
    setShowSnips(false);
  }

  const showList = !narrow || !sel;
  const showThread = !narrow || !!sel;
  const closed = thread?.conversation.status === "CLOSED";
  const aiOn = thread?.conversation.aiEnabled;
  const contactPhone = thread?.conversation.contact.phone ?? null;

  // B1 — estado de la barra de operación: funde el ConvItem de la lista (nombres de
  // agente/asignado/etapa, sin llamadas extra), el hilo (aiEnabled fresco + ventana 24h)
  // y el contexto (etiquetas del contacto).
  const selItem = sel ? items.find((c) => c.id === sel) ?? null : null;
  const opState: OpState | null =
    sel && thread
      ? (() => {
          const lastIn = [...thread.messages].reverse().find((m) => m.direction === "INBOUND");
          const hrs = lastIn ? (Date.now() - new Date(lastIn.createdAt).getTime()) / 3_600_000 : null;
          return {
            conversationId: sel,
            contactId: thread.conversation.contact.id,
            aiEnabled: thread.conversation.aiEnabled,
            activeAgentId: selItem?.activeAgentId ?? null,
            activeAgentName: selItem?.activeAgentName ?? null,
            assignedUserId: selItem?.assignedUserId ?? null,
            assignedUserName: selItem?.assignedUserName ?? null,
            stage: selItem?.stage ?? null,
            tags: ctx?.tags ?? [],
            windowOpen: hrs === null ? null : hrs < 24,
            windowHoursLeft: hrs === null ? null : 24 - hrs,
          };
        })()
      : null;

  const headerBtn: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "6px 10px",
    borderRadius: 999,
    border: "1px solid var(--line)",
    background: "transparent",
    color: "var(--ink)",
    cursor: "pointer",
  };

  return (
    <AppShell>
      <div style={{ display: "flex", height: narrow ? "calc(100dvh - 62px)" : "100dvh" }}>
        {/* LISTA */}
        {showList ? (
          <div style={{ width: narrow ? "100%" : 340, borderRight: narrow ? "none" : "1px solid var(--hairline)", display: "flex", flexDirection: "column", minWidth: 0 }}>
            <div style={{ padding: "18px 18px 10px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "0 0 12px" }}>
                <h1 className="display" style={{ fontSize: 24, margin: 0 }}>Conversaciones</h1>
                <button className="btn-accent" onClick={() => setShowNew(true)} title="Nueva conversación" style={{ marginLeft: "auto", borderRadius: "50%", width: 36, height: 36, display: "grid", placeItems: "center", padding: 0 }} aria-label="Nueva conversación">
                  <Plus size={18} />
                </button>
              </div>
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
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                          {/* B1 — mini-indicador del responsable asignado (paridad con la bandeja de TuBot). */}
                          {c.assignedUserName ? <Avatar name={c.assignedUserName} size={18} /> : null}
                          {c.unreadCount > 0 ? (
                            <span style={{ background: "var(--acc)", color: "var(--acc-ink)", borderRadius: 999, fontSize: 11, fontWeight: 700, minWidth: 18, height: 18, display: "grid", placeItems: "center", padding: "0 5px" }}>{c.unreadCount}</span>
                          ) : c.aiEnabled ? (
                            <Bot size={14} className="text-dim" />
                          ) : null}
                        </span>
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
                  {aiOn ? (
                    <span className="text-accent" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}><Bot size={13} /> IA activa</span>
                  ) : thread ? (
                    <span className="text-dim" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}><BotOff size={13} /> Manual</span>
                  ) : null}
                  {/* B1 — la píldora de ventana de 24h se movió a la barra de operación (abajo). */}
                  {thread ? (
                    <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                      <button
                        onClick={() => setShowFicha((v) => !v)}
                        title="Ver ficha del cliente"
                        style={{ ...headerBtn, ...(showFicha ? { background: "var(--acc-dim)", color: "var(--acc-deep)", border: "none" } : {}) }}
                      >
                        <UserRound size={16} />
                        <span style={{ fontSize: 12 }}>Ver ficha</span>
                      </button>
                      <button
                        onClick={() => action(aiOn ? "takeover" : "release")}
                        disabled={busyAction}
                        title={aiOn ? "Tomar el control (pausa la IA)" : "Devolver a la IA"}
                        style={headerBtn}
                      >
                        {aiOn ? <BotOff size={16} /> : <Bot size={16} />}
                        <span style={{ fontSize: 12 }}>{aiOn ? "Tomar control" : "Devolver a IA"}</span>
                      </button>
                      <button
                        onClick={() => action(closed ? "reopen" : "close")}
                        disabled={busyAction}
                        title={closed ? "Reabrir" : "Cerrar conversación"}
                        style={headerBtn}
                      >
                        {closed ? <RotateCcw size={16} /> : <CheckCircle2 size={16} />}
                        <span style={{ fontSize: 12 }}>{closed ? "Reabrir" : "Cerrar"}</span>
                      </button>
                    </span>
                  ) : null}
                </div>

                {/* B1 — barra de operación: chips de agente / asignado / etapa / etiquetas + ventana 24h. */}
                {opState ? <OperationBar state={opState} narrow={narrow} onChanged={refreshOpen} /> : null}

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
                              {m.authorType === "AGENT" ? "IA · " : ""}
                              {note ? "Nota · " : ""}
                              {shortTime(m.createdAt)}
                              {out && m.status === "FAILED" ? " · no se envió" : ""}
                            </div>
                          </div>
                        );
                      })
                  )}
                  <div ref={bottomRef} />
                </div>

                <div style={{ borderTop: "1px solid var(--hairline)", position: "relative" }}>
                  {/* B2 — fila de acciones del redactor */}
                  <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "8px 16px 0", flexWrap: "wrap" }}>
                    <button
                      type="button"
                      onClick={() => setInternal((v) => !v)}
                      title="Nota interna (no se envía al cliente)"
                      style={composerChip(internal)}
                    >
                      <StickyNote size={14} /> Nota interna
                    </button>
                    <button type="button" onClick={() => setShowSnips((v) => !v)} title="Respuestas rápidas (escribe / )" style={composerChip(showSnips)} disabled={internal}>
                      <MessageSquareText size={14} /> Respuestas
                    </button>
                    <button type="button" onClick={() => setShowAgendar(true)} title="Agendar una cita desde el chat" style={composerChip(false)}>
                      <CalendarPlus size={14} /> Agendar
                    </button>
                    <button type="button" onClick={() => setShowPago(true)} title="Enviar un link de pago" style={composerChip(false)}>
                      <CreditCard size={14} /> Link de pago
                    </button>
                    {internal ? <span className="text-dim" style={{ fontSize: 11, marginLeft: "auto" }}>Solo tu equipo la verá.</span> : null}
                  </div>

                  {/* B2 — buscador de respuestas rápidas */}
                  {showSnips && !internal ? (
                    <div className="card" style={{ margin: "8px 16px 0", padding: 6, maxHeight: 220, overflowY: "auto" }}>
                      {snipMatches.length === 0 ? (
                        <p className="text-dim" style={{ fontSize: 12, padding: "8px 10px", margin: 0 }}>Sin respuestas rápidas. Créalas en Bandeja.</p>
                      ) : (
                        snipMatches.map((s) => (
                          <button key={s.id} type="button" onClick={() => pickSnippet(s)} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", borderRadius: 10, border: "none", background: "transparent", cursor: "pointer", color: "var(--ink)" }}>
                            <b style={{ fontSize: 12, color: "var(--acc-deep)" }}>/{s.shortcut}</b>
                            <span style={{ display: "block", fontSize: 12.5, color: "var(--ink-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.body}</span>
                          </button>
                        ))
                      )}
                    </div>
                  ) : null}

                  {/* B2 — gating de la ventana de 24 h: fuera de ventana solo se puede reactivar con plantilla */}
                  {opState?.windowOpen === false && !internal ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "8px 16px 0", padding: "9px 12px", borderRadius: 12, background: "color-mix(in srgb, var(--warn) 14%, transparent)", border: "1px solid color-mix(in srgb, var(--warn) 40%, transparent)" }}>
                      <Lock size={15} style={{ color: "var(--warn)", flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: "var(--ink-dim)", flex: 1 }}>La ventana de 24 h está cerrada. Para escribirle primero debes enviar una plantilla aprobada.</span>
                      {contactPhone ? (
                        <button type="button" className="btn-accent" onClick={() => setTemplateFor(contactPhone)} style={{ fontSize: 12, padding: "6px 12px", flexShrink: 0 }}>Enviar plantilla</button>
                      ) : null}
                    </div>
                  ) : null}

                  <form onSubmit={send} style={{ display: "flex", gap: 8, padding: "10px 16px 12px", alignItems: "center" }}>
                    <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={onPickFile} style={{ display: "none" }} />
                    <button type="button" onClick={() => fileRef.current?.click()} disabled={sending || internal || (opState?.windowOpen === false)} title="Adjuntar imagen o PDF" style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--ink-dim)", borderRadius: "50%", width: 40, height: 40, display: "grid", placeItems: "center", cursor: "pointer", flexShrink: 0, opacity: internal || opState?.windowOpen === false ? 0.4 : 1 }} aria-label="Adjuntar">
                      <Paperclip size={18} />
                    </button>
                    <input
                      value={text}
                      onChange={(e) => onComposerChange(e.target.value)}
                      disabled={opState?.windowOpen === false && !internal}
                      placeholder={opState?.windowOpen === false && !internal ? "Ventana de 24 h cerrada — envía una plantilla" : internal ? "Escribe una nota interna…" : "Escribe un mensaje…  (usa / para respuestas rápidas)"}
                      style={{ flex: 1, padding: "11px 14px", borderRadius: 999, border: internal ? "1px solid var(--warn)" : "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14, opacity: opState?.windowOpen === false && !internal ? 0.6 : 1 }}
                    />
                    <button className="btn-accent" type="submit" disabled={sending || !text.trim() || (opState?.windowOpen === false && !internal)} style={{ borderRadius: "50%", width: 44, height: 44, display: "grid", placeItems: "center", opacity: sending || !text.trim() || (opState?.windowOpen === false && !internal) ? 0.5 : 1, flexShrink: 0 }} aria-label="Enviar">
                      <Send size={18} />
                    </button>
                  </form>
                </div>
              </>
            )}
          </div>
        ) : null}

        {/* B3 — ficha del cliente bajo demanda (drawer derecho; overlay completo en móvil) */}
        {showFicha && sel ? <FichaPanel conversationId={sel} narrow={narrow} onClose={() => setShowFicha(false)} /> : null}
      </div>
      {showNew ? (
        <NewConversation
          onClose={() => setShowNew(false)}
          onCreated={(convId) => {
            setShowNew(false);
            setStatus("all");
            loadList();
            openConv(convId);
          }}
        />
      ) : null}
      {/* B2 — enviar plantilla para reabrir la ventana de 24 h (contacto existente prellenado) */}
      {templateFor ? (
        <NewConversation
          prefillPhone={templateFor}
          onClose={() => setTemplateFor(null)}
          onCreated={(convId) => {
            setTemplateFor(null);
            loadList();
            openConv(convId);
          }}
        />
      ) : null}
      {/* B2 — agendar una cita desde el chat */}
      {showAgendar && sel && thread ? (
        <AgendarModal
          contactId={thread.conversation.contact.id}
          onClose={() => setShowAgendar(false)}
          onCreated={(line) => {
            setShowAgendar(false);
            setText((t) => (t.trim() ? `${t}\n${line}` : line));
          }}
        />
      ) : null}
      {/* B2 — generar link de pago; se inserta en el compositor para enviarlo */}
      {showPago && sel ? (
        <PagoModal
          conversationId={sel}
          onClose={() => setShowPago(false)}
          onCreated={(line) => {
            setShowPago(false);
            setText((t) => (t.trim() ? `${t}\n${line}` : line));
          }}
        />
      ) : null}
      {error ? <p style={{ color: "var(--danger)", fontSize: 12, position: "fixed", bottom: 8, left: 80 }}>{error}</p> : null}
    </AppShell>
  );
}

type Template = { id: string; name: string; language: string; category: string; bodyText: string; variableFields: string[] };

function NewConversation({ onClose, onCreated, prefillPhone }: { onClose: () => void; onCreated: (convId: string) => void; prefillPhone?: string }) {
  const [phone, setPhone] = useState(prefillPhone ?? "");
  const [name, setName] = useState("");
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ templates: Template[] }>("/channels/templates/approved")
      .then((r) => setTemplates(r.templates))
      .catch((e) => setErr((e as Error).message));
  }, []);

  const picked = templates.find((t) => t.id === templateId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!phone.trim() || !templateId) {
      setErr("Ingresa el teléfono y elige una plantilla.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const r = await api<{ conversationId: string }>("/conversations/start", {
        method: "POST",
        body: JSON.stringify({ phone: phone.trim(), name: name.trim() || undefined, templateId }),
      });
      onCreated(r.conversationId);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const field: React.CSSProperties = { width: "100%", padding: "10px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };
  const lbl: React.CSSProperties = { fontSize: 12, color: "var(--ink-dim)", display: "block", marginTop: 12 };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card" style={{ width: "100%", maxWidth: 440, padding: 24, maxHeight: "90dvh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 2 }}>
          <h2 className="display" style={{ fontSize: 20, margin: 0 }}>Nueva conversación</h2>
          <button type="button" onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }} aria-label="Cerrar"><X size={20} /></button>
        </div>
        <p className="text-dim" style={{ fontSize: 12, margin: "4px 0 0" }}>Para escribirle a alguien nuevo (o fuera de 24 h) se usa una plantilla aprobada.</p>

        <label style={lbl}>Teléfono (con código de país)
          <input style={field} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="56912345678" inputMode="tel" />
        </label>
        <label style={lbl}>Nombre (opcional)
          <input style={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre del cliente" />
        </label>
        <label style={lbl}>Plantilla
          <select style={field} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">— elegir —</option>
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}
          </select>
        </label>
        {picked ? (
          <div className="card" style={{ padding: "10px 12px", marginTop: 8, fontSize: 13 }}>
            <p className="text-dim" style={{ margin: 0, fontSize: 11 }}>Vista previa</p>
            <p style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{picked.bodyText || "(sin cuerpo)"}</p>
            {picked.variableFields.length ? <p className="text-dim" style={{ margin: "6px 0 0", fontSize: 11 }}>⚠ Esta plantilla tiene variables; el asistente las completará al enviarla.</p> : null}
          </div>
        ) : templates.length === 0 && !err ? (
          <p className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>No hay plantillas aprobadas aún.</p>
        ) : null}

        {err ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{err}</p> : null}
        <button className="btn-accent" type="submit" disabled={saving} style={{ width: "100%", marginTop: 18, opacity: saving ? 0.6 : 1 }}>
          {saving ? "Enviando…" : "Iniciar conversación"}
        </button>
      </form>
    </div>
  );
}

// ------------------------- B2: agendar desde el chat -------------------------
type Pro = { id: string; name: string; specialty: string | null; type: string; durationMin: number | null };
type Slot = { professionalId: string; start: string; end: string };

function AgendarModal({ contactId, onClose, onCreated }: { contactId: string; onClose: () => void; onCreated: (line: string) => void }) {
  const [pros, setPros] = useState<Pro[]>([]);
  const [proId, setProId] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<Pro[]>("/agenda/professionals").catch(() => [] as Pro[]),
      api<{ slots: Slot[] }>("/agenda/availability").catch(() => ({ slots: [] as Slot[] })),
    ])
      .then(([p, a]) => {
        setPros(p);
        setSlots(a.slots ?? []);
      })
      .finally(() => setLoading(false));
  }, []);

  const proName = (id: string) => pros.find((p) => p.id === id)?.name ?? "";
  const filtered = (proId ? slots.filter((s) => s.professionalId === proId) : slots).slice().sort((a, b) => a.start.localeCompare(b.start));
  const byDay = new Map<string, Slot[]>();
  for (const s of filtered) {
    const key = new Date(s.start).toLocaleDateString("es-CL", { weekday: "long", day: "2-digit", month: "long" });
    (byDay.get(key) ?? byDay.set(key, []).get(key)!).push(s);
  }

  async function book(slot: Slot) {
    setSaving(true);
    setErr(null);
    try {
      await api("/agenda/appointments", {
        method: "POST",
        body: JSON.stringify({ contactId, professionalId: slot.professionalId || undefined, startsAt: slot.start, endsAt: slot.end }),
      });
      const d = new Date(slot.start);
      const who = slot.professionalId ? ` con ${proName(slot.professionalId)}` : "";
      const line = `Te agendé para el ${d.toLocaleDateString("es-CL", { weekday: "long", day: "2-digit", month: "long" })} a las ${d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}${who}.`;
      onCreated(line);
    } catch (e) {
      setErr((e as Error).message);
      setSaving(false);
    }
  }

  const field: React.CSSProperties = { width: "100%", padding: "10px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 480, padding: 24, maxHeight: "90dvh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
          <h2 className="display" style={{ fontSize: 20, margin: 0 }}>Agendar una cita</h2>
          <button type="button" onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }} aria-label="Cerrar"><X size={20} /></button>
        </div>
        {pros.length > 1 ? (
          <select style={field} value={proId} onChange={(e) => setProId(e.target.value)}>
            <option value="">Cualquier recurso</option>
            {pros.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        ) : null}
        {loading ? (
          <p className="text-dim" style={{ fontSize: 14, marginTop: 14 }}>Cargando disponibilidad…</p>
        ) : filtered.length === 0 ? (
          <p className="text-dim" style={{ fontSize: 14, marginTop: 14 }}>No hay horas disponibles. Configura horarios en Agenda.</p>
        ) : (
          <div style={{ marginTop: 10 }}>
            {[...byDay.entries()].map(([day, list]) => (
              <div key={day} style={{ marginTop: 12 }}>
                <p className="text-dim" style={{ fontSize: 12, textTransform: "capitalize", margin: "0 0 6px" }}>{day}</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {list.slice(0, 24).map((s) => (
                    <button key={s.start + s.professionalId} type="button" disabled={saving} onClick={() => book(s)} style={{ padding: "7px 11px", borderRadius: 999, border: "1px solid var(--line)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 13, opacity: saving ? 0.5 : 1 }}>
                      {new Date(s.start).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        {err ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{err}</p> : null}
      </div>
    </div>
  );
}

// ------------------------- B2: link de pago desde el chat -------------------------
function PagoModal({ conversationId, onClose, onCreated }: { conversationId: string; onClose: () => void; onCreated: (line: string) => void }) {
  const [amount, setAmount] = useState("");
  const [concept, setConcept] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amt = Math.round(Number(amount));
    if (!amt || amt <= 0 || !concept.trim()) {
      setErr("Ingresa un monto (> 0) y un concepto.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const r = await api<{ url: string; amount: number; concept: string }>("/charging/link", {
        method: "POST",
        body: JSON.stringify({ conversationId, amount: amt, concept: concept.trim() }),
      });
      onCreated(`Aquí está tu link de pago por $${r.amount.toLocaleString("es-CL")} (${r.concept}): ${r.url}`);
    } catch (e) {
      setErr((e as Error).message);
      setSaving(false);
    }
  }

  const field: React.CSSProperties = { width: "100%", padding: "10px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };
  const lbl: React.CSSProperties = { fontSize: 12, color: "var(--ink-dim)", display: "block", marginTop: 12 };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card" style={{ width: "100%", maxWidth: 400, padding: 24 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 2 }}>
          <h2 className="display" style={{ fontSize: 20, margin: 0 }}>Link de pago</h2>
          <button type="button" onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }} aria-label="Cerrar"><X size={20} /></button>
        </div>
        <p className="text-dim" style={{ fontSize: 12, margin: "4px 0 0" }}>Se genera con tu cuenta de cobros y se inserta en el mensaje para que lo envíes.</p>
        <label style={lbl}>Monto (CLP)
          <input style={field} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} placeholder="15000" inputMode="numeric" />
        </label>
        <label style={lbl}>Concepto
          <input style={field} value={concept} onChange={(e) => setConcept(e.target.value)} placeholder="Reserva de hora" maxLength={120} />
        </label>
        {err ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{err}</p> : null}
        <button className="btn-accent" type="submit" disabled={saving} style={{ width: "100%", marginTop: 18, opacity: saving ? 0.6 : 1 }}>
          {saving ? "Generando…" : "Generar link"}
        </button>
      </form>
    </div>
  );
}
