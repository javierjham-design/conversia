"use client";

/** Monitor de infraestructura (Railway + Postgres) para el Super Admin. */
import { useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, useToast } from "@/components/ui";

interface Svc { id: string; name: string; cpu: number | null; cpuLimit: number | null; memoryGb: number | null; memoryLimitGb: number | null }
interface Project { id: string; name: string; services: Svc[]; usage: Record<string, number> }
interface Infra {
  configured: boolean;
  postgres: { connections: number; active: number; maxConnections: number; dbSizeBytes: number };
  railway?: Project[];
  error?: string;
}

/** Color por umbral: verde <60%, ámbar 60-85%, rojo >85%. */
function tone(pct: number): { bar: string; text: string } {
  if (pct >= 0.85) return { bar: "bg-red-500", text: "text-red-600" };
  if (pct >= 0.6) return { bar: "bg-amber-500", text: "text-amber-600" };
  return { bar: "bg-emerald-500", text: "text-emerald-600" };
}

function Bar({ pct, label }: { pct: number; label: string }) {
  const t = tone(pct);
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-slate-500">{label}</span>
        <span className={`font-medium ${t.text}`}>{Math.round(pct * 100)}%</span>
      </div>
      <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full ${t.bar}`} style={{ width: `${Math.min(100, Math.round(pct * 100))}%` }} />
      </div>
    </div>
  );
}

function human(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

export default function InfraPage() {
  const toast = useToast();
  const [data, setData] = useState<Infra | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await padmin<Infra>("/platform/infra"));
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);

  if (!data) return <div className="mx-auto max-w-[1100px] px-6 py-6"><Skeleton className="h-64" /></div>;

  const pg = data.postgres;
  const connPct = pg.maxConnections ? pg.connections / pg.maxConnections : 0;
  const connTone = tone(connPct);

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6 lg:px-8">
      <PageHeader title="Infraestructura" description="Uso de Railway y Postgres. Verde = holgado, ámbar = vigilar, rojo = actuar." />
      <div className="mb-4"><Button onClick={() => void load()} disabled={loading}>{loading ? "Actualizando…" : "Actualizar"}</Button></div>

      {/* Postgres — el cuello de botella #1 */}
      <div className="mb-5 rounded-card border border-slate-200 bg-white p-5 shadow-card">
        <div className="flex items-center justify-between">
          <p className="font-semibold">Postgres <span className="text-xs font-normal text-slate-400">(cuello de botella #1)</span></p>
          <span className={`text-xs font-medium ${connTone.text}`}>{pg.connections} / {pg.maxConnections} conexiones</span>
        </div>
        <div className="mt-3 max-w-md">
          <Bar pct={connPct} label={`Conexiones (${pg.active} activas)`} />
        </div>
        <p className="mt-2 text-xs text-slate-500">Tamaño de la base: <b>{human(pg.dbSizeBytes)}</b></p>
        {connPct >= 0.6 && (
          <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-700">
            ⚠ Conexiones altas. Qué hacer: baja <code>DB_CONNECTION_LIMIT</code> en las variables, reduce réplicas, o agrega <b>PgBouncer</b> como servicio.
          </p>
        )}
      </div>

      {/* Railway */}
      {!data.configured && (
        <div className="rounded-card border border-slate-200 bg-white p-5 text-sm text-slate-600 shadow-card">
          Falta la variable <code>RAILWAY_API_TOKEN</code> en Railway para ver CPU/RAM/uso por servicio. Agrégala (Account → Tokens) y recarga.
        </div>
      )}
      {data.error && (
        <div className="rounded-card border border-red-200 bg-red-50 p-4 text-sm text-red-700">Error consultando Railway: {data.error}</div>
      )}

      {data.railway?.map((proj) => (
        <div key={proj.id} className="mb-5 rounded-card border border-slate-200 bg-white p-5 shadow-card">
          <p className="font-semibold">{proj.name} <span className="text-xs font-normal text-slate-400">· {proj.services.length} servicios</span></p>

          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {proj.services.map((s) => {
              const cpuPct = s.cpu != null && s.cpuLimit ? s.cpu / s.cpuLimit : null;
              const memPct = s.memoryGb != null && s.memoryLimitGb ? s.memoryGb / s.memoryLimitGb : null;
              return (
                <div key={s.id} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                  <p className="text-sm font-medium text-slate-700">{s.name}</p>
                  <div className="mt-2 space-y-2">
                    {cpuPct != null ? <Bar pct={cpuPct} label={`CPU ${s.cpu!.toFixed(2)} / ${s.cpuLimit} vCPU`} /> : <p className="text-[11px] text-slate-400">CPU sin datos</p>}
                    {memPct != null ? <Bar pct={memPct} label={`RAM ${s.memoryGb!.toFixed(2)} / ${s.memoryLimitGb} GB`} /> : <p className="text-[11px] text-slate-400">RAM sin datos</p>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Uso mensual estimado del proyecto */}
          {Object.keys(proj.usage).length > 0 && (
            <div className="mt-3 flex flex-wrap gap-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
              <span>Uso mes estimado:</span>
              <span>RAM <b>{(proj.usage.MEMORY_USAGE_GB ?? 0).toFixed(0)}</b> GB-h</span>
              <span>Disco <b>{(proj.usage.DISK_USAGE_GB ?? 0).toFixed(0)}</b> GB-h</span>
              <span>Egress <b>{(proj.usage.NETWORK_TX_GB ?? 0).toFixed(2)}</b> GB</span>
              <span>Backups <b>{(proj.usage.BACKUP_USAGE_GB ?? 0).toFixed(0)}</b> GB-h</span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
