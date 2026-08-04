"use client";

/**
 * Bandeja Pro — 4 zonas: clasificador · lista · conversación · panel de contacto.
 * Tiempo real vía SSE (pub/sub Redis por tenant) con fallback automático a sondeo.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Search, User } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { EmptyState, Modal, cn } from "@/components/ui";
import { ContactPanel } from "./contact-panel";
import { InboxSidebar } from "./sidebar";
import { Thread } from "./thread";
import { avatarColor, displayName, initials, type ChannelInfo, type ConvContext, type ConvItem, type ConversationFull, type Counters, type InboxFilter, type Msg, type Stage } from "./types";

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

  // Deep-link desde Configuración → Equipos: /inbox?team=<id>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const teamId = params.get("team");
    if (teamId) {
      setFilter({ kind: "team", id: teamId, label: "Equipo" });
      window.history.replaceState(null, "", "/inbox");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // ---------- Atajos de teclado ----------
  const searchRef = useRef<HTMLInputElement>(null);
  const [showHelp, setShowHelp] = useState(false);
  const itemsRef = useRef<ConvItem[]>(items);
  itemsRef.current = items;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
      if (e.key === "Escape") {
        if (showHelp) setShowHelp(false);
        else if (el.tagName === "INPUT") (el as HTMLInputElement).blur();
        return;
      }
      if (typing) return;
      const list = itemsRef.current;
      const idx = list.findIndex((c) => c.id === selectedRef.current);
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "?") {
        setShowHelp((v) => !v);
      } else if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const next = list[Math.min(list.length - 1, idx < 0 ? 0 : idx + 1)];
        if (next) openConversation(next.id);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const prev = list[Math.max(0, idx <= 0 ? 0 : idx - 1)];
        if (prev) openConversation(prev.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openConversation, showHelp]);

  return (
    <div className="flex h-full flex-col">
      {channelError && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
          ⚠ El canal <b>{channelError.name}</b> necesita reautorización — los mensajes salientes están fallando.{" "}
          <a href="/channels" className="font-medium underline">Ir a Canales</a>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Zona 1 — clasificador */}
        <div className={cn(selectedId ? "hidden xl:block" : "hidden md:block")}>
          <InboxSidebar counters={counters} filter={filter} onSelect={(f) => { setFilter(f); setSelectedId(null); }} channels={channels} onViewsChanged={() => void loadCounters()} onManageStages={() => (window.location.href = "/settings/lifecycle")} />
        </div>

        {/* Zona 2 — lista */}
        <aside className={cn("w-full flex-col border-r border-line bg-panel md:w-80 lg:w-96", selectedId ? "hidden lg:flex" : "flex")}>
          <header className="space-y-2 border-b border-line p-3">
            <div className="flex items-center justify-between">
              <h1 className="text-sm font-semibold text-ink">
                {filter.kind === "all" ? "Todas" : filter.kind === "mine" ? "Mías" : filter.kind === "unassigned" ? "Sin asignar" : filter.kind === "unanswered" ? "No respondidas" : filter.kind === "blocked" ? "Bloqueados" : (filter as { label: string }).label}
              </h1>
              <span className={cn("flex items-center gap-1 text-2xs", live ? "text-emerald-600 dark:text-emerald-400" : "text-ink-subtle")} title={live ? "Actualización en tiempo real" : "Actualizando por sondeo"}>
                <span className={cn("h-1.5 w-1.5 rounded-full", live ? "bg-emerald-500 live-dot" : "bg-ink-subtle")} />
                {live ? "en vivo" : "sondeo"}
              </span>
            </div>
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-2.5 text-ink-subtle" />
              <input ref={searchRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…  ( / )" className="w-full rounded-control border border-line-strong bg-panel py-1.5 pl-8 pr-3 text-sm text-ink placeholder:text-ink-subtle" />
            </div>
            <div className="flex items-center gap-1.5 text-xs">
              <select value={order} onChange={(e) => setOrder(e.target.value)} className="flex-1 rounded-control border border-line bg-panel px-2 py-1 text-ink">
                <option value="recent">Más nuevas primero</option>
                <option value="oldest">Más antiguas primero</option>
                <option value="unanswered_first">Sin responder primero</option>
              </select>
              <label className="flex items-center gap-1 whitespace-nowrap text-2xs text-ink-muted">
                <input type="checkbox" checked={onlyUnanswered} onChange={(e) => setOnlyUnanswered(e.target.checked)} />
                Solo no respondidas
              </label>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto">
            {items.length === 0 && <p className="p-4 text-sm text-ink-subtle">Sin conversaciones con estos filtros.</p>}
            {items.map((c) => (
              <button
                key={c.id}
                onClick={() => openConversation(c.id)}
                className={cn(
                  "relative block w-full border-b border-line/60 px-3 py-2.5 text-left transition-colors",
                  selectedId === c.id ? "bg-brand-soft" : "hover:bg-app",
                )}
              >
                {selectedId === c.id && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand-500" />}
                <div className="flex items-center gap-2.5">
                  <div className="relative shrink-0">
                    <div className={cn("flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold", avatarColor(c.contact))}>
                      {initials(c.contact).toUpperCase()}
                    </div>
                    <span
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-panel text-[8px] text-white",
                        c.aiEnabled ? "bg-brand-500" : "bg-amber-500",
                      )}
                      title={c.aiEnabled ? "Atendida por IA" : "Control humano"}
                    >
                      {c.aiEnabled ? <Bot size={9} /> : <User size={9} />}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={cn("truncate text-sm", c.unreadCount > 0 ? "font-semibold text-ink" : "font-medium text-ink")}>{displayName(c.contact)}</span>
                      <span className="flex shrink-0 items-center gap-1 text-2xs tnum text-ink-subtle">
                        {c.unreadCount > 0 && c.lastMessageAt && Date.now() - new Date(c.lastMessageAt).getTime() > (counters?.firstResponseTargetMinutes ?? 15) * 60_000 && (
                          <span className="text-red-500" title="Supera el tiempo objetivo de primera respuesta">⏱</span>
                        )}
                        {c.lastMessageAt ? new Date(c.lastMessageAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }) : ""}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      <p className={cn("truncate text-xs", c.unreadCount > 0 ? "text-ink-muted" : "text-ink-subtle")}>{c.lastMessagePreview ?? "—"}</p>
                      {c.unreadCount > 0 && (
                        <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1 text-2xs tnum font-semibold text-white">{c.unreadCount}</span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      {c.stage && (
                        <span
                          className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                          style={{ backgroundColor: `${c.stage.color ?? "#94a3b8"}1f`, color: c.stage.color ?? "#64748b" }}
                        >
                          {c.stage.emoji ? `${c.stage.emoji} ` : ""}{c.stage.name}
                        </span>
                      )}
                      {c.status === "CLOSED" && <span className="rounded-full bg-line px-1.5 py-0.5 text-[10px] text-ink-subtle">cerrada</span>}
                      {(c.assignedUserName || c.assignedTeamName) && (
                        <span className="ml-auto flex items-center gap-1 truncate text-[10px] text-ink-subtle" title="Asignada a">
                          <User size={9} /> {c.assignedUserName ?? c.assignedTeamName}
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
                className="block w-full py-2.5 text-center text-xs font-medium text-brand-700 transition-colors hover:bg-app dark:text-brand-400 dark:text-brand-300"
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
              <div className="absolute inset-0 bg-navy-950/50" onClick={() => setPanelOpen(false)} />
              <div className="relative h-full">
                <ContactPanel conversationId={selectedId} context={context} onClose={() => setPanelOpen(false)} onChanged={refreshCurrent} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Hoja de ayuda de atajos (tecla ?) */}
      <Modal open={showHelp} onClose={() => setShowHelp(false)} title="Atajos de teclado">
        <ul className="space-y-2 text-sm text-ink">
          {[
            ["/", "Buscar conversaciones"],
            ["J  ·  ↓", "Siguiente conversación"],
            ["K  ·  ↑", "Conversación anterior"],
            ["Enter", "Enviar el mensaje (en el compositor)"],
            ["Esc", "Salir del buscador / cerrar diálogo"],
            ["?", "Mostrar u ocultar esta ayuda"],
          ].map(([k, d]) => (
            <li key={k} className="flex items-center justify-between gap-4">
              <span className="text-ink-muted">{d}</span>
              <kbd className="rounded-control border border-line bg-app px-2 py-0.5 font-mono text-2xs text-ink">{k}</kbd>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
