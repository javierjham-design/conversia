"use client";

import { useEffect, useState } from "react";
import { Building2, Cpu, DollarSign, Users } from "lucide-react";
import { padmin } from "@/lib/platform-api";
import { MetricCard, PageHeader, Skeleton } from "@/components/ui";

interface Metrics {
  organizations: { total: number; active: number; trialing: number; suspended: number };
  subscriptionsActive: number;
  mrr: { clp: number; usd: number };
  aiCostUsd30d: number;
  aiRequests30d: number;
  whatsappCostUsd30d: number;
  whatsappMessages30d: number;
  revenuePaidClp: number;
}

const clp = (n: number) => `$${n.toLocaleString("es-CL")}`;

export default function PlatformOverview() {
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void padmin<Metrics>("/platform/metrics").then(setM).catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div className="mx-auto max-w-[1300px] px-6 py-6 lg:px-8">
      <PageHeader title="Resumen de la plataforma" description="Estado global de organizaciones, suscripciones e ingresos." />
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!m ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Organizaciones" value={m.organizations.total} hint={`${m.organizations.active} activas · ${m.organizations.trialing} trial · ${m.organizations.suspended} suspendidas`} icon={<Building2 size={16} />} />
            <MetricCard label="Suscripciones activas" value={m.subscriptionsActive} icon={<Users size={16} />} />
            <MetricCard label="MRR (aprox.)" value={clp(m.mrr.clp)} hint={`USD ${m.mrr.usd.toLocaleString("en-US")}`} tone="ok" icon={<DollarSign size={16} />} />
            <MetricCard label="Ingresos cobrados" value={clp(m.revenuePaidClp)} hint="facturas pagadas" icon={<DollarSign size={16} />} />
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <MetricCard label="Costo IA (30 d)" value={`US$ ${m.aiCostUsd30d.toFixed(2)}`} hint={`${m.aiRequests30d.toLocaleString("es-CL")} requests`} icon={<Cpu size={16} />} />
            <MetricCard label="Costo Meta / WhatsApp (30 d)" value={`US$ ${(m.whatsappCostUsd30d ?? 0).toFixed(2)}`} hint={`${(m.whatsappMessages30d ?? 0).toLocaleString("es-CL")} mensajes facturables · tarifa aprox.`} icon={<DollarSign size={16} />} />
            <MetricCard label="Margen bruto (aprox.)" value={m.mrr.usd > 0 ? `${Math.round((1 - (m.aiCostUsd30d + (m.whatsappCostUsd30d ?? 0)) / Math.max(m.mrr.usd, 1)) * 100)}%` : "—"} hint="MRR USD vs costo IA + Meta 30d — referencial" />
          </div>
        </>
      )}
    </div>
  );
}
