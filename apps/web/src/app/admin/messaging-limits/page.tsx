"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Gauge, ShieldAlert } from "lucide-react";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, useToast } from "@/components/ui";

interface Limits {
  global: number;
  perTenantDefault: number;
  todayGlobal: number;
  fuseTripped: boolean;
  clpPerMsg: { marketing: number; utility: number };
}

const clp = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`;

/** Muestra la equivalencia en pesos de un tope (rango utilidad→marketing). */
function ClpHint({ n, rate }: { n: number; rate: { marketing: number; utility: number } }) {
  if (!n || n <= 0) return null;
  return (
    <p className="mt-1 text-xs text-slate-500">
      ≈ {clp(n * rate.utility)}/día si todo es <b>utilidad</b> · hasta{" "}
      <b>{clp(n * rate.marketing)}/día</b> si todo es <b>marketing</b>
    </p>
  );
}

interface Weights {
  utility: number;
  authentication: number;
  marketing: number;
}

export default function MessagingLimitsPage() {
  const toast = useToast();
  const [data, setData] = useState<Limits | null>(null);
  const [global, setGlobal] = useState(0);
  const [perTenant, setPerTenant] = useState(0);
  const [weights, setWeights] = useState<Weights | null>(null);
  const [pricing, setPricing] = useState<{ priceClp: number | null; priceUsd: number | null }>({ priceClp: null, priceUsd: null });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const d = await padmin<Limits>("/platform/messaging-limits");
    setData(d);
    setGlobal(d.global);
    setPerTenant(d.perTenantDefault);
  }, []);

  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    void padmin<Weights>("/platform/wallet-weights").then(setWeights).catch(() => undefined);
    void padmin<{ priceClp: number | null; priceUsd: number | null }>("/platform/templates-pricing").then(setPricing).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function savePricing() {
    setBusy(true);
    try {
      await padmin("/platform/templates-pricing", { method: "PATCH", body: JSON.stringify(pricing) });
      toast.push("Precio de activación guardado ✔", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function saveWeights() {
    if (!weights) return;
    setBusy(true);
    try {
      await padmin("/platform/wallet-weights", { method: "PATCH", body: JSON.stringify(weights) });
      toast.push("Pesos guardados ✔", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await padmin("/platform/messaging-limits", { method: "PATCH", body: JSON.stringify({ global, perTenantDefault: perTenant }) });
      toast.push("Límites actualizados ✔", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="mx-auto max-w-2xl px-6 py-6"><Skeleton className="h-64" /></div>;

  const rate = data.clpPerMsg;

  return (
    <div className="mx-auto max-w-2xl px-6 py-6 lg:px-8">
      <PageHeader
        title="Límites de mensajería"
        description="Fusible global y tope por defecto por tenant. Solo afectan a mensajes de plantilla (los que cuestan); las respuestas dentro de 24 h nunca se tocan."
      />

      {/* Estado del fusible + consumo del día */}
      <div className={`mb-5 flex items-center gap-3 rounded-card border p-4 ${data.fuseTripped ? "border-red-300 bg-red-50" : "border-slate-200 bg-white"}`}>
        {data.fuseTripped ? <ShieldAlert size={22} className="text-red-500" /> : <Gauge size={22} className="text-brand-600" />}
        <div className="flex-1">
          <p className="text-sm font-medium text-navy-900">
            Consumo global de hoy: <b>{data.todayGlobal.toLocaleString("es-CL")}</b> / {data.global.toLocaleString("es-CL")} plantillas
          </p>
          <p className="text-xs text-slate-500">
            {data.fuseTripped
              ? "⚠ Fusible CORTADO: los envíos de plantilla están en pausa para todos. Sube el tope global y se reanudan."
              : `Equivale hoy a ~${clp(data.todayGlobal * rate.utility)}–${clp(data.todayGlobal * rate.marketing)} CLP.`}
          </p>
        </div>
      </div>

      <div className="space-y-5">
        {/* Fusible global */}
        <div className="rounded-card border border-slate-200 bg-white p-5 shadow-card">
          <label className="block text-sm font-medium text-navy-900">Fusible global (plantillas/día, toda la plataforma)</label>
          <p className="mb-2 text-xs text-slate-500">Al superarlo, se cortan los envíos de plantilla de todos los tenants y te llega alerta. Es la red contra un bug o abuso masivo.</p>
          <input
            type="number"
            min={1}
            value={global}
            onChange={(e) => setGlobal(Number(e.target.value))}
            className="w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <ClpHint n={global} rate={rate} />
        </div>

        {/* Tope por defecto por tenant */}
        <div className="rounded-card border border-slate-200 bg-white p-5 shadow-card">
          <label className="block text-sm font-medium text-navy-900">Tope por defecto por tenant (plantillas/día)</label>
          <p className="mb-2 text-xs text-slate-500">Se aplica a cada tenant que no tenga un tope propio. El tope propio se fija en la ficha de cada organización.</p>
          <input
            type="number"
            min={1}
            value={perTenant}
            onChange={(e) => setPerTenant(Number(e.target.value))}
            className="w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <ClpHint n={perTenant} rate={rate} />
        </div>

        {/* Bolsa prepagada: pesos por categoría (A=1/1/1 por cantidad · B=marketing>1) */}
        {weights && (
          <div className="rounded-card border border-slate-200 bg-white p-5 shadow-card">
            <label className="block text-sm font-medium text-navy-900">Peso por categoría en la bolsa</label>
            <p className="mb-2 text-xs text-slate-500">
              Cuántos créditos descuenta cada mensaje. <b>1/1/1</b> = por cantidad (modo A). Sube <b>marketing</b> (p. ej. 4) para proteger margen (modo B), ya que marketing cuesta ~4× una utilidad.
            </p>
            <div className="flex flex-wrap gap-3 text-sm">
              {(["utility", "authentication", "marketing"] as const).map((k) => (
                <label key={k} className="flex items-center gap-1.5">
                  <span className="text-slate-600">{k === "utility" ? "Utilidad" : k === "authentication" ? "Auth" : "Marketing"}</span>
                  <input type="number" min={1} max={100} value={weights[k]} onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })} className="w-16 rounded-lg border border-slate-300 px-2 py-1 text-sm" />
                </label>
              ))}
              <Button variant="secondary" disabled={busy} onClick={() => void saveWeights()}>Guardar pesos</Button>
            </div>
          </div>
        )}

        {/* Precio de activación de mensajes de plantilla (servicio adicional) */}
        <div className="rounded-card border border-slate-200 bg-white p-5 shadow-card">
          <label className="block text-sm font-medium text-navy-900">Precio de activación de mensajes de plantilla</label>
          <p className="mb-2 text-xs text-slate-500">
            Precio de referencia para cobrar la activación de la capacidad de plantillas por cliente (servicio adicional).
            Se muestra en el panel del cliente cuando la función no está incluida. Déjalo vacío si va incluida en el plan.
          </p>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="text-slate-600">CLP</span>
              <input
                type="number"
                min={0}
                value={pricing.priceClp ?? ""}
                onChange={(e) => setPricing((p) => ({ ...p, priceClp: e.target.value === "" ? null : Number(e.target.value) }))}
                className="w-32 rounded-lg border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-slate-600">USD</span>
              <input
                type="number"
                min={0}
                value={pricing.priceUsd ?? ""}
                onChange={(e) => setPricing((p) => ({ ...p, priceUsd: e.target.value === "" ? null : Number(e.target.value) }))}
                className="w-28 rounded-lg border border-slate-300 px-2 py-1 text-sm"
              />
            </label>
            <Button variant="secondary" disabled={busy} onClick={() => void savePricing()}>Guardar precio</Button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button disabled={busy || global < 1 || perTenant < 1} onClick={() => void save()}>
            {busy ? "Guardando…" : "Guardar límites"}
          </Button>
          <span className="flex items-center gap-1.5 text-xs text-slate-500">
            <AlertTriangle size={13} /> Tarifa de referencia (Chile): utilidad {clp(rate.utility)} · marketing {clp(rate.marketing)} por mensaje.
          </span>
        </div>
      </div>
    </div>
  );
}
