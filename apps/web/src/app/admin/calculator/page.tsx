"use client";

/**
 * Calculadora de costos de planes (Super Admin): combina el costo del motor de IA,
 * el costo que cobra Meta por mensajes de plantilla, y el gasto en Meta Ads, para
 * estimar el costo mensual por cliente y sugerir precio según un margen objetivo.
 * Todo se calcula en el navegador con las tarifas reales del backend.
 */
import { useEffect, useMemo, useState } from "react";
import { PageHeader, Skeleton } from "@/components/ui";
import { padmin } from "@/lib/platform-api";

interface ModelPricing { inputPerMTok: number; outputPerMTok: number }
interface WaRates { marketing: number; utility: number; authentication: number; service: number }
interface CostModel { models: Record<string, ModelPricing>; whatsapp: Record<string, WaRates> }
interface PlanRow { code: string; name: string; priceClp: number; priceUsd: number; features: Record<string, any> }

const money = (n: number) => `US$${n.toFixed(2)}`;

export default function CalculatorPage() {
  const [cost, setCost] = useState<CostModel | null>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);

  // Escenario
  const [country, setCountry] = useState("CL");
  const [fx, setFx] = useState(950); // USD→CLP
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

  useEffect(() => {
    void padmin<CostModel>("/platform/cost-model").then(setCost).catch(() => setCost({ models: {}, whatsapp: {} }));
    void padmin<PlanRow[]>("/platform/plans").then(setPlans).catch(() => setPlans([]));
  }, []);

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

      <p className="mt-3 text-[11px] text-slate-400">
        Tarifas: IA por token (lista de modelos) y Meta por mensaje según país — ambas aproximadas y configurables. El
        gasto en Meta Ads es del cliente salvo que marques que lo pagas tú. Cálculo referencial para fijar precios.
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
