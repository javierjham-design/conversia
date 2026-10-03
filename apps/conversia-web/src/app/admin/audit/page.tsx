"use client";
import { useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";

/**
 * Auditoría (super admin Conversia). Bitácora de las acciones hechas desde la consola
 * de plataforma (super admin / operador). Solo lectura. Si el registro trae
 * `after._actorRole` mostramos con qué poder se hizo la acción.
 */
type Entry = {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actor: string;
  after: Record<string, unknown> | null;
  createdAt: string;
};

const ACTION_LABEL: Record<string, string> = {
  "platform.login": "Inicio de sesión",
  "platform.mfa.enabled": "MFA activado",
  "platform.mfa.disabled": "MFA desactivado",
  "platform.impersonate": "Impersonación de tenant",
  "platform.org.config": "Configuración de tenant",
  "platform.org.delivered": "Tenant entregado (GO-LIVE)",
  "platform.org.onboarding": "Onboarding de tenant",
  "platform.org.templates_on": "Plantillas activadas",
  "platform.org.templates_off": "Plantillas desactivadas",
  "platform.org.channel_add": "Canal agregado",
  "platform.org.channel_remove": "Canal quitado",
  "platform.agent.model": "Modelo de agente",
  "platform.agent.prompt": "Prompt de agente",
  "platform.agent.active": "Agente activado/desactivado",
  "platform.admin.reset_password": "Contraseña restablecida",
  "platform.demo.create": "Prospecto creado",
  "platform.demo.update": "Prospecto actualizado",
  "platform.demo.provision": "Demo provisionado",
  "platform.plan.create": "Plan creado",
  "platform.plan.update": "Plan actualizado",
  "platform.billing.settings": "Pasarela de pago",
  "platform.support.reply": "Respuesta de soporte",
};

const ROLE_LABEL: Record<string, string> = { owner: "Super admin", admin: "Super admin", operator: "Operador" };

function fecha(iso: string): string {
  return new Date(iso).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function AdminAudit() {
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    padmin<Entry[]>("/platform/audit")
      .then(setRows)
      .catch((e) => setError((e as Error).message));
  }, []);

  const th: React.CSSProperties = { padding: "10px 12px", textAlign: "left", fontSize: 11, color: "var(--ink-dim)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em" };
  const td: React.CSSProperties = { padding: "11px 12px", fontSize: 13, borderTop: "1px solid var(--hairline)", verticalAlign: "top" };

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Auditoría</h1>
      <p className="text-dim" style={{ margin: "0 0 18px", fontSize: 14 }}>Acciones hechas desde la consola de plataforma (super admin y operadores). Últimas 100. Solo lectura.</p>
      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}

      {!rows ? (
        <p className="text-dim">Cargando…</p>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 22 }}>
          <p style={{ margin: 0 }}>Sin registros aún.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={th}>Fecha</th>
                <th style={th}>Actor</th>
                <th style={th}>Acción</th>
                <th style={th}>Entidad</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const role = typeof r.after?._actorRole === "string" ? (r.after._actorRole as string) : null;
                return (
                  <tr key={r.id}>
                    <td style={{ ...td, color: "var(--ink-dim)", whiteSpace: "nowrap" }}>{fecha(r.createdAt)}</td>
                    <td style={td}>
                      <span style={{ fontWeight: 600 }}>{r.actor}</span>
                      {role ? <span className="text-dim" style={{ fontSize: 11, display: "block" }}>{ROLE_LABEL[role] ?? role}</span> : null}
                    </td>
                    <td style={{ ...td, fontWeight: 600 }}>{ACTION_LABEL[r.action] ?? r.action}</td>
                    <td style={{ ...td, color: "var(--ink-dim)" }}>
                      {r.entityType ?? "—"}{r.entityId ? ` · ${r.entityId.slice(0, 8)}…` : ""}
                    </td>
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
