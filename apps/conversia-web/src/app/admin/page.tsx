"use client";
import { useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";

type Metrics = {
  organizations: { total: number; active: number; trialing: number; suspended: number };
  subscriptionsActive: number;
  mrr: { clp: number; usd: number };
  aiCostUsd30d: number;
  aiRequests30d: number;
  whatsappCostUsd30d: number;
  whatsappMessages30d: number;
  revenuePaidClp: number;
};
type Quality = {
  windowHours: number;
  aiRequests: number;
  avgResponseMs: number;
  aiErrors: number;
  aiRefusals: number;
  failedOutbound: number;
  responseRatePct: number;
  topFailingTenants: { organizationId: string; name: string; failed: number }[];
};

const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card" style={{ padding: 18 }}>
      <p className="text-dim" style={{ margin: 0, fontSize: 12 }}>{label}</p>
      <p className="display" style={{ margin: "6px 0 0", fontSize: 26 }}>{value}</p>
      {hint ? <p className="text-dim" style={{ margin: "4px 0 0", fontSize: 12 }}>{hint}</p> : null}
    </div>
  );
}

export default function AdminDashboard() {
  const [m, setM] = useState<Metrics | null>(null);
  const [q, setQ] = useState<Quality | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([padmin<Metrics>("/platform/metrics"), padmin<Quality>("/platform/quality")])
      .then(([mm, qq]) => {
        setM(mm);
        setQ(qq);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Panel</h1>
      <p className="text-dim" style={{ margin: "0 0 22px", fontSize: 14 }}>Solo tus tenants de Conversia.</p>
      {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}
      {!m ? (
        <p className="text-dim">Cargando métricas…</p>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 14 }}>
            <Stat label="Tenants" value={String(m.organizations.total)} hint={`${m.organizations.active} activos · ${m.organizations.trialing} en prueba · ${m.organizations.suspended} susp.`} />
            <Stat label="Suscripciones activas" value={String(m.subscriptionsActive)} />
            <Stat label="MRR" value={clp(m.mrr.clp)} hint={m.mrr.usd ? `+ US$${Math.round(m.mrr.usd).toLocaleString("en-US")}` : undefined} />
            <Stat label="Ingresos cobrados" value={clp(m.revenuePaidClp)} />
            <Stat label="Costo IA (30d)" value={`US$${m.aiCostUsd30d.toFixed(2)}`} hint={`${m.aiRequests30d} solicitudes`} />
            <Stat label="Costo WhatsApp (30d)" value={`US$${m.whatsappCostUsd30d.toFixed(2)}`} hint={`${m.whatsappMessages30d} mensajes`} />
          </div>

          {q ? (
            <>
              <h2 className="display" style={{ fontSize: 20, margin: "30px 0 12px" }}>Calidad del bot · {q.windowHours}h</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
                <Stat label="Tasa de respuesta" value={`${q.responseRatePct}%`} />
                <Stat label="Respuesta media" value={`${q.avgResponseMs} ms`} />
                <Stat label="Errores de IA" value={String(q.aiErrors)} hint={`${q.aiRefusals} rechazos`} />
                <Stat label="Envíos fallidos" value={String(q.failedOutbound)} />
              </div>
              {q.topFailingTenants.length ? (
                <div className="card" style={{ padding: 18, marginTop: 14 }}>
                  <p className="text-dim" style={{ margin: "0 0 8px", fontSize: 12 }}>Tenants con más fallos</p>
                  {q.topFailingTenants.map((t) => (
                    <div key={t.organizationId} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--hairline)" }}>
                      <a href={`/admin/organizations/${t.organizationId}`} className="text-accent" style={{ textDecoration: "none" }}>{t.name}</a>
                      <span className="text-dim">{t.failed}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
