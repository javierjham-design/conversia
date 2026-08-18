"use client";

/** Super Admin — cobro recurrente: ingresos, fallos, suspendidas y próximos cobros. */
import { useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";
import { PageHeader, Skeleton, useToast } from "@/components/ui";

interface Overview {
  mrr: number;
  counts: { active: number; pastDue: number; suspended: number; canceling: number; failed30: number };
  upcoming: Array<{ org: string; nextChargeAt: string | null; interval: string }>;
}
const clp = (n: number) => `$${n.toLocaleString("es-CL")}`;

export default function RecurringPage() {
  const toast = useToast();
  const [d, setD] = useState<Overview | null>(null);
  const load = useCallback(async () => {
    try {
      setD(await padmin<Overview>("/platform/billing/recurring"));
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  if (!d) return <div className="mx-auto max-w-[1100px] px-6 py-6"><Skeleton className="h-64" /></div>;
  const cards = [
    { label: "MRR (ingreso recurrente mensual)", value: clp(d.mrr), tone: "text-emerald-600" },
    { label: "Suscripciones activas", value: d.counts.active },
    { label: "Pago pendiente (en ventana 48 h)", value: d.counts.pastDue, tone: d.counts.pastDue ? "text-amber-600" : "" },
    { label: "Suspendidas por impago", value: d.counts.suspended, tone: d.counts.suspended ? "text-red-600" : "" },
    { label: "Por cancelar (fin de período)", value: d.counts.canceling },
    { label: "Cobros fallidos (30 días)", value: d.counts.failed30, tone: d.counts.failed30 ? "text-amber-600" : "" },
  ];

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6 lg:px-8">
      <PageHeader title="Cobro recurrente" description="El estado del negocio de un vistazo: ingresos, fallos y próximos cobros." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((c) => (
          <div key={c.label} className="rounded-card border border-slate-200 bg-white p-4 shadow-card">
            <p className="text-xs text-slate-500">{c.label}</p>
            <p className={`mt-1 text-2xl font-semibold ${c.tone ?? "text-slate-800"}`}>{c.value}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 rounded-card border border-slate-200 bg-white p-5 shadow-card">
        <p className="text-sm font-semibold">Próximos cobros (7 días)</p>
        {d.upcoming.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">Sin cobros programados en los próximos 7 días.</p>
        ) : (
          <div className="mt-2 overflow-hidden rounded-lg border border-slate-100 text-sm">
            {d.upcoming.map((u, i) => (
              <div key={i} className="flex items-center justify-between border-b border-slate-100 px-3 py-2 last:border-0">
                <span>{u.org}</span>
                <span className="text-slate-500">{u.nextChargeAt ? new Date(u.nextChargeAt).toLocaleDateString("es-CL") : "—"} · {u.interval === "yearly" ? "anual" : "mensual"}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
