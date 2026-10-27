"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { padmin, PlatformApiError, setPlatformToken } from "@/lib/platform-api";

/**
 * Login del SUPER ADMIN de Conversia. Mismo endpoint que TuBot (/platform/auth/login)
 * pero la marca se deriva del Origin (app.conversia.cl → conversia): solo valida contra
 * el super admin de Conversia. Si el admin tiene MFA, el backend responde `mfaRequired`
 * y mostramos el campo de código. También admite "Continuar con Google" (GIS): el backend
 * valida el ID token (/platform/auth/google) y exige el mismo 2FA.
 */
export default function AdminLogin() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [mfa, setMfa] = useState(false);
  const [googleCred, setGoogleCred] = useState<string | null>(null);
  const [googleReady, setGoogleReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Botón "Continuar con Google" (GIS). El backend valida el ID token, resuelve la marca por
  // Origin y exige el 2FA igual que el login por contraseña. Degrada en silencio si no carga.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await padmin<{ clientId: string }>("/auth/google-config");
        if (!cfg.clientId || cancelled) return;
        await new Promise<void>((resolve, reject) => {
          if ((window as any).google?.accounts?.id) return resolve();
          const s = document.createElement("script");
          s.src = "https://accounts.google.com/gsi/client";
          s.async = true;
          s.defer = true;
          s.onload = () => resolve();
          s.onerror = () => reject(new Error("gsi"));
          document.head.appendChild(s);
        });
        if (cancelled) return;
        const g = (window as any).google;
        g.accounts.id.initialize({
          client_id: cfg.clientId,
          callback: (resp: { credential?: string }) => {
            if (resp.credential) void doGoogle(resp.credential);
          },
        });
        const el = document.getElementById("admin-google-btn");
        if (el) {
          g.accounts.id.renderButton(el, { theme: "outline", size: "large", width: 344, text: "continue_with" });
          setGoogleReady(true);
        }
      } catch {
        /* Google no disponible: queda el login por contraseña */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function doGoogle(credential: string, withCode?: string) {
    setError(null);
    setLoading(true);
    try {
      const res = await padmin<{ token: string }>("/platform/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential, ...(withCode ? { code: withCode } : {}) }),
      });
      setPlatformToken(res.token);
      router.replace("/admin");
    } catch (err) {
      if (err instanceof PlatformApiError && err.body?.mfaRequired) {
        setGoogleCred(credential);
        setMfa(true);
        setError(withCode ? "Código inválido. Intenta de nuevo." : null);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function submitPassword(withCode?: string) {
    setError(null);
    setLoading(true);
    try {
      const res = await padmin<{ token: string; brand: string }>("/platform/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password, ...(withCode ? { code: withCode } : {}) }),
      });
      setPlatformToken(res.token);
      router.replace("/admin");
    } catch (err) {
      if (err instanceof PlatformApiError && err.body?.mfaRequired) {
        setMfa(true);
        setError(withCode ? "Código inválido. Intenta de nuevo." : null);
      } else {
        setError((err as Error).message);
      }
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // En el paso de 2FA: si venimos de Google, verificamos con la credencial guardada; si no, contraseña.
    if (mfa && googleCred) return void doGoogle(googleCred, code);
    return void submitPassword(mfa ? code : undefined);
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
      <form onSubmit={onSubmit} className="card" style={{ width: "100%", maxWidth: 400, padding: 28 }}>
        <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Conversia · Consola</p>
        <h1 className="display" style={{ fontSize: 26, margin: "4px 0 20px" }}>
          Super <span className="display-italic">admin</span>
        </h1>
        {!mfa ? (
          <>
            <div id="admin-google-btn" style={{ display: "flex", justifyContent: "center" }} />
            {googleReady ? (
              <div className="text-dim" style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0", fontSize: 12 }}>
                <span style={{ height: 1, flex: 1, background: "var(--line)" }} />o<span style={{ height: 1, flex: 1, background: "var(--line)" }} />
              </div>
            ) : null}
          </>
        ) : null}
        <label style={{ fontSize: 13 }} className="text-dim">
          Correo
          <input style={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" disabled={mfa} />
        </label>
        <label style={{ fontSize: 13, display: "block", marginTop: 14 }} className="text-dim">
          Contraseña
          <input style={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={!googleCred} autoComplete="current-password" disabled={mfa} />
        </label>
        {mfa ? (
          <label style={{ fontSize: 13, display: "block", marginTop: 14 }} className="text-dim">
            Código de verificación (2FA)
            <input style={field} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus placeholder="123456" />
            <span style={{ fontSize: 11, color: "var(--ink-subtle, #94a3b8)" }}>También podés usar un código de recuperación.</span>
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
