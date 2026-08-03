"use client";

/**
 * Bandeja Pro — 4 zonas: clasificador · lista · conversación · panel de contacto.
 * Tiempo real vía SSE (pub/sub Redis por tenant) con fallback automático a sondeo.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Search, User } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { EmptyState, cn } from "@/components/ui";
import { ContactPanel } from "./contact-panel";
import { LifecycleModal } from "./lifecycle-modal";
import { InboxSidebar } from "./sidebar";
import { Thread } from "./thread";
import { displayName, initials, type ChannelInfo, type ConvContext, type ConvItem, type ConversationFull, type Counters, type InboxFilter, type Msg, type Stage } from "./types";

function filterParams(filter: InboxFilter): Record<string, string> {
  switch (filter.kind) {
    case "all":
      return {};
    case "mine":
      return { assigned: "me" };
    case "unassigned":
      return { assigned: "unassigned" };
    case "unanswered":
      return { unanswered: "1" };
    case "blocked":
      return { blocked: "1" };
    case "agent":
      return { agentId: filter.id };
    case "stage":
      return { stage: filter.code };
    case "team":
      return { teamId: filter.id };
    case "view":
      return { view: filter.id };
  }
}

export default function InboxPage() {
  const [counters, setCounters] = useState<Counters | null>(null);
  const [filter, setFilter] = useState<InboxFilter>({ kind: "all" });
  const [items, setItems] = useState<ConvItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [q, setQ] = useState("");
  const [order, setOrder] = useState("recent");
  const [onlyUnanswered, setOnlyUnanswered] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<ConversationFull | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [context, setContext] = useState<ConvContext | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [live, setLive] = useState(false);
  const [manageStages, setManageStages] = useState(false);

  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [users, setUsers] = useState<{ userId: string; name: string }[]>([]);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [agents, setAgents] = useState<{ id: string; name: string; slug: string }[]>([]);
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [allStages, setAllStages] = useState<Stage[]>([]);

  const loadStages = useCallback(async () => {
    try {
      const rows = await api<{ code: string; name: string; emoji: string | null; color: string | null; category: string }[]>("/lifecycle-stages");
      setAllStages(rows.map((s) => ({ code: s.code, name: s.name, emoji: s.emoji, color: s.color, category: s.category })));
    } catch {
      setAllStages([]);
    }
  }, []);

  const loadCounters = useCallback(async () => {
    try {
      setCounters(await api<Counters>("/inbox/counters"));
    } catch {
      /* mantiene los últimos */
    }
  }, []);

  const loadList = useCallback(
    async (cursor?: string | null) => {
      const params = new URLSearchParams(filterParams(filter));
      if (q.trim()) params.set("q", q.trim());
      if (order !== "recent") params.set("order", order);
      if (onlyUnanswered) params.set("unanswered", "1");
      if (cursor) params.set("cursor", cursor);
      const res = await api<{ items: ConvItem[]; nextCursor: string | null }>(`/conversations?${params.toString()}`);
      setItems((prev) => (cursor ? [...prev, ...res.items] : res.items));
      setNextCursor(res.nextCursor);
    },
    [filter, q, order, onlyUnanswered],
  );

  const loadMessages = useCallback(async (id: string) => {
    const res = await api<{ conversation: ConversationFull; messages: Msg[] }>(`/conversations/${id}/messages`);
    setConversation(res.conversation);
    setMessages(res.messages);
  }, []);

  const loadContext = useCallback(async (id: string) => {
    try {
      setContext(await api<ConvContext>(`/conversations/${id}/context`));
    } catch {
      setContext(null);
    }
  }, []);

  const openConversation = useCallback(
    (id: string) => {
      setSelectedId(id);
      setContext(null);
      void loadMessages(id);
      void loadContext(id);
      // En escritorio ancho el panel del contacto se abre solo; en chico queda como drawer bajo demanda.
      if (typeof window !== "undefined" && window.innerWidth >= 1280) setPanelOpen(true);
    },
    [loadMessages, loadContext],
  );

  const refreshCurrent = useCallback(() => {
    if (selectedId) {
      void loadMessages(selectedId);
      void loadContext(selectedId);
    }
    void loadList();
    void loadCounters();
  }, [selectedId, loadMessages, loadContext, loadList, loadCounters]);

  // Catálogos (una vez)
  useEffect(() => {
    void api<{ userId: string; name: string }[]>("/users/assignable").then(setUsers).catch(() => setUsers([]));
    void api<{ id: string; name: string }[]>("/users/teams").then(setTeams).catch(() => setTeams([]));
    void api<{ id: string; name: string; slug: string }[]>("/agents/assignable").then(setAgents).catch(() => setAgents([]));
    void api<{ id: string; name: string; status: string }[]>("/workflows")
      .then((r) => setWorkflows(r.filter((w) => w.status === "published").map((w) => ({ id: w.id, name: w.name }))))
      .catch(() => setWorkflows([]));
    void api<ChannelInfo[]>("/channels").then(setChannels).catch(() => setChannels([]));
    void loadStages();
  }, []);

  useEffect(() => {
    void loadCounters();
  }, [loadCounters]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // ---------- Tiempo real: SSE (fetch streaming) con fallback a sondeo ----------
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;
  const refreshersRef = useRef({ loadList, loadCounters, loadMessages, loadContext });
  refreshersRef.current = { loadList, loadCounters, loadMessages, loadContext };

  useEffect(() => {
    let stopped = false;
    let fallback: ReturnType<typeof setInterval> | null = null;
    let retryMs = 2000;

    function startFallback() {
      if (fallback) return;
      setLive(false);
      fallback = setInterval(() => {
        void refreshersRef.current.loadList();
        void refreshersRef.current.loadCounters();
        if (selectedRef.current) void refreshersRef.current.loadMessages(selectedRef.current);
      }, 5000);
    }
    function stopFallback() {
      if (fallback) {
        clearInterval(fallback);
        fallback = null;
      }
    }

    async function connect() {
      while (!stopped) {
        try {
          const res = await fetch("/backend/conversations/stream/updates", {
            headers: { authorization: `Bearer ${getToken() ?? ""}` },
          });
          if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
          stopFallback();
          setLive(true);
          retryMs = 2000;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done || stopped) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() ?? "";
            for (const part of parts) {
              const line = part.split("\n").find((l) => l.startsWith("data: "));
              if (!line) continue;
              try {
                const event = JSON.parse(line.slice(6)) as { type: string; conversationId?: string };
                if (event.type === "counters.dirty") void refreshersRef.current.loadCounters();
                if (event.type === "message.created" || event.type === "message.updated") {
                  void refreshersRef.current.loadList();
                  if (event.conversationId && event.conversationId === selectedRef.current) {
                    void refreshersRef.current.loadMessages(event.conversationId);
                  }
                }
                if (event.type === "conversation.updated") {
                  void refreshersRef.current.loadList();
                  void refreshersRef.current.loadCounters();
                  if (event.conversationId && event.conversationId === selectedRef.current) {
                    void refreshersRef.current.loadMessages(event.conversationId);
                    void refreshersRef.current.loadContext(event.conversationId);
                  }
                }
              } catch {
                /* evento malformado */
              }
            }
          }
        } catch {
          /* reconectar abajo */
        }
        if (stopped) break;
        startFallback(); // mientras reintenta, sondeo de respaldo
        await new Promise((r) => setTimeout(r, retryMs));
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    }
    void connect();
    return () => {
      stopped = true;
      stopFallback();
    };
  }, []);

  const channelOf = (c: { channelConnectionId: string | null } | null) => channels.find((ch) => ch.id === c?.channelConnectionId) ?? null;
  const channelError = channels.find((ch) => ch.type === "WHATSAPP_CLOUD" && ch.status === "error");
  const stagesForHeader = allStages;

  return (
    <div className="flex h-full flex-col">
      {channelError && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          ⚠ El canal <b>{channelError.name}</b> necesita reautorización — los mensajes salientes están fallando.{" "}
          <a href="/channels" className="font-medium underline">Ir a Canales</a>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Zona 1 — clasificador */}
        <div className={cn(selectedId ? "hidden xl:block" : "hidden md:block")}>
          <InboxSidebar counters={counters} filter={filter} onSelect={(f) => { setFilter(f); setSelectedId(null); }} channels={channels} onViewsChanged={() => void loadCounters()} onManageStages={() => setManageStages(true)} />
        </div>

        {/* Zona 2 — lista */}
        <aside className={cn("w-full flex-col border-r border-slate-200 bg-white md:w-80 lg:w-96", selectedId ? "hidden lg:flex" : "flex")}>
          <header className="space-y-2 border-b border-slate-200 p-3">
            <div className="flex items-center justify-between">
              <h1 className="text-sm font-semibold">
                {filter.kind === "all" ? "Todas" : filter.kind === "mine" ? "Mías" : filter.kind === "unassigned" ? "Sin asignar" : filter.kind === "unanswered" ? "No respondidas" : filter.kind === "blocked" ? "Bloqueados" : (filter as { label: string }).label}
              </h1>
              <span className={cn("flex items-center gap-1 text-[10px]", live ? "text-emerald-500" : "text-slate-400")} title={live ? "Actualización en tiempo real" : "Actualizando por sondeo"}>
                <span className={cn("h-1.5 w-1.5 rounded-full", live ? "bg-emerald-500" : "bg-slate-300")} />
                {live ? "en vivo" : "sondeo"}
              </span>
            </div>
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar nombre o teléfono…" className="w-full rounded-lg border border-slate-300 py-1.5 pl-8 pr-3 text-sm" />
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <select value={order} onChange={(e) => setOrder(e.target.value)} className="flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1">
                <option value="recent">Más nuevas primero</option>
                <option value="oldest">Más antiguas primero</option>
                <option value="unanswered_first">Sin responder primero</option>
              </select>
              <label className="flex items-center gap-1 whitespace-nowrap text-[11px] text-slate-500">
                <input type="checkbox" checked={onlyUnanswered} onChange={(e) => setOnlyUnanswered(e.target.checked)} />
                Solo no respondidas
              </label>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto">
            {items.length === 0 && <p className="p-4 text-sm text-slate-400">Sin conversaciones con estos filtros.</p>}
            {items.map((c) => (
              <button
                key={c.id}
                onClick={() => openConversation(c.id)}
                className={cn("block w-full border-b border-slate-100 p-2.5 text-left hover:bg-slate-50", selectedId === c.id && "bg-cyan-50")}
              >
                <div className="flex items-center gap-2.5">
                  <div className="relative shrink-0">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
                      {initials(c.contact).toUpperCase()}
                    </div>
                    <span
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-white text-[8px] text-white",
                        c.aiEnabled ? "bg-cyan-500" : "bg-amber-500",
                      )}
                      title={c.aiEnabled ? "Atendida por IA" : "Control humano"}
                    >
                      {c.aiEnabled ? <Bot size={9} /> : <User size={9} />}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13px] font-medium">{displayName(c.contact)}</span>
                      <span className="shrink-0 text-[10px] text-slate-400">
                        {c.lastMessageAt
                          ? new Date(c.lastMessageAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })
                          : ""}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-xs text-slate-500">
                        {c.unreadCount > 0 ? "↙ " : ""}
                        {c.lastMessagePreview ?? "—"}
                      </p>
                      {c.unreadCount > 0 && (
                        <span className="shrink-0 rounded-full bg-cyan-600 px-1.5 text-[10px] font-medium text-white">{c.unreadCount}</span>
                      )}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      {c.stage && (
                        <span className="rounded-full px-1.5 text-[9px] font-medium" style={{ backgroundColor: `${c.stage.color ?? "#94a3b8"}22`, color: c.stage.color ?? "#64748b" }}>
                          {c.stage.emoji ? `${c.stage.emoji} ` : ""}{c.stage.name}
                        </span>
                      )}
                      {c.status === "CLOSED" && <span className="text-[9px] text-slate-400">cerrada</span>}
                      {(c.assignedUserName || c.assignedTeamName) && (
                        <span className="ml-auto truncate text-[9px] text-slate-400" title="Asignada a">
                          {c.assignedUserName ?? c.assignedTeamName}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            ))}
            {nextCursor && (
              <button
                onClick={() => {
                  setLoadingMore(true);
                  void loadList(nextCursor).finally(() => setLoadingMore(false));
                }}
                disabled={loadingMore}
                className="block w-full py-2.5 text-center text-xs text-cyan-700 hover:bg-slate-50"
              >
                {loadingMore ? "Cargando…" : "Cargar más"}
              </button>
            )}
          </div>
        </aside>

        {/* Zona 3 — conversación */}
        {!selectedId || !conversation ? (
          <section className="hidden flex-1 items-center justify-center lg:flex">
            <EmptyState title="Selecciona una conversación" description="Elige una bandeja en el clasificador y una conversación de la lista." />
          </section>
        ) : (
          <Thread
            conversation={conversation}
            messages={messages}
            context={context}
            stages={stagesForHeader}
            users={users}
            teams={teams}
            agents={agents}
            workflows={workflows}
            channel={channelOf(conversation)}
            onRefresh={refreshCurrent}
            onBack={() => setSelectedId(null)}
            onTogglePanel={() => setPanelOpen(!panelOpen)}
            panelOpen={panelOpen}
          />
        )}

        {/* Zona 4 — panel derecho (colapsable; overlay en pantallas chicas) */}
        {selectedId && conversation && panelOpen && (
          <>
            <div className="hidden xl:block">
              <ContactPanel conversationId={selectedId} context={context} onClose={() => setPanelOpen(false)} onChanged={refreshCurrent} />
            </div>
            <div className="fixed inset-0 z-40 flex justify-end xl:hidden">
              <div className="absolute inset-0 bg-navy-950/40" onClick={() => setPanelOpen(false)} />
              <div className="relative h-full">
                <ContactPanel conversationId={selectedId} context={context} onClose={() => setPanelOpen(false)} onChanged={refreshCurrent} />
              </div>
            </div>
          </>
        )}
      </div>

      {manageStages && (
        <LifecycleModal
          onClose={() => setManageStages(false)}
          onChanged={() => {
            void loadStages();
            void loadCounters();
            if (selectedId) void loadContext(selectedId);
          }}
        />
      )}
    </div>
  );
}
