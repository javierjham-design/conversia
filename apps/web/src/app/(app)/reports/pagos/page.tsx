"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { API_URL, api, getToken } from "@/lib/api";
import { Skeleton, cn } from "@/components/ui";

type PaymentRow = {
  id: string;
  paidAt: string;
  subject: string;
  amount: number;
  currency: string;
  status: string;
  contact: { name: string; phone: string | null };
};
type PaymentsReport = {
  available: boolean;
  currency: string;
  range: { from: string; to: string };
  summary: { paidCount: number; paidTotal: number; pendingCount: number };
  byItem: { subject: string; count: number; total: number }[];
  payments: PaymentRow[];
};

const clp = (n: number) => `$${(n ?? 0).toLocaleString("es-CL")}`;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function Kpi({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <p className="text-xs text-ink-subtle">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tnum">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-ink-subtle">{hint}</p>}
    </div>
  );
}

export default function PaymentsReportPage() {
  const today = useMemo(() => new Date(), []);
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 30); return ymd(d); });
  const [to, setTo] = useState(() => ymd(new Date()));
  const [data, setData] = useState<PaymentsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<PaymentsReport>(`/reports/payments?from=${from}&to=${to}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);
  useEffect(() => void load(), [load]);

  function preset(days: number) {
    const t = new Date();
    const f = new Date(); f.setDate(f.getDate() - days);
    setFrom(ymd(f)); setTo(ymd(t));
  }
  function thisMonth() {
    const now = new Date();
    setFrom(ymd(new Date(now.getFullYear(), now.getMonth(), 1)));
    setTo(ymd(now));
  }

  async function downloadCsv() {
    const res = await fetch(`${API_URL}/reports/export/payments?from=${from}&to=${to}`, { headers: { authorization: `Bearer ${getToken()}` } });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `pagos_${from}_a_${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const inputCls = "rounded-control border border-line-strong bg-panel px-2 py-1.5 text-sm text-ink";
  const maxItem = Math.max(1, ...(data?.byItem ?? []).map((i) => i.total));

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-1">
        <Link href="/reports" className="inline-flex items-center gap-1 text-xs text-ink-subtle hover:text-ink"><ArrowLeft size={13} /> Reportes</Link>
      </div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Reporte de pagos</h1>
          <p className="text-sm text-ink-muted">Pagos recibidos e ítems cobrados en el período.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-ink-muted">Desde<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={cn(inputCls, "mt-1 block")} /></label>
          <label className="text-xs text-ink-muted">Hasta<input type="date" value={to} min={from} max={ymd(today)} onChange={(e) => setTo(e.target.value)} className={cn(inputCls, "mt-1 block")} /></label>
          <div className="flex gap-1">
            <button onClick={() => preset(7)} className="rounded-control border border-line px-2 py-1.5 text-xs text-ink-muted hover:bg-app">7d</button>
            <button onClick={() => preset(30)} className="rounded-control border border-line px-2 py-1.5 text-xs text-ink-muted hover:bg-app">30d</button>
            <button onClick={() => preset(90)} className="rounded-control border border-line px-2 py-1.5 text-xs text-ink-muted hover:bg-app">90d</button>
            <button onClick={thisMonth} className="rounded-control border border-line px-2 py-1.5 text-xs text-ink-muted hover:bg-app">Este mes</button>
          </div>
          <button onClick={() => void downloadCsv()} className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-2 text-sm hover:bg-app"><Download size={15} /> Exportar CSV</button>
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      {loading && !data ? (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}</div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : data && !data.available ? (
        <div className="rounded-xl border border-line bg-panel p-6 text-sm text-ink-muted">
          Aún no hay pagos registrados. Cuando tus agentes envíen links de pago (Flow) y se confirmen, aparecerán aquí.
        </div>
      ) : data ? (
        <div className={cn("space-y-6", loading && "opacity-60")}>
          {/* Resumen */}
          <div className="grid gap-3 sm:grid-cols-3">
            <Kpi label="Total recibido" value={clp(data.summary.paidTotal)} hint={`${data.summary.paidCount} pago${data.summary.paidCount === 1 ? "" : "s"} confirmado${data.summary.paidCount === 1 ? "" : "s"}`} />
            <Kpi label="Pagos recibidos" value={data.summary.paidCount} hint="cobros confirmados por Flow" />
            <Kpi label="Pendientes" value={data.summary.pendingCount} hint="links enviados sin pagar aún" />
          </div>

          {/* Por ítem cobrado */}
          <section className="rounded-xl border border-line bg-panel p-4">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="font-medium">Ítems cobrados</h2>
              <span className="text-xs text-ink-subtle">{data.byItem.length} ítem{data.byItem.length === 1 ? "" : "s"}</span>
            </div>
            {data.byItem.length === 0 ? (
              <p className="text-sm text-ink-subtle">Sin pagos en el período.</p>
            ) : (
              <div className="space-y-1.5">
                {data.byItem.map((it) => (
                  <div key={it.subject} className="flex items-center gap-3 text-sm">
                    <span className="w-48 shrink-0 truncate text-xs text-ink-muted" title={it.subject}>{it.subject}</span>
                    <div className="h-5 flex-1 rounded bg-app">
                      <div className="h-5 rounded bg-emerald-500/80" style={{ width: `${Math.max((it.total / maxItem) * 100, it.total > 0 ? 6 : 0)}%` }} />
                    </div>
                    <span className="w-10 shrink-0 text-right text-xs text-ink-subtle tnum">{it.count}</span>
                    <span className="w-24 shrink-0 text-right text-sm font-medium tnum">{clp(it.total)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Detalle de pagos */}
          <section className="rounded-xl border border-line bg-panel">
            <div className="flex items-baseline justify-between border-b border-line px-4 py-3">
              <h2 className="font-medium">Detalle de pagos recibidos</h2>
              <span className="text-xs text-ink-subtle">{data.payments.length} registro{data.payments.length === 1 ? "" : "s"}</span>
            </div>
            {data.payments.length === 0 ? (
              <p className="p-4 text-sm text-ink-subtle">Sin pagos recibidos en el período seleccionado.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-ink-subtle">
                      <th className="px-4 py-2 font-medium">Fecha</th>
                      <th className="px-4 py-2 font-medium">Contacto</th>
                      <th className="px-4 py-2 font-medium">Ítem cobrado</th>
                      <th className="px-4 py-2 text-right font-medium">Monto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.payments.map((p) => (
                      <tr key={p.id} className="border-t border-line">
                        <td className="whitespace-nowrap px-4 py-2 text-ink-muted tnum">{new Date(p.paidAt).toLocaleDateString("es-CL", { day: "2-digit", month: "short", year: "numeric" })}</td>
                        <td className="px-4 py-2">
                          <div className="text-ink">{p.contact.name}</div>
                          {p.contact.phone && <div className="text-2xs text-ink-subtle tnum">{p.contact.phone}</div>}
                        </td>
                        <td className="px-4 py-2 text-ink-muted">{p.subject}</td>
                        <td className="whitespace-nowrap px-4 py-2 text-right font-medium tnum">{clp(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-line-strong">
                      <td className="px-4 py-2 text-xs font-semibold text-ink-subtle" colSpan={3}>Total recibido</td>
                      <td className="px-4 py-2 text-right text-sm font-semibold tnum">{clp(data.summary.paidTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}
