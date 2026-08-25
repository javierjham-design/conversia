"use client";

import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { API_URL, api, getToken } from "@/lib/api";
import { Select } from "@/components/ui";

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

const CHART_DAYS = 14;

function Kpi({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <p className="text-xs text-ink-subtle">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tnum">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-ink-subtle">{hint}</p>}
    </div>
  );
}

/** Devuelve los últimos N días (YYYY-MM-DD, hora local) con el conteo real o 0. */
function fillDays(data: { day: string; count: number }[] | null | undefined, n: number): { day: string; count: number }[] {
  const byDay = new Map((data ?? []).map((d) => [d.day, d.count]));
  const out: { day: string; count: number }[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    out.push({ day: key, count: byDay.get(key) ?? 0 });
  }
  return out;
}

function fmtDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1).toLocaleDateString("es-CL", { day: "numeric", month: "short" });
}

/** Barras por día con eje Y (máximo), ticks de fecha, línea base y ceros rellenados. */
function DayBars({ data }: { data: { day: string; count: number }[] | null | undefined }) {
  const rows = fillDays(data, CHART_DAYS);
  const max = Math.max(1, ...rows.map((d) => d.count));
  const total = rows.reduce((a, d) => a + d.count, 0);
  return (
    <div>
      <div className="flex gap-2">
        {/* Eje Y: máximo y cero */}
        <div className="flex w-6 shrink-0 flex-col justify-between py-0.5 text-right text-[9px] tnum text-ink-subtle">
          <span>{max}</span>
          <span>0</span>
        </div>
        <div className="relative flex-1">
          {/* Línea base */}
          <div className="absolute inset-x-0 bottom-0 border-b border-line" />
          <div className="flex h-24 items-end gap-1">
            {rows.map((d) => (
              <div key={d.day} className="group relative flex flex-1 justify-center">
                <div
                  className="w-full rounded-t bg-brand-500/80 transition-colors group-hover:bg-brand-600"
                  style={{ height: `${(d.count / max) * 92 + (d.count > 0 ? 3 : 1)}px` }}
                />
                <span className="pointer-events-none absolute -top-6 left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded bg-navy-950 px-1.5 py-0.5 text-[9px] text-white group-hover:block dark:bg-raised dark:text-ink dark:ring-1 dark:ring-line">
                  {fmtDay(d.day)}: {d.count}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Eje X: primer y último día del tramo + total */}
      <div className="mt-1 flex justify-between pl-8 text-[9px] text-ink-subtle">
        <span>{fmtDay(rows[0]!.day)}</span>
        <span className="tnum">{total} en total</span>
        <span>{fmtDay(rows[rows.length - 1]!.day)}</span>
      </div>
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
  const funnelTotal = leadFunnel.reduce((acc, f) => acc + f.count, 0);
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
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Últimos 7 días</option>
            <option value={30}>Últimos 30 días</option>
            <option value={90}>Últimos 90 días</option>
          </Select>
          <button onClick={() => void download(`/reports/export/conversations?days=${days}`, `conversaciones_${days}d.csv`)} className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-2 text-sm hover:bg-app">
            <Download size={15} /> Conversaciones
          </button>
          <button onClick={() => void download("/reports/export/leads", "leads.csv")} className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-3 py-2 text-sm hover:bg-app">
            <Download size={15} /> Leads
          </button>
        </div>
      </div>

      <div className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Kpi label={`Conversaciones nuevas (${data.days}d)`} value={data.conversations.newInPeriod} hint={`${data.conversations.total} históricas`} />
        <Kpi label="Abiertas ahora" value={data.conversations.openNow} hint={`${data.conversations.humanControlNow} en control humano`} />
        <Kpi label={`Mensajes (${data.days}d)`} value={data.messages.inbound + data.messages.outbound} hint={`${data.messages.inbound} recibidos · ${data.messages.outbound} enviados`} />
        <Kpi label="Escalamientos a humano" value={data.humanHandoffs} hint={`en los últimos ${data.days} días`} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-panel p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-medium">Embudo de leads (actual)</h2>
            <span className="text-xs text-ink-subtle tnum">{funnelTotal} leads</span>
          </div>
          {leadFunnel.length === 0 ? (
            <p className="text-sm text-ink-subtle">Sin etapas configuradas.</p>
          ) : (
            <div className="space-y-1.5">
              {leadFunnel.map((f) => (
                <div key={f.code} className="flex items-center gap-2 text-sm">
                  <span className="w-40 shrink-0 truncate text-xs text-ink-muted" title={f.name}>{f.name}</span>
                  <div className="h-5 flex-1 rounded bg-app">
                    <div
                      className="h-5 rounded bg-brand-500/80"
                      style={{ width: `${Math.max((f.count / funnelMax) * 100, f.count > 0 ? 6 : 0)}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right text-xs font-medium tnum">{f.count}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 font-medium">Citas ({data.days}d)</h2>
          {appointments.length === 0 ? (
            <p className="text-sm text-ink-subtle">Sin citas en el período.</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              {appointments.map((a) => (
                <div key={a.status} className="rounded-lg bg-app px-4 py-2 text-center">
                  <p className="text-xl font-semibold tnum">{a.count}</p>
                  <p className="text-xs text-ink-muted">{apptLabel[a.status] ?? a.status}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 font-medium">Conversaciones nuevas por día ({CHART_DAYS}d)</h2>
          <DayBars data={data.series?.conversationsPerDay} />
        </section>

        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-3 font-medium">Mensajes recibidos por día ({CHART_DAYS}d)</h2>
          <DayBars data={data.series?.inboundPerDay} />
        </section>
      </div>
    </div>
  );
}
