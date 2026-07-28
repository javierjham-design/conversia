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
type Draft = { priceClp: number; priceUsd: number; limits: Record<string, number>; features: Record<string, boolean> };
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
];

export default function PlansPage() {
  const toast = useToast();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [cost, setCost] = useState<CostModel | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // Supuestos del estimador de costos de IA.
  const [model, setModel] = useState("gpt-4o-mini");
  const [inputPct, setInputPct] = useState(75);

  const load = useCallback(async () => {
    const [p, c] = await Promise.all([padmin<Plan[]>("/platform/plans"), padmin<CostModel>("/platform/cost-model")]);
    setPlans(p);
    setCost(c);
    const d: Record<string, Draft> = {};
    for (const plan of p) {
      d[plan.id] = {
        priceClp: Number(plan.priceClp),
        priceUsd: Number(plan.priceUsd),
        limits: Object.fromEntries(LIMIT_FIELDS.map((f) => [f.key, Number(plan.limits?.[f.key] ?? 0)])),
        features: Object.fromEntries(FEATURE_FIELDS.map((f) => [f.key, Boolean((plan.features as any)?.[f.key])])),
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
        body: JSON.stringify({ priceClp: d.priceClp, priceUsd: d.priceUsd, limits: { ...plan.limits, ...d.limits }, features: { ...plan.features, ...d.features } }),
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
      <PageHeader title="Planes" description="Edita precios y límites. El estimador calcula el costo de IA para fijar el cobro con margen." />

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

                <div className="mt-2 flex gap-3">
                  {FEATURE_FIELDS.map((f) => (
                    <label key={f.key} className="flex items-center gap-1.5 text-xs text-slate-600">
                      <input type="checkbox" checked={d.features[f.key]} onChange={(e) => patchDraft(p.id, (x) => ({ ...x, features: { ...x.features, [f.key]: e.target.checked } }))} />
                      {f.label}
                    </label>
                  ))}
                </div>

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
