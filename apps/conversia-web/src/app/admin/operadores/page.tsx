"use client";
import { useEffect, useState } from "react";
import { padmin, PlatformApiError } from "@/lib/platform-api";

/**
 * F10 — gestión del EQUIPO de implementación (operadores). Solo el super admin llega aquí
 * (el backend bloquea /platform/admins para el rol operador). Un operador opera la ficha de
 * clientes pero no toca config global ni a otros operadores. MFA es obligatorio para todos.
 */
type Admin = { id: string; email: string; name: string; role: string; mfaEnabled: boolean; isSuperAdmin: boolean; createdAt: string };

export default function OperadoresPage() {
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; tempPassword: string } | null>(null);

  const load = () => padmin<Admin[]>("/platform/admins").then(setAdmins).catch((e) => setError((e as Error).message));
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null); setCreated(null);
    try {
      const r = await padmin<{ email: string; tempPassword: string }>("/platform/admins", { method: "POST", body: JSON.stringify({ email: email.trim(), name: name.trim() }) });
      setCreated({ email: r.email, tempPassword: r.tempPassword });
      setEmail(""); setName("");
      load();
    } catch (err) {
      setError(err instanceof PlatformApiError ? err.message : (err as Error).message);
    } finally { setBusy(false); }
  }

  async function remove(a: Admin) {
    if (!confirm(`¿Eliminar al operador ${a.email}? Perderá el acceso a la consola.`)) return;
    try { await padmin(`/platform/admins/${a.id}`, { method: "DELETE" }); load(); }
    catch (err) { setError((err as Error).message); }
  }

  const field: React.CSSProperties = { width: "100%", padding: "10px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Operadores</h1>
      <p className="text-dim" style={{ margin: "0 0 18px", fontSize: 14 }}>El equipo que implementa y opera clientes. Pueden operar la ficha de cada cliente e impersonar con auditoría, pero no tocan planes, precios, pasarelas ni a otros operadores. Deben activar MFA al entrar.</p>
      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}

      <form onSubmit={create} className="card" style={{ padding: 18, marginBottom: 18 }}>
        <h2 className="display" style={{ fontSize: 17, margin: "0 0 10px" }}>Nuevo operador</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Correo
            <input style={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="persona@conversia.cl" required />
          </label>
          <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Nombre
            <input style={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre Apellido" required />
          </label>
        </div>
        <button className="btn-accent" type="submit" disabled={busy} style={{ marginTop: 14, opacity: busy ? 0.6 : 1 }}>Crear operador</button>
      </form>

      {created ? (
        <div className="card" style={{ padding: 16, marginBottom: 18, borderColor: "var(--ok)" }}>
          <p style={{ margin: "0 0 6px", fontWeight: 600 }}>Operador creado: {created.email}</p>
          <p className="text-dim" style={{ fontSize: 13, margin: "0 0 8px" }}>Contraseña temporal (se muestra UNA sola vez — cópiala y entrégala por un canal seguro):</p>
          <code style={{ display: "inline-block", padding: "8px 12px", borderRadius: 8, background: "var(--surface-solid)", border: "1px solid var(--line)", fontSize: 15, userSelect: "all" }}>{created.tempPassword}</code>
          <p className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>En su primer ingreso deberá activar la verificación en dos pasos (MFA).</p>
        </div>
      ) : null}

      {!admins ? (
        <p className="text-dim">Cargando…</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {admins.map((a) => (
            <div key={a.id} className="card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{a.name}</p>
                <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>{a.email}</p>
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: a.isSuperAdmin ? "var(--acc)" : "var(--ink-dim)" }}>{a.isSuperAdmin ? "Super admin" : "Operador"}</span>
              <span style={{ fontSize: 11, color: a.mfaEnabled ? "var(--ok)" : "var(--danger)" }}>{a.mfaEnabled ? "MFA ✓" : "sin MFA"}</span>
              {!a.isSuperAdmin ? (
                <button onClick={() => remove(a)} className="text-dim" style={{ border: "1px solid var(--line)", background: "transparent", cursor: "pointer", borderRadius: 8, padding: "5px 10px", fontSize: 12 }}>Eliminar</button>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
