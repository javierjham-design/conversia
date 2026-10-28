"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

/**
 * §10.5 — Recuperar el acceso (autoservicio), panel de TuBot.
 *
 * Una pantalla con los dos pasos según venga `?token=` en la URL: sin token pide el correo
 * y manda el enlace; con token pide la contraseña nueva.
 *
 * El mensaje tras pedir el enlace es EL MISMO exista o no la cuenta — el backend contesta
 * igual a propósito (decir "ese correo no existe" convertiría el endpoint en una forma de
 * averiguar quién es cliente), y la pantalla no puede contradecirlo.
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
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token");
    setToken(t && t.length > 10 ? t : null);
  }, []);

  const card = "w-full max-w-sm space-y-4 rounded-2xl border border-line bg-panel p-8 shadow-sm";
  const input = "mt-1 w-full rounded-lg border border-line-strong px-3 py-2";
  const btn = "w-full rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50";

  async function pedirEnlace(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api("/auth/forgot", { method: "POST", body: JSON.stringify({ email }) });
      setEnviado(true);
    } catch (err) {
      setError((err as Error).message || "No pudimos enviar el enlace. Intenta de nuevo.");
    } finally {
      setLoading(false);
    }
  }

  async function fijarContrasena(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== password2) {
      setError("Las dos contraseñas no coinciden.");
      return;
    }
    setLoading(true);
    try {
      await api("/auth/reset", { method: "POST", body: JSON.stringify({ token, password }) });
      setListo(true);
      setTimeout(() => router.push("/login"), 2200);
    } catch (err) {
      setError((err as Error).message || "No pudimos cambiar la contraseña.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className={card}>
        <div className="text-center">
          <img src="/brand/tubot-horizontal.png" alt="TuBot.cl" className="mx-auto h-9 w-auto dark:brightness-0 dark:invert" />
        </div>

        {listo ? (
          <>
            <h1 className="text-center text-lg font-semibold text-ink">Contraseña cambiada</h1>
            <p className="text-center text-sm text-ink-muted">
              Cerramos las sesiones que estaban abiertas, por seguridad. Te llevamos al inicio de sesión…
            </p>
          </>
        ) : token ? (
          <form onSubmit={fijarContrasena} className="space-y-4">
            <h1 className="text-center text-lg font-semibold text-ink">Crea tu contraseña nueva</h1>
            <label className="block text-sm">
              Contraseña nueva
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={input}
                required
                minLength={10}
              />
            </label>
            <p className="text-[11px] text-ink-subtle">Mínimo 10 caracteres.</p>
            <label className="block text-sm">
              Repítela
              <input
                type="password"
                autoComplete="new-password"
                value={password2}
                onChange={(e) => setPassword2(e.target.value)}
                className={input}
                required
                minLength={10}
              />
            </label>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button type="submit" disabled={loading} className={btn}>{loading ? "Guardando…" : "Guardar y entrar"}</button>
          </form>
        ) : enviado ? (
          <>
            <h1 className="text-center text-lg font-semibold text-ink">Revisa tu correo</h1>
            <p className="text-center text-sm text-ink-muted">
              Si ese correo tiene una cuenta, te mandamos un enlace para crear una contraseña nueva. Sirve una sola vez
              y vence en 1 hora. Mira también la carpeta de spam.
            </p>
            <p className="text-center text-sm">
              <a href="/login" className="font-medium text-brand-600 hover:text-brand-700">Volver a entrar</a>
            </p>
          </>
        ) : (
          <form onSubmit={pedirEnlace} className="space-y-4">
            <h1 className="text-center text-lg font-semibold text-ink">Recupera tu acceso</h1>
            <label className="block text-sm">
              Tu correo
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={input}
                required
              />
            </label>
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
            <button type="submit" disabled={loading} className={btn}>{loading ? "Enviando…" : "Enviarme el enlace"}</button>
            <p className="text-center text-sm text-ink-muted">
              <a href="/login" className="hover:text-ink">Volver a entrar</a>
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
