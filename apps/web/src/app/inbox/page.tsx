"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL, api, clearToken, getToken } from "@/lib/api";

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
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  contact: Contact;
}
interface Message {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string | null;
  authorType: string;
  status: string;
  createdAt: string;
}

export default function InboxPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    const items = await api<Conversation[]>("/conversations");
    setConversations(items);
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    const res = await api<{ conversation: Conversation; messages: Message[] }>(`/conversations/${id}/messages`);
    setSelected(res.conversation);
    setMessages(res.messages);
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  // Tiempo real v0: SSE (EventSource no soporta headers → refresco por polling del stream vía fetch)
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

  function displayName(c: Contact) {
    return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || "Sin nombre";
  }

  if (typeof window !== "undefined" && !getToken()) {
    window.location.href = "/login";
    return null;
  }

  return (
    <main className="flex h-screen">
      <aside className="flex w-80 flex-col border-r border-slate-200 bg-white">
        <header className="flex items-center justify-between border-b border-slate-200 p-4">
          <h1 className="font-semibold">Bandeja</h1>
          <button
            onClick={() => {
              clearToken();
              window.location.href = "/login";
            }}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            Salir
          </button>
        </header>
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 && (
            <p className="p-4 text-sm text-slate-400">
              Sin conversaciones. Simula una con:{" "}
              <code className="text-xs">node scripts/simulate-inbound.mjs</code>
            </p>
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
                  {c.aiEnabled ? "IA" : "Humano"}
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
            <header className="flex items-center justify-between border-b border-slate-200 bg-white p-4">
              <div>
                <h2 className="font-medium">{displayName(selected.contact)}</h2>
                <p className="text-xs text-slate-400">{selected.contact.phone}</p>
              </div>
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
            </header>
            <div className="flex-1 space-y-2 overflow-y-auto p-4">
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.direction === "OUTBOUND" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-md rounded-2xl px-4 py-2 text-sm ${
                      m.direction === "OUTBOUND" ? "bg-cyan-700 text-white" : "border border-slate-200 bg-white"
                    }`}
                  >
                    <p className="whitespace-pre-wrap">{m.body}</p>
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
    </main>
  );
}
