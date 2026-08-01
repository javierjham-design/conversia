"use client";

/** Zona 3: cabecera con indicadores + hilo de mensajes + compositor. */
import { useEffect, useRef, useState } from "react";
import { ExternalLink, Megaphone, PanelRight } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { Button, Modal, cn, useToast } from "@/components/ui";
import { Composer } from "./composer";
import { displayName, type ChannelInfo, type ConvContext, type ConversationFull, type Msg, type Stage } from "./types";

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

const STATUS_TICK: Record<string, string> = { PENDING: "🕓", SENT: "✓", DELIVERED: "✓✓", READ: "✓✓", FAILED: "⚠" };

export function Thread({
  conversation,
  messages,
  context,
  stages,
  users,
  teams,
  agents,
  workflows,
  channel,
  onRefresh,
  onBack,
  onTogglePanel,
  panelOpen,
}: {
  conversation: ConversationFull;
  messages: Msg[];
  context: ConvContext | null;
  stages: Stage[];
  users: { userId: string; name: string }[];
  teams: { id: string; name: string }[];
  agents: { id: string; name: string }[];
  workflows: { id: string; name: string }[];
  channel: ChannelInfo | null;
  onRefresh: () => void;
  onBack: () => void;
  onTogglePanel: () => void;
  panelOpen: boolean;
}) {
  const toast = useToast();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<{ id: string; name: string; language: string; bodyText: string }[]>([]);
  const [sendingTemplate, setSendingTemplate] = useState(false);
  const [closeNote, setCloseNote] = useState<string | null>(null); // null = modal cerrado
  const [capiOffer, setCapiOffer] = useState<{ stageName: string } | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
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

  const sel = "rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs";
  const closed = conversation.status === "CLOSED";

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      {/* ---------- Cabecera ---------- */}
      <header className="border-b border-slate-200 bg-white px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onBack} className="text-lg text-slate-500 hover:text-slate-800 lg:hidden" aria-label="Volver">←</button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-medium">{displayName(conversation.contact)}</h2>
              {/* Selector de etapa del ciclo de vida, editable aquí mismo */}
              <select
                value={context?.stage?.code ?? ""}
                onChange={(e) => void setStage(e.target.value)}
                className="rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium"
                style={context?.stage?.color ? { borderColor: context.stage.color, color: context.stage.color } : {}}
                title="Etapa del ciclo de vida"
              >
                <option value="">— etapa —</option>
                {stages.map((s) => (
                  <option key={s.code} value={s.code}>{s.name}</option>
                ))}
              </select>
            </div>
            <p className="truncate text-[11px] text-slate-400">
              {conversation.contact.phone}
              {channel && (
                <span title="Número por el que se conversa">
                  {" "}· 📱 {channel.name}
                  {channel.displayPhone ? ` (${channel.displayPhone})` : ""}
                  {channel.status === "error" && <span className="text-red-500"> ⚠ reautorizar</span>}
                </span>
              )}
            </p>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <select value={conversation.assignedUserId ?? ""} onChange={(e) => void act("assign", { userId: e.target.value || null })} className={sel} title="Responsable">
              <option value="">👤 Sin asignar</option>
              {users.map((u) => (
                <option key={u.userId} value={u.userId}>👤 {u.name}</option>
              ))}
            </select>
            {teams.length > 0 && (
              <select value={conversation.assignedTeamId ?? ""} onChange={(e) => void act("assign", { teamId: e.target.value || null })} className={sel} title="Equipo">
                <option value="">👥 Sin equipo</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>👥 {t.name}</option>
                ))}
              </select>
            )}
            <select value={conversation.activeAgentId ?? ""} onChange={(e) => void act("agent", { agentId: e.target.value || null })} className={sel} title="Agente IA a cargo">
              <option value="">🤖 Sin agente</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>🤖 {a.name}</option>
              ))}
            </select>
            {workflows.length > 0 && (
              <select
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
              </select>
            )}
            <button
              onClick={() => void act(conversation.aiEnabled ? "takeover" : "release")}
              className={cn(
                "rounded-lg px-2.5 py-1.5 text-xs font-medium",
                conversation.aiEnabled ? "bg-amber-100 text-amber-800 hover:bg-amber-200" : "bg-cyan-100 text-cyan-800 hover:bg-cyan-200",
              )}
            >
              {conversation.aiEnabled ? "Tomar control" : "Devolver a IA"}
            </button>
            {closed ? (
              <button onClick={() => void act("reopen")} className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs hover:bg-slate-50">Reabrir</button>
            ) : (
              <button onClick={() => setCloseNote("")} className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs hover:bg-slate-50">Cerrar</button>
            )}
            <button onClick={onTogglePanel} className={cn("rounded-lg border px-2 py-1.5", panelOpen ? "border-cyan-300 bg-cyan-50 text-cyan-700" : "border-slate-300 text-slate-500 hover:bg-slate-50")} title="Panel del contacto">
              <PanelRight size={14} />
            </button>
          </div>
        </div>
      </header>

      {/* ---------- Hilo ---------- */}
      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {/* Banner de origen por anuncio CTWA */}
        {context?.ad && (
          <div className="mx-auto max-w-lg rounded-xl border border-violet-200 bg-violet-50 p-3 text-xs text-violet-800">
            <p className="flex items-center gap-1.5 font-medium"><Megaphone size={13} /> Conversación iniciada desde un anuncio</p>
            {context.ad.headline && <p className="mt-1">«{context.ad.headline}»</p>}
            <div className="mt-1 flex items-center gap-3">
              {context.ad.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={context.ad.imageUrl} alt="Anuncio" className="max-h-16 rounded-lg object-cover" />
              )}
              <div className="min-w-0 text-[10px] text-violet-500">
                {context.ad.ctwaClid && <p className="truncate">ctwa_clid: {context.ad.ctwaClid}</p>}
                {context.ad.sourceUrl && (
                  <a href={context.ad.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
                    Ver anuncio <ExternalLink size={10} />
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
        {context?.leadForm && (
          <div className="mx-auto max-w-lg rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800">
            <p className="font-medium">📋 Llegó desde un formulario de Meta</p>
            <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
              {context.leadForm.fields.slice(0, 8).map(([k, v]) => (
                <div key={k} className="flex gap-1">
                  <dt className="shrink-0 text-sky-500">{k}:</dt>
                  <dd className="truncate">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {messages.map((m) => {
          // Eventos del sistema: línea centrada con estilo propio
          if (m.type === "SYSTEM") {
            return (
              <div key={m.id} className="flex justify-center">
                <span className="rounded-full bg-slate-100 px-3 py-1 text-[10px] text-slate-500">
                  {m.body} · {new Date(m.createdAt).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
            );
          }
          // Comentarios internos: burbuja amarilla solo-equipo
          if (m.visibility === "INTERNAL" || m.type === "NOTE") {
            return (
              <div key={m.id} className="flex justify-center">
                <div className="max-w-md rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
                  <p className="whitespace-pre-wrap">{m.body}</p>
                  <p className="mt-1 text-[10px] text-amber-600">
                    🔒 Solo equipo · {m.authorName ?? (m.authorType === "AGENT" ? "IA" : "equipo")} ·{" "}
                    {new Date(m.createdAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              </div>
            );
          }
          const outbound = m.direction === "OUTBOUND";
          const payload = (m.payload ?? {}) as Record<string, any>;
          return (
            <div key={m.id} className={`flex ${outbound ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-md rounded-2xl px-4 py-2 text-sm ${outbound ? "bg-cyan-700 text-white" : "border border-slate-200 bg-white"}`}>
                {m.type === "AUDIO" ? (
                  <AudioBubble conversationId={conversation.id} messageId={m.id} transcript={m.body} outbound={outbound} />
                ) : m.type === "IMAGE" ? (
                  <p className="whitespace-pre-wrap">📷 {payload.caption ?? m.body ?? "Imagen"}</p>
                ) : m.type === "DOCUMENT" ? (
                  <p className="whitespace-pre-wrap">📎 {payload.filename ?? m.body ?? "Documento"}</p>
                ) : m.type === "TEMPLATE" ? (
                  <div>
                    <p className="mb-0.5 text-[10px] opacity-70">📄 Plantilla {payload.templateName ?? ""}</p>
                    <p className="whitespace-pre-wrap">{m.body}</p>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap">{m.body}</p>
                )}
                <p className={`mt-1 text-[10px] ${outbound ? "text-cyan-200" : "text-slate-400"}`}>
                  {outbound ? (m.authorType === "AGENT" ? "🤖 IA" : m.authorName ?? "equipo") : displayName(conversation.contact)} ·{" "}
                  {new Date(m.createdAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}
                  {outbound && <span title={m.status.toLowerCase()}> {STATUS_TICK[m.status] ?? ""}</span>}
                  {m.status === "FAILED" && m.error ? <span className="text-red-300"> {String(m.error).slice(0, 60)}</span> : null}
                </p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
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
        <p className="mb-3 text-xs text-slate-500">
          Las variables se completan con los datos del contacto. Las plantillas aprobadas funcionan aunque la ventana de 24 h esté cerrada.
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
                className="block w-full rounded-lg border border-slate-200 p-3 text-left hover:border-cyan-400 hover:bg-cyan-50 disabled:opacity-50"
              >
                <p className="font-mono text-xs font-medium">{t.name} · {t.language}</p>
                <p className="mt-1 text-xs text-slate-500">{t.bodyText.slice(0, 140)}{t.bodyText.length > 140 ? "…" : ""}</p>
              </button>
            ))}
          </div>
        )}
      </Modal>

      {/* Cerrar con nota opcional */}
      <Modal open={closeNote !== null} onClose={() => setCloseNote(null)} title="Cerrar conversación">
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Nota de cierre (opcional, queda como comentario interno)</span>
          <textarea value={closeNote ?? ""} onChange={(e) => setCloseNote(e.target.value)} rows={3} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="p. ej. Agendó limpieza para el martes; quedó de confirmar la hora" />
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
        <p className="text-sm text-slate-600">
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
