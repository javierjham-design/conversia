"use client";

import { useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, StatusBadge, useToast } from "@/components/ui";

interface Plan {
  id: string;
  code: string;
  name: string;
  priceClp: string;
  priceUsd: string;
  interval: string;
  isPublic: boolean;
  active: boolean;
  order: number;
  limits: Record<string, number>;
  features: Record<string, unknown>;
}
type Draft = { priceClp: number; priceUsd: number; interval: string; isPublic: boolean; limits: Record<string, number>; features: Record<string, boolean>; lsVariantId: string; templateMessages: number };
type NewPlan = { code: string; name: string; interval: string; priceClp: number; priceUsd: number; templateMessages: number; whatsappTemplates: boolean; isPublic: boolean; order: number };
const EMPTY_NEW: NewPlan = { code: "", name: "", interval: "monthly", priceClp: 0, priceUsd: 0, templateMessages: 1000, whatsappTemplates: true, isPublic: true, order: 10 };
interface CostModel {
  models: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
}

const LIMIT_FIELDS: { key: string; label: string }[] = [
  { key: "aiTokensDaily", label: "Tokens IA / día" },
  { key: "agents", label: "Agentes" },
  { key: "channels", label: "Canales" },
  { key: "workflows", label: "Flujos" },
  { key: "users", label: "Usuarios" },
  { key: "clinics", label: "Sedes" },
];
const FEATURE_FIELDS: { key: string; label: string }[] = [
  { key: "api", label: "API" },
  { key: "whiteLabel", label: "Marca blanca" },
  { key: "whatsappTemplates", label: "Plantillas WhatsApp" },
];

export default function PlansPage() {
  const toast = useToast();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [cost, setCost] = useState<CostModel | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [newPlan, setNewPlan] = useState<NewPlan>(EMPTY_NEW);
  const [showNew, setShowNew] = useState(false);
  const [creating, setCreating] = useState(false);
  // Supuestos del estimador de costos de IA.
  const [model, setModel] = useState("gpt-4o-mini");
  const [inputPct, setInputPct] = useState(75);
  // Prueba de IA en vivo.
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any | null>(null);

  async function runTest() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await padmin("/platform/test-ai", { method: "POST", body: JSON.stringify({ model }) }));
    } catch (e) {
      setTestResult({ ok: false, error: (e as Error).message });
    } finally {
      setTesting(false);
    }
  }

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([padmin<Plan[]>("/platform/plans"), padmin<CostModel>("/platform/cost-model")]);
    setPlans(p);
    setCost(c);
    const d: Record<string, Draft> = {};
    for (const plan of p) {
      d[plan.id] = {
        priceClp: Number(plan.priceClp),
        priceUsd: Number(plan.priceUsd),
        interval: plan.interval || "monthly",
        isPublic: Boolean(plan.isPublic),
        limits: Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, Number(plan.limits?.[f.key] ?? 0)])),
        features: Object.fromEntries(FEATURE_FIELDS.map((f) => [f.key, Boolean((plan.features as any)?.[f.key])])),
        lsVariantId: String((plan.features as any)?.lsVariantId ?? ""),
        templateMessages: Number((plan.features as any)?.templateMessages ?? 0),
      };
    }
    setDrafts(d);
  }, []);
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  function patchDraft(id: string, fn: (d: Draft) => Draft) {
    setDrafts((prev) => ({ ...prev, [id]: fn(prev[id]) }));
  }

  async function save(plan: Plan) {
    const d = drafts[plan.id];
    if (!d) return;
    try {
      await padmin(`/platform/plans/${plan.id}`, {
        method: "PATCH",
        body: JSON.stringify({ priceClp: d.priceClp, priceUsd: d.priceUsd, interval: d.interval, isPublic: d.isPublic, limits: { ...plan.limits, ...d.limits }, features: { ...plan.features, ...d.features, lsVariantId: d.lsVariantId || undefined, templateMessages: d.templateMessages } }),
      });
      toast.push(`Plan ${plan.name} guardado`, "ok");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }
  async function toggleActive(p: Plan) {
    await padmin(`/platform/plans/${p.id}`, { method: "PATCH", body: JSON.stringify({ active: !p.active }) });
    await load();
  }
  async function createPlan() {
    if (!newPlan.code.trim() || !newPlan.name.trim()) {
      toast.push("Código y nombre son obligatorios", "error");
      return;
    }
    setCreating(true);
    try {
      await padmin("/platform/plans", {
        method: "POST",
        body: JSON.stringify({
          code: newPlan.code.trim(),
          name: newPlan.name.trim(),
          interval: newPlan.interval,
          priceClp: newPlan.priceClp,
          priceUsd: newPlan.priceUsd,
          isPublic: newPlan.isPublic,
          order: newPlan.order,
          features: { templateMessages: newPlan.templateMessages, whatsappTemplates: newPlan.whatsappTemplates },
          limits: {},
        }),
      });
      toast.push(`Plan ${newPlan.name} creado`, "ok");
      setNewPlan(EMPTY_NEW);
      setShowNew(false);
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setCreating(false);
    }
  }

  // Costo IA mensual estimado según el tope diario de tokens y el modelo/mezcla elegidos.
  function estimateAiCost(d: Draft): number | null {
    const daily = d.limits.aiTokensDaily;
    const pr = cost?.models?.[model];
    if (!daily || !pr) return null; // 0 = ilimitado → no estimable
    const blendedPerM = pr.inputPerMTok * (inputPct / 100) + pr.outputPerMTok * ((100 - inputPct) / 100);
    return (daily * 30 * blendedPerM) / 1_000_000;
  }

  return (
    <div className="mx-auto max-w-[1300px] px-6 py-6 lg:px-8">
      <PageHeader title="Planes" description="Crea y edita planes (mensuales y anuales), precios y límites. El estimador calcula el costo de IA para fijar el cobro con margen." />

      {/* Crear plan (incluye variante ANUAL) */}
      <div className="mb-5 rounded-card border border-slate-200 bg-white p-4 shadow-card">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold">Nuevo plan</p>
          <Button onClick={() => setShowNew((v) => !v)}>{showNew ? "Cancelar" : "+ Crear plan"}</Button>
        </div>
        {showNew && (
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <label className="text-xs text-slate-500">
              Código (único)
              <input value={newPlan.code} onChange={(e) => setNewPlan((p) => ({ ...p, code: e.target.value }))} placeholder="p. ej. starter_anual" className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-sm" />
            </label>
            <label className="text-xs text-slate-500">
              Nombre
              <input value={newPlan.name} onChange={(e) => setNewPlan((p) => ({ ...p, name: e.target.value }))} placeholder="p. ej. Starter Anual" className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs text-slate-500">
              Cobro
              <select value={newPlan.interval} onChange={(e) => setNewPlan((p) => ({ ...p, interval: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
                <option value="monthly">Mensual</option>
                <option value="yearly">Anual</option>
              </select>
            </label>
            <label className="text-xs text-slate-500">
              Precio CLP {newPlan.interval === "yearly" ? "(total del año)" : "(por mes)"}
              <input type="number" value={newPlan.priceClp} onChange={(e) => setNewPlan((p) => ({ ...p, priceClp: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs text-slate-500">
              Precio USD {newPlan.interval === "yearly" ? "(total del año)" : "(por mes)"}
              <input type="number" value={newPlan.priceUsd} onChange={(e) => setNewPlan((p) => ({ ...p, priceUsd: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs text-slate-500">
              Mensajes de plantilla / mes (−1 = ilimitado)
              <input type="number" value={newPlan.templateMessages} onChange={(e) => setNewPlan((p) => ({ ...p, templateMessages: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="text-xs text-slate-500">
              Orden
              <input type="number" value={newPlan.order} onChange={(e) => setNewPlan((p) => ({ ...p, order: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
            <label className="flex items-center gap-2 self-end text-xs text-slate-600">
              <input type="checkbox" checked={newPlan.whatsappTemplates} onChange={(e) => setNewPlan((p) => ({ ...p, whatsappTemplates: e.target.checked }))} />
              Plantillas WhatsApp
            </label>
            <label className="flex items-center gap-2 self-end text-xs text-slate-600">
              <input type="checkbox" checked={newPlan.isPublic} onChange={(e) => setNewPlan((p) => ({ ...p, isPublic: e.target.checked }))} />
              Público (visible al cotizar)
            </label>
            <div className="md:col-span-3">
              <Button onClick={() => void createPlan()} disabled={creating}>{creating ? "Creando…" : "Crear plan"}</Button>
              <span className="ml-3 text-[11px] text-slate-400">El plan anual es una fila aparte (p. ej. «Starter Anual»). El bot lo mostrará al cotizar si es público.</span>
            </div>
          </div>
        )}
      </div>

      {/* Supuestos del estimador */}
      <div className="mb-5 flex flex-wrap items-end gap-4 rounded-card border border-slate-200 bg-white p-4 shadow-card">
        <div>
          <label className="block text-xs text-slate-500">Modelo IA de referencia</label>
          <select value={model} onChange={(e) => setModel(e.target.value)} className="mt-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm">
            {cost ? Object.keys(cost.models).map((m) => <option key={m} value={m}>{m}</option>) : <option>{model}</option>}
          </select>
        </div>
        <div>
          <label className="block text-xs text-slate-500">Mezcla de tokens: {inputPct}% entrada / {100 - inputPct}% salida</label>
          <input type="range" min={0} max={100} value={inputPct} onChange={(e) => setInputPct(Number(e.target.value))} className="mt-2 w-56" />
        </div>
        {cost?.models?.[model] && (
          <p className="text-xs text-slate-400">
            {model}: ${cost.models[model].inputPerMTok}/M entrada · ${cost.models[model].outputPerMTok}/M salida
          </p>
        )}
      </div>

      {/* Probar IA en vivo (verifica la llave del proveedor) */}
      <div className="mb-5 rounded-card border border-slate-200 bg-white p-4 shadow-card">
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => void runTest()} disabled={testing}>
            {testing ? "Probando…" : `Probar IA (${model})`}
          </Button>
          <span className="text-xs text-slate-400">Manda un prompt de prueba al modelo seleccionado y verifica que la llave funciona.</span>
        </div>
        {testResult &&
          (testResult.ok ? (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
              <p className="text-emerald-800">✓ {testResult.text}</p>
              <p className="mt-1 text-xs text-emerald-600">
                {testResult.model} · {testResult.usage?.inputTokens}+{testResult.usage?.outputTokens} tokens · US$
                {Number(testResult.usage?.costUsd ?? 0).toFixed(5)} · {testResult.latencyMs}ms
              </p>
            </div>
          ) : (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">✗ {testResult.error ?? "Error"}</div>
          ))}
      </div>

      {!plans ? (
        <Skeleton className="h-56" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {plans.map((p) => {
            const d = drafts[p.id];
            if (!d) return null;
            const aiCost = estimateAiCost(d);
            const margin = aiCost == null ? null : d.priceUsd - aiCost;
            const marginPct = margin != null && d.priceUsd > 0 ? (margin / d.priceUsd) * 100 : null;
            return (
              <div key={p.id} className="rounded-card border border-slate-200 bg-white p-4 shadow-card">
                <div className="mb-2 flex items-center justify-between">
                  <div>
                    <p className="font-semibold">{p.name}</p>
                    <p className="text-xs text-slate-400">{p.code} · {p.interval}{p.isPublic ? "" : " · privado"}</p>
                  </div>
                  <button onClick={() => void toggleActive(p)}>
                    <StatusBadge kind={p.active ? "connected" : "disconnected"} label={p.active ? "activo" : "inactivo"} />
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs text-slate-500">
                    Precio CLP
                    <input type="number" value={d.priceClp} onChange={(e) => patchDraft(p.id, (x) => ({ ...x, priceClp: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
                  </label>
                  <label className="text-xs text-slate-500">
                    Precio USD
                    <input type="number" value={d.priceUsd} onChange={(e) => patchDraft(p.id, (x) => ({ ...x, priceUsd: Number(e.target.value) }))} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
                  </label>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="text-xs text-slate-500">
                    Cobro
                    <select value={d.interval} onChange={(e) => patchDraft(p.id, (x) => ({ ...x, interval: e.target.value }))} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
                      <option value="monthly">Mensual</option>
                      <option value="yearly">Anual</option>
                    </select>
                  </label>
                  <label className="flex items-center gap-2 self-end pb-1.5 text-xs text-slate-600">
                    <input type="checkbox" checked={d.isPublic} onChange={(e) => patchDraft(p.id, (x) => ({ ...x, isPublic: e.target.checked }))} />
                    Público (cotizable)
                  </label>
                </div>

                <div className="mt-3 space-y-1.5 rounded-lg bg-slate-50 p-2">
                  {LIMIT_FIELDS.map((f) => (
                    <label key={f.key} className="flex items-center justify-between text-xs text-slate-600">
                      <span>{f.label}</span>
                      <span className="flex items-center gap-1">
                        <input
                          type="number"
                          value={d.limits[f.key]}
                          onChange={(e) => patchDraft(p.id, (x) => ({ ...x, limits: { ...x.limits, [f.key]: Number(e.target.value) } }))}
                          className="w-24 rounded border border-slate-300 px-2 py-1 text-right text-sm"
                        />
                      </span>
                    </label>
                  ))}
                  <p className="pt-1 text-[10px] text-slate-400">0 = ilimitado</p>
                </div>

                <div className="mt-2 space-y-1.5 rounded-lg bg-slate-50 p-2">
                  <p className="text-[11px] font-medium text-slate-600">Bolsa de mensajes de plantilla (prepago)</p>
                  <label className="flex items-center justify-between text-xs text-slate-600">
                    <span>Incluidos / mes (−1 = ilimitado)</span>
                    <input type="number" value={d.templateMessages} onChange={(e) => patchDraft(p.id, (x) => ({ ...x, templateMessages: Number(e.target.value) }))} className="w-24 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
                  </label>
                  <p className="text-[10px] text-slate-400">Recarga la bolsa del tenant al renovar. El excedente se compra por paquetes prepago (no hay cobro post-pago).</p>
                </div>

                <div className="mt-2 flex gap-3">
                  {FEATURE_FIELDS.map((f) => (
                    <label key={f.key} className="flex items-center gap-1.5 text-xs text-slate-600">
                      <input type="checkbox" checked={d.features[f.key]} onChange={(e) => patchDraft(p.id, (x) => ({ ...x, features: { ...x.features, [f.key]: e.target.checked } }))} />
                      {f.label}
                    </label>
                  ))}
                </div>

                <label className="mt-2 block text-xs text-slate-500">
                  Lemon Squeezy · Variant ID (cobro USD)
                  <input
                    value={d.lsVariantId}
                    onChange={(e) => patchDraft(p.id, (x) => ({ ...x, lsVariantId: e.target.value }))}
                    placeholder="p. ej. 123456"
                    className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1 font-mono text-sm"
                  />
                </label>

                {/* Estimación de costo/margen */}
                <div className="mt-3 rounded-lg border border-slate-100 bg-white p-2 text-xs">
                  {aiCost == null ? (
                    <p className="text-slate-400">IA ilimitada (tope 0) — sin estimación de costo.</p>
                  ) : (
                    <div className="space-y-0.5">
                      <div className="flex justify-between"><span className="text-slate-500">Costo IA est. / mes</span><span className="font-medium">US${aiCost.toFixed(2)}</span></div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">Margen (USD)</span>
                        <span className={`font-medium ${margin! < 0 ? "text-red-600" : "text-emerald-600"}`}>
                          US${margin!.toFixed(2)}{marginPct != null ? ` (${marginPct.toFixed(0)}%)` : ""}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <Button className="mt-3 w-full" onClick={() => void save(p)}>Guardar cambios</Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
