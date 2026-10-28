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
 *
 * EL PASO DEL CÓDIGO ES UNA PANTALLA APARTE (28-oct-2026). Antes seguía mostrando los campos
 * de correo y contraseña, solo que `disabled`. Chrome los autocompletaba con cualquier cuenta
 * guardada de este dominio, así que al entrar con Google la pantalla mostraba un correo ajeno
 * —uno de un tenant de prueba— mientras por detrás se verificaba la credencial de Google.
 * Encima no había vuelta atrás: el botón de Google desaparecía y solo se salía recargando.
 * Resultado real: el dueño leyó un correo que no era el suyo, creyó que el login estaba roto
 * y quedó trabado. Ahora el paso del código dice CON QUÉ IDENTIDAD vas a entrar y tiene
 * "Usar otra cuenta".
 */
/**
 * Correo del ID token de Google, SOLO PARA MOSTRARLO. No se usa para decidir nada: quien
 * valida la firma es el backend contra Google. Sirve para que el paso del código diga con
 * qué cuenta estás entrando en vez de dejar que el autocompletado invente una.
 */
function correoDeGoogle(credential: string | null): string | null {
  if (!credential) return null;
  try {
    const payload = credential.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const email = JSON.parse(json)?.email;
    return typeof email === "string" && email ? email : null;
  } catch {
    return null;
  }
}

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

  /** Vuelve al primer paso. Sin esto, del paso del código solo se salía recargando la página. */
  function volver() {
    setMfa(false);
    setGoogleCred(null);
    setCode("");
    setError(null);
  }

  // Lo que se va a enviar de verdad: el correo del token de Google si venimos de ahí, y si no
  // el que el usuario escribió. Nunca lo que el navegador haya autocompletado por su cuenta.
  const identidad = correoDeGoogle(googleCred) ?? (email || null);

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
        {mfa ? (
          <>
            {/* Con qué identidad se va a entrar. El autocompletado del navegador ya no puede
                contradecir esto, porque los campos de contraseña no se renderizan acá. */}
            <p className="text-dim" style={{ fontSize: 13, margin: "0 0 16px" }}>
              Entrando como <strong style={{ color: "var(--ink)" }}>{identidad ?? "tu cuenta"}</strong>
              {googleCred ? " (Google)" : null}
            </p>
            <label style={{ fontSize: 13, display: "block" }} className="text-dim">
              Código de verificación (2FA)
              <input style={field} inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus placeholder="123456" autoComplete="one-time-code" />
              <span style={{ fontSize: 11, color: "var(--ink-subtle, #94a3b8)" }}>También podés usar un código de recuperación.</span>
            </label>
          </>
        ) : (
          <>
            <div id="admin-google-btn" style={{ display: "flex", justifyContent: "center" }} />
            {googleReady ? (
              <div className="text-dim" style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0", fontSize: 12 }}>
                <span style={{ height: 1, flex: 1, background: "var(--line)" }} />o<span style={{ height: 1, flex: 1, background: "var(--line)" }} />
              </div>
            ) : null}
            <label style={{ fontSize: 13 }} className="text-dim">
              Correo
              <input style={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            </label>
            <label style={{ fontSize: 13, display: "block", marginTop: 14 }} className="text-dim">
              Contraseña
              <input style={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
            </label>
          </>
        )}
        {error ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{error}</p> : null}
        <button className="btn-accent" type="submit" disabled={loading} style={{ width: "100%", marginTop: 20, opacity: loading ? 0.6 : 1 }}>
          {loading ? "Entrando…" : mfa ? "Verificar" : "Entrar"}
        </button>
        {mfa ? (
          <button
            type="button"
            onClick={volver}
            className="text-dim"
            style={{ width: "100%", marginTop: 12, background: "none", border: 0, cursor: "pointer", fontSize: 13, textDecoration: "underline" }}
          >
            Usar otra cuenta
          </button>
        ) : null}
      </form>
    </main>
  );
}
