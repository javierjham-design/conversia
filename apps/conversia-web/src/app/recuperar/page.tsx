"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

/**
 * §10.5 — Recuperar el acceso (autoservicio).
 *
 * Una sola pantalla con los dos pasos, según venga `?token=` en la URL:
 *  - sin token: pide el correo y manda el enlace;
 *  - con token: pide la contraseña nueva.
 *
 * El mensaje tras pedir el enlace es EL MISMO exista o no la cuenta — el backend contesta
 * igual a propósito (si dijera "ese correo no existe", cualquiera podría averiguar quién
 * es cliente), y la pantalla no puede contradecirlo.
 */
export default function Recuperar() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [enviado, setEnviado] = useState(false);
  const [listo, setListo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  // Vía window.location para no exigir <Suspense> alrededor de useSearchParams (Next 15),
  // igual que la pantalla de login.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token");
    setToken(t && t.length > 10 ? t : null);
  }, []);

  const field: React.CSSProperties = {
    width: "100%",
    padding: "11px 13px",
    marginTop: 6,
    borderRadius: 12,
    border: "1px solid var(--line)",
    background: "var(--surface-solid)",
    color: "var(--ink)",
    fontSize: 15,
  };
  const boton: React.CSSProperties = {
    width: "100%",
    marginTop: 18,
    padding: "12px 16px",
    borderRadius: 12,
    border: "1px solid transparent",
    background: "var(--acc)",
    color: "var(--acc-ink)",
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  };

  async function pedirEnlace(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCargando(true);
    try {
      await api("/auth/forgot", { method: "POST", body: JSON.stringify({ email }) });
      setEnviado(true);
    } catch (err) {
      // Solo errores de transporte o 429 llegan acá; el backend no distingue cuentas.
      setError((err as Error).message || "No pudimos enviar el enlace. Intenta de nuevo.");
    } finally {
      setCargando(false);
    }
  }

  async function fijarContrasena(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== password2) {
      setError("Las dos contraseñas no coinciden.");
      return;
    }
    setCargando(true);
    try {
      await api("/auth/reset", { method: "POST", body: JSON.stringify({ token, password }) });
      setListo(true);
      setTimeout(() => router.push("/login"), 2200);
    } catch (err) {
      setError((err as Error).message || "No pudimos cambiar la contraseña.");
    } finally {
      setCargando(false);
    }
  }

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20 }}>
      <div className="card" style={{ width: "100%", maxWidth: 400, padding: 28 }}>
        <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Conversia</p>

        {listo ? (
          <>
            <h1 className="display" style={{ fontSize: 26, margin: "4px 0 12px" }}>
              Contraseña <span className="display-italic">cambiada</span>
            </h1>
            <p className="text-dim" style={{ fontSize: 14, lineHeight: 1.5 }}>
              Cerramos las sesiones que estaban abiertas, por seguridad. Te llevamos al inicio de sesión…
            </p>
          </>
        ) : token ? (
          <form onSubmit={fijarContrasena}>
            <h1 className="display" style={{ fontSize: 26, margin: "4px 0 16px" }}>
              Crea tu <span className="display-italic">contraseña nueva</span>
            </h1>
            <label style={{ display: "block", fontSize: 14 }}>
              Contraseña nueva
              <input
                style={field}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={10}
                autoComplete="new-password"
              />
            </label>
            <p className="text-dim" style={{ fontSize: 12, margin: "6px 0 0" }}>Mínimo 10 caracteres.</p>
            <label style={{ display: "block", fontSize: 14, marginTop: 14 }}>
              Repítela
              <input
                style={field}
                type="password"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                required
                minLength={10}
                autoComplete="new-password"
              />
            </label>
            {error ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{error}</p> : null}
            <button type="submit" disabled={cargando} style={boton}>
              {cargando ? "Guardando…" : "Guardar y entrar"}
            </button>
          </form>
        ) : enviado ? (
          <>
            <h1 className="display" style={{ fontSize: 26, margin: "4px 0 12px" }}>
              Revisa tu <span className="display-italic">correo</span>
            </h1>
            <p className="text-dim" style={{ fontSize: 14, lineHeight: 1.5 }}>
              Si ese correo tiene una cuenta, te mandamos un enlace para crear una contraseña nueva. Sirve una sola vez
              y vence en 1 hora. Mira también la carpeta de spam.
            </p>
            <a href="/login" className="text-accent" style={{ display: "inline-block", marginTop: 18, fontSize: 14, textDecoration: "none" }}>
              Volver a entrar
            </a>
          </>
        ) : (
          <form onSubmit={pedirEnlace}>
            <h1 className="display" style={{ fontSize: 26, margin: "4px 0 16px" }}>
              Recupera tu <span className="display-italic">acceso</span>
            </h1>
            <label style={{ display: "block", fontSize: 14 }}>
              Tu correo
              <input
                style={field}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </label>
            {error ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{error}</p> : null}
            <button type="submit" disabled={cargando} style={boton}>
              {cargando ? "Enviando…" : "Enviarme el enlace"}
            </button>
            <a href="/login" className="text-dim" style={{ display: "inline-block", marginTop: 16, fontSize: 13, textDecoration: "none" }}>
              Volver a entrar
            </a>
          </form>
        )}
      </div>
    </main>
  );
}
