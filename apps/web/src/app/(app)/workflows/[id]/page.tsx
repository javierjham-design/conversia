"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";

// ---- tipos ----
interface Catalog {
  triggers: { type: string; label: string; description: string; config?: string[] }[];
  nodes: { type: string; label: string; description: string }[];
  leadStatuses: { code: string; name: string }[];
  agents: { slug: string; name: string }[];
}
interface Detail {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  publishedVersion: number | null;
  draftVersion: number | null;
  definition: any;
  versions: { version: number; status: string; publishedAt: string | null }[];
}
interface Run {
  id: string;
  status: string;
  startedAt: string;
  error: string | null;
  steps: { nodeId: string; nodeType: string; status: string }[];
}

/** Paso en la UI (se traduce al JSON del motor al guardar). */
interface Step {
  uiType: string;
  text?: string;
  agentSlug?: string;
  amount?: number;
  unit?: "minutes" | "hours" | "days";
  cancelOnReply?: boolean;
  statusCode?: string;
  tag?: string;
  reason?: string;
}

const UNIT_LABEL = { minutes: "minutos", hours: "horas", days: "días" } as const;

function definitionToSteps(def: any): { triggerType: string; keyword: string; steps: Step[] } {
  const triggerType = def?.trigger?.type ?? "conversation_started";
  const keyword = def?.trigger?.config?.keyword ?? "";
  const steps: Step[] = (def?.nodes ?? []).map((n: any) => {
    const c = n.config ?? {};
    switch (n.type) {
      case "send_text":
        return { uiType: "send_text", text: c.text ?? "" };
      case "run_agent":
        return { uiType: "run_agent", agentSlug: c.agentSlug ?? "" };
      case "wait": {
        if (c.days) return { uiType: "wait", amount: Number(c.days), unit: "days" as const, cancelOnReply: c.cancelOn === "contact_reply" };
        if (c.hours) return { uiType: "wait", amount: Number(c.hours), unit: "hours" as const, cancelOnReply: c.cancelOn === "contact_reply" };
        return { uiType: "wait", amount: Number(c.minutes ?? 5), unit: "minutes" as const, cancelOnReply: c.cancelOn === "contact_reply" };
      }
      case "condition":
        return { uiType: "condition_no_reply" };
      case "update_lead_status":
        return { uiType: "update_lead_status", statusCode: c.statusCode ?? "" };
      case "add_tag":
        return { uiType: "add_tag", tag: c.tag ?? "" };
      case "transfer_human":
        return { uiType: "transfer_human", reason: c.reason ?? "" };
      case "close_conversation":
        return { uiType: "close_conversation" };
      default:
        return { uiType: "stop" };
    }
  });
  return { triggerType, keyword, steps };
}

function stepsToDefinition(triggerType: string, keyword: string, steps: Step[]): any {
  const nodes = steps.map((s, i) => {
    const id = `n${i + 1}`;
    switch (s.uiType) {
      case "send_text":
        return { id, type: "send_text", config: { text: s.text ?? "" } };
      case "run_agent":
        return { id, type: "run_agent", config: { agentSlug: s.agentSlug } };
      case "wait": {
        const config: Record<string, unknown> = {};
        config[s.unit ?? "minutes"] = s.amount ?? 5;
        if (s.cancelOnReply) config.cancelOn = "contact_reply";
        return { id, type: "wait", config };
      }
      case "condition_no_reply":
        return { id, type: "condition", config: { kind: "no_reply" } };
      case "update_lead_status":
        return { id, type: "update_lead_status", config: { statusCode: s.statusCode } };
      case "add_tag":
        return { id, type: "add_tag", config: { tag: s.tag } };
      case "transfer_human":
        return { id, type: "transfer_human", config: { reason: s.reason ?? "solicitud del flujo" } };
      case "close_conversation":
        return { id, type: "close_conversation", config: {} };
      default:
        return { id, type: "stop", config: {} };
    }
  });
  const edges = nodes.slice(0, -1).map((n, i) => ({
    from: n.id,
    to: nodes[i + 1].id,
    ...(n.type === "condition" ? { when: "true" } : {}),
  }));
  return {
    trigger: { type: triggerType, config: triggerType === "keyword" ? { keyword } : {} },
    variables: {},
    nodes,
    edges,
  };
}

export default function WorkflowEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [name, setName] = useState("");
  const [triggerType, setTriggerType] = useState("conversation_started");
  const [keyword, setKeyword] = useState("");
  const [steps, setSteps] = useState<Step[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [d, c, r] = await Promise.all([
      api<Detail>(`/workflows/${id}`),
      api<Catalog>("/workflows/meta/catalog"),
      api<Run[]>(`/workflows/${id}/runs`),
    ]);
    setDetail(d);
    setCatalog(c);
    setRuns(r);
    setName(d.name);
    const parsed = definitionToSteps(d.definition);
    setTriggerType(parsed.triggerType);
    setKeyword(parsed.keyword);
    setSteps(parsed.steps);
  }, [id]);

  useEffect(() => {
    void load().catch((e) => setMsg({ kind: "error", text: (e as Error).message }));
  }, [load]);

  function updateStep(i: number, patch: Partial<Step>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function moveStep(i: number, dir: -1 | 1) {
    setSteps((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function removeStep(i: number) {
    setSteps((prev) => prev.filter((_, idx) => idx !== i));
  }
  function addStep(uiType: string) {
    const base: Step = { uiType };
    if (uiType === "wait") Object.assign(base, { amount: 5, unit: "minutes", cancelOnReply: true });
    setSteps((prev) => [...prev, base]);
  }

  async function saveDraft(): Promise<boolean> {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/workflows/${id}/draft`, {
        method: "PUT",
        body: JSON.stringify({ name, definition: stepsToDefinition(triggerType, keyword, steps) }),
      });
      setMsg({ kind: "ok", text: "Borrador guardado" });
      await load();
      return true;
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!(await saveDraft())) return;
    setBusy(true);
    try {
      const r = await api<{ publishedVersion: number }>(`/workflows/${id}/publish`, { method: "POST" });
      setMsg({ kind: "ok", text: `Versión ${r.publishedVersion} publicada y activa` });
      await load();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (!detail || !catalog) return <div className="p-6 text-slate-400">Cargando…</div>;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <button onClick={() => router.push("/workflows")} className="text-xs text-slate-400 hover:text-slate-600">← Volver a flujos</button>
          <input value={name} onChange={(e) => setName(e.target.value)} className="block rounded-lg border border-transparent text-xl font-semibold hover:border-slate-200 focus:border-slate-300" />
          <p className="text-xs text-slate-400">
            {detail.publishedVersion ? `v${detail.publishedVersion} en producción` : "nunca publicado"}
            {detail.draftVersion ? ` · borrador v${detail.draftVersion}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void saveDraft()} disabled={busy} className="rounded-lg border border-cyan-600 px-3 py-2 text-sm text-cyan-700 hover:bg-cyan-50 disabled:opacity-50">Guardar borrador</button>
          <button onClick={() => void publish()} disabled={busy} className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800 disabled:opacity-50">Publicar</button>
        </div>
      </div>

      {msg && (
        <p className={`mb-4 rounded-lg px-3 py-2 text-sm ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>{msg.text}</p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="space-y-3 lg:col-span-2">
          {/* Disparador */}
          <div className="rounded-xl border-2 border-cyan-200 bg-white p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-cyan-700">⚡ Disparador</p>
            <div className="flex flex-wrap gap-3">
              <select value={triggerType} onChange={(e) => setTriggerType(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                {catalog.triggers.map((t) => (
                  <option key={t.type} value={t.type}>{t.label}</option>
                ))}
              </select>
              {triggerType === "keyword" && (
                <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="palabra o frase" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              )}
            </div>
            <p className="mt-1 text-xs text-slate-400">{catalog.triggers.find((t) => t.type === triggerType)?.description}</p>
          </div>

          {/* Pasos */}
          {steps.map((s, i) => {
            const meta = catalog.nodes.find((n) => n.type === s.uiType);
            return (
              <div key={i} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium">{i + 1}. {meta?.label ?? s.uiType}</p>
                  <div className="flex gap-1 text-xs">
                    <button onClick={() => moveStep(i, -1)} className="rounded border border-slate-200 px-2 py-0.5 hover:bg-slate-50">↑</button>
                    <button onClick={() => moveStep(i, 1)} className="rounded border border-slate-200 px-2 py-0.5 hover:bg-slate-50">↓</button>
                    <button onClick={() => removeStep(i)} className="rounded border border-red-200 px-2 py-0.5 text-red-500 hover:bg-red-50">✕</button>
                  </div>
                </div>

                {s.uiType === "send_text" && (
                  <>
                    <textarea value={s.text ?? ""} onChange={(e) => updateStep(i, { text: e.target.value })} rows={3} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Mensaje… puedes usar {{contact.firstName}}, {{clinic.name}}" />
                    <p className="text-[10px] text-slate-400">Variables: {"{{contact.firstName}} {{organization.name}} {{clinic.name}} {{clinic.address}}"}</p>
                  </>
                )}
                {s.uiType === "run_agent" && (
                  <select value={s.agentSlug ?? ""} onChange={(e) => updateStep(i, { agentSlug: e.target.value })} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                    <option value="">— agente activo de la conversación —</option>
                    {catalog.agents.map((a) => (
                      <option key={a.slug} value={a.slug}>🤖 {a.name}</option>
                    ))}
                  </select>
                )}
                {s.uiType === "wait" && (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    Esperar
                    <input type="number" min={1} value={s.amount ?? 5} onChange={(e) => updateStep(i, { amount: Number(e.target.value) })} className="w-20 rounded-lg border border-slate-300 px-2 py-1.5" />
                    <select value={s.unit ?? "minutes"} onChange={(e) => updateStep(i, { unit: e.target.value as Step["unit"] })} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5">
                      {Object.entries(UNIT_LABEL).map(([v, l]) => (
                        <option key={v} value={v}>{l}</option>
                      ))}
                    </select>
                    <label className="flex items-center gap-1 text-xs text-slate-500">
                      <input type="checkbox" checked={s.cancelOnReply ?? false} onChange={(e) => updateStep(i, { cancelOnReply: e.target.checked })} />
                      cancelar si el contacto responde
                    </label>
                  </div>
                )}
                {s.uiType === "condition_no_reply" && (
                  <p className="text-xs text-slate-500">Si el contacto <b>no ha respondido</b> desde que inició el flujo → continúa al siguiente paso. Si respondió → el flujo termina aquí.</p>
                )}
                {s.uiType === "update_lead_status" && (
                  <select value={s.statusCode ?? ""} onChange={(e) => updateStep(i, { statusCode: e.target.value })} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                    <option value="">— elegir estado —</option>
                    {catalog.leadStatuses.map((st) => (
                      <option key={st.code} value={st.code}>{st.name}</option>
                    ))}
                  </select>
                )}
                {s.uiType === "add_tag" && (
                  <input value={s.tag ?? ""} onChange={(e) => updateStep(i, { tag: e.target.value })} placeholder="etiqueta" className="rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                )}
                {s.uiType === "transfer_human" && (
                  <input value={s.reason ?? ""} onChange={(e) => updateStep(i, { reason: e.target.value })} placeholder="motivo del escalamiento" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                )}
              </div>
            );
          })}

          {/* Agregar paso */}
          <div className="rounded-xl border border-dashed border-slate-300 p-4">
            <p className="mb-2 text-xs font-medium text-slate-500">+ Agregar paso</p>
            <div className="flex flex-wrap gap-2">
              {catalog.nodes.map((n) => (
                <button key={n.type} onClick={() => addStep(n.type)} title={n.description} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs hover:border-cyan-300 hover:bg-cyan-50">
                  {n.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 font-medium">Últimas ejecuciones</h2>
            {runs.length === 0 && <p className="text-xs text-slate-400">Aún sin ejecuciones.</p>}
            <ul className="space-y-2">
              {runs.slice(0, 10).map((r) => (
                <li key={r.id} className="rounded-lg border border-slate-100 p-2 text-xs">
                  <div className="flex justify-between">
                    <span className={
                      r.status === "COMPLETED" ? "text-emerald-600" :
                      r.status === "WAITING" ? "text-amber-600" :
                      r.status === "FAILED" ? "text-red-600" : "text-slate-500"
                    }>
                      {r.status.toLowerCase()}
                    </span>
                    <span className="text-slate-400">{new Date(r.startedAt).toLocaleString("es-CL")}</span>
                  </div>
                  <p className="mt-1 text-slate-400">{r.steps.map((st) => st.nodeType).join(" → ") || "sin pasos"}</p>
                  {r.error && <p className="text-red-500">{r.error}</p>}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 font-medium">Versiones</h2>
            <ul className="space-y-1 text-sm">
              {detail.versions.map((v) => (
                <li key={v.version} className="flex justify-between">
                  <span>v{v.version}</span>
                  <span className={`text-[10px] ${v.status === "PUBLISHED" ? "text-emerald-600" : "text-amber-600"}`}>{v.status.toLowerCase()}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-[11px] text-slate-400">
            Las ejecuciones en curso siguen usando la versión con la que partieron. El lienzo visual (drag & drop) llega en la siguiente iteración; este editor genera el mismo formato.
          </p>
        </aside>
      </div>
    </div>
  );
}
