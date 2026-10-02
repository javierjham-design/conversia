"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { padmin, PlatformApiError, setPlatformToken } from "@/lib/platform-api";

/**
 * Login del SUPER ADMIN de Conversia. Mismo endpoint que TuBot (/platform/auth/login)
 * pero la marca se deriva del Origin (app.conversia.cl → conversia): solo valida contra
 * el super admin de Conversia. Si el admin tiene MFA, el backend responde `mfaRequired`
 * y mostramos el campo de código.
 */
export default function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mfa, setMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await padmin<{ token: string; brand: string }>("/platform/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password, ...(code ? { code } : {}) }),
      });
      setPlatformToken(res.token);
      router.replace("/admin");
    } catch (err) {
      if (err instanceof PlatformApiError && err.body?.mfaRequired) {
        setMfa(true);
        setError(code ? "Código inválido. Intenta de nuevo." : null);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }

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

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 20 }}>
      <form onSubmit={submit} className="card" style={{ width: "100%", maxWidth: 400, padding: 28 }}>
        <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Conversia · Consola</p>
        <h1 className="display" style={{ fontSize: 26, margin: "4px 0 20px" }}>
          Super <span className="display-italic">admin</span>
        </h1>
        <label style={{ fontSize: 13 }} className="text-dim">
          Correo
          <input style={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" disabled={mfa} />
        </label>
        <label style={{ fontSize: 13, display: "block", marginTop: 14 }} className="text-dim">
          Contraseña
          <input style={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" disabled={mfa} />
        </label>
        {mfa ? (
          <label style={{ fontSize: 13, display: "block", marginTop: 14 }} className="text-dim">
            Código de verificación (2FA)
            <input style={field} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus placeholder="123456" />
          </label>
        ) : null}
        {error ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{error}</p> : null}
        <button className="btn-accent" type="submit" disabled={loading} style={{ width: "100%", marginTop: 20, opacity: loading ? 0.6 : 1 }}>
          {loading ? "Entrando…" : mfa ? "Verificar" : "Entrar"}
        </button>
      </form>
    </main>
  );
}
