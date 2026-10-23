"use client";

import { useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";
import { PageHeader, Skeleton, useToast } from "@/components/ui";

interface Alert {
  id: string;
  provider: string;
  type: string;
  status: string;
  message: string | null;
  org: string;
  createdAt: string;
}

interface Quality {
  windowHours: number;
  aiRequests: number;
  avgResponseMs: number;
  aiErrors: number;
  aiRefusals: number;
  failedOutbound: number;
  inbound: number;
  botReplies: number;
  responseRatePct: number;
  topFailingTenants: { organizationId: string; name: string; failed: number }[];
}

function Metric({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${warn ? "text-red-600" : "text-navy-900"}`}>{value}</div>
    </div>
  );
}

interface WaTokenHealth {
  ok: boolean;
  globalOk: boolean;
  globalDetail: string | null;
  checked: number;
  stale: boolean;
  hasData: boolean;
  ts: number | null;
  dead: { organizationId: string; phone: string | null; name: string | null; detail: string }[];
}

export default function AlertsPage() {
  const toast = useToast();
  const [rows, setRows] = useState<Alert[] | null>(null);
  const [q, setQ] = useState<Quality | null>(null);
  const [wa, setWa] = useState<WaTokenHealth | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [a, quality, waHealth] = await Promise.all([
      padmin<Alert[]>("/platform/alerts"),
      padmin<Quality>("/platform/quality"),
      padmin<WaTokenHealth>("/platform/whatsapp-token-health").catch(() => null),
    ]);
    setRows(a);
    setQ(quality);
    setWa(waHealth);
  }, []);
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Re-dispara el chequeo activo de tokens de WhatsApp y recarga. Tras corregir un token en
  // Railway, detecta la recuperación al instante (no espera el ciclo de 15 min) y limpia la alerta.
  const recheck = useCallback(async () => {
    setBusy(true);
    try {
      await padmin("/platform/alerts/recheck", { method: "POST" });
      // El barrido corre en el worker; dale un momento y recarga.
      await new Promise((r) => setTimeout(r, 2500));
      await load();
      toast.push("Verificación re-ejecutada", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6 lg:px-8">
      <PageHeader title="Alertas" description="Avisos y errores de integración de todos los tenants (salud de Meta, IA en pausa, suspensiones…)." />

      <section className="mb-6">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-navy-900">Salud de tokens de WhatsApp</h2>
          <button
            type="button"
            onClick={() => void recheck()}
            disabled={busy}
            title="Vuelve a verificar los tokens de WhatsApp y actualiza la lista"
            className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {busy ? "Revisando…" : "↻ Revisar de nuevo"}
          </button>
        </div>
        {!wa ? (
          <Skeleton className="h-16" />
        ) : (
          <div className={`rounded-card border p-4 shadow-card ${wa.ok ? "border-slate-200 bg-white" : "border-red-300 bg-red-50"}`}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${wa.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                {wa.ok ? "Todo vivo ✔" : "Hay tokens caídos"}
              </span>
              <span className="text-slate-600">
                Token global del Tech Provider: <b className={wa.globalOk ? "text-emerald-700" : "text-red-700"}>{wa.globalOk ? "vivo" : "CAÍDO"}</b>
                {!wa.globalOk && wa.globalDetail ? ` (${wa.globalDetail})` : ""}
                {wa.globalOk && wa.globalDetail ? <span className="ml-1 text-amber-600">· ⓘ {wa.globalDetail}</span> : null}
              </span>
              <span className="text-slate-500">{wa.checked} canal(es) verificado(s)</span>
              <span className="text-slate-400">
                Última verificación: {wa.ts ? new Date(wa.ts).toLocaleString("es-CL") : "aún sin datos"}{wa.stale ? " (desactualizada)" : ""}
              </span>
            </div>
            {wa.dead.length > 0 && (
              <ul className="mt-3 space-y-1 text-[13px]">
                {wa.dead.map((d, i) => (
                  <li key={i} className="flex gap-2 text-red-800">
                    <span className="font-medium">{d.name ?? "Canal"}{d.phone ? ` · ${d.phone}` : ""}:</span>
                    <span className="text-red-700">token caído — reemplazar en Railway</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-navy-900">Calidad del bot (últimas 24 h)</h2>
        {!q ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
              <Metric label="Tasa de respuesta" value={`${q.responseRatePct}%`} warn={q.responseRatePct < 90} />
              <Metric label="Tiempo medio" value={`${(q.avgResponseMs / 1000).toFixed(1)}s`} warn={q.avgResponseMs > 15000} />
              <Metric label="Respuestas IA" value={q.aiRequests} />
              <Metric label="Errores IA" value={q.aiErrors} warn={q.aiErrors > 0} />
              <Metric label="Rechazos IA" value={q.aiRefusals} />
              <Metric label="Envíos fallidos" value={q.failedOutbound} warn={q.failedOutbound > 0} />
            </div>
            {q.topFailingTenants.length > 0 && (
              <p className="mt-2 text-xs text-slate-500">
                Con más envíos fallidos:{" "}
                {q.topFailingTenants.map((t) => `${t.name} (${t.failed})`).join(" · ")}
              </p>
            )}
          </>
        )}
      </section>
      {!rows ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="overflow-x-auto rounded-card border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="p-3">Nivel</th>
                <th className="p-3">Tenant</th>
                <th className="p-3">Evento</th>
                <th className="p-3">Detalle</th>
                <th className="p-3">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-6 text-center text-slate-400">Sin alertas. Todo en orden ✔</td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="p-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          r.status === "error" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"
                        }`}
                      >
                        {r.status === "error" ? "error" : "aviso"}
                      </span>
                    </td>
                    <td className="p-3 font-medium text-navy-900">{r.org}</td>
                    <td className="p-3 text-slate-500">
                      <span className="text-slate-400">{r.provider}</span> · {r.type}
                    </td>
                    <td className="p-3 text-slate-600">{r.message ?? "—"}</td>
                    <td className="p-3 text-slate-400">{new Date(r.createdAt).toLocaleString("es-CL")}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
