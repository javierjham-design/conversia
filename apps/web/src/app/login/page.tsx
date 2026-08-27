"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { api, setToken } from "@/lib/api";

type LoginResp =
  | { token: string }
  | { mfaRequired: true; mfaToken: string }
  | { mfaSetupRequired: true; mfaToken: string };

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [googleReady, setGoogleReady] = useState(false);

  // Estado del 2.º factor.
  const [mfaMode, setMfaMode] = useState<"verify" | "setup" | null>(null);
  const [mfaToken, setMfaToken] = useState("");
  const [code, setCode] = useState("");
  const [otpauth, setOtpauth] = useState("");
  const [secret, setSecret] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);

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
          callback: async (resp: any) => {
            setError(null);
            try {
              const r = await api<{ token: string }>("/auth/google", { method: "POST", body: JSON.stringify({ credential: resp.credential }) });
              setToken(r.token);
              router.push("/inbox");
            } catch (err) {
              setError((err as Error).message);
            }
          },
        });
        const el = document.getElementById("google-btn");
        if (el) {
          g.accounts.id.renderButton(el, { theme: "outline", size: "large", width: 320, text: "continue_with" });
          setGoogleReady(true);
        }
      } catch {
        /* Google no configurado */
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
      const res = await api<LoginResp>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      if ("token" in res) {
        setToken(res.token);
        router.push("/inbox");
      } else if ("mfaRequired" in res) {
        setMfaToken(res.mfaToken);
        setMfaMode("verify");
      } else {
        // Enrolamiento forzado por política de la organización.
        setMfaToken(res.mfaToken);
        const setup = await api<{ otpauthUri: string; secret: string }>("/auth/mfa/setup", { method: "POST", body: JSON.stringify({ mfaToken: res.mfaToken }) });
        setOtpauth(setup.otpauthUri);
        setSecret(setup.secret);
        setMfaMode("setup");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await api<{ token: string }>("/auth/mfa/verify", { method: "POST", body: JSON.stringify({ mfaToken, code }) });
      setToken(r.token);
      router.push("/inbox");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function enableForced(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const r = await api<{ token: string; recoveryCodes: string[] }>("/auth/mfa/enable", { method: "POST", body: JSON.stringify({ mfaToken, code }) });
      setRecovery(r.recoveryCodes);
      setToken(r.token); // sesión emitida; se entra tras ver los códigos
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const card = "w-full max-w-sm space-y-4 rounded-2xl border border-line bg-panel p-8 shadow-sm";
  const input = "mt-1 w-full rounded-lg border border-line-strong px-3 py-2";
  const btn = "w-full rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50";

  // Códigos de recuperación tras el enrolamiento forzado.
  if (recovery) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className={card}>
          <h1 className="text-center text-lg font-semibold">Guarda tus códigos de recuperación</h1>
          <p className="text-sm text-ink-muted">Úsalos si pierdes el acceso a tu app de autenticación. Cada uno sirve una vez. No volverán a mostrarse.</p>
          <div className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-app p-3 font-mono text-sm">
            {recovery.map((c) => (<span key={c}>{c}</span>))}
          </div>
          <button onClick={() => router.push("/inbox")} className={btn}>Ya los guardé, entrar</button>
        </div>
      </main>
    );
  }

  // Paso de verificación (2.º factor) o enrolamiento forzado.
  if (mfaMode) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <form onSubmit={mfaMode === "verify" ? verifyCode : enableForced} className={card}>
          <div className="text-center">
            <img src="/brand/tubot-horizontal.png" alt="TuBot.cl" className="mx-auto h-9 w-auto dark:brightness-0 dark:invert" />
            <h1 className="mt-2 text-lg font-semibold">Verificación en dos pasos</h1>
          </div>
          {mfaMode === "setup" && (
            <div className="space-y-2">
              <p className="text-sm text-ink-muted">Tu organización exige verificación en dos pasos. Escanea este código con Google Authenticator o Authy:</p>
              <div className="flex justify-center rounded-lg bg-white p-3">{otpauth && <QRCodeSVG value={otpauth} size={160} />}</div>
              <p className="text-center text-[11px] text-ink-subtle">¿No puedes escanear? Ingresa la clave: <span className="font-mono">{secret}</span></p>
            </div>
          )}
          <label className="block text-sm">
            Código de 6 dígitos
            <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoFocus placeholder="123456" className={`${input} text-center tracking-[0.3em]`} />
          </label>
          {mfaMode === "verify" && <p className="text-[11px] text-ink-subtle">También puedes ingresar uno de tus códigos de recuperación.</p>}
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <button type="submit" disabled={loading} className={btn}>{loading ? "Verificando…" : mfaMode === "setup" ? "Activar y entrar" : "Verificar"}</button>
        </form>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className={card}>
        <div className="text-center">
          <img src="/brand/tubot-horizontal.png" alt="TuBot.cl" className="mx-auto h-9 w-auto dark:brightness-0 dark:invert" />
          <p className="mt-2 text-sm text-ink-muted">Conversa. Automatiza. Crece.</p>
        </div>
        <div id="google-btn" className="flex justify-center" />
        {googleReady && (
          <div className="flex items-center gap-3 text-xs text-ink-subtle">
            <span className="h-px flex-1 bg-line" />o<span className="h-px flex-1 bg-line" />
          </div>
        )}
        <label className="block text-sm">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={input} required />
        </label>
        <label className="block text-sm">
          Contraseña
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} required />
        </label>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button type="submit" disabled={loading} className={btn}>{loading ? "Entrando…" : "Entrar"}</button>
        <p className="text-center text-sm text-ink-muted">
          ¿No tienes cuenta?{" "}
          <a href="/registro" className="font-medium text-brand-600 hover:text-brand-700">Crear cuenta gratis</a>
        </p>
      </form>
    </main>
  );
}
