"use client";
import { useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";

/**
 * Infraestructura (super admin Conversia). Conexiones y tamaño de Postgres (el cuello
 * de botella #1) + métricas de Railway (CPU/RAM por servicio y uso mensual) si hay
 * RAILWAY_API_TOKEN. Solo lectura.
 */
type Svc = { id: string; name: string; cpu: number | null; cpuLimit: number | null; memoryGb: number | null; memoryLimitGb: number | null };
type Project = { id: string; name: string; services: Svc[]; usage: Record<string, number> };
type Infra = {
  configured: boolean;
  postgres: { connections: number; active: number; maxConnections: number; dbSizeBytes: number };
  railway?: Project[];
  error?: string;
};

/** Verde <60%, ámbar 60-85%, rojo >85%. */
function tone(pct: number): string {
  if (pct >= 0.85) return "var(--danger)";
  if (pct >= 0.6) return "var(--warn)";
  return "var(--ok)";
}

function human(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} KB`;
}

function Stat({ label, value, hint, color }: { label: string; value: string; hint?: string; color?: string }) {
  return (
    <div className="card" style={{ padding: 18 }}>
      <p className="text-dim" style={{ margin: 0, fontSize: 12 }}>{label}</p>
      <p className="display" style={{ margin: "6px 0 0", fontSize: 26, color: color ?? "var(--ink)" }}>{value}</p>
      {hint ? <p className="text-dim" style={{ margin: "4px 0 0", fontSize: 12 }}>{hint}</p> : null}
    </div>
  );
}

function Bar({ pct, label }: { pct: number; label: string }) {
  const color = tone(pct);
  const width = Math.min(100, Math.round(pct * 100));
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
        <span className="text-dim">{label}</span>
        <span style={{ fontWeight: 600, color }}>{Math.round(pct * 100)}%</span>
      </div>
      <div style={{ height: 8, width: "100%", borderRadius: 999, background: "var(--hairline)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${width}%`, background: color }} />
      </div>
    </div>
  );
}

export default function AdminInfra() {
  const [data, setData] = useState<Infra | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    padmin<Infra>("/platform/infra")
      .then(setData)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const pg = data?.postgres;
  const connPct = pg && pg.maxConnections ? pg.connections / pg.maxConnections : 0;

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Infraestructura</h1>
      <p className="text-dim" style={{ margin: "0 0 16px", fontSize: 14 }}>Uso de Postgres y Railway. Verde = holgado, ámbar = vigilar, rojo = actuar. Solo lectura.</p>

      <button onClick={load} disabled={loading} className="btn-accent" style={{ marginBottom: 18, opacity: loading ? 0.6 : 1 }}>
        {loading ? "Actualizando…" : "Actualizar"}
      </button>

      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}

      {!data ? (
        <p className="text-dim">Cargando…</p>
      ) : (
        <>
          <h2 className="display" style={{ fontSize: 18, margin: "0 0 12px" }}>Postgres <span className="text-dim" style={{ fontSize: 12 }}>(cuello de botella #1)</span></h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14, marginBottom: 14 }}>
            <Stat label="Conexiones" value={`${pg!.connections} / ${pg!.maxConnections}`} hint={`${pg!.active} activas`} color={tone(connPct)} />
            <Stat label="Tamaño de la base" value={human(pg!.dbSizeBytes)} />
          </div>
          <div className="card" style={{ padding: 18, marginBottom: 22 }}>
            <div style={{ maxWidth: 440 }}>
              <Bar pct={connPct} label={`Uso de conexiones (${pg!.active} activas)`} />
            </div>
            {connPct >= 0.6 ? (
              <p style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, background: "var(--acc-dim)", color: "var(--ink)", fontSize: 12 }}>
                ⚠ Conexiones altas. Qué hacer: baja <code>DB_CONNECTION_LIMIT</code> en las variables, reduce réplicas, o agrega PgBouncer como servicio.
              </p>
            ) : null}
          </div>

          <h2 className="display" style={{ fontSize: 18, margin: "0 0 12px" }}>Railway</h2>
          {!data.configured ? (
            <div className="card" style={{ padding: 18 }}>
              <p className="text-dim" style={{ margin: 0, fontSize: 13 }}>
                Falta la variable <code>RAILWAY_API_TOKEN</code> en Railway para ver CPU/RAM y uso por servicio. Agrégala (Account → Tokens) y recarga.
              </p>
            </div>
          ) : data.error ? (
            <div className="card" style={{ padding: 18, borderColor: "var(--danger)" }}>
              <p style={{ margin: 0, fontSize: 13, color: "var(--danger)" }}>Error consultando Railway: {data.error}</p>
            </div>
          ) : (
            data.railway?.map((proj) => (
              <div key={proj.id} className="card" style={{ padding: 18, marginBottom: 14 }}>
                <p style={{ margin: "0 0 12px", fontWeight: 600 }}>
                  {proj.name} <span className="text-dim" style={{ fontSize: 12 }}>· {proj.services.length} servicios</span>
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
                  {proj.services.map((s) => {
                    const cpuPct = s.cpu != null && s.cpuLimit ? s.cpu / s.cpuLimit : null;
                    const memPct = s.memoryGb != null && s.memoryLimitGb ? s.memoryGb / s.memoryLimitGb : null;
                    return (
                      <div key={s.id} style={{ borderRadius: 12, border: "1px solid var(--hairline)", background: "var(--surface-solid)", padding: 12 }}>
                        <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 600 }}>{s.name}</p>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {cpuPct != null ? <Bar pct={cpuPct} label={`CPU ${s.cpu!.toFixed(2)} / ${s.cpuLimit} vCPU`} /> : <p className="text-dim" style={{ margin: 0, fontSize: 11 }}>CPU sin datos</p>}
                          {memPct != null ? <Bar pct={memPct} label={`RAM ${s.memoryGb!.toFixed(2)} / ${s.memoryLimitGb} GB`} /> : <p className="text-dim" style={{ margin: 0, fontSize: 11 }}>RAM sin datos</p>}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {Object.keys(proj.usage).length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 16, borderTop: "1px solid var(--hairline)", marginTop: 14, paddingTop: 12, fontSize: 12, color: "var(--ink-dim)" }}>
                    <span>Uso mes estimado:</span>
                    <span>RAM <b>{(proj.usage.MEMORY_USAGE_GB ?? 0).toFixed(0)}</b> GB-h</span>
                    <span>Disco <b>{(proj.usage.DISK_USAGE_GB ?? 0).toFixed(0)}</b> GB-h</span>
                    <span>Egress <b>{(proj.usage.NETWORK_TX_GB ?? 0).toFixed(2)}</b> GB</span>
                    <span>Backups <b>{(proj.usage.BACKUP_USAGE_GB ?? 0).toFixed(0)}</b> GB-h</span>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
