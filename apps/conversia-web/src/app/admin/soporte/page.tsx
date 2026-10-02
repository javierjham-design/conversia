"use client";
import { useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";

type Ticket = { id: string; org: string; user: string | null; email: string | null; subject: string | null; message: string; status: string; createdAt: string };
type ThreadMsg = { author: string; body: string; at: string };
type ClientContext = { text: string; credits?: { over80?: boolean }; lifecycle?: { stage: string | null } };
type Detail = { id: string; organizationName: string; code: string | null; subject: string | null; message: string; status: string; email: string | null; thread: ThreadMsg[]; createdAt: string; clientContext?: ClientContext | null };

function hhmm(iso: string): string {
  return new Date(iso).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function Soporte() {
  const [filter, setFilter] = useState<"open" | "all" | "resolved">("open");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(() => {
    padmin<{ openCount: number; tickets: Ticket[] }>(`/platform/support?status=${filter}`)
      .then((r) => { setTickets(r.tickets); setOpenCount(r.openCount); })
      .catch((e) => setError((e as Error).message));
  }, [filter]);

  useEffect(() => { loadList(); }, [loadList]);

  function open(id: string) {
    setSel(id);
    setDetail(null);
    padmin<Detail>(`/platform/support/${id}`).then(setDetail).catch((e) => setError((e as Error).message));
  }

  async function sendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!sel || !reply.trim()) return;
    setBusy(true);
    try {
      await padmin(`/platform/support/${sel}/reply`, { method: "POST", body: JSON.stringify({ body: reply.trim() }) });
      setReply("");
      open(sel);
      loadList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resolve(status: "resolved" | "open") {
    if (!sel) return;
    await padmin(`/platform/support/${sel}`, { method: "PATCH", body: JSON.stringify({ status }) }).catch((e) => setError((e as Error).message));
    open(sel);
    loadList();
  }

  const FILTERS = [{ k: "open", l: `Abiertos${openCount ? ` (${openCount})` : ""}` }, { k: "all", l: "Todos" }, { k: "resolved", l: "Resueltos" }] as const;

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Soporte</h1>
      <p className="text-dim" style={{ fontSize: 14, margin: "0 0 16px" }}>Tickets de tus clientes (in-app). Responde y se les muestra en su panel.</p>
      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}

      <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
        <div style={{ width: 320, flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {FILTERS.map((f) => (
              <button key={f.k} onClick={() => setFilter(f.k)} style={{ padding: "6px 12px", fontSize: 13, borderRadius: 999, cursor: "pointer", border: filter === f.k ? "none" : "1px solid var(--line)", background: filter === f.k ? "var(--acc)" : "transparent", color: filter === f.k ? "var(--acc-ink)" : "var(--ink-dim)" }}>{f.l}</button>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "72dvh", overflowY: "auto" }}>
            {tickets.length === 0 ? <p className="text-dim" style={{ fontSize: 14, padding: 8 }}>Sin tickets.</p> : tickets.map((t) => (
              <button key={t.id} onClick={() => open(t.id)} className="card" style={{ padding: 12, textAlign: "left", cursor: "pointer", border: sel === t.id ? "none" : "1px solid var(--hairline)", boxShadow: sel === t.id ? "inset 0 0 0 2px var(--acc)" : undefined }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <b style={{ fontSize: 13 }}>{t.org}</b>
                  <span style={{ fontSize: 11, color: t.status === "open" ? "var(--warn)" : "var(--ok)" }}>● {t.status === "open" ? "abierto" : "resuelto"}</span>
                </div>
                <p style={{ margin: "3px 0 0", fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.subject || t.message}</p>
                <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 11 }}>{t.user ?? t.email ?? "—"} · {hhmm(t.createdAt)}</p>
              </button>
            ))}
          </div>
        </div>

        <div className="card" style={{ flex: 1, minWidth: 0, padding: 16, minHeight: 320, display: "flex", flexDirection: "column" }}>
          {!sel ? (
            <p className="text-dim" style={{ fontSize: 14 }}>Elige un ticket.</p>
          ) : !detail ? (
            <p className="text-dim" style={{ fontSize: 14 }}>Cargando…</p>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--hairline)", paddingBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <b style={{ fontSize: 15 }}>{detail.organizationName}</b>
                  <span className="text-dim" style={{ fontSize: 12 }}> · {detail.code ?? ""} · {detail.email ?? ""}</span>
                </div>
                <button onClick={() => resolve(detail.status === "open" ? "resolved" : "open")} className="nav-item" style={{ width: "auto", height: 34, padding: "0 12px", border: "1px solid var(--line)", background: "transparent", cursor: "pointer", fontSize: 12 }}>
                  {detail.status === "open" ? "Marcar resuelto" : "Reabrir"}
                </button>
              </div>
              {detail.clientContext?.text ? (
                <details style={{ borderBottom: "1px solid var(--hairline)", padding: "8px 0" }}>
                  <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--ink-dim)", fontWeight: 600 }}>
                    📋 Contexto del cliente {detail.clientContext.credits?.over80 ? "· ⚠️ créditos sobre 80%" : ""}{detail.clientContext.lifecycle?.stage ? ` · ${detail.clientContext.lifecycle.stage}` : ""}
                  </summary>
                  <pre style={{ margin: "8px 0 0", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--ink-dim)", fontFamily: "inherit" }}>{detail.clientContext.text.trim()}</pre>
                </details>
              ) : null}
              <div style={{ flex: 1, overflowY: "auto", padding: "12px 0", display: "flex", flexDirection: "column", gap: 8, maxHeight: "56dvh" }}>
                {(detail.thread.length ? detail.thread : [{ author: "user", body: detail.message, at: detail.createdAt }]).map((m, i) => {
                  const team = m.author === "team";
                  return (
                    <div key={i} style={{ alignSelf: team ? "flex-end" : "flex-start", maxWidth: "78%" }}>
                      <div style={{ padding: "8px 12px", borderRadius: 14, fontSize: 14, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word", background: team ? "var(--acc)" : "var(--surface-solid)", color: team ? "var(--acc-ink)" : "var(--ink)", border: team ? "none" : "1px solid var(--hairline)" }}>{m.body}</div>
                      <div className="text-dim" style={{ fontSize: 10, marginTop: 2, textAlign: team ? "right" : "left" }}>{team ? "Equipo" : m.author === "agent" ? "🤖" : "Cliente"} · {hhmm(m.at)}</div>
                    </div>
                  );
                })}
              </div>
              <form onSubmit={sendReply} style={{ display: "flex", gap: 8, borderTop: "1px solid var(--hairline)", paddingTop: 10 }}>
                <input value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Responder al cliente…" style={{ flex: 1, padding: "10px 13px", borderRadius: 999, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 }} />
                <button className="btn-accent" type="submit" disabled={busy || !reply.trim()} style={{ opacity: busy || !reply.trim() ? 0.5 : 1 }}>Enviar</button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
