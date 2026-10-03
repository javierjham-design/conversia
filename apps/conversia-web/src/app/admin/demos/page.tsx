"use client";
import { useCallback, useEffect, useState } from "react";
import { padmin, PlatformApiError } from "@/lib/platform-api";

/**
 * Prospectos / CRM (super admin Conversia). Lista de prospectos con días en la
 * plataforma y estado de IA si ya se provisionó, crear prospecto manual, editar
 * estado/notas inline y provisionar el demo (crea org + owner con la IA en pausa).
 */
type Lead = {
  id: string;
  name: string;
  email: string;
  company: string | null;
  phone: string | null;
  planInterest: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
  organizationId: string | null;
  orgStatus: string | null;
  daysOnPlatform: number | null;
  aiEnabled: boolean | null;
  validUntil: string | null;
};

type Provisioned = { email: string; tempPassword: string | null; organizationId: string; validUntil?: string | null };

const STATUSES = ["NEW", "CONTACTED", "PROVISIONED", "ACTIVE", "WON", "LOST"] as const;
const STATUS_LABEL: Record<string, string> = {
  NEW: "Nuevo",
  CONTACTED: "Contactado",
  PROVISIONED: "Demo creado",
  ACTIVE: "Activo",
  WON: "Ganado",
  LOST: "Perdido",
};

function fecha(iso: string): string {
  return new Date(iso).toLocaleString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default function AdminDemos() {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<Provisioned | null>(null);
  const [form, setForm] = useState({ name: "", email: "", company: "", phone: "", planInterest: "" });

  const load = useCallback(() => {
    padmin<Lead[]>("/platform/demo-leads").then(setLeads).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await padmin("/platform/demo-leads", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          company: form.company.trim() || undefined,
          phone: form.phone.trim() || undefined,
          planInterest: form.planInterest.trim() || undefined,
        }),
      });
      setForm({ name: "", email: "", company: "", phone: "", planInterest: "" });
      load();
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : (err as Error).message);
    } finally { setBusy(false); }
  }

  async function provision(l: Lead) {
    if (!confirm(`¿Provisionar el demo de ${l.company ?? l.name}? Se crea la organización y el usuario owner con la IA EN PAUSA (no gasta tokens hasta que la habilites).`)) return;
    setError(null);
    try {
      const res = await padmin<Provisioned>(`/platform/demo-leads/${l.id}/provision`, { method: "POST" });
      setCreds(res);
      load();
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : (err as Error).message);
    }
  }

  async function patch(id: string, data: { status?: string; notes?: string }) {
    try {
      await padmin(`/platform/demo-leads/${id}`, { method: "PATCH", body: JSON.stringify(data) });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const field: React.CSSProperties = { width: "100%", padding: "10px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Prospectos / CRM</h1>
      <p className="text-dim" style={{ margin: "0 0 18px", fontSize: 14 }}>Prospectos que piden demo. Provisiónalos con la IA en pausa (no gasta tokens) y habilítala desde la ficha cuando estés listo.</p>
      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}

      <form onSubmit={create} className="card" style={{ padding: 18, marginBottom: 18 }}>
        <h2 className="display" style={{ fontSize: 17, margin: "0 0 10px" }}>Nuevo prospecto</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Nombre
            <input style={field} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nombre Apellido" required />
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Correo
            <input style={field} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="persona@empresa.cl" required />
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Empresa
            <input style={field} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} placeholder="Empresa" />
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Teléfono
            <input style={field} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+56 9 …" />
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Plan de interés
            <input style={field} value={form.planInterest} onChange={(e) => setForm({ ...form, planInterest: e.target.value })} placeholder="opcional" />
          </label>
        </div>
        <button className="btn-accent" type="submit" disabled={busy} style={{ marginTop: 14, opacity: busy ? 0.6 : 1 }}>Agregar prospecto</button>
      </form>

      {creds ? (
        <div className="card" style={{ padding: 16, marginBottom: 18, borderColor: "var(--ok)" }}>
          <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Demo provisionado ✔ — {creds.email}</p>
          <p className="text-dim" style={{ fontSize: 13, margin: "0 0 8px" }}>
            Comparte estos accesos. La IA está EN PAUSA (no gasta tokens) hasta que la habilites desde la ficha de la organización.
          </p>
          {creds.tempPassword ? (
            <>
              <p className="text-dim" style={{ fontSize: 12, margin: "0 0 4px" }}>Contraseña temporal (se muestra UNA sola vez):</p>
              <code style={{ display: "inline-block", padding: "8px 12px", borderRadius: 8, background: "var(--surface-solid)", border: "1px solid var(--line)", fontSize: 15, userSelect: "all" }}>{creds.tempPassword}</code>
            </>
          ) : (
            <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>El usuario ya tenía cuenta; usa su contraseña actual.</p>
          )}
          {creds.validUntil ? <p className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>Vigencia del demo: {fecha(creds.validUntil)}.</p> : null}
          <div style={{ marginTop: 12 }}>
            <a href={`/admin/organizations/${creds.organizationId}`} className="btn-accent" style={{ textDecoration: "none" }}>Ir a la ficha</a>
            <button onClick={() => setCreds(null)} className="text-dim" style={{ marginLeft: 10, border: "1px solid var(--line)", background: "transparent", cursor: "pointer", borderRadius: 10, padding: "9px 14px", fontSize: 13 }}>Cerrar</button>
          </div>
        </div>
      ) : null}

      {!leads ? (
        <p className="text-dim">Cargando…</p>
      ) : leads.length === 0 ? (
        <div className="card" style={{ padding: 22 }}>
          <p style={{ margin: 0 }}>Aún no hay prospectos.</p>
          <p className="text-dim" style={{ fontSize: 13, margin: "6px 0 0" }}>Los que piden demo en la web aparecen aquí; también puedes agregar uno a mano arriba.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {leads.map((l) => (
            <div key={l.id} className="card" style={{ padding: 16 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 14, flexWrap: "wrap" }}>
                <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                  <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>{l.company ?? l.name}</p>
                  <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>
                    {l.name} · {l.email}{l.phone ? ` · ${l.phone}` : ""}{l.planInterest ? ` · ${l.planInterest}` : ""}
                  </p>
                  <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 11 }}>Alta {fecha(l.createdAt)}</p>
                </div>
                <label style={{ fontSize: 11, color: "var(--ink-dim)" }}>Estado
                  <select
                    value={l.status}
                    onChange={(e) => patch(l.id, { status: e.target.value })}
                    style={{ display: "block", marginTop: 4, padding: "7px 10px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 13 }}
                  >
                    {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                </label>
                <div style={{ fontSize: 12, color: "var(--ink-dim)", minWidth: 110 }}>
                  <div>{l.daysOnPlatform != null ? `${l.daysOnPlatform} día${l.daysOnPlatform === 1 ? "" : "s"} en plataforma` : "Sin provisionar"}</div>
                  {l.validUntil ? <div style={{ fontSize: 11 }}>vence {fecha(l.validUntil)}</div> : null}
                  {l.aiEnabled == null ? null : (
                    <div style={{ fontSize: 11, color: l.aiEnabled ? "var(--ok)" : "var(--warn)", fontWeight: 600 }}>IA {l.aiEnabled ? "habilitada" : "en pausa"}</div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center" }}>
                  {l.organizationId ? (
                    <a href={`/admin/organizations/${l.organizationId}`} className="btn-accent" style={{ textDecoration: "none" }}>Gestionar</a>
                  ) : (
                    <button onClick={() => provision(l)} className="btn-accent">Provisionar</button>
                  )}
                </div>
              </div>
              <label style={{ display: "block", fontSize: 11, color: "var(--ink-dim)", marginTop: 10 }}>Notas
                <textarea
                  defaultValue={l.notes ?? ""}
                  onBlur={(e) => { if (e.target.value !== (l.notes ?? "")) patch(l.id, { notes: e.target.value }); }}
                  placeholder="Notas del prospecto (se guardan al salir del campo)…"
                  rows={2}
                  style={{ ...field, resize: "vertical", fontFamily: "inherit" }}
                />
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
