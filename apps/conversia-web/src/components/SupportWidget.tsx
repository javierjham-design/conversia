"use client";
import { useEffect, useRef, useState } from "react";
import { LifeBuoy, Send, X } from "lucide-react";
import { api } from "@/lib/api";

type ThreadMsg = { author: "user" | "team" | "agent"; body: string; at: string };
type Ticket = { id: string; code: string | null; status: string; thread: ThreadMsg[] } | null;

const SUPPORT_WA = process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP; // número de soporte (cuando exista)

/** Widget de soporte in-app (F7): burbuja flotante → chat con el equipo Conversia, con
 *  número de ticket (CV-XXXX) y persistencia server-side (retoma donde quedaste). */
export function SupportWidget() {
  const [open, setOpen] = useState(false);
  const [ticket, setTicket] = useState<Ticket>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function load() {
    try {
      const t = await api<Ticket>("/support/active");
      setTicket(t);
    } catch {
      /* noop */
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    if (open && !loaded) load();
  }, [open, loaded]);
  useEffect(() => {
    if (open) setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "auto" }), 60);
  }, [open, ticket]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      const t = await api<Ticket>("/support/messages", { method: "POST", body: JSON.stringify({ body }) });
      setTicket(t);
      setText("");
    } catch {
      /* noop */
    } finally {
      setSending(false);
    }
  }

  const thread = ticket?.thread ?? [];
  const waLink = SUPPORT_WA && ticket?.code ? `https://wa.me/${SUPPORT_WA}?text=${encodeURIComponent(`${ticket.code} — continuar mi caso`)}` : null;

  return (
    <>
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          aria-label="Soporte"
          style={{ position: "fixed", right: 18, bottom: 78, zIndex: 40, width: 52, height: 52, borderRadius: "50%", background: "var(--acc)", color: "var(--acc-ink)", border: "none", boxShadow: "var(--shadow)", cursor: "pointer", display: "grid", placeItems: "center" }}
        >
          <LifeBuoy size={24} />
        </button>
      ) : (
        <div className="card" style={{ position: "fixed", right: 16, bottom: 72, zIndex: 41, width: "min(360px, calc(100vw - 32px))", height: "min(520px, calc(100dvh - 120px))", display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: "1px solid var(--hairline)" }}>
            <LifeBuoy size={18} className="text-accent" />
            <div style={{ flex: 1 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>Soporte Conversia</p>
              {ticket?.code ? <p className="text-dim" style={{ margin: 0, fontSize: 11 }}>Ticket {ticket.code} · {ticket.status === "open" ? "abierto" : "resuelto"}</p> : <p className="text-dim" style={{ margin: 0, fontSize: 11 }}>¿En qué te ayudamos?</p>}
            </div>
            <button onClick={() => setOpen(false)} aria-label="Cerrar" style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }}><X size={18} /></button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 8 }}>
            {!loaded ? (
              <p className="text-dim" style={{ fontSize: 13 }}>Cargando…</p>
            ) : thread.length === 0 ? (
              <p className="text-dim" style={{ fontSize: 13 }}>Escríbenos tu duda o problema y el equipo te responde aquí mismo. Tu conversación queda guardada.</p>
            ) : (
              thread.map((m, i) => {
                const mine = m.author === "user";
                return (
                  <div key={i} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "82%" }}>
                    <div style={{ padding: "8px 12px", borderRadius: 14, fontSize: 14, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word", background: mine ? "var(--acc)" : "var(--surface-solid)", color: mine ? "var(--acc-ink)" : "var(--ink)", border: mine ? "none" : "1px solid var(--hairline)" }}>{m.body}</div>
                    <div className="text-dim" style={{ fontSize: 10, marginTop: 2, textAlign: mine ? "right" : "left" }}>{mine ? "Tú" : m.author === "agent" ? "🤖 Asistente" : "Equipo"}</div>
                  </div>
                );
              })
            )}
            <div ref={bottomRef} />
          </div>

          {waLink ? (
            <a href={waLink} target="_blank" rel="noreferrer" className="text-accent" style={{ fontSize: 12, textAlign: "center", padding: "6px 0", textDecoration: "none", borderTop: "1px solid var(--hairline)" }}>Seguir en WhatsApp →</a>
          ) : ticket?.code ? (
            <p className="text-dim" style={{ fontSize: 11, textAlign: "center", padding: "6px 10px", margin: 0, borderTop: "1px solid var(--hairline)" }}>Para seguir por WhatsApp, menciona tu código {ticket.code}.</p>
          ) : null}

          <form onSubmit={send} style={{ display: "flex", gap: 8, padding: 10, borderTop: "1px solid var(--hairline)" }}>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribe aquí…" style={{ flex: 1, padding: "10px 12px", borderRadius: 999, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 }} />
            <button className="btn-accent" type="submit" disabled={sending || !text.trim()} style={{ borderRadius: "50%", width: 40, height: 40, display: "grid", placeItems: "center", flexShrink: 0, opacity: sending || !text.trim() ? 0.5 : 1 }} aria-label="Enviar"><Send size={16} /></button>
          </form>
        </div>
      )}
    </>
  );
}
