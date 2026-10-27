"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, setSession } from "@/lib/api";

/** Solo acepta rutas internas ("/algo"), nunca absolutas ("//host") → anti open-redirect. */
function safeVolver(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expired, setExpired] = useState(false);
  const [volver, setVolver] = useState<string | null>(null);
  const [googleReady, setGoogleReady] = useState(false);

  // Lee el motivo (?expirada=1) y la ruta a la que volver (?volver=) del querystring. Vía
  // window.location para no exigir un <Suspense> alrededor de useSearchParams (Next 15).
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setExpired(q.get("expirada") === "1");
    setVolver(safeVolver(q.get("volver")));
  }, []);

  // Botón "Continuar con Google" (Google Identity Services). El backend valida el ID token
  // y resuelve la marca por el Origin (app.conversia.cl → conversia); emite la MISMA sesión
  // deslizante que el login con correo (setSession). Es SOLO acceso: no crea cuentas nuevas.
  // Si Google no está configurado o lo bloquea el navegador, el login con correo sigue intacto.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await api<{ clientId: string }>("/auth/google-config");
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
          callback: async (resp: { credential?: string }) => {
            setError(null);
            try {
              const r = await api<{ token: string; refreshToken?: string }>("/auth/google", {
                method: "POST",
                body: JSON.stringify({ credential: resp.credential }),
              });
              setSession(r);
              const back = safeVolver(new URLSearchParams(window.location.search).get("volver"));
              router.replace(back ?? "/inicio");
            } catch (err) {
              setError((err as Error).message);
            }
          },
        });
        const el = document.getElementById("google-btn");
        if (el) {
          g.accounts.id.renderButton(el, { theme: "outline", size: "large", width: 324, text: "continue_with" });
          setGoogleReady(true);
        }
      } catch {
        /* Google no configurado o bloqueado: solo se oculta el botón. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Identidad ÚNICA de plataforma: el MISMO login que TuBot (misma API, mismo JWT).
      const res = await api<{ token: string; refreshToken?: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setSession(res);
      // Tras entrar, vuelve a donde estaba cuando expiró la sesión (si es una ruta interna segura).
      router.replace(volver ?? "/inicio");
    } catch (err) {
      setError((err as Error).message);
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
      <form onSubmit={submit} className="card" style={{ width: "100%", maxWidth: 380, padding: 28 }}>
        <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Conversia</p>
        <h1 className="display" style={{ fontSize: 26, margin: "4px 0 20px" }}>
          Entra a tu <span className="display-italic">negocio</span>
        </h1>
        {expired ? (
          <p style={{ fontSize: 13, margin: "0 0 16px", padding: "10px 12px", borderRadius: 10, background: "var(--acc-dim)", color: "var(--acc-deep)", lineHeight: 1.45 }}>
            Tu sesión expiró por seguridad. Entra de nuevo y seguimos donde estabas.
          </p>
        ) : null}
        <div id="google-btn" style={{ display: "flex", justifyContent: "center" }} />
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
        {error ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{error}</p> : null}
        <button className="btn-accent" type="submit" disabled={loading} style={{ width: "100%", marginTop: 20, opacity: loading ? 0.6 : 1 }}>
          {loading ? "Entrando…" : "Entrar"}
        </button>
        <p className="text-dim" style={{ fontSize: 13, textAlign: "center", marginTop: 16 }}>
          ¿No tienes cuenta? <a href="/registro" className="text-accent" style={{ textDecoration: "none" }}>Crear cuenta</a>
        </p>
      </form>
    </main>
  );
}
