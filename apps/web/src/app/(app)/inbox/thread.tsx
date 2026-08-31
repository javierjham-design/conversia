"use client";

/** Zona 3: cabecera con indicadores + hilo de mensajes + compositor. */
import { useEffect, useRef, useState } from "react";
import { Clock, ExternalLink, Megaphone, PanelRight, Smartphone, Trash2 } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { Button, ConfirmDialog, Modal, Select, cn, useToast } from "@/components/ui";
import { Composer } from "./composer";
import { avatarColor, displayName, initials, type ChannelInfo, type ConvContext, type ConversationFull, type Msg, type Stage } from "./types";

/**
 * Fuerza a Chromium a calcular la duración real de un OGG/Opus en streaming (las notas
 * de voz de WhatsApp): sin esto reporta duration=Infinity, la barra queda en 0:00 y a
 * veces no arranca. Truco: saltar a un tiempo enorme y volver a 0 al recibir timeupdate.
 */
function fixStreamedDuration(el: HTMLAudioElement) {
  if (el.duration !== Infinity && el.duration > 0) return;
  const onT = () => {
    el.removeEventListener("timeupdate", onT);
    if (el.duration === Infinity) return;
    el.currentTime = 0;
  };
  el.addEventListener("timeupdate", onT);
  try { el.currentTime = 1e101; } catch { el.removeEventListener("timeupdate", onT); }
}

function AudioBubble({ conversationId, messageId, transcript, outbound }: { conversationId: string; messageId: string; transcript: string | null; outbound: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);
  const [playErr, setPlayErr] = useState(false);
  async function load() {
    if (url || loading) return;
    setLoading(true);
    setErr(false);
    try {
      const res = await fetch(`/backend/conversations/${conversationId}/messages/${messageId}/audio`, {
        headers: { authorization: `Bearer ${getToken() ?? ""}` },
      });
      if (!res.ok) throw new Error();
      // Re-envolvemos con un tipo MIME limpio (sin "; codecs=…") para el <audio>.
      const raw = await res.blob();
      const type = (raw.type || "audio/ogg").split(";")[0].trim();
      setUrl(URL.createObjectURL(new Blob([raw], { type })));
    } catch {
      setErr(true);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div>
      {url ? (
        <div className="mb-1">
          <audio
            controls
            src={url}
            preload="metadata"
            className="h-9 w-56 max-w-full"
            onLoadedMetadata={(e) => fixStreamedDuration(e.currentTarget)}
            onError={() => setPlayErr(true)}
          />
          {playErr && (
            <a href={url} download="audio-cliente.ogg" className={cn("mt-0.5 block text-2xs underline", outbound ? "text-white/80" : "text-brand-700 dark:text-brand-300")}>
              Tu navegador no pudo reproducirlo — descargar el audio
            </a>
          )}
        </div>
      ) : (
        <button
          onClick={() => void load()}
          disabled={loading}
          className={cn("mb-1 flex items-center gap-1.5 rounded-control px-2 py-1 text-xs", outbound ? "bg-white/20 text-white" : "bg-app text-ink-muted")}
        >
          🎤 {loading ? "Cargando…" : err ? "No disponible" : "Escuchar audio"}
        </button>
      )}
      {transcript && <p className="whitespace-pre-wrap">{transcript}</p>}
    </div>
  );
}

/** Adjunto de documento (PDF, etc.): baja el binario de Meta (vía backend, con token) y lo
 *  abre/descarga con su nombre real. En iPhone, descargar un PDF lo abre en el visor. */
function DocumentBubble({ conversationId, messageId, filename, caption, outbound }: { conversationId: string; messageId: string; filename: string; caption: string | null; outbound: boolean }) {
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);
  async function open() {
    if (loading) return;
    setLoading(true);
    setErr(false);
    try {
      const res = await fetch(`/backend/conversations/${conversationId}/messages/${messageId}/document`, {
        headers: { authorization: `Bearer ${getToken() ?? ""}` },
      });
      if (!res.ok) throw new Error();
      const objUrl = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = filename || "documento";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objUrl), 10_000);
    } catch {
      setErr(true);
    } finally {
      setLoading(false);
    }
  }
  return (
    <div>
      <button
        onClick={() => void open()}
        disabled={loading}
        className={cn("mb-1 flex items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-xs", outbound ? "bg-white/20 text-white" : "bg-app text-ink-muted hover:bg-line/40")}
      >
        <span className="shrink-0 text-base leading-none">📄</span>
        <span className="min-w-0">
          <span className="block max-w-[13rem] truncate font-medium">{filename || "Documento"}</span>
          <span className="block text-2xs opacity-70">{loading ? "Descargando…" : err ? "No disponible" : "Toca para ver / descargar"}</span>
        </span>
      </button>
      {caption && <p className="whitespace-pre-wrap">{caption}</p>}
    </div>
  );
}

/** Miniatura de imagen del hilo: baja el binario de Meta (vía backend) con token y lo muestra. Clic → visor dentro del chat. */
function ImageBubble({ conversationId, messageId, caption, outbound, onLoaded }: { conversationId: string; messageId: string; caption: string | null; outbound: boolean; onLoaded?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [zoom, setZoom] = useState(false);
  useEffect(() => {
    let alive = true;
    let objUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(`/backend/conversations/${conversationId}/messages/${messageId}/image`, {
          headers: { authorization: `Bearer ${getToken() ?? ""}` },
        });
        if (!res.ok) throw new Error();
        objUrl = URL.createObjectURL(await res.blob());
        if (alive) setUrl(objUrl);
        else URL.revokeObjectURL(objUrl);
      } catch {
        if (alive) setErr(true);
      }
    })();
    return () => {
      alive = false;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [conversationId, messageId]);
  // Cerrar el visor con Esc
  useEffect(() => {
    if (!zoom) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoom(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);
  return (
    <div>
      {url ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={caption ?? "Imagen"}
            onClick={() => setZoom(true)}
            onLoad={() => onLoaded?.()}
            title="Ver más grande"
            className="mb-1 max-h-72 w-auto max-w-full cursor-zoom-in rounded-card"
          />
          {/* Visor dentro del chat: overlay oscuro, clic afuera o Esc para cerrar. Responsive (no se sale en el celular). */}
          {zoom && (
            <div
              onClick={() => setZoom(false)}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
              role="dialog"
              aria-modal="true"
            >
              <button
                onClick={() => setZoom(false)}
                className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-lg text-white hover:bg-white/25"
                aria-label="Cerrar"
                title="Cerrar (Esc)"
              >
                ✕
              </button>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={caption ?? "Imagen"}
                onClick={(e) => e.stopPropagation()}
                className="max-h-[90vh] max-w-[95vw] cursor-default rounded-card object-contain shadow-e3"
              />
            </div>
          )}
        </>
      ) : (
        <div className={cn("mb-1 flex h-24 w-40 items-center justify-center rounded-card text-xs", outbound ? "bg-white/15 text-white/80" : "bg-app text-ink-subtle")}>
          {err ? "🖼️ No disponible" : "🖼️ Cargando…"}
        </div>
      )}
      {caption && <p className="whitespace-pre-wrap">{caption}</p>}
    </div>
  );
}

const STATUS_TICK: Record<string, string> = { PENDING: "🕓", SENT: "✓", DELIVERED: "✓✓", READ: "✓✓", FAILED: "⚠" };

/** Etiqueta de separador de día: "Hoy" / "Ayer" / "5 de agosto". */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Hoy";
  if (same(d, yest)) return "Ayer";
  return d.toLocaleDateString("es-CL", { day: "numeric", month: "long", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}

/** Comentario interno o Resumen IA como tarjeta de nota (borde izquierdo semántico).
 *  El resumen IA se muestra plegable para no dominar el hilo. */
function NoteCard({ body, author, at }: { body: string; author: string; at: string }) {
  const isSummary = body.startsWith("📋");
  const [open, setOpen] = useState(!isSummary);
  const time = new Date(at).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
  return (
    <div className="mx-auto max-w-lg rounded-card border border-amber-200/70 border-l-[3px] border-l-amber-400 bg-amber-50/70 px-3.5 py-2 text-sm text-ink dark:border-amber-500/25 dark:border-l-amber-500/60 dark:bg-amber-500/[0.07]">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-2xs font-medium text-amber-700 dark:text-amber-300">
          {isSummary ? "📋 Resumen IA" : "🔒 Comentario interno"} · solo equipo
        </span>
        {isSummary && (
          <button onClick={() => setOpen(!open)} className="text-2xs text-amber-700 underline dark:text-amber-300">
            {open ? "Ocultar" : "Ver"}
          </button>
        )}
      </div>
      {open && <p className="mt-1 whitespace-pre-wrap text-ink">{isSummary ? body.replace(/^📋[^\n]*\n?/, "") : body}</p>}
      <p className="mt-1 text-2xs text-ink-subtle tnum">{author} · {time}</p>
    </div>
  );
}

export function Thread({
  conversation,
  messages,
  hasMore,
  onLoadFull,
  context,
  stages,
  users,
  teams,
  agents,
  workflows,
  channel,
  channels,
  onRefresh,
  onBack,
  onTogglePanel,
  panelOpen,
}: {
  conversation: ConversationFull;
  messages: Msg[];
  hasMore?: boolean;
  onLoadFull?: () => Promise<void> | void;
  context: ConvContext | null;
  stages: Stage[];
  users: { userId: string; name: string }[];
  teams: { id: string; name: string }[];
  agents: { id: string; name: string }[];
  workflows: { id: string; name: string }[];
  channel: ChannelInfo | null;
  channels: ChannelInfo[];
  onRefresh: () => void;
  onBack: () => void;
  onTogglePanel: () => void;
  panelOpen: boolean;
}) {
  const toast = useToast();
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);
  const [loadingFull, setLoadingFull] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<{ id: string; name: string; language: string; bodyText: string }[]>([]);
  const [sendingTemplate, setSendingTemplate] = useState(false);
  const [closeNote, setCloseNote] = useState<string | null>(null); // null = modal cerrado
  const [capiOffer, setCapiOffer] = useState<{ stageName: string } | null>(null);
  const [deleteConvOpen, setDeleteConvOpen] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState<Msg | null>(null);

  async function deleteConversation() {
    try {
      await api(`/conversations/${conversation.id}`, { method: "DELETE" });
      toast.push("Conversación eliminada", "ok");
      setDeleteConvOpen(false);
      onBack();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }

  async function deleteMessage(m: Msg) {
    try {
      await api(`/conversations/${conversation.id}/messages/${m.id}`, { method: "DELETE" });
      toast.push("Mensaje eliminado de TuBot", "ok");
      setDeleteMsg(null);
      onRefresh();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }

  // Baja al final del hilo usando el CONTENEDOR directo (más fiable que scrollIntoView).
  function scrollToBottom(smooth = false) {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }
  // ¿El usuario está mirando cerca del final? (si sí, seguimos pegados al último mensaje).
  function nearBottom(px = 240) {
    const el = scrollRef.current;
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < px;
  }
  // Cargar TODA la conversación (no solo los últimos 300) y llevar al inicio para leer desde el principio.
  async function handleLoadFull() {
    if (loadingFull || !onLoadFull) return;
    setLoadingFull(true);
    try {
      await onLoadFull();
      requestAnimationFrame(() => requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: 0 })));
    } finally {
      setLoadingFull(false);
    }
  }
  // Al ABRIR o CAMBIAR de conversación: siempre al último mensaje, al instante (sin flash).
  // Doble rAF: espera a que el hilo nuevo termine de pintar antes de saltar al fondo.
  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom(false)));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id]);
  // Al LLEGAR mensajes nuevos: baja solo si ya estabas abajo (no te saca de leer el historial).
  useEffect(() => {
    if (nearBottom()) scrollToBottom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length]);

  useEffect(() => {
    if (showTemplates && templates.length === 0) {
      void api<{ templates: { id: string; name: string; language: string; bodyText: string }[] }>("/channels/templates/approved")
        .then((r) => setTemplates(r.templates))
        .catch(() => setTemplates([]));
    }
  }, [showTemplates, templates.length]);

  // Ventana de 24 h con semáforo
  const lastInboundAt = messages.reduce<number | null>((acc, m) => {
    if (m.direction !== "INBOUND" || m.visibility === "INTERNAL") return acc;
    const t = new Date(m.createdAt).getTime();
    return acc === null || t > acc ? t : acc;
  }, null);
  const msLeft = lastInboundAt === null ? 0 : lastInboundAt + 24 * 3_600_000 - Date.now();
  const windowOpen = msLeft > 0;
  const windowLevel: "ok" | "warn" | "closed" = !windowOpen ? "closed" : msLeft < 6 * 3_600_000 ? "warn" : "ok";
  const windowLabel = windowOpen
    ? `Ventana 24 h abierta · quedan ${Math.floor(msLeft / 3_600_000)} h ${Math.floor((msLeft % 3_600_000) / 60_000)} m`
    : "Ventana de 24 h cerrada — solo plantillas aprobadas";

  async function setStage(statusCode: string) {
    if (!statusCode) return;
    try {
      const r = await api<{ changed: boolean; conversion: boolean; capiReady: boolean; to: string }>(`/conversations/${conversation.id}/stage`, {
        method: "POST",
        body: JSON.stringify({ statusCode }),
      });
      onRefresh();
      if (r.changed && r.conversion && r.capiReady) {
        const st = stages.find((s) => s.code === statusCode);
        setCapiOffer({ stageName: st?.name ?? statusCode });
      }
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }

  async function sendCapi() {
    try {
      await api(`/conversations/${conversation.id}/capi`, { method: "POST", body: JSON.stringify({ eventName: "Purchase" }) });
      toast.push("Evento de conversión enviado a Meta (CAPI)", "ok");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setCapiOffer(null);
    }
  }

  const act = async (path: string, body?: unknown) => {
    try {
      await api(`/conversations/${conversation.id}/${path}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });
      onRefresh();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  };

  // Si la conversación quedó SIN un canal que resuelva (p. ej. atada a uno viejo)
  // y existe UN solo canal de WhatsApp activo, asígnalo por defecto — así siempre
  // hay un canal de envío asignado y no se ve "Elegir canal…". El ref evita
  // re-disparar mientras se guarda / al recargar.
  const autoBoundRef = useRef<string | null>(null);
  useEffect(() => {
    const waChannels = channels.filter((ch) => ch.type === "WHATSAPP_CLOUD" && ch.status !== "inactive");
    const resolved = channels.some((ch) => ch.id === conversation.channelConnectionId);
    if (!resolved && waChannels.length === 1 && autoBoundRef.current !== conversation.id) {
      autoBoundRef.current = conversation.id;
      void act("channel", { channelConnectionId: waChannels[0]!.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id, conversation.channelConnectionId, channels]);

  // Selects terciarios: compactos, sin competir con la acción primaria.
  const sel = "max-w-[8.5rem] truncate text-xs";
  const closed = conversation.status === "CLOSED";
  const windowTone =
    windowLevel === "ok"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
      : windowLevel === "warn"
        ? "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300"
        : "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300";
  const windowShort = windowOpen ? `${Math.floor(msLeft / 3_600_000)} h ${Math.floor((msLeft % 3_600_000) / 60_000)} m` : "cerrada";

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      {/* ---------- Cabecera ---------- */}
      <header className="border-b border-line bg-panel px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onBack} className="text-lg text-ink-muted hover:text-ink lg:hidden" aria-label="Volver">←</button>
          {/* Zona izquierda: identidad */}
          <div className="flex min-w-0 items-center gap-2.5">
            {conversation.contact.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img referrerPolicy="no-referrer" src={conversation.contact.avatarUrl} alt="" className="h-9 w-9 shrink-0 rounded-full border border-line object-cover" />
            ) : (
              <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold", avatarColor(conversation.contact))}>
                {initials(conversation.contact).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-base font-semibold text-ink">{displayName(conversation.contact)}</h2>
                {/* Etapa como CHIP con el color de la etapa (select estilizado) */}
                <div
                  className="relative inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium"
                  style={
                    context?.stage
                      ? { backgroundColor: `${context.stage.color ?? "#94a3b8"}1f`, color: context.stage.color ?? "#64748b" }
                      : undefined
                  }
                >
                  <span className={cn("pointer-events-none flex items-center gap-1", !context?.stage && "text-ink-subtle")}>
                    {context?.stage ? `${context.stage.emoji ? `${context.stage.emoji} ` : ""}${context.stage.name}` : "— etapa —"}
                    <span className="opacity-60">▾</span>
                  </span>
                  <select
                    value={context?.stage?.code ?? ""}
                    onChange={(e) => void setStage(e.target.value)}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    title="Etapa del ciclo de vida"
                    aria-label="Etapa del ciclo de vida"
                  >
                    <option value="">— etapa —</option>
                    {stages.map((s) => (
                      <option key={s.code} value={s.code}>{s.emoji ? `${s.emoji} ` : ""}{s.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              {/* Segunda línea de contexto: teléfono · canal · ventana 24h */}
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-ink-subtle">
                <span className="tnum">{conversation.contact.phone}</span>
                {channel && (
                  <span className="inline-flex items-center gap-1" title="Canal por el que se conversa">
                    {channel.pictureUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img referrerPolicy="no-referrer" src={channel.pictureUrl} alt="" className="h-3.5 w-3.5 rounded-full border border-line object-cover" />
                    ) : (
                      <Smartphone size={11} />
                    )}{" "}
                    {channel.name}
                    {channel.displayPhone ? ` · ${channel.displayPhone}` : ""}
                    {channel.status === "error" && <span className="text-red-500">⚠ reautorizar</span>}
                  </span>
                )}
                <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium tnum", windowTone)} title={windowLabel}>
                  <Clock size={10} /> {windowShort}
                </span>
              </div>
            </div>
          </div>

          {/* Zona derecha: 1 primaria + secundaria + terciarios */}
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <div className="flex items-center gap-1 rounded-control bg-app p-0.5">
              <Select value={conversation.assignedUserId ?? ""} onChange={(e) => void act("assign", { userId: e.target.value || null })} className={sel} title="Responsable">
                <option value="">👤 Sin asignar</option>
                {users.map((u) => (
                  <option key={u.userId} value={u.userId}>👤 {u.name}</option>
                ))}
              </Select>
              {teams.length > 0 && (
                <Select value={conversation.assignedTeamId ?? ""} onChange={(e) => void act("assign", { teamId: e.target.value || null })} className={sel} title="Equipo">
                  <option value="">👥 Sin equipo</option>
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>👥 {t.name}</option>
                  ))}
                </Select>
              )}
              <Select value={conversation.activeAgentId ?? ""} onChange={(e) => void act("agent", { agentId: e.target.value || null })} className={sel} title="Agente IA a cargo">
                <option value="">🤖 Sin agente</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>🤖 {a.name}</option>
                ))}
              </Select>
              {/* Canal de envío: por cuál número sale esta conversación. Se muestra
                  cuando hay 2+ canales de WhatsApp o si el actual no resuelve (quedó
                  atada a un canal viejo). Cambiarlo re-envía por el número elegido. */}
              {(() => {
                const waChannels = channels.filter((ch) => ch.type === "WHATSAPP_CLOUD" && ch.status !== "inactive");
                const currentUnresolved = !channels.some((ch) => ch.id === conversation.channelConnectionId);
                if (waChannels.length < 2 && !(currentUnresolved && waChannels.length >= 1)) return null;
                return (
                  <Select
                    value={channels.some((ch) => ch.id === conversation.channelConnectionId) ? conversation.channelConnectionId ?? "" : ""}
                    onChange={(e) => {
                      if (e.target.value) void act("channel", { channelConnectionId: e.target.value }).then(() => toast.push("Canal de envío cambiado", "ok"));
                    }}
                    className={sel}
                    title="Canal (número de WhatsApp) por el que se envía esta conversación"
                  >
                    <option value="">📱 Elegir canal…</option>
                    {waChannels.map((ch) => (
                      <option key={ch.id} value={ch.id}>📱 {ch.name}{ch.displayPhone ? ` · ${ch.displayPhone}` : ""}{ch.status === "error" ? " ⚠" : ""}</option>
                    ))}
                  </Select>
                );
              })()}
              {workflows.length > 0 && (
                <Select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) {
                      void act("run-workflow", { workflowId: e.target.value }).then(() => toast.push("Flujo ejecutado", "ok"));
                    }
                  }}
                  className={sel}
                  title="Ejecutar un flujo"
                >
                  <option value="">⚡ Flujo…</option>
                  {workflows.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </Select>
              )}
            </div>
            {/* Acción primaria única */}
            <button
              onClick={() => void act(conversation.aiEnabled ? "takeover" : "release")}
              className={cn(
                "rounded-control px-3 py-1.5 text-xs font-semibold shadow-e1 transition-colors",
                conversation.aiEnabled ? "bg-brand-600 text-white hover:bg-brand-700" : "border border-brand-300 bg-brand-soft text-brand-700 hover:bg-brand-100 dark:border-brand-500/40 dark:text-brand-300",
              )}
            >
              {conversation.aiEnabled ? "Tomar control" : "Devolver a IA"}
            </button>
            {/* Secundaria */}
            {closed ? (
              <button onClick={() => void act("reopen")} className="rounded-control border border-line-strong px-2.5 py-1.5 text-xs text-ink transition-colors hover:bg-app">Reabrir</button>
            ) : (
              <button onClick={() => setCloseNote("")} className="rounded-control border border-line-strong px-2.5 py-1.5 text-xs text-ink transition-colors hover:bg-app">Cerrar</button>
            )}
            <button
              onClick={() => setDeleteConvOpen(true)}
              className="rounded-control border border-line-strong p-1.5 text-ink-muted transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10"
              title="Eliminar conversación"
              aria-label="Eliminar conversación"
            >
              <Trash2 size={14} />
            </button>
            <button onClick={onTogglePanel} className={cn("rounded-control border p-1.5 transition-colors", panelOpen ? "border-brand-300 bg-brand-soft text-brand-700 dark:border-brand-500/40 dark:text-brand-300" : "border-line-strong text-ink-muted hover:bg-app")} title="Panel del contacto">
              <PanelRight size={14} />
            </button>
          </div>
        </div>
      </header>

      {/* ---------- Hilo ---------- */}
      <div className="relative flex-1 overflow-hidden bg-app">
        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 240);
          }}
          className="h-full space-y-2 overflow-y-auto p-4"
        >
        {/* Cargar el historial completo (por defecto se muestran los últimos 300) */}
        {hasMore && (
          <div className="flex justify-center pb-1">
            <button
              onClick={() => void handleLoadFull()}
              disabled={loadingFull}
              className="rounded-full border border-line bg-raised px-3 py-1 text-xs text-ink-muted shadow-e1 transition-colors hover:text-ink disabled:opacity-50"
            >
              {loadingFull ? "Cargando…" : "↑ Ver mensajes anteriores"}
            </button>
          </div>
        )}
        {/* Banner de origen por anuncio CTWA */}
        {context?.ad && (
          <div className="mx-auto max-w-lg rounded-card border-l-[3px] border-violet-400 bg-raised p-3 text-xs text-ink shadow-e1 dark:border-violet-500">
            <p className="flex items-center gap-1.5 font-medium text-violet-700 dark:text-violet-300"><Megaphone size={13} /> Conversación iniciada desde un anuncio</p>
            {context.ad.headline && <p className="mt-1 text-ink-muted">«{context.ad.headline}»</p>}
            <div className="mt-1.5 flex items-center gap-3">
              {context.ad.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img referrerPolicy="no-referrer" src={context.ad.imageUrl} alt="Anuncio" className="max-h-16 rounded-control object-cover" />
              )}
              <div className="min-w-0 text-2xs text-ink-subtle">
                {context.ad.ctwaClid && <p className="truncate">ctwa_clid: {context.ad.ctwaClid}</p>}
                {context.ad.sourceUrl && (
                  <a href={context.ad.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-violet-600 underline dark:text-violet-300 ">
                    Ver anuncio <ExternalLink size={10} />
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
        {context?.leadForm && (
          <div className="mx-auto max-w-lg rounded-card border-l-[3px] border-sky-400 bg-raised p-3 text-xs text-ink shadow-e1 dark:border-sky-500">
            <p className="font-medium text-sky-700 dark:text-sky-300">📋 Llegó desde un formulario de Meta</p>
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-ink-muted">
              {context.leadForm.fields.slice(0, 8).map(([k, v]) => (
                <div key={k} className="flex gap-1">
                  <dt className="shrink-0 text-ink-subtle">{k}:</dt>
                  <dd className="truncate">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {(() => {
          let lastDay = "";
          return messages.map((m) => {
            const dl = dayLabel(m.createdAt);
            const sep =
              dl !== lastDay ? (
                <div key={`sep-${m.id}`} className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-line" />
                  <span className="text-2xs font-medium text-ink-subtle">{dl}</span>
                  <span className="h-px flex-1 bg-line" />
                </div>
              ) : null;
            lastDay = dl;

            // Eventos del sistema: línea centrada fina con icono
            if (m.type === "SYSTEM") {
              return (
                <div key={m.id}>
                  {sep}
                  <div className="flex justify-center py-0.5">
                    <span className="text-2xs text-ink-subtle">
                      {m.body} · {new Date(m.createdAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                </div>
              );
            }
            // Comentarios internos / Resumen IA: tarjeta de nota (no bloque amarillo)
            if (m.visibility === "INTERNAL" || m.type === "NOTE") {
              return (
                <div key={m.id}>
                  {sep}
                  <NoteCard body={m.body ?? ""} author={m.authorName ?? (m.authorType === "AGENT" ? "IA" : "equipo")} at={m.createdAt} />
                </div>
              );
            }
            const outbound = m.direction === "OUTBOUND";
            const payload = (m.payload ?? {}) as Record<string, any>;
            const failed = m.status === "FAILED";
            return (
              <div key={m.id}>
                {sep}
                <div className={cn("group flex items-center gap-1.5", outbound ? "justify-end" : "justify-start")}>
                  {outbound && (
                    <button
                      onClick={() => setDeleteMsg(m)}
                      className="rounded p-1 text-ink-subtle opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                      title="Eliminar mensaje (solo de TuBot)"
                      aria-label="Eliminar mensaje"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                  <div
                    className={cn(
                      "max-w-[62ch] rounded-bubble px-3.5 py-2 text-sm shadow-e1",
                      outbound
                        ? cn("rounded-br-md text-white", failed ? "bg-red-500" : "bg-brand-600")
                        : "rounded-bl-md border border-line bg-raised text-ink",
                    )}
                  >
                    {m.type === "AUDIO" ? (
                      <AudioBubble conversationId={conversation.id} messageId={m.id} transcript={m.body} outbound={outbound} />
                    ) : m.type === "IMAGE" ? (
                      <ImageBubble
                        conversationId={conversation.id}
                        messageId={m.id}
                        caption={payload.caption ?? payload.image?.caption ?? (m.body && !/^\[.*\]$/.test(m.body) && m.body !== "📷 Imagen" ? m.body : null)}
                        outbound={outbound}
                        onLoaded={() => { if (nearBottom(400)) scrollToBottom(false); }}
                      />
                    ) : m.type === "DOCUMENT" ? (
                      <DocumentBubble
                        conversationId={conversation.id}
                        messageId={m.id}
                        filename={payload.document?.filename ?? payload.filename ?? "Documento"}
                        caption={payload.document?.caption ?? (m.body && !/^\[.*\]$/.test(m.body) ? m.body : null)}
                        outbound={outbound}
                      />
                    ) : m.type === "TEMPLATE" ? (
                      <div>
                        <p className="mb-0.5 text-2xs opacity-70">📄 Plantilla {payload.templateName ?? ""}</p>
                        <p className="whitespace-pre-wrap">{m.body}</p>
                      </div>
                    ) : (
                      <p className="whitespace-pre-wrap">{m.body}</p>
                    )}
                    <p className={cn("mt-1 flex items-center gap-1 text-2xs tnum", outbound ? "text-white/70" : "text-ink-subtle")}>
                      {outbound ? (m.authorType === "AGENT" ? "🤖 IA" : m.authorName ?? "equipo") : displayName(conversation.contact)} ·{" "}
                      {new Date(m.createdAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}
                      {outbound && <span title={m.status.toLowerCase()}>{STATUS_TICK[m.status] ?? ""}</span>}
                    </p>
                    {failed && (
                      <p className="mt-1 rounded bg-white/20 px-1.5 py-1 text-2xs font-medium leading-snug text-white">
                        ⚠ No entregado{m.error ? `: ${String(m.error)}` : " — motivo no disponible (reenvía para ver el detalle de Meta)"}
                      </p>
                    )}
                  </div>
                  {!outbound && (
                    <button
                      onClick={() => setDeleteMsg(m)}
                      className="rounded p-1 text-ink-subtle opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-100"
                      title="Eliminar mensaje (solo de TuBot)"
                      aria-label="Eliminar mensaje"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            );
          });
        })()}
        <div ref={bottomRef} />
        </div>
        {/* Botón flotante: ir al último mensaje */}
        {showJump && (
          <button
            onClick={() => scrollToBottom(true)}
            className="absolute bottom-4 right-4 flex h-9 w-9 items-center justify-center rounded-full border border-line bg-raised text-ink-muted shadow-e2 transition-colors hover:text-ink"
            title="Ir al último mensaje"
            aria-label="Ir al último mensaje"
          >
            ↓
          </button>
        )}
      </div>

      {/* ---------- Compositor ---------- */}
      <Composer
        conversation={conversation}
        windowOpen={windowOpen}
        windowLabel={windowLabel}
        windowLevel={windowLevel}
        onSent={onRefresh}
        onOpenTemplates={() => setShowTemplates(true)}
      />

      {/* Modal de plantillas (ventana cerrada) */}
      <Modal open={showTemplates} onClose={() => setShowTemplates(false)} title="Enviar plantilla">
        <p className="mb-3 text-xs text-ink-muted">
          Las variables se completan con los datos del contacto. Las plantillas aprobadas funcionan aunque la ventana de 24 h esté cerrada.
        </p>
        {templates.length === 0 ? (
          <p className="rounded-control bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            No hay plantillas aprobadas. Créalas o sincronízalas en <a href="/channels" className="underline">Canales → Plantillas</a>.
          </p>
        ) : (
          <div className="space-y-2">
            {templates.map((t) => (
              <button
                key={t.id}
                disabled={sendingTemplate}
                onClick={() => {
                  setSendingTemplate(true);
                  void api(`/conversations/${conversation.id}/send-template`, { method: "POST", body: JSON.stringify({ templateId: t.id }) })
                    .then(() => {
                      setShowTemplates(false);
                      onRefresh();
                    })
                    .catch((err) => toast.push((err as Error).message, "error"))
                    .finally(() => setSendingTemplate(false));
                }}
                className="block w-full rounded-control border border-line p-3 text-left transition-colors hover:border-brand-400 hover:bg-brand-soft disabled:opacity-50"
              >
                <p className="font-mono text-xs font-medium text-ink">{t.name} · {t.language}</p>
                <p className="mt-1 text-xs text-ink-muted">{t.bodyText.slice(0, 140)}{t.bodyText.length > 140 ? "…" : ""}</p>
              </button>
            ))}
          </div>
        )}
      </Modal>

      {/* Eliminar conversación */}
      <ConfirmDialog
        open={deleteConvOpen}
        onClose={() => setDeleteConvOpen(false)}
        onConfirm={() => void deleteConversation()}
        title="¿Eliminar esta conversación?"
        description="Se borra TODO el historial de mensajes de TuBot (no se puede deshacer). El contacto, sus leads y citas se conservan. Ojo: esto no borra el chat del teléfono del cliente."
        confirmLabel="Eliminar conversación"
        danger
      />

      {/* Eliminar mensaje */}
      <ConfirmDialog
        open={deleteMsg !== null}
        onClose={() => setDeleteMsg(null)}
        onConfirm={() => deleteMsg && void deleteMessage(deleteMsg)}
        title="¿Eliminar este mensaje?"
        description={`Se elimina solo del historial de TuBot — el cliente lo sigue viendo en su chat. «${(deleteMsg?.body ?? "").slice(0, 80)}»`}
        confirmLabel="Eliminar mensaje"
        danger
      />

      {/* Cerrar con nota opcional */}
      <Modal open={closeNote !== null} onClose={() => setCloseNote(null)} title="Cerrar conversación">
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Nota de cierre (opcional, queda como comentario interno)</span>
          <textarea value={closeNote ?? ""} onChange={(e) => setCloseNote(e.target.value)} rows={3} className="mt-1 w-full rounded-control border border-line-strong bg-panel px-3 py-2 text-sm text-ink" placeholder="p. ej. Agendó limpieza para el martes; quedó de confirmar la hora" />
        </label>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setCloseNote(null)}>Cancelar</Button>
          <Button
            onClick={() => {
              void act("close", closeNote?.trim() ? { note: closeNote.trim() } : undefined);
              setCloseNote(null);
            }}
          >
            Cerrar conversación
          </Button>
        </div>
      </Modal>

      {/* Oferta de envío CAPI al marcar etapa de conversión */}
      <Modal open={capiOffer !== null} onClose={() => setCapiOffer(null)} title="¿Reportar la conversión a Meta?">
        <p className="text-sm text-ink-muted">
          Marcaste la etapa <b>{capiOffer?.stageName}</b> (conversión). ¿Quieres enviar el evento <b>Purchase</b> a Meta
          Conversions API para optimizar tus campañas?
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setCapiOffer(null)}>Ahora no</Button>
          <Button onClick={() => void sendCapi()}>Enviar evento CAPI</Button>
        </div>
      </Modal>
    </section>
  );
}
