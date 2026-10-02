"use client";
import { useEffect, useState } from "react";
import { padmin, PlatformApiError } from "@/lib/platform-api";

/**
 * F10 TAREA 3 — Alta guiada ("nuevo cliente Conversia"). Encadena EN UN SOLO FLUJO lo que
 * ya existe: elegir el tenant (se crea al registrarse en app.conversia.cl) → instalar el
 * paquete del rubro → personalizar agente / conectar WhatsApp (en la ficha) → checklist de
 * GO-LIVE → marcar ENTREGADO (dispara la activación del cobro, D5). Todo auditado en el back.
 */
type OrgRow = { id: string; name: string; slug: string; country: string | null; lifecycle?: { stage: string | null; setupPaid: boolean; deliveredAt: string | null } };
type Vertical = { key: string; name: string };
type Impl = {
  steps: { key: string; title: string; done: boolean }[];
  completed: number; total: number; percent: number; goLiveReady: boolean;
  lifecycle: { stage: string | null; setupPaid: boolean; setupVertical: string | null; deliveredAt: string | null };
};

export default function AltaGuiadaPage() {
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const [verticals, setVerticals] = useState<Vertical[]>([]);
  const [sel, setSel] = useState<OrgRow | null>(null);
  const [impl, setImpl] = useState<Impl | null>(null);
  const [vkey, setVkey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    padmin<OrgRow[]>("/platform/organizations").then((r) => setOrgs(r.filter((o) => o.lifecycle?.stage !== "active" && !o.lifecycle?.deliveredAt))).catch((e) => setError((e as Error).message));
    padmin<Vertical[]>("/platform/verticals").then(setVerticals).catch(() => {});
  }, []);

  function loadImpl(org: OrgRow) {
    setSel(org); setImpl(null); setMsg(null); setError(null);
    padmin<Impl>(`/platform/organizations/${org.id}/implementation`).then(setImpl).catch((e) => setError((e as Error).message));
  }

  async function installVertical() {
    if (!sel || !vkey) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      await padmin(`/platform/organizations/${sel.id}/vertical`, { method: "POST", body: JSON.stringify({ key: vkey }) });
      setMsg(`Paquete "${vkey}" instalado.`);
      loadImpl(sel);
    } catch (err) { setError(err instanceof PlatformApiError ? err.message : (err as Error).message); } finally { setBusy(false); }
  }

  async function markDelivered() {
    if (!sel) return;
    if (!confirm("¿Marcar ENTREGADO? Esto pone al cliente EN VIVO y activa su ciclo de cobro.")) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      await padmin(`/platform/organizations/${sel.id}/lifecycle/delivered`, { method: "POST" });
      setMsg("Cliente marcado como ENTREGADO (en vivo).");
      loadImpl(sel);
    } catch (err) { setError(err instanceof PlatformApiError ? err.message : (err as Error).message); } finally { setBusy(false); }
  }

  const field: React.CSSProperties = { padding: "9px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };

  return (
    <div style={{ maxWidth: 780 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Alta guiada</h1>
      <p className="text-dim" style={{ margin: "0 0 18px", fontSize: 14 }}>Lleva a un cliente desde el registro hasta EN VIVO, paso a paso. El cliente se crea al registrarse en app.conversia.cl; aquí lo pones en marcha.</p>
      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}
      {msg ? <p style={{ color: "var(--ok)", fontSize: 13 }}>{msg}</p> : null}

      {/* Paso 1 — elegir cliente */}
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <p style={{ margin: "0 0 8px", fontWeight: 600, fontSize: 14 }}>1 · Elige el cliente a implementar</p>
        {!orgs ? <p className="text-dim" style={{ fontSize: 13 }}>Cargando…</p> : orgs.length === 0 ? (
          <p className="text-dim" style={{ fontSize: 13 }}>No hay clientes pendientes de implementar. Los que ya están en vivo no aparecen aquí.</p>
        ) : (
          <select style={{ ...field, width: "100%" }} value={sel?.id ?? ""} onChange={(e) => { const o = orgs.find((x) => x.id === e.target.value); if (o) loadImpl(o); }}>
            <option value="">— Selecciona un cliente —</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.slug}) · {o.country ?? "—"}</option>)}
          </select>
        )}
      </div>

      {sel && impl ? (
        <>
          {/* Paso 2 — paquete del rubro */}
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <p style={{ margin: "0 0 8px", fontWeight: 600, fontSize: 14 }}>2 · Instala el paquete del rubro</p>
            {impl.steps.find((s) => s.key === "vertical")?.done ? (
              <p className="text-dim" style={{ fontSize: 13 }}>✓ Paquete instalado{impl.lifecycle.setupVertical ? ` (${impl.lifecycle.setupVertical})` : ""}. Puedes reinstalar/actualizar si cambió el rubro.</p>
            ) : null}
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              <select style={field} value={vkey} onChange={(e) => setVkey(e.target.value)}>
                <option value="">— Rubro —</option>
                {verticals.map((v) => <option key={v.key} value={v.key}>{v.name}</option>)}
              </select>
              <button className="btn-accent" onClick={installVertical} disabled={busy || !vkey} style={{ opacity: busy || !vkey ? 0.5 : 1 }}>Instalar paquete</button>
            </div>
          </div>

          {/* Paso 3 — checklist derivado + accesos a la ficha */}
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <p style={{ margin: "0 0 4px", fontWeight: 600, fontSize: 14 }}>3 · Puesta en marcha ({impl.percent}%)</p>
            <p className="text-dim" style={{ fontSize: 12, margin: "0 0 10px" }}>Conecta WhatsApp, publica el agente y el flujo desde la ficha del cliente.</p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {impl.steps.map((s) => (
                <li key={s.key} style={{ fontSize: 13, color: s.done ? "var(--ok)" : "var(--ink-dim)" }}>{s.done ? "✓" : "○"} {s.title}</li>
              ))}
            </ul>
            <a href={`/admin/organizations/${sel.id}`} className="nav-item" style={{ width: "auto", display: "inline-flex", marginTop: 12, padding: "0 14px", height: 38, border: "1px solid var(--line)", fontSize: 13 }}>Abrir ficha del cliente →</a>
          </div>

          {/* Paso 4 — GO-LIVE */}
          <div className="card" style={{ padding: 16 }}>
            <p style={{ margin: "0 0 8px", fontWeight: 600, fontSize: 14 }}>4 · Marcar ENTREGADO (GO-LIVE)</p>
            {impl.lifecycle.deliveredAt || impl.lifecycle.stage === "active" ? (
              <p style={{ color: "var(--ok)", fontSize: 13, margin: 0 }}>🟢 Cliente en vivo.</p>
            ) : (
              <>
                <p className="text-dim" style={{ fontSize: 12, margin: "0 0 10px" }}>
                  {!impl.lifecycle.setupPaid ? "Requiere setup pagado. " : ""}
                  {!impl.goLiveReady ? "Completa la puesta en marcha (WhatsApp, agente, paquete, flujo, plantillas)." : "Todo listo para salir en vivo."}
                </p>
                <button className="btn-accent" onClick={markDelivered} disabled={busy || !impl.lifecycle.setupPaid} style={{ opacity: busy || !impl.lifecycle.setupPaid ? 0.5 : 1 }}>Marcar ENTREGADO</button>
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
