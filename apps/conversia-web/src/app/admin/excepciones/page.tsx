"use client";
import { useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";

// V2-8 — COLA DE EXCEPCIONES: el home operativo de la consola. Nadie revisa fichas sanas;
// se opera por excepción (bot fallando, saldo 0 sin recarga, número enfermo, margen negativo…).

type Exc = { id: string; organizationId: string; orgName: string | null; type: string; severity: string; title: string; detail: string | null; status: string; createdAt: string };

const TYPE_LABEL: Record<string, string> = {
  qa_failed: "QA falló",
  canario_degradado: "Canario degradado",
  saldo_gracia_sin_recarga: "Saldo 0 sin recarga",
  recarga_fallida: "Recarga fallida",
  numero_salud: "Salud del número",
  hsm_rechazada: "Plantilla rechazada",
  coexistence_error: "Error de Coexistence",
  canal_conexion_fallida: "No conecta su WhatsApp",
  verificacion_negocio: "Verificación de negocio (Meta)",
  margen_negativo: "Margen negativo",
  abandono_alta: "Alta abandonada",
};
const SEV_COLOR: Record<string, string> = { critical: "var(--danger)", warning: "var(--warn)", info: "var(--ink-dim)" };

export default function Excepciones() {
  const [items, setItems] = useState<Exc[]>([]);
  const [status, setStatus] = useState("open");
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const load = (s: string) => {
    setLoading(true);
    padmin<Exc[]>(`/platform/exceptions?status=${s}`).then(setItems).catch(() => setItems([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(status); }, [status]);

  async function act(id: string, action: "assign" | "resolve") {
    try {
      const body = action === "resolve" ? JSON.stringify({ resolution: prompt("Resolución (opcional):") ?? "" }) : undefined;
      await padmin(`/platform/exceptions/${id}/${action}`, { method: "POST", ...(body ? { body } : {}) });
      setMsg(action === "resolve" ? "Excepción resuelta." : "Asignada a ti.");
      load(status);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <div style={{ padding: "8px 4px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <h1 className="display" style={{ fontSize: 24, margin: 0 }}>Cola de excepciones</h1>
        <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          {[["open", "Abiertas"], ["resolved", "Resueltas"], ["all", "Todas"]].map(([k, l]) => (
            <button key={k} onClick={() => setStatus(k)} className={status === k ? "btn-accent" : ""} style={{ padding: "6px 12px", fontSize: 13, borderRadius: 999, cursor: "pointer", border: status === k ? "none" : "1px solid var(--line)", background: status === k ? undefined : "transparent", color: status === k ? undefined : "var(--ink-dim)" }}>{l}</button>
          ))}
        </div>
      </div>
      {msg ? <p className="text-accent" style={{ fontSize: 13 }}>{msg}</p> : null}
      {loading ? (
        <p className="text-dim">Cargando…</p>
      ) : items.length === 0 ? (
        <div className="card" style={{ padding: 28, textAlign: "center" }}>
          <p style={{ margin: 0, fontSize: 15 }}>Nada pendiente 🎉</p>
          <p className="text-dim" style={{ fontSize: 13, margin: "6px 0 0" }}>No hay excepciones abiertas. La cartera está sana.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((e) => (
            <div key={e.id} className="card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: SEV_COLOR[e.severity] ?? "var(--ink-dim)", flexShrink: 0 }} />
              <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{e.title}</p>
                <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>
                  <span style={{ padding: "1px 7px", borderRadius: 999, border: "1px solid var(--line)", marginRight: 6 }}>{TYPE_LABEL[e.type] ?? e.type}</span>
                  {e.orgName ?? e.organizationId}{e.detail ? ` · ${e.detail}` : ""}
                </p>
              </div>
              {e.status !== "resolved" ? (
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <a href={`/admin/organizations/${e.organizationId}`} className="text-accent" style={{ fontSize: 12, textDecoration: "none", alignSelf: "center", marginRight: 4 }}>Ver ficha</a>
                  <button onClick={() => act(e.id, "assign")} style={{ fontSize: 12, padding: "5px 11px", borderRadius: 999, border: "1px solid var(--line)", background: "transparent", color: "var(--ink)", cursor: "pointer" }}>Tomar</button>
                  <button onClick={() => act(e.id, "resolve")} className="btn-accent" style={{ fontSize: 12, padding: "5px 12px" }}>Resolver</button>
                </div>
              ) : <span className="text-dim" style={{ fontSize: 12 }}>Resuelta</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
