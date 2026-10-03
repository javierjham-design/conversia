"use client";
import { useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";

/**
 * Alertas (super admin Conversia). Eventos de integración con status warning/error
 * por tenant (salud de Meta, IA en pausa, suspensiones…). Solo lectura; enlaza a la
 * ficha de la org cuando corresponde.
 */
type Alert = {
  id: string;
  provider: string;
  type: string;
  status: string;
  message: string | null;
  org: string;
  organizationId?: string | null;
  createdAt: string;
};

function fecha(iso: string): string {
  return new Date(iso).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function AdminAlerts() {
  const [rows, setRows] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    padmin<Alert[]>("/platform/alerts")
      .then(setRows)
      .catch((e) => setError((e as Error).message));
  }, []);

  const th: React.CSSProperties = { padding: "10px 12px", textAlign: "left", fontSize: 11, color: "var(--ink-dim)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" };
  const td: React.CSSProperties = { padding: "11px 12px", fontSize: 13, borderTop: "1px solid var(--hairline)", verticalAlign: "top" };

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Alertas</h1>
      <p className="text-dim" style={{ margin: "0 0 18px", fontSize: 14 }}>Avisos y errores de integración de tus tenants: salud de Meta, IA en pausa, suspensiones y más.</p>
      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}

      {!rows ? (
        <p className="text-dim">Cargando…</p>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 22 }}>
          <p style={{ margin: 0 }}>Sin alertas. Todo en orden.</p>
          <p className="text-dim" style={{ fontSize: 13, margin: "6px 0 0" }}>Aquí aparecen los eventos de integración con nivel aviso o error de tus tenants.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Nivel</th>
                <th style={th}>Tenant</th>
                <th style={th}>Evento</th>
                <th style={th}>Detalle</th>
                <th style={th}>Fecha</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isError = r.status === "error";
                return (
                  <tr key={r.id}>
                    <td style={td}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: isError ? "var(--danger)" : "var(--warn)" }}>
                        ● {isError ? "error" : "aviso"}
                      </span>
                    </td>
                    <td style={{ ...td, fontWeight: 600 }}>
                      {r.organizationId ? (
                        <a href={`/admin/organizations/${r.organizationId}`} className="text-accent" style={{ textDecoration: "none" }}>{r.org}</a>
                      ) : (
                        r.org
                      )}
                    </td>
                    <td style={{ ...td, color: "var(--ink-dim)" }}>
                      <span style={{ color: "var(--ink-dim)" }}>{r.provider}</span> · {r.type}
                    </td>
                    <td style={{ ...td, color: "var(--ink-dim)", maxWidth: 360, wordBreak: "break-word" }}>{r.message ?? "—"}</td>
                    <td style={{ ...td, color: "var(--ink-dim)", whiteSpace: "nowrap" }}>{fecha(r.createdAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
