"use client";

import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";
import { api } from "@/lib/api";
import { Button, PageHeader, Skeleton, StatusBadge, useToast } from "@/components/ui";

interface Overview {
  organization: { name: string; status: string; currency: string };
  plan: { code: string; name: string; priceClp: number; priceUsd: number; interval: string } | null;
  subscription: { status: string; periodEnd: string | null } | null;
  usage: Record<string, { used: number; limit: number | null }>;
  invoices: Array<{ id: string; number: string; status: string; currency: string; amountDue: string; createdAt: string }>;
}
interface Plan {
  code: string;
  name: string;
  priceClp: string;
  priceUsd: string;
  interval: string;
  limits: Record<string, number>;
  features: Record<string, boolean>;
}

const USAGE_LABELS: Record<string, string> = {
  agents: "Agentes IA",
  channels: "Canales",
  workflows: "Flujos",
  users: "Usuarios",
  aiTokensToday: "Tokens IA hoy",
};

export default function BillingPage() {
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);

  const load = useCallback(async () => {
    const [o, p] = await Promise.all([api<Overview>("/billing/me"), api<Plan[]>("/billing/plans")]);
    setData(o);
    setPlans(p);
  }, []);
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function choose(planCode: string) {
    try {
      const session = await api<{ url: string; mock: boolean }>("/billing/checkout", { method: "POST", body: JSON.stringify({ planCode }) });
      if (session.mock) {
        // Dev: confirmación simulada (en prod redirige a la pasarela)
        await api("/billing/mock-confirm", { method: "POST", body: JSON.stringify({ planCode }) });
        toast.push("Plan activado (pago simulado en desarrollo)", "ok");
        await load();
      } else {
        window.location.href = session.url;
      }
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }

  const currency = data?.organization.currency ?? "CLP";
  const price = (p: Plan) => (currency === "CLP" ? `$${Number(p.priceClp).toLocaleString("es-CL")}` : `US$${Number(p.priceUsd)}`);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1100px] px-6 py-6 lg:px-8">
        <PageHeader title="Plan y facturación" description="Tu plan actual, consumo del período y facturas." />
        {!data ? (
          <Skeleton className="h-40" />
        ) : (
          <>
            {/* Plan actual + uso */}
            <div className="mb-6 grid gap-4 lg:grid-cols-3">
              <div className="rounded-card border border-slate-200 bg-white p-5 shadow-card">
                <p className="text-xs text-slate-400">Plan actual</p>
                <p className="text-2xl font-semibold">{data.plan?.name ?? "Sin plan"}</p>
                {data.subscription && <StatusBadge kind={data.subscription.status === "ACTIVE" ? "connected" : "beta"} label={data.subscription.status.toLowerCase()} />}
                {data.subscription?.periodEnd && <p className="mt-2 text-xs text-slate-400">Renueva {new Date(data.subscription.periodEnd).toLocaleDateString("es-CL")}</p>}
              </div>
              <div className="lg:col-span-2 rounded-card border border-slate-200 bg-white p-5 shadow-card">
                <p className="mb-3 text-sm font-medium">Consumo del período</p>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {Object.entries(data.usage).map(([k, v]) => {
                    const pct = v.limit && v.limit > 0 ? Math.min(100, Math.round((v.used / v.limit) * 100)) : 0;
                    return (
                      <div key={k}>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">{USAGE_LABELS[k] ?? k}</span>
                          <span className="font-medium">{v.used.toLocaleString("es-CL")}{v.limit ? ` / ${v.limit === 0 ? "∞" : v.limit.toLocaleString("es-CL")}` : ""}</span>
                        </div>
                        {v.limit && v.limit > 0 && (
                          <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                            <div className={`h-1.5 rounded-full ${pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-brand-600"}`} style={{ width: `${pct}%` }} />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Planes disponibles */}
            <h2 className="mb-3 text-lg font-semibold">Planes disponibles</h2>
            <div className="mb-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {plans.map((p) => {
                const current = data.plan?.code === p.code;
                return (
                  <div key={p.code} className={`rounded-card border bg-white p-5 shadow-card ${current ? "border-brand-400 ring-1 ring-brand-200" : "border-slate-200"}`}>
                    <p className="font-semibold">{p.name}</p>
                    <p className="mt-1 text-2xl font-bold">{price(p)}<span className="text-sm font-normal text-slate-400">/{p.interval === "yearly" ? "año" : "mes"}</span></p>
                    <ul className="mt-3 space-y-1 text-xs text-slate-600">
                      {Object.entries(p.limits).slice(0, 5).map(([k, v]) => (
                        <li key={k} className="flex items-center gap-1.5"><Check size={12} className="text-emerald-500" /> {k}: {v === 0 ? "ilimitado" : v.toLocaleString("es-CL")}</li>
                      ))}
                    </ul>
                    <Button
                      variant={current ? "secondary" : "primary"}
                      className="mt-4 w-full"
                      disabled={current}
                      onClick={() => void choose(p.code)}
                    >
                      {current ? "Plan actual" : "Elegir plan"}
                    </Button>
                  </div>
                );
              })}
            </div>

            {/* Facturas */}
            <h2 className="mb-3 text-lg font-semibold">Facturas</h2>
            {data.invoices.length === 0 ? (
              <p className="text-sm text-slate-400">Aún no hay facturas.</p>
            ) : (
              <div className="overflow-x-auto rounded-card border border-slate-200 bg-white shadow-card">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs text-slate-500">
                    <tr><th className="p-3">Número</th><th className="p-3">Monto</th><th className="p-3">Estado</th><th className="p-3">Fecha</th></tr>
                  </thead>
                  <tbody>
                    {data.invoices.map((inv) => (
                      <tr key={inv.id} className="border-t border-slate-100">
                        <td className="p-3 font-mono text-xs">{inv.number}</td>
                        <td className="p-3">{inv.currency} {Number(inv.amountDue).toLocaleString("es-CL")}</td>
                        <td className="p-3">{inv.status.toLowerCase()}</td>
                        <td className="p-3 text-xs text-slate-400">{new Date(inv.createdAt).toLocaleDateString("es-CL")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-4 text-xs text-slate-400">
              El cobro se procesa mediante la pasarela configurada. En desarrollo el pago es simulado; en producción se integra Stripe (ver docs/BILLING.md).
            </p>
          </>
        )}
      </div>
    </div>
  );
}
