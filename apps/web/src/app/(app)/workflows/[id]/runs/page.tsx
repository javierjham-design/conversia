"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AlertTriangle, ArrowLeft, CheckCircle2, Clock, RefreshCw, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { Button, DateInput, Modal, Select, cn, useToast } from "@/components/ui";

// Etiquetas legibles por tipo de paso (para el historial y el canvas de recorrido).
// Fuente puente hasta consolidar el catálogo en el Bloque 6.
const NODE_LABEL: Record<string, string> = {
  send_text: "Enviar mensaje", send_template: "Enviar plantilla", run_agent: "Ejecutar agente IA",
  switch_agent: "Cambiar agente IA", ai_objective: "Agente con objetivo", update_lead_status: "Cambiar etapa",
  add_tag: "Agregar etiqueta", remove_tag: "Quitar etiqueta", update_contact: "Actualizar contacto",
  assign_user: "Asignar a usuario", assign_team: "Asignar a equipo", add_note: "Comentario interno",
  open_conversation: "Abrir conversación", close_conversation: "Cerrar conversación", transfer_human: "Escalar a humano",
  wait: "Esperar", wait_reply: "¿Respondió?", condition: "¿Sigue sin responder?", business_hours: "Fecha y hora",
  goto: "Saltar a paso", start_workflow: "Disparar flujo", stop: "Terminar", send_capi: "Evento CAPI",
  send_ga4_event: "Evento GA4", send_tiktok_event: "Evento TikTok", call_api: "Petición HTTP",
  send_internal_email: "Correo interno", google_sheets_append: "Google Sheets", pause_ai: "Pausar IA", resume_ai: "Reanudar IA",
};
const nodeLabel = (t: string) => NODE_LABEL[t] ?? t;

const RUN_STATUS: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
  COMPLETED: { label: "Completada", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300", icon: <CheckCircle2 size={13} /> },
  FAILED: { label: "Con error", cls: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300", icon: <XCircle size={13} /> },
  WAITING: { label: "En espera", cls: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300", icon: <Clock size={13} /> },
  RUNNING: { label: "En curso", cls: "bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300", icon: <Clock size={13} /> },
  CANCELLED: { label: "Cancelada", cls: "bg-app text-ink-subtle", icon: <XCircle size={13} /> },
};
const STEP_STATUS: Record<string, string> = { COMPLETED: "bg-emerald-500", FAILED: "bg-red-500", RUNNING: "bg-brand-500", SKIPPED: "bg-slate-300 dark:bg-slate-600", PENDING: "bg-slate-300 dark:bg-slate-600" };

function fmtDate(s: string) { return new Date(s).toLocaleString("es-CL", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); }
function fmtDur(ms: number | null) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

interface RunRow { id: string; status: string; startedAt: string; finishedAt: string | null; durationMs: number | null; error: string | null; contact: { id: string; name: string; phone: string | null } | null; triggerLabel: string; stepCount: number; path: string[] }
interface Metrics { periodDays: number; total: number; byStatus: Record<string, number>; completionRate: number | null; avgDurationMs: number | null; dropoffNodeId: string | null; dropoffNodeType: string | null; dropoffCount: number; conversions: number }
interface RunDetail {
  run: { id: string; status: string; startedAt: string; finishedAt: string | null; durationMs: number | null; error: string | null; currentNodeId: string | null; variables: Record<string, string>; triggerLabel: string };
  contact: { id: string; name: string; phone: string | null } | null;
  definition: any;
  steps: { nodeId: string; nodeType: string; status: string; attempt: number; error: string | null; startedAt: string; finishedAt: string | null; durationMs: number | null; output: any }[];
  path: string[];
}
interface RetryPreview { canRetry: boolean; fromNodeType: string | null; templateSends: number; templates: { name: string; category: string; weight: number }[]; estimatedDebit: number; walletBalance: number; wouldExceed: boolean }

// ── Canvas de recorrido (solo lectura): nodos por estado + camino resaltado ──
function RunNode({ data }: NodeProps) {
  const d = data as { label: string; state: "done" | "failed" | "idle" };
  const cls = d.state === "failed" ? "border-red-400 bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"
    : d.state === "done" ? "border-brand-400 bg-brand-soft text-ink"
    : "border-line bg-panel text-ink-subtle opacity-60";
  return (
    <div className={cn("rounded-lg border px-3 py-1.5 text-[11px] font-medium shadow-e1", cls)}>
      <Handle type="target" position={Position.Top} className="!h-1.5 !w-1.5 !bg-line-strong" />
      {d.label}
      <Handle type="source" position={Position.Bottom} className="!h-1.5 !w-1.5 !bg-line-strong" />
    </div>
  );
}
const runNodeTypes = { runNode: RunNode };

function RunFlow({ detail }: { detail: RunDetail }) {
  const visited = useMemo(() => new Set(detail.path), [detail.path]);
  const traversed = useMemo(() => {
    const s = new Set<string>();
    for (let i = 0; i < detail.path.length - 1; i++) s.add(`${detail.path[i]}->${detail.path[i + 1]}`);
    return s;
  }, [detail.path]);
  const nodes: Node[] = (detail.definition?.nodes ?? []).map((n: any, i: number) => ({
    id: n.id,
    type: "runNode",
    position: n.position ?? { x: 250, y: 120 + i * 90 },
    data: { label: nodeLabel(n.type), state: n.id === detail.run.currentNodeId && detail.run.status === "FAILED" ? "failed" : visited.has(n.id) ? "done" : "idle" },
    draggable: false,
    selectable: false,
  }));
  const edges: Edge[] = (detail.definition?.edges ?? []).map((e: any, i: number) => {
    const on = traversed.has(`${e.from}->${e.to}`);
    return { id: `e${i}`, source: e.from, target: e.to, animated: on, style: { stroke: on ? "#2563eb" : "#cbd5e1", strokeWidth: on ? 2 : 1 }, label: e.when === "true" || e.when === "no_reply" ? "No" : e.when === "false" || e.when === "replied" ? "Sí" : e.when };
  });
  return (
    <div className="h-[340px] rounded-lg border border-line bg-app">
      <ReactFlowProvider>
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={runNodeTypes} fitView proOptions={{ hideAttribution: true }} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}>
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#cbd5e1" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

export default function WorkflowRunsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [status, setStatus] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryPreview, setRetryPreview] = useState<RetryPreview | null>(null);

  const load = useCallback(async () => {
    const qs = new URLSearchParams();
    if (status) qs.set("status", status);
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const [wf, m, r] = await Promise.all([
      api<{ name: string }>(`/workflows/${id}`),
      api<Metrics>(`/workflows/${id}/metrics`),
      api<{ runs: RunRow[] }>(`/workflows/${id}/runs?${qs.toString()}`),
    ]);
    setName(wf.name);
    setMetrics(m);
    setRuns(r.runs);
  }, [id, status, from, to]);

  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, from, to]);

  async function openDetail(runId: string) {
    try {
      setDetail(await api<RunDetail>(`/workflows/${id}/runs/${runId}`));
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }

  async function openRetry() {
    if (!detail) return;
    try {
      setRetryPreview(await api<RetryPreview>(`/workflows/${id}/runs/${detail.run.id}/retry-preview`));
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }

  async function retry() {
    if (!detail) return;
    setRetrying(true);
    try {
      await api(`/workflows/${id}/runs/${detail.run.id}/retry`, { method: "POST" });
      toast.push("Reintento encolado — se ejecuta en segundos.", "ok");
      setRetryPreview(null);
      setDetail(null);
      setTimeout(() => void load(), 1500);
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setRetrying(false);
    }
  }

  return (
    <div className="mx-auto flex h-full max-w-[1100px] flex-col px-6 py-5">
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => router.push(`/workflows/${id}`)} className="rounded-lg p-1.5 text-ink-subtle hover:bg-app" title="Volver al editor"><ArrowLeft size={18} /></button>
        <div>
          <h1 className="text-base font-semibold text-ink">Ejecuciones — {name}</h1>
          <p className="text-xs text-ink-subtle">Historial real de corridas del flujo. Responde “¿por qué no se ejecutó?” con datos.</p>
        </div>
      </div>

      {/* Métricas */}
      {metrics && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: `Ejecuciones (${metrics.periodDays}d)`, value: metrics.total },
            { label: "Tasa de finalización", value: metrics.completionRate == null ? "—" : `${metrics.completionRate}%` },
            { label: "Con error", value: metrics.byStatus.FAILED ?? 0 },
            { label: "Duración media", value: fmtDur(metrics.avgDurationMs) },
            { label: "Conversiones (CAPI)", value: metrics.conversions },
          ].map((c) => (
            <div key={c.label} className="rounded-card border border-line bg-panel p-3">
              <p className="text-lg font-semibold text-ink">{c.value}</p>
              <p className="text-[11px] text-ink-subtle">{c.label}</p>
            </div>
          ))}
          {metrics.dropoffNodeId && (
            <div className="col-span-2 rounded-card border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300 sm:col-span-5">
              <AlertTriangle size={13} className="mr-1 inline" /> El paso donde más se cae es <b>{nodeLabel(metrics.dropoffNodeType ?? "")}</b> ({metrics.dropoffCount} fallo{metrics.dropoffCount > 1 ? "s" : ""}).
            </div>
          )}
        </div>
      )}

      {/* Filtros */}
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-ink-muted">Estado
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="mt-1 block">
            <option value="">Todas</option>
            <option value="errors">Solo con error</option>
            <option value="COMPLETED">Completadas</option>
            <option value="WAITING">En espera</option>
            <option value="CANCELLED">Canceladas</option>
          </Select>
        </label>
        <label className="text-xs text-ink-muted">Desde
          <DateInput value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 block" />
        </label>
        <label className="text-xs text-ink-muted">Hasta
          <DateInput value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 block" />
        </label>
        {(status || from || to) && <button onClick={() => { setStatus(""); setFrom(""); setTo(""); }} className="pb-2 text-xs text-ink-subtle underline hover:text-ink">Limpiar</button>}
      </div>

      {/* Tabla */}
      <div className="min-h-0 flex-1 overflow-auto rounded-card border border-line bg-panel">
        {!runs ? (
          <p className="p-6 text-sm text-ink-subtle">Cargando…</p>
        ) : runs.length === 0 ? (
          <p className="p-6 text-sm text-ink-subtle">Sin ejecuciones para este filtro. Cuando el flujo se dispare, aquí verás cada corrida.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-app text-[11px] uppercase text-ink-subtle">
              <tr><th className="px-3 py-2">Fecha</th><th className="px-3 py-2">Contacto</th><th className="px-3 py-2">Disparador</th><th className="px-3 py-2">Pasos</th><th className="px-3 py-2">Duración</th><th className="px-3 py-2">Resultado</th></tr>
            </thead>
            <tbody>
              {runs.map((r) => {
                const st = RUN_STATUS[r.status] ?? RUN_STATUS.CANCELLED;
                return (
                  <tr key={r.id} onClick={() => void openDetail(r.id)} className="cursor-pointer border-t border-line hover:bg-app">
                    <td className="px-3 py-2 text-ink-muted">{fmtDate(r.startedAt)}</td>
                    <td className="px-3 py-2 text-ink">{r.contact?.name ?? <span className="text-ink-subtle">—</span>}</td>
                    <td className="px-3 py-2 text-ink-muted">{r.triggerLabel}</td>
                    <td className="px-3 py-2 text-ink-subtle">{r.stepCount}</td>
                    <td className="px-3 py-2 text-ink-subtle">{fmtDur(r.durationMs)}</td>
                    <td className="px-3 py-2"><span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]", st.cls)}>{st.icon}{st.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Detalle de una ejecución */}
      <Modal open={!!detail} onClose={() => setDetail(null)} title="Detalle de la ejecución" wide>
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 text-xs text-ink-muted">
              <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5", (RUN_STATUS[detail.run.status] ?? RUN_STATUS.CANCELLED).cls)}>{(RUN_STATUS[detail.run.status] ?? RUN_STATUS.CANCELLED).icon}{(RUN_STATUS[detail.run.status] ?? RUN_STATUS.CANCELLED).label}</span>
              <span>Disparador: <b className="text-ink">{detail.run.triggerLabel}</b></span>
              {detail.contact && <span>Contacto: <b className="text-ink">{detail.contact.name}</b></span>}
              <span>Inicio: {fmtDate(detail.run.startedAt)}</span>
              <span>Duración: {fmtDur(detail.run.durationMs)}</span>
              {detail.run.status === "FAILED" && (
                <Button variant="secondary" disabled={retrying} onClick={() => void openRetry()}><RefreshCw size={14} className="mr-1" /> Reintentar desde el paso que falló</Button>
              )}
            </div>
            {detail.run.error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">⚠ {detail.run.error}</p>}

            {/* Recorrido dibujado */}
            {detail.definition && <RunFlow detail={detail} />}

            {/* Pasos */}
            <div>
              <p className="mb-1 text-sm font-medium text-ink">Pasos ejecutados</p>
              <ol className="space-y-1.5">
                {detail.steps.map((s, i) => (
                  <li key={i} className="flex items-start gap-2 rounded-lg border border-line p-2 text-xs">
                    <span className={cn("mt-1 inline-block h-2 w-2 shrink-0 rounded-full", STEP_STATUS[s.status] ?? "bg-slate-300 dark:bg-slate-600")} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink">{nodeLabel(s.nodeType)} <span className="font-normal text-ink-subtle">· {fmtDur(s.durationMs)}{s.attempt > 1 ? ` · intento ${s.attempt}` : ""}</span></p>
                      {s.error && <p className="text-red-600 dark:text-red-400">{s.error}</p>}
                      {s.output && Object.keys(s.output).length > 0 && (
                        <p className="truncate font-mono text-[10px] text-ink-subtle">{JSON.stringify(s.output)}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            {/* Variables finales */}
            {detail.run.variables && Object.keys(detail.run.variables).length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium text-ink">Variables de la ejecución</p>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(detail.run.variables).map(([k, v]) => (
                    <span key={k} className="rounded bg-app px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"><b>{k}</b>: {String(v).slice(0, 40)}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Confirmación del reintento: qué hará y qué costará */}
      <Modal open={!!retryPreview} onClose={() => setRetryPreview(null)} title="Confirmar reintento">
        {retryPreview && (
          <div className="space-y-3 text-sm">
            <p className="text-ink-muted">
              El reintento retomará el flujo <b>desde el paso que falló</b>{retryPreview.fromNodeType ? <> (<b>{nodeLabel(retryPreview.fromNodeType)}</b>)</> : null} y <b>ejecuta acciones reales</b>.
            </p>
            <div className="rounded-lg border border-line bg-app p-3">
              {retryPreview.templateSends === 0 ? (
                <p className="text-ink-muted">No hay envíos de plantilla en el camino restante: <b>no descuenta bolsa</b>.</p>
              ) : (
                <>
                  <p className="text-ink">
                    Podría enviar hasta <b>{retryPreview.templateSends}</b> mensaje{retryPreview.templateSends > 1 ? "s" : ""} de plantilla ·
                    descuento estimado de la bolsa: <b>{retryPreview.estimatedDebit}</b> crédito{retryPreview.estimatedDebit !== 1 ? "s" : ""} ·
                    saldo actual: <b>{retryPreview.walletBalance}</b>.
                  </p>
                  <ul className="mt-1.5 space-y-0.5 text-xs text-ink-muted">
                    {retryPreview.templates.map((t, i) => (
                      <li key={i}>· {t.name} <span className="text-ink-subtle">({t.category.toLowerCase()} · {t.weight} crédito{t.weight !== 1 ? "s" : ""})</span></li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-[11px] text-ink-subtle">Es una cota superior: el descuento real depende de las ramas que tome el flujo.</p>
                  {retryPreview.wouldExceed && (
                    <p className="mt-1.5 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                      ⚠ El descuento estimado supera tu saldo: algunos envíos podrían bloquearse por la bolsa.
                    </p>
                  )}
                </>
              )}
            </div>
            <p className="text-[11px] text-ink-subtle">
              El reintento pasa por las mismas <b>6 condiciones</b> del guard de mensajería (plan incluye plantillas → interruptor encendido → estado de la cuenta → tope diario → bolsa con saldo → fusible global); si alguna bloquea, ese envío no sale y queda registrado.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setRetryPreview(null)}>Cancelar</Button>
              <Button disabled={retrying} onClick={() => void retry()}><RefreshCw size={14} className="mr-1" /> {retrying ? "Reintentando…" : "Reintentar"}</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
