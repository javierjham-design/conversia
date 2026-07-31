"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken } from "@/lib/api";
import { useToast } from "@/components/ui";

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
  profileName: string | null;
  phone: string | null;
}
interface Conversation {
  id: string;
  status: string;
  aiEnabled: boolean;
  assignedUserId: string | null;
  activeAgentId: string | null;
  channelConnectionId: string | null;
  lastMessagePreview: string | null;
  lastMessageAt: string | null;
  contact: Contact;
}
interface ChannelInfo {
  id: string;
  type: string;
  name: string;
  status: string;
  displayPhone: string | null;
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
  const toast = useToast();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [users, setUsers] = useState<Assignable[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [fStatus, setFStatus] = useState("open");
  const [fAi, setFAi] = useState("all");
  const [fAssigned, setFAssigned] = useState("all");
  const [q, setQ] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  // Plantillas HSM aprobadas (envío fuera de la ventana de 24 h)
  const [templates, setTemplates] = useState<{ id: string; name: string; language: string; bodyText: string }[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [sendingTemplate, setSendingTemplate] = useState(false);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const channelOf = (c: Conversation | null) => channels.find((ch) => ch.id === c?.channelConnectionId) ?? null;
  const hasWhatsapp = channels.some((ch) => ch.type === "WHATSAPP_CLOUD" && ch.status !== "inactive");
  const channelError = channels.find((ch) => ch.type === "WHATSAPP_CLOUD" && ch.status === "error");

  // Ventana de servicio de 24 h: desde el último mensaje ENTRANTE del contacto.
  const lastInboundAt = messages.reduce<number | null>((acc, m) => {
    if (m.direction !== "INBOUND") return acc;
    const t = new Date(m.createdAt).getTime();
    return acc === null || t > acc ? t : acc;
  }, null);
  const windowMsLeft = lastInboundAt === null ? 0 : lastInboundAt + 24 * 60 * 60 * 1000 - Date.now();
  const windowOpen = windowMsLeft > 0;
  const windowLabel = windowOpen
    ? `ventana 24 h abierta · quedan ${Math.floor(windowMsLeft / 3_600_000)} h ${Math.floor((windowMsLeft % 3_600_000) / 60_000)} m`
    : "ventana de 24 h cerrada — solo plantillas aprobadas";

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
    // Flujos publicados+activos, para el atajo "Ejecutar flujo".
    void api<{ id: string; name: string; status: string }[]>("/workflows")
      .then((r) => setWorkflows(r.filter((w) => w.status === "published").map((w) => ({ id: w.id, name: w.name }))))
      .catch(() => setWorkflows([]));
    // Plantillas aprobadas del tenant (para escribir fuera de la ventana de 24 h).
    void api<{ templates: { id: string; name: string; language: string; bodyText: string }[] }>("/channels/templates/approved")
      .then((r) => setTemplates(r.templates))
      .catch(() => setTemplates([]));
    // Canales: indicador de número por conversación + CTA si falta WhatsApp.
    void api<ChannelInfo[]>("/channels").then(setChannels).catch(() => setChannels([]));
  }, []);

  async function sendTemplate(templateId: string) {
    if (!selected) return;
    setSendingTemplate(true);
    try {
      await api(`/conversations/${selected.id}/send-template`, {
        method: "POST",
        body: JSON.stringify({ templateId }),
      });
      setShowTemplates(false);
      await loadMessages(selected.id);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSendingTemplate(false);
    }
  }

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

  async function runWorkflow(workflowId: string) {
    if (!selected || !workflowId) return;
    try {
      await api(`/conversations/${selected.id}/run-workflow`, {
        method: "POST",
        body: JSON.stringify({ workflowId }),
      });
      toast.push("Flujo ejecutado sobre esta conversación", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }

  function displayName(c: Contact) {
    // Nombre real → nombre de perfil de WhatsApp → teléfono.
    return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.profileName || c.phone || "Sin nombre";
  }

  const showChecklist = channels.length > 0 && (!hasWhatsapp || workflows.length === 0);

  return (
    <div className="flex h-full flex-col">
      {/* Banners transversales: estado del canal + puesta en marcha */}
      {channelError && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          ⚠ El canal <b>{channelError.name}</b> necesita reautorización — los mensajes salientes están fallando.{" "}
          <a href="/channels" className="font-medium underline">Ir a Canales</a>
        </div>
      )}
      {!channelError && showChecklist && (
        <div className="flex flex-wrap items-center gap-3 border-b border-cyan-100 bg-cyan-50 px-4 py-2 text-xs text-cyan-900">
          <span className="font-medium">Puesta en marcha:</span>
          <a href="/channels" className={hasWhatsapp ? "text-emerald-600" : "underline"}>
            {hasWhatsapp ? "✔ WhatsApp conectado" : "1. Conecta WhatsApp"}
          </a>
          <a href="/agents" className={agents.length > 0 ? "text-emerald-600" : "underline"}>
            {agents.length > 0 ? "✔ Agente IA creado" : "2. Crea tu agente IA"}
          </a>
          <a href="/workflows" className={workflows.length > 0 ? "text-emerald-600" : "underline"}>
            {workflows.length > 0 ? "✔ Flujo publicado" : "3. Publica tu primer flujo"}
          </a>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
      <aside className={`${selected ? "hidden md:flex" : "flex"} w-full flex-col border-r border-slate-200 bg-white md:w-96`}>
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

      <section className={`${selected ? "flex" : "hidden md:flex"} flex-1 flex-col`}>
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-slate-400">
            Selecciona una conversación
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white p-3">
              <div className="flex items-center gap-2">
                <button onClick={() => setSelected(null)} className="text-lg text-slate-500 hover:text-slate-800 md:hidden" aria-label="Volver a la lista">←</button>
                <div>
                  <h2 className="font-medium">{displayName(selected.contact)}</h2>
                  <p className="text-xs text-slate-400">
                    {selected.contact.phone}
                    {channelOf(selected) && (
                      <span title="Número por el que se habla">
                        {" "}· 📱 {channelOf(selected)!.name}
                        {channelOf(selected)!.displayPhone ? ` (${channelOf(selected)!.displayPhone})` : ""}
                        {channelOf(selected)!.status === "error" && <span className="text-red-500"> ⚠ reautorizar</span>}
                      </span>
                    )}
                  </p>
                </div>
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
                {workflows.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => void runWorkflow(e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                    title="Ejecutar un flujo sobre esta conversación"
                  >
                    <option value="">⚡ Ejecutar flujo…</option>
                    {workflows.map((w) => (
                      <option key={w.id} value={w.id}>{w.name}</option>
                    ))}
                  </select>
                )}
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
            <footer className="border-t border-slate-200 bg-white p-4">
              <p className={`mb-2 text-[10px] ${windowOpen ? "text-slate-400" : "font-medium text-amber-600"}`}>
                {windowLabel}
              </p>
              <div className="flex gap-2">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void send()}
                  placeholder={windowOpen ? "Escribe un mensaje…" : "Ventana cerrada — usa una plantilla"}
                  disabled={!windowOpen}
                  className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-400"
                />
                <button
                  onClick={() => setShowTemplates(true)}
                  title="Enviar plantilla aprobada (funciona con la ventana cerrada)"
                  className={`rounded-lg px-3 py-2 text-sm font-medium ${
                    windowOpen
                      ? "border border-slate-300 text-slate-600 hover:bg-slate-50"
                      : "bg-amber-500 text-white hover:bg-amber-600"
                  }`}
                >
                  📄 Plantilla
                </button>
                <button
                  onClick={() => void send()}
                  disabled={!windowOpen}
                  className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800 disabled:opacity-40"
                >
                  Enviar
                </button>
              </div>
            </footer>

            {showTemplates && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog">
                <div className="absolute inset-0 bg-navy-950/50" onClick={() => setShowTemplates(false)} />
                <div className="relative max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
                  <h2 className="mb-1 text-lg font-semibold">Enviar plantilla</h2>
                  <p className="mb-3 text-xs text-slate-500">
                    Las variables se completan solas con los datos del contacto. Las plantillas aprobadas funcionan aunque la
                    ventana de 24 h esté cerrada.
                  </p>
                  {templates.length === 0 ? (
                    <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                      No hay plantillas aprobadas. Créalas o sincronízalas en <a href="/channels" className="underline">Canales → Plantillas</a>.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {templates.map((t) => (
                        <button
                          key={t.id}
                          disabled={sendingTemplate}
                          onClick={() => void sendTemplate(t.id)}
                          className="block w-full rounded-lg border border-slate-200 p-3 text-left hover:border-cyan-400 hover:bg-cyan-50 disabled:opacity-50"
                        >
                          <p className="font-mono text-xs font-medium">{t.name} · {t.language}</p>
                          <p className="mt-1 text-xs text-slate-500">{t.bodyText.slice(0, 140)}{t.bodyText.length > 140 ? "…" : ""}</p>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="mt-4 flex justify-end">
                    <button onClick={() => setShowTemplates(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm">
                      Cancelar
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </section>
      </div>
    </div>
  );
}
