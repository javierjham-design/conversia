"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken } from "@/lib/api";

/** Reproductor de nota de voz: descarga el audio (con auth) on-demand y lo reproduce. */
function AudioBubble({ conversationId, messageId, transcript, outbound }: { conversationId: string; messageId: string; transcript: string | null; outbound: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);
  async function load() {
    if (url || loading) return;
    setLoading(true);
    setErr(false);
    try {
      const res = await fetch(`/backend/conversations/${conversationId}/messages/${messageId}/audio`, {
        headers: { authorization: `Bearer ${getToken() ?? ""}` },
      });
      if (!res.ok) throw new Error();
      setUrl(URL.createObjectURL(await res.blob()));
    } catch {
      setErr(true);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div>
      {url ? (
        <audio controls src={url} className="mb-1 h-9 w-56" />
      ) : (
        <button
          onClick={() => void load()}
          disabled={loading}
          className={`mb-1 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs ${outbound ? "bg-cyan-600 text-white" : "bg-slate-100 text-slate-700"}`}
        >
          🎤 {loading ? "Cargando…" : err ? "No disponible" : "Escuchar audio"}
        </button>
      )}
      {transcript && <p className="whitespace-pre-wrap">{transcript}</p>}
    </div>
  );
}

interface Contact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
}
interface Conversation {
  id: string;
  status: string;
  aiEnabled: boolean;
  assignedUserId: string | null;
  activeAgentId: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  contact: Contact;
}
interface Message {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  type?: string;
  body: string | null;
  authorType: string;
  status: string;
  createdAt: string;
}
interface Assignable {
  userId: string;
  name: string;
}
interface AgentOption {
  id: string;
  name: string;
  slug: string;
}

export default function InboxPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [users, setUsers] = useState<Assignable[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [fStatus, setFStatus] = useState("open");
  const [fAi, setFAi] = useState("all");
  const [fAssigned, setFAssigned] = useState("all");
  const [q, setQ] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    const params = new URLSearchParams();
    params.set("status", fStatus);
    if (fAi !== "all") params.set("ai", fAi);
    if (fAssigned !== "all") params.set("assigned", fAssigned);
    if (q.trim()) params.set("q", q.trim());
    setConversations(await api<Conversation[]>(`/conversations?${params.toString()}`));
  }, [fStatus, fAi, fAssigned, q]);

  const loadMessages = useCallback(async (id: string) => {
    const res = await api<{ conversation: Conversation; messages: Message[] }>(`/conversations/${id}/messages`);
    setSelected(res.conversation);
    setMessages(res.messages);
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    void api<Assignable[]>("/users/assignable").then(setUsers).catch(() => setUsers([]));
    void api<AgentOption[]>("/agents/assignable").then(setAgents).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      void loadConversations();
      if (selected) void loadMessages(selected.id);
    }, 4000);
    return () => clearInterval(interval);
  }, [loadConversations, loadMessages, selected]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function send() {
    if (!selected || !draft.trim()) return;
    await api(`/conversations/${selected.id}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: draft.trim() }),
    });
    setDraft("");
    await loadMessages(selected.id);
  }

  async function toggleAi() {
    if (!selected) return;
    const action = selected.aiEnabled ? "takeover" : "release";
    await api(`/conversations/${selected.id}/${action}`, { method: "POST" });
    await loadMessages(selected.id);
    await loadConversations();
  }

  async function toggleClosed() {
    if (!selected) return;
    const action = selected.status === "CLOSED" ? "reopen" : "close";
    await api(`/conversations/${selected.id}/${action}`, { method: "POST" });
    await loadMessages(selected.id);
    await loadConversations();
  }

  async function assign(userId: string) {
    if (!selected) return;
    await api(`/conversations/${selected.id}/assign`, {
      method: "POST",
      body: JSON.stringify({ userId: userId || null }),
    });
    await loadMessages(selected.id);
  }

  async function assignAgent(agentId: string) {
    if (!selected) return;
    // Al asignar un agente, la IA retoma el control (aiEnabled=true en el backend).
    await api(`/conversations/${selected.id}/agent`, {
      method: "POST",
      body: JSON.stringify({ agentId: agentId || null }),
    });
    await loadMessages(selected.id);
  }

  function displayName(c: Contact) {
    return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || "Sin nombre";
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-96 flex-col border-r border-slate-200 bg-white">
        <header className="space-y-2 border-b border-slate-200 p-3">
          <div className="flex items-center justify-between">
            <h1 className="font-semibold">Bandeja</h1>
            <span className="text-xs text-slate-400">{conversations.length}</span>
          </div>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar nombre o teléfono…"
            className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
          <div className="flex gap-1.5 text-xs">
            <select value={fStatus} onChange={(e) => setFStatus(e.target.value)} className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1">
              <option value="open">Abiertas</option>
              <option value="pending">Pendientes</option>
              <option value="closed">Cerradas</option>
              <option value="all">Todas</option>
            </select>
            <select value={fAi} onChange={(e) => setFAi(e.target.value)} className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1">
              <option value="all">IA y humano</option>
              <option value="on">Con IA</option>
              <option value="off">Control humano</option>
            </select>
            <select value={fAssigned} onChange={(e) => setFAssigned(e.target.value)} className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1">
              <option value="all">Cualquiera</option>
              <option value="me">Mías</option>
              <option value="unassigned">Sin asignar</option>
            </select>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 && (
            <p className="p-4 text-sm text-slate-400">Sin conversaciones con estos filtros.</p>
          )}
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => void loadMessages(c.id)}
              className={`block w-full border-b border-slate-100 p-3 text-left hover:bg-slate-50 ${
                selected?.id === c.id ? "bg-cyan-50" : ""
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{displayName(c.contact)}</span>
                <span className={`text-[10px] ${c.aiEnabled ? "text-cyan-600" : "text-amber-600"}`}>
                  {c.status === "CLOSED" ? "cerrada" : c.aiEnabled ? "IA" : "Humano"}
                </span>
              </div>
              <p className="truncate text-xs text-slate-500">{c.lastMessagePreview ?? "—"}</p>
            </button>
          ))}
        </div>
      </aside>

      <section className="flex flex-1 flex-col">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-slate-400">
            Selecciona una conversación
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white p-3">
              <div>
                <h2 className="font-medium">{displayName(selected.contact)}</h2>
                <p className="text-xs text-slate-400">{selected.contact.phone}</p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={selected.assignedUserId ?? ""}
                  onChange={(e) => void assign(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                  title="Asignar a"
                >
                  <option value="">👤 Sin asignar</option>
                  {users.map((u) => (
                    <option key={u.userId} value={u.userId}>👤 {u.name}</option>
                  ))}
                </select>
                <select
                  value={selected.activeAgentId ?? ""}
                  onChange={(e) => void assignAgent(e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                  title="Agente de IA a cargo"
                >
                  <option value="">🤖 Sin agente</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>🤖 {a.name}</option>
                  ))}
                </select>
                <button
                  onClick={() => void toggleAi()}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
                    selected.aiEnabled
                      ? "bg-amber-100 text-amber-800 hover:bg-amber-200"
                      : "bg-cyan-100 text-cyan-800 hover:bg-cyan-200"
                  }`}
                >
                  {selected.aiEnabled ? "Tomar control" : "Devolver a IA"}
                </button>
                <button
                  onClick={() => void toggleClosed()}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
                >
                  {selected.status === "CLOSED" ? "Reabrir" : "Cerrar"}
                </button>
              </div>
            </header>
            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.direction === "OUTBOUND" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-md rounded-2xl px-4 py-2 text-sm ${
                      m.direction === "OUTBOUND" ? "bg-cyan-700 text-white" : "border border-slate-200 bg-white"
                    }`}
                  >
                    {m.type === "AUDIO" ? (
                      <AudioBubble conversationId={selected?.id ?? ""} messageId={m.id} transcript={m.body} outbound={m.direction === "OUTBOUND"} />
                    ) : (
                      <p className="whitespace-pre-wrap">{m.body}</p>
                    )}
                    <p className={`mt-1 text-[10px] ${m.direction === "OUTBOUND" ? "text-cyan-200" : "text-slate-400"}`}>
                      {m.authorType.toLowerCase()} · {new Date(m.createdAt).toLocaleTimeString("es-CL")} · {m.status.toLowerCase()}
                    </p>
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
            <footer className="flex gap-2 border-t border-slate-200 bg-white p-4">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void send()}
                placeholder="Escribe un mensaje…"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                onClick={() => void send()}
                className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800"
              >
                Enviar
              </button>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
