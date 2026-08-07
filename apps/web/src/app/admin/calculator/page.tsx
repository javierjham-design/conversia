"use client";

/**
 * Calculadora de costos de planes (Super Admin): combina el costo del motor de IA,
 * el costo que cobra Meta por mensajes de plantilla, y el gasto en Meta Ads, para
 * estimar el costo mensual por cliente y sugerir precio según un margen objetivo.
 * Todo se calcula en el navegador con las tarifas reales del backend.
 */
import { useEffect, useMemo, useState } from "react";
import { PageHeader, Skeleton, useToast } from "@/components/ui";
import { padmin } from "@/lib/platform-api";

interface ModelPricing { inputPerMTok: number; outputPerMTok: number }
interface WaRates { marketing: number; utility: number; authentication: number; service: number }
interface CostModel { models: Record<string, ModelPricing>; whatsapp: Record<string, WaRates>; usdToClp?: number }
interface PlanRow { code: string; name: string; priceClp: number; priceUsd: number; features: Record<string, any> }

const money = (n: number) => `US$${n.toFixed(2)}`;

export default function CalculatorPage() {
  const toast = useToast();
  const [cost, setCost] = useState<CostModel | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [savingRates, setSavingRates] = useState(false);
  // Editor masivo de tarifas: todos los países a la vez.
  const [allRates, setAllRates] = useState<Record<string, WaRates>>({});
  const [newCountry, setNewCountry] = useState("");
  const [importText, setImportText] = useState("");

  // Escenario
  const [country, setCountry] = useState("CL");
  const [fx, setFx] = useState(950); // USD→CLP (editable/persistente)
  // IA
  const [model, setModel] = useState("claude-haiku-4-5");
  const [convos, setConvos] = useState(500);
  const [inTok, setInTok] = useState(1500);
  const [outTok, setOutTok] = useState(400);
  // Mensajes de plantilla (Meta)
  const [mkt, setMkt] = useState(200);
  const [util, setUtil] = useState(300);
  const [auth, setAuth] = useState(0);
  // Meta Ads
  const [adSpend, setAdSpend] = useState(0);
  const [adMarkup, setAdMarkup] = useState(0); // % que le sumas si lo revendes
  const [adIsCost, setAdIsCost] = useState(false); // ¿el gasto en ads es TU costo?
  // Precio / margen
  const [priceUsd, setPriceUsd] = useState(39);
  const [targetMargin, setTargetMargin] = useState(70);

  const loadCost = () =>
    padmin<CostModel>("/platform/cost-model").then((c) => {
      setCost(c);
      if (c.usdToClp) setFx(c.usdToClp);
      // Precarga TODAS las tarifas efectivas en el editor masivo.
      setAllRates(JSON.parse(JSON.stringify(c.whatsapp ?? {})));
    });
  useEffect(() => {
    void loadCost().catch(() => setCost({ models: {}, whatsapp: {} }));
    void padmin<PlanRow[]>("/platform/plans").then(setPlans).catch(() => setPlans([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setRate(cc: string, key: keyof WaRates, val: number) {
    setAllRates((prev) => ({ ...prev, [cc]: { ...(prev[cc] ?? { marketing: 0, utility: 0, authentication: 0, service: 0 }), [key]: val } }));
  }
  function addCountry() {
    const cc = newCountry.trim().toUpperCase();
    if (!cc || allRates[cc]) return;
    setAllRates((prev) => ({ ...prev, [cc]: { marketing: 0, utility: 0, authentication: 0, service: 0 } }));
    setNewCountry("");
  }
  function applyImport() {
    try {
      const parsed = JSON.parse(importText);
      if (typeof parsed !== "object" || !parsed) throw new Error("no es un objeto");
      // Normaliza: acepta { CL: { marketing, utility, authentication } , ... }.
      const merged: Record<string, WaRates> = { ...allRates };
      for (const [cc, r] of Object.entries(parsed as Record<string, any>)) {
        merged[cc.toUpperCase()] = {
          marketing: Number(r.marketing ?? 0),
          utility: Number(r.utility ?? 0),
          authentication: Number(r.authentication ?? r.auth ?? 0),
          service: Number(r.service ?? 0),
        };
      }
      setAllRates(merged);
      setImportText("");
      toast.push(`Importados ${Object.keys(parsed).length} país(es) ✔ (revisa y guarda)`, "ok");
    } catch (e) {
      toast.push(`JSON inválido: ${(e as Error).message}`, "error");
    }
  }

  async function saveAllRates() {
    setSavingRates(true);
    try {
      await padmin("/platform/cost-settings", { method: "PATCH", body: JSON.stringify({ usdToClp: fx, whatsappRates: allRates }) });
      await loadCost();
      toast.push("Tarifas y tipo de cambio guardados ✔", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setSavingRates(false);
    }
  }

  const calc = useMemo(() => {
    if (!cost) return null;
    const m = cost.models[model] ?? { inputPerMTok: 0, outputPerMTok: 0 };
    const rates = cost.whatsapp[country] ?? cost.whatsapp.default ?? { marketing: 0, utility: 0, authentication: 0, service: 0 };
    const aiPerConvo = (inTok * m.inputPerMTok + outTok * m.outputPerMTok) / 1_000_000;
    const aiCost = convos * aiPerConvo;
    const msgCost = mkt * rates.marketing + util * rates.utility + auth * rates.authentication;
    const adsCostToYou = adIsCost ? adSpend : 0;
    const totalCost = aiCost + msgCost + adsCostToYou;
    const margin = priceUsd > 0 ? (1 - totalCost / priceUsd) * 100 : 0;
    const suggested = targetMargin < 100 ? totalCost / (1 - targetMargin / 100) : Infinity;
    // Ingreso extra si revendes ads con margen (informativo).
    const adResaleProfit = adSpend * (adMarkup / 100);
    return { aiCost, msgCost, adsCostToYou, totalCost, margin, suggested, adResaleProfit, msgTotal: mkt + util + auth };
  }, [cost, model, country, convos, inTok, outTok, mkt, util, auth, adSpend, adMarkup, adIsCost, priceUsd, targetMargin]);

  if (!cost || !calc) return <div className="mx-auto max-w-5xl px-6 py-6"><Skeleton className="h-96" /></div>;

  const input = "mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm";
  const card = "rounded-card border border-slate-200 bg-white p-4 shadow-card";

  return (
    <div className="mx-auto max-w-5xl px-6 py-6 lg:px-8">
      <PageHeader title="Calculadora de costos" description="Modela un escenario para fijar el precio de un plan: IA + mensajes Meta + Meta Ads." />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Escenario */}
        <div className={card}>
          <h2 className="mb-2 font-semibold text-navy-900">Escenario</h2>
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
            <label>País (tarifa Meta)
              <select value={country} onChange={(e) => setCountry(e.target.value)} className={input}>
                {Object.keys(cost.whatsapp).map((c) => (<option key={c} value={c}>{c}</option>))}
              </select>
            </label>
            <label>Tipo de cambio USD→CLP
              <input type="number" value={fx} onChange={(e) => setFx(Number(e.target.value))} className={input} />
            </label>
          </div>
        </div>

        {/* IA */}
        <div className={card}>
          <h2 className="mb-2 font-semibold text-navy-900">Motor de IA</h2>
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
            <label className="col-span-2">Modelo
              <select value={model} onChange={(e) => setModel(e.target.value)} className={input}>
                {Object.keys(cost.models).map((k) => (<option key={k} value={k}>{k}</option>))}
              </select>
            </label>
            <label>Conversaciones / mes<input type="number" value={convos} onChange={(e) => setConvos(Number(e.target.value))} className={input} /></label>
            <label>&nbsp;<div className="mt-1 text-[11px] text-slate-400">Tokens por conversación:</div></label>
            <label>Entrada<input type="number" value={inTok} onChange={(e) => setInTok(Number(e.target.value))} className={input} /></label>
            <label>Salida<input type="number" value={outTok} onChange={(e) => setOutTok(Number(e.target.value))} className={input} /></label>
          </div>
          <p className="mt-2 text-xs text-slate-500">Costo IA: <b>{money(calc.aiCost)}</b>/mes</p>
        </div>

        {/* Mensajes Meta */}
        <div className={card}>
          <h2 className="mb-2 font-semibold text-navy-900">Mensajes de plantilla (Meta cobra)</h2>
          <div className="grid grid-cols-3 gap-2 text-xs text-slate-600">
            <label>Marketing / mes<input type="number" value={mkt} onChange={(e) => setMkt(Number(e.target.value))} className={input} /></label>
            <label>Utilidad (fuera 24 h)<input type="number" value={util} onChange={(e) => setUtil(Number(e.target.value))} className={input} /></label>
            <label>Autenticación<input type="number" value={auth} onChange={(e) => setAuth(Number(e.target.value))} className={input} /></label>
          </div>
          <p className="mt-2 text-xs text-slate-500">Costo mensajes: <b>{money(calc.msgCost)}</b>/mes ({calc.msgTotal.toLocaleString("es-CL")} msgs) · <span className="text-slate-400">servicio dentro de 24 h = gratis</span></p>
        </div>

        {/* Meta Ads */}
        <div className={card}>
          <h2 className="mb-2 font-semibold text-navy-900">Meta Ads</h2>
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
            <label>Gasto en ads / mes (USD)<input type="number" value={adSpend} onChange={(e) => setAdSpend(Number(e.target.value))} className={input} /></label>
            <label>Margen si lo revendes (%)<input type="number" value={adMarkup} onChange={(e) => setAdMarkup(Number(e.target.value))} className={input} /></label>
          </div>
          <label className="mt-2 flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" checked={adIsCost} onChange={(e) => setAdIsCost(e.target.checked)} /> El gasto en ads es MI costo (lo pago yo)
          </label>
          {calc.adResaleProfit > 0 && <p className="mt-1 text-xs text-emerald-700">Ganancia por reventa de ads: {money(calc.adResaleProfit)}/mes (informativo)</p>}
        </div>
      </div>

      {/* Precio y resultado */}
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className={card}>
          <h2 className="mb-2 font-semibold text-navy-900">Precio y margen</h2>
          <div className="grid grid-cols-2 gap-2 text-xs text-slate-600">
            <label>Precio del plan (USD/mes)<input type="number" value={priceUsd} onChange={(e) => setPriceUsd(Number(e.target.value))} className={input} /></label>
            <label>Margen objetivo (%)<input type="number" value={targetMargin} onChange={(e) => setTargetMargin(Number(e.target.value))} className={input} /></label>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {plans.map((p) => (
              <button key={p.code} onClick={() => setPriceUsd(Number(p.priceUsd))} className="rounded border border-slate-300 px-2 py-0.5 text-[11px] hover:bg-slate-50">
                {p.name} (US${Number(p.priceUsd)})
              </button>
            ))}
          </div>
        </div>

        <div className={`${card} bg-navy-900 text-white`}>
          <h2 className="mb-2 font-semibold">Resultado mensual</h2>
          <div className="space-y-1 text-sm">
            <Row label="Costo IA" value={money(calc.aiCost)} />
            <Row label="Costo mensajes Meta" value={money(calc.msgCost)} />
            {adIsCost && <Row label="Costo Meta Ads" value={money(calc.adsCostToYou)} />}
            <div className="my-1 h-px bg-white/20" />
            <Row label="Costo total" value={money(calc.totalCost)} strong />
            <Row label={`≈ en CLP`} value={`$${Math.round(calc.totalCost * fx).toLocaleString("es-CL")}`} muted />
            <div className="my-1 h-px bg-white/20" />
            <Row label="Precio del plan" value={money(priceUsd)} />
            <Row label="Margen bruto" value={`${calc.margin.toFixed(0)}%`} strong tone={calc.margin >= targetMargin ? "ok" : "warn"} />
            <Row label={`Precio sugerido (${targetMargin}% margen)`} value={Number.isFinite(calc.suggested) ? money(calc.suggested) : "—"} />
          </div>
        </div>
      </div>

      {/* Editor MASIVO de tarifas de Meta + tipo de cambio (se guardan) */}
      <div className={`${card} mt-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold text-navy-900">⚙ Tarifas de Meta y tipo de cambio (se guardan)</h2>
          <div className="flex items-center gap-2">
            <label className="text-xs text-slate-600">USD→CLP
              <input type="number" value={fx} onChange={(e) => setFx(Number(e.target.value))} className="ml-1 w-24 rounded border border-slate-300 px-2 py-1 text-sm" />
            </label>
            <button onClick={() => void saveAllRates()} disabled={savingRates} className="rounded-lg bg-navy-900 px-3 py-2 text-xs font-semibold text-white hover:bg-navy-800 disabled:opacity-50">
              {savingRates ? "Guardando…" : "Guardar todo"}
            </button>
          </div>
        </div>
        <p className="mt-0.5 text-[11px] text-slate-500">
          Afectan la <b>facturación real</b> (costo Meta por tenant + excedente en CLP). Precio por mensaje en USD. Edita
          varios países a la vez o pégalos en bloque. <b>Servicio dentro de 24 h = gratis; «default» = fallback.</b>
        </p>

        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="py-1 pr-2">País</th>
                <th className="py-1 pr-2">Marketing</th>
                <th className="py-1 pr-2">Utilidad</th>
                <th className="py-1 pr-2">Autenticación</th>
              </tr>
            </thead>
            <tbody>
              {Object.keys(allRates).sort().map((cc) => (
                <tr key={cc} className="border-t border-slate-100">
                  <td className="py-1 pr-2 font-mono font-medium text-navy-900">{cc}</td>
                  {(["marketing", "utility", "authentication"] as const).map((k) => (
                    <td key={k} className="py-1 pr-2">
                      <input type="number" step="0.001" value={allRates[cc][k]} onChange={(e) => setRate(cc, k, Number(e.target.value))} className="w-24 rounded border border-slate-300 px-2 py-1 text-right text-sm" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={newCountry} onChange={(e) => setNewCountry(e.target.value)} placeholder="Agregar país (ISO, ej: BR)" maxLength={3} className="w-40 rounded border border-slate-300 px-2 py-1 text-sm uppercase" />
          <button onClick={addCountry} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50">Agregar país</button>
        </div>

        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-medium text-slate-600">Pegar / importar rate card (JSON) — carga rápida de muchos países</summary>
          <p className="mt-1 text-[11px] text-slate-500">
            Pega un objeto tipo <span className="font-mono">{`{ "CL": { "marketing": 0.06, "utility": 0.018, "authentication": 0.03 }, "BR": { ... } }`}</span>. Se fusiona con lo actual; luego «Guardar todo».
          </p>
          <textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={4} placeholder='{ "CL": { "marketing": 0.06, "utility": 0.018, "authentication": 0.03 } }' className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 font-mono text-xs" />
          <button onClick={applyImport} disabled={!importText.trim()} className="mt-1 rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50 disabled:opacity-50">Aplicar al editor</button>
        </details>
      </div>

      <p className="mt-3 text-[11px] text-slate-400">
        Tarifas: IA por token (lista de modelos) y Meta por mensaje según país. El gasto en Meta Ads es del cliente salvo
        que marques que lo pagas tú. Cálculo referencial para fijar precios.
      </p>
    </div>
  );
}

function Row({ label, value, strong, muted, tone }: { label: string; value: string; strong?: boolean; muted?: boolean; tone?: "ok" | "warn" }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? "text-white/50" : "text-white/80"}>{label}</span>
      <span className={`${strong ? "font-bold" : ""} ${tone === "ok" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : ""}`}>{value}</span>
    </div>
  );
}
