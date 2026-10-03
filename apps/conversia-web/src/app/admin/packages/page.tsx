"use client";
import { useEffect, useState } from "react";
import { padmin, PlatformApiError } from "@/lib/platform-api";

/**
 * Paquetes de mensajes (prepago) de la plataforma. Misma API que el super admin de TuBot
 * (GET/POST/PATCH/DELETE /platform/packages), con el estilo "Nocturna" de la consola de
 * Conversia. priceUsd llega como string (Decimal) → se normaliza a número en pantalla.
 */
type Pkg = {
  id: string;
  code: string;
  name: string;
  credits: number;
  priceClp: number;
  priceUsd: number | string;
  active: boolean;
  order: number;
};

type Draft = { code: string; name: string; credits: number; priceClp: number; priceUsd: number; order: number; active: boolean };
const EMPTY_DRAFT: Draft = { code: "", name: "", credits: 1000, priceClp: 29900, priceUsd: 34, order: 0, active: true };

export default function PackagesPage() {
  const [rows, setRows] = useState<Pkg[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    padmin<Pkg[]>("/platform/packages")
      .then(setRows)
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    load();
  }, []);

  function startCreate() {
    setEditing(null);
    setDraft({ ...EMPTY_DRAFT });
  }
  function startEdit(p: Pkg) {
    setEditing(p.id);
    setDraft({ code: p.code, name: p.name, credits: p.credits, priceClp: Number(p.priceClp), priceUsd: Number(p.priceUsd), order: p.order, active: p.active });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = JSON.stringify({
        code: draft.code.trim(),
        name: draft.name.trim(),
        credits: draft.credits,
        priceClp: draft.priceClp,
        priceUsd: draft.priceUsd,
        order: draft.order,
        active: draft.active,
      });
      if (editing) {
        await padmin(`/platform/packages/${editing}`, { method: "PATCH", body });
        setNotice("Paquete actualizado.");
      } else {
        await padmin("/platform/packages", { method: "POST", body });
        setNotice("Paquete creado.");
      }
      setDraft(null);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: Pkg) {
    if (!confirm(`¿Eliminar el paquete ${p.name}?`)) return;
    setError(null);
    try {
      await padmin(`/platform/packages/${p.id}`, { method: "DELETE" });
      if (editing === p.id) {
        setDraft(null);
        setEditing(null);
      }
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const field: React.CSSProperties = { width: "100%", padding: "10px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };
  const clp = (n: number) => `$${Number(n).toLocaleString("es-CL")}`;

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Paquetes de mensajes</h1>
      <p className="text-dim" style={{ fontSize: 14, margin: "0 0 18px" }}>Recargas prepago que el tenant compra cuando se le agota la bolsa de mensajes de plantilla.</p>

      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}
      {notice ? <p style={{ color: "var(--ok)", fontSize: 13 }}>{notice}</p> : null}

      {draft ? (
        <form onSubmit={save} className="card" style={{ padding: 18, marginBottom: 18 }}>
          <h2 className="display" style={{ fontSize: 17, margin: "0 0 12px" }}>{editing ? "Editar paquete" : "Nuevo paquete"}</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
            <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Código
              <input style={{ ...field, fontFamily: "ui-monospace, monospace" }} value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} placeholder="msgs_2000" disabled={!!editing} required />
            </label>
            <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Nombre
              <input style={field} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="2.000 mensajes" required />
            </label>
            <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Créditos
              <input style={field} type="number" min={1} value={draft.credits} onChange={(e) => setDraft({ ...draft, credits: Number(e.target.value) })} required />
            </label>
            <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Precio CLP
              <input style={field} type="number" min={0} value={draft.priceClp} onChange={(e) => setDraft({ ...draft, priceClp: Number(e.target.value) })} required />
            </label>
            <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Precio USD
              <input style={field} type="number" min={0} step="0.01" value={draft.priceUsd} onChange={(e) => setDraft({ ...draft, priceUsd: Number(e.target.value) })} required />
            </label>
            <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Orden
              <input style={field} type="number" value={draft.order} onChange={(e) => setDraft({ ...draft, order: Number(e.target.value) })} />
            </label>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-dim)", marginTop: 14 }}>
            <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
            Activo (comprable por el tenant)
          </label>
          <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
            <button className="btn-accent" type="submit" disabled={busy || !draft.code.trim() || !draft.name.trim()} style={{ opacity: busy ? 0.6 : 1 }}>{editing ? "Guardar cambios" : "Crear paquete"}</button>
            <button type="button" onClick={() => { setDraft(null); setEditing(null); }} className="text-dim" style={{ border: "1px solid var(--line)", background: "transparent", cursor: "pointer", borderRadius: 10, padding: "8px 14px", fontSize: 13 }}>Cancelar</button>
          </div>
        </form>
      ) : (
        <button className="btn-accent" onClick={startCreate} style={{ marginBottom: 18 }}>+ Nuevo paquete</button>
      )}

      {!rows ? (
        <p className="text-dim">Cargando…</p>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 22 }}>
          <p style={{ margin: 0 }}>Aún no hay paquetes de mensajes.</p>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((p) => (
            <div key={p.id} className="card" style={{ padding: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>{p.name}</p>
                <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12, fontFamily: "ui-monospace, monospace" }}>{p.code}</p>
              </div>
              <span className="text-dim" style={{ fontSize: 13, minWidth: 110 }}>{p.credits.toLocaleString("es-CL")} créditos</span>
              <span className="text-dim" style={{ fontSize: 13, minWidth: 100 }}>{clp(p.priceClp)} · US${Number(p.priceUsd).toFixed(2)}</span>
              <span style={{ fontSize: 11, fontWeight: 600, color: p.active ? "var(--ok)" : "var(--ink-dim)" }}>● {p.active ? "Activo" : "Inactivo"}</span>
              <button onClick={() => startEdit(p)} className="text-dim" style={{ border: "1px solid var(--line)", background: "transparent", cursor: "pointer", borderRadius: 8, padding: "5px 10px", fontSize: 12 }}>Editar</button>
              <button onClick={() => remove(p)} style={{ border: "1px solid var(--line)", background: "transparent", color: "var(--danger)", cursor: "pointer", borderRadius: 8, padding: "5px 10px", fontSize: 12 }}>Eliminar</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
