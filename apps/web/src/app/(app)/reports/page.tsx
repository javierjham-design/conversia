"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL, api, getToken } from "@/lib/api";

interface Overview {
  days: number;
  conversations: { total: number; newInPeriod: number; openNow: number; humanControlNow: number };
  messages: { inbound: number; outbound: number };
  humanHandoffs: number;
  appointments: { status: string; count: number }[];
  leadFunnel: { code: string; name: string; category: string; count: number }[];
  series: {
    conversationsPerDay: { day: string; count: number }[];
    inboundPerDay: { day: string; count: number }[];
  };
}

function Kpi({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <p className="text-xs text-ink-subtle">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
      {hint && <p className="text-[11px] text-ink-subtle">{hint}</p>}
    </div>
  );
}

function Bars({ data }: { data: { day: string; count: number }[] | null | undefined }) {
  const rows = data ?? [];
  const max = Math.max(1, ...rows.map((d) => d.count));
  if (rows.length === 0) {
    return <div className="flex h-24 items-center justify-center text-sm text-ink-subtle">Sin datos en el período.</div>;
  }
  return (
    <div className="flex h-24 items-end gap-1">
      {rows.map((d) => (
        <div key={d.day} className="group relative flex-1">
          <div className="rounded-t bg-cyan-600/80 transition group-hover:bg-cyan-700" style={{ height: `${(d.count / max) * 88 + 4}px` }} />
          <span className="pointer-events-none absolute -top-5 left-1/2 hidden -translate-x-1/2 rounded bg-slate-800 px-1 text-[9px] text-white group-hover:block">
            {d.day.slice(5)}: {d.count}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function ReportsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await api<Overview>(`/reports/overview?days=${days}`));
  }, [days]);

  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, [load]);

  async function download(path: string, filename: string) {
    const res = await fetch(`${API_URL}${path}`, { headers: { authorization: `Bearer ${getToken()}` } });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (error) return <div className="p-6 text-red-600 dark:text-red-400">{error}</div>;
  if (!data) return <div className="p-6 text-ink-subtle">Cargando…</div>;

  const leadFunnel = data.leadFunnel ?? [];
  const appointments = data.appointments ?? [];
  const funnelMax = Math.max(1, ...leadFunnel.map((f) => f.count));
  const apptLabel: Record<string, string> = {
    PENDING: "pendientes",
    CONFIRMED: "confirmadas",
    CANCELLED: "canceladas",
    COMPLETED: "completadas",
    NO_SHOW: "no asistió",
    RESCHEDULED: "reagendadas",
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Reportes</h1>
          <p className="text-sm text-ink-muted">Actividad y conversión de leads de tu cuenta.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm">
            <option value={7}>Últimos 7 días</option>
            <option value={30}>Últimos 30 días</option>
            <option value={90}>Últimos 90 días</option>
          </select>
          <button onClick={() => void download(`/reports/export/conversations?days=${days}`, `conversaciones_${days}d.csv`)} className="rounded-lg border border-line-strong px-3 py-2 text-sm hover:bg-app">
            ⬇ Conversaciones CSV
          </button>
          <button onClick={() => void download("/reports/export/leads", "leads.csv")} className="rounded-lg border border-line-strong px-3 py-2 text-sm hover:bg-app">
            ⬇ Leads CSV
          </button>
        </div>
      </div>

      <div className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Kpi label={`Conversaciones nuevas (${data.days}d)`} value={data.conversations.newInPeriod} hint={`${data.conversations.total} históricas`} />
        <Kpi label="Abiertas ahora" value={data.conversations.openNow} hint={`${data.conversations.humanControlNow} en control humano`} />
        <Kpi label={`Mensajes (${data.days}d)`} value={data.messages.inbound + data.messages.outbound} hint={`${data.messages.inbound} recibidos · ${data.messages.outbound} enviados`} />
        <Kpi label="Leads en el funnel" value={leadFunnel.reduce((acc, f) => acc + f.count, 0)} hint={`${data.humanHandoffs} escalados a humano (${data.days}d)`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 font-medium">Funnel de leads (actual)</h2>
          {leadFunnel.filter((f) => f.count > 0).length === 0 && (
            <p className="text-sm text-ink-subtle">Sin leads registrados aún.</p>
          )}
          <div className="space-y-1.5">
            {leadFunnel.filter((f) => f.count > 0).map((f) => (
              <div key={f.code} className="flex items-center gap-2 text-sm">
                <span className="w-40 truncate text-xs text-ink-muted">{f.name}</span>
                <div className="h-5 rounded bg-cyan-600/80" style={{ width: `${(f.count / funnelMax) * 60 + 4}%` }} />
                <span className="text-xs font-medium">{f.count}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 font-medium">Citas ({data.days}d)</h2>
          {appointments.length === 0 ? (
            <p className="text-sm text-ink-subtle">Sin citas en el período.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {appointments.map((a) => (
                <div key={a.status} className="rounded-lg bg-app px-4 py-2 text-center">
                  <p className="text-xl font-semibold">{a.count}</p>
                  <p className="text-xs text-ink-muted">{apptLabel[a.status] ?? a.status}</p>
                </div>
              ))}
            </div>
          )}
          <p className="mt-4 border-t border-line pt-3 text-sm">
            Escalamientos a humano en el período: <b>{data.humanHandoffs}</b>
          </p>
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 font-medium">Conversaciones nuevas por día (14d)</h2>
          <Bars data={data.series?.conversationsPerDay} />
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 font-medium">Mensajes recibidos por día (14d)</h2>
          <Bars data={data.series?.inboundPerDay} />
        </section>
      </div>
    </div>
  );
}
