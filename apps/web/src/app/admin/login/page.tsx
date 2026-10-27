"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { API_URL, setPlatformToken } from "@/lib/platform-api";

export default function PlatformLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [googleCred, setGoogleCred] = useState<string | null>(null);
  const [googleReady, setGoogleReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Botón "Continuar con Google" (GIS): el backend valida el ID token (/platform/auth/google),
  // resuelve la marca por Origin (tubot) y exige el mismo 2FA. Degrada en silencio si no carga.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfgRes = await fetch(`${API_URL}/auth/google-config`);
        const cfg = (await cfgRes.json().catch(() => ({}))) as { clientId?: string };
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
          g.accounts.id.renderButton(el, { theme: "outline", size: "large", width: 320, text: "continue_with" });
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
      const res = await fetch(`${API_URL}/platform/auth/google`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential, code: withCode || undefined }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (res.ok) {
        setPlatformToken(body.token);
        router.push("/admin");
        return;
      }
      if (body.mfaRequired) {
        setGoogleCred(credential);
        setNeedCode(true);
        setError(withCode ? "Código de verificación inválido." : null);
      } else {
        setError(body.message ?? "No se pudo iniciar sesión");
      }
    } catch {
      setError("Error de conexión");
    } finally {
      setLoading(false);
    }
  }

  async function submitPassword(withCode?: string) {
    setError(null);
    setLoading(true);
    try {
      // Fetch directo (no `padmin`) para poder leer el flag `mfaRequired` del 401.
      const res = await fetch(`${API_URL}/platform/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, code: withCode || undefined }),
      });
      const body = await res.json().catch(() => ({} as any));
      if (res.ok) {
        setPlatformToken(body.token);
        router.push("/admin");
        return;
      }
      if (body.mfaRequired) {
        setNeedCode(true);
        setError(withCode ? "Código de verificación inválido." : null);
      } else {
        setError(body.message ?? "No se pudo iniciar sesión");
      }
    } catch {
      setError("Error de conexión");
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (needCode && googleCred) return void doGoogle(googleCred, code);
    return void submitPassword(needCode ? code : undefined);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-navy-950 p-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-2xl border border-navy-700 bg-navy-900 p-8 text-navy-200 shadow-pop">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-500 text-white">
            <ShieldCheck size={18} />
          </div>
          <div>
            <h1 className="font-semibold text-white">TuBot · Plataforma</h1>
            <p className="text-[11px] text-navy-300">Administración de la plataforma</p>
          </div>
        </div>
        {!needCode && (
          <>
            <div id="admin-google-btn" className="flex justify-center" />
            {googleReady && (
              <div className="flex items-center gap-3 text-[11px] text-navy-400">
                <span className="h-px flex-1 bg-navy-700" />o<span className="h-px flex-1 bg-navy-700" />
              </div>
            )}
          </>
        )}
        <label className="block text-sm">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required={!googleCred} disabled={needCode} autoComplete="username" className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-800 px-3 py-2 text-white disabled:opacity-50" />
        </label>
        <label className="block text-sm">
          Contraseña
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required={!googleCred} disabled={needCode} autoComplete="current-password" className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-800 px-3 py-2 text-white disabled:opacity-50" />
        </label>
        {needCode && (
          <label className="block text-sm">
            Código de verificación
            <input
              inputMode="numeric"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6 dígitos de tu app"
              className="mt-1 w-full rounded-lg border border-navy-700 bg-navy-800 px-3 py-2 tracking-widest text-white"
            />
            <span className="mt-1 block text-[11px] text-navy-400">O usa un código de recuperación.</span>
          </label>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" disabled={loading} className="w-full rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50">
          {loading ? "Entrando…" : needCode ? "Verificar" : "Entrar"}
        </button>
        <p className="text-[11px] text-navy-300">Acceso exclusivo para administradores de la plataforma TuBot.</p>
      </form>
    </main>
  );
}
