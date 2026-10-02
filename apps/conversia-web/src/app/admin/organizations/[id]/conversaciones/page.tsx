"use client";
import { use, useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";

type Conv = { id: string; status: string; aiEnabled: boolean; unreadCount: number; lastMessagePreview: string | null; lastMessageAt: string | null; contact: { name: string; phone: string | null } };
type Msg = { id: string; direction: string; type: string; visibility: string; body: string | null; authorType: string; status: string; createdAt: string };
type Thread = { conversation: { id: string; status: string; aiEnabled: boolean; contact: { name: string; phone: string | null } }; messages: Msg[] };

const STATUSES = [
  { key: "open", label: "Abiertas" },
  { key: "pending", label: "Pendientes" },
  { key: "all", label: "Todas" },
] as const;

function hhmm(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit" });
}

export default function ConsoleConversations({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [status, setStatus] = useState<(typeof STATUSES)[number]["key"]>("open");
  const [items, setItems] = useState<Conv[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(() => {
    padmin<Conv[]>(`/platform/organizations/${id}/conversations?status=${status}`).then(setItems).catch((e) => setError((e as Error).message));
  }, [id, status]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  function open(cid: string) {
    setSel(cid);
    setThread(null);
    padmin<Thread>(`/platform/organizations/${id}/conversations/${cid}/messages`).then(setThread).catch((e) => setError((e as Error).message));
  }

  return (
    <div style={{ maxWidth: 1000 }}>
      <a href={`/admin/organizations/${id}`} className="text-dim" style={{ fontSize: 13, textDecoration: "none" }}>← Tenant</a>
      <h1 className="display" style={{ fontSize: 26, margin: "8px 0 4px" }}>Conversaciones</h1>
      <p className="text-dim" style={{ fontSize: 13, margin: "0 0 16px" }}>Solo lectura · para revisar y ajustar la atención del cliente.</p>
      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}

      <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
        {/* Lista */}
        <div style={{ width: 320, flexShrink: 0 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {STATUSES.map((s) => (
              <button key={s.key} onClick={() => setStatus(s.key)} style={{ padding: "6px 12px", fontSize: 13, borderRadius: 999, cursor: "pointer", border: status === s.key ? "none" : "1px solid var(--line)", background: status === s.key ? "var(--acc)" : "transparent", color: status === s.key ? "var(--acc-ink)" : "var(--ink-dim)" }}>{s.label}</button>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: "70dvh", overflowY: "auto" }}>
            {items.length === 0 ? <p className="text-dim" style={{ fontSize: 14, padding: 8 }}>Sin conversaciones.</p> : items.map((c) => (
              <button key={c.id} onClick={() => open(c.id)} className="card" style={{ padding: 12, textAlign: "left", cursor: "pointer", border: sel === c.id ? "none" : "1px solid var(--hairline)", boxShadow: sel === c.id ? "inset 0 0 0 2px var(--acc)" : undefined }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <b style={{ fontSize: 14, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.contact.name}</b>
                  <span className="text-dim" style={{ fontSize: 11 }}>{hhmm(c.lastMessageAt)}</span>
                </div>
                <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.lastMessagePreview ?? "—"}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Hilo */}
        <div className="card" style={{ flex: 1, minWidth: 0, padding: 16, minHeight: 300, maxHeight: "78dvh", overflowY: "auto" }}>
          {!sel ? (
            <p className="text-dim" style={{ fontSize: 14 }}>Elige una conversación.</p>
          ) : !thread ? (
            <p className="text-dim" style={{ fontSize: 14 }}>Cargando…</p>
          ) : (
            <>
              <b style={{ fontSize: 15 }}>{thread.conversation.contact.name}</b>
              <span className="text-dim" style={{ fontSize: 12 }}> · {thread.conversation.contact.phone ?? ""} · {thread.conversation.aiEnabled ? "IA activa" : "manual"}</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
                {thread.messages.filter((m) => m.visibility !== "INTERNAL" || m.type === "NOTE").map((m) => {
                  const out = m.direction === "OUTBOUND";
                  const note = m.visibility === "INTERNAL";
                  return (
                    <div key={m.id} style={{ alignSelf: out ? "flex-end" : "flex-start", maxWidth: "76%" }}>
                      <div style={{ padding: "9px 13px", borderRadius: 16, fontSize: 14, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word", background: note ? "var(--warn)" : out ? "var(--acc)" : "var(--surface-solid)", color: note ? "#2a1c02" : out ? "var(--acc-ink)" : "var(--ink)", border: out || note ? "none" : "1px solid var(--hairline)" }}>
                        {m.body ?? (m.type !== "TEXT" ? `[${m.type.toLowerCase()}]` : "")}
                      </div>
                      <div className="text-dim" style={{ fontSize: 10, marginTop: 2, textAlign: out ? "right" : "left" }}>{m.authorType === "AGENT" ? "🤖 " : ""}{note ? "Nota · " : ""}{hhmm(m.createdAt)}</div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
