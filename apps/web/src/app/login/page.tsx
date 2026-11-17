"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Fingerprint } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, WebAuthnAbortService } from "@simplewebauthn/browser";
import { api, setSession, setToken, type SesionDelServidor } from "@/lib/api";
import { hayPasskeyEnEsteAparato, recordarPasskeyEnEsteAparato } from "@/lib/passkey-aparato";

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
  // Passkeys (P2): entrar con Face ID / huella. `browserSupportsWebAuthn` corre solo en cliente.
  const [pkSupported, setPkSupported] = useState(false);
  const [pkBusy, setPkBusy] = useState(false);
  // P4 — ¿este aparato ya entró con Face ID? Solo cambia la PRESENTACIÓN (ver `passkey-aparato`).
  const [pkEnEsteAparato, setPkEnEsteAparato] = useState(false);

  useEffect(() => {
    setPkSupported(browserSupportsWebAuthn());
    setPkEnEsteAparato(hayPasskeyEnEsteAparato());
  }, []);

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

  /** Paso 1 del login por passkey: el desafío del servidor para ESTA marca. */
  function pedirDesafio() {
    return api<{ loginId: string; opciones: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(
      "/auth/passkey-login/options",
      { method: "POST", body: "{}" },
    );
  }

  /** Paso 3: canjea la firma por la sesión y entra. Compartido por el botón y el autocompletado. */
  async function canjearPasskey(loginId: string, response: Awaited<ReturnType<typeof startAuthentication>>) {
    // Entrar por passkey crea una SESIÓN DE APARATO (P3): trae `refreshToken` y sin techo. Se
    // guarda con `setSession` (no `setToken`), para conservar el refresh que renovará con Face ID.
    const res = await api<SesionDelServidor>("/auth/passkey-login", { method: "POST", body: JSON.stringify({ loginId, response }) });
    setSession(res);
    recordarPasskeyEnEsteAparato();
    router.push("/inbox");
  }

  // P4 — AUTOCOMPLETADO (mediación condicional): el passkey aparece DENTRO del campo de correo,
  // como aparece una contraseña guardada. Es lo que hace que entrar no parezca un login: no hay
  // que tocar ningún botón ni teclear nada, se elige la cuenta en la lista del propio navegador.
  //
  // Por qué no abrimos la hoja del sistema sola al cargar la pantalla: `credentials.get()` en
  // modo modal EXIGE un gesto de la persona en Safari/iOS. Dispararlo desde un `useEffect`
  // funciona en Android y tira `NotAllowedError` en iPhone — o sea, se rompe en la mitad de los
  // teléfonos y sin dejar rastro. La mediación condicional no exige gesto en ninguno de los dos.
  //
  // El campo de correo DEBE llevar `autocomplete` terminado en `webauthn` o la propia librería
  // tira error (`verifyBrowserAutofillInput`); lo encierra `passkeys-permisos.test.ts`.
  useEffect(() => {
    let vivo = true;
    (async () => {
      if (!(await browserSupportsWebAuthnAutofill().catch(() => false))) return;
      try {
        const { loginId, opciones } = await pedirDesafio();
        if (!vivo) return;
        // Queda ESPERANDO (no abre nada) hasta que se elija el passkey en el autocompletado.
        const response = await startAuthentication({ optionsJSON: opciones, useBrowserAutofill: true });
        if (!vivo) return;
        await canjearPasskey(loginId, response);
      } catch {
        // Abortada porque se tocó el botón o se dejó la pantalla, o este dominio no tiene
        // passkeys en el aparato: nada que la persona tenga que leer.
      }
    })();
    return () => {
      vivo = false;
      // Sin esto la ceremonia queda viva tras salir de la pantalla y la siguiente falla.
      WebAuthnAbortService.cancelCeremony();
    };
    // Corre una sola vez al montar: re-ejecutarla abortaría su propia ceremonia.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function entrarConPasskey() {
    setError(null);
    setPkBusy(true);
    try {
      // Paso 1: el servidor arma el desafío (sin saber aún quién entra). Paso 2: el SISTEMA pide
      // la cara o el dedo y el teléfono elige la cuenta. Paso 3: el servidor verifica y emite la
      // sesión — idéntica a la del login por contraseña.
      const { loginId, opciones } = await pedirDesafio();
      const response = await startAuthentication({ optionsJSON: opciones });
      await canjearPasskey(loginId, response);
    } catch (err) {
      const nombre = (err as { name?: string })?.name ?? "";
      // Cancelar el diálogo del sistema no es un error: no se muestra nada.
      if (nombre === "NotAllowedError" || nombre === "AbortError") return;
      setError(mensajeDeErrorPasskey(err));
    } finally {
      setPkBusy(false);
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

  /** El botón de Face ID. `destacado` lo pinta como el botón principal y lo deja arriba (P4). */
  function botonPasskey(destacado: boolean) {
    return (
      <button
        type="button"
        onClick={() => void entrarConPasskey()}
        disabled={pkBusy}
        className={
          destacado
            ? `${btn} flex items-center justify-center gap-2 text-sm`
            : "flex w-full items-center justify-center gap-2 rounded-lg border border-line-strong bg-panel px-4 py-2 text-sm font-medium text-ink hover:bg-app disabled:opacity-50"
        }
      >
        <Fingerprint size={16} aria-hidden />
        {pkBusy ? "Abriendo…" : "Entrar con Face ID o huella"}
      </button>
    );
  }

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
        {/* P4 — en el aparato que YA entró con Face ID, el botón va PRIMERO y acentuado: esa es
            la puerta de esta persona, no una alternativa escondida abajo de Google. En un
            aparato nuevo queda después, como una opción más entre otras. */}
        {pkSupported && pkEnEsteAparato ? botonPasskey(true) : null}
        <div id="google-btn" className="flex justify-center" />
        {pkSupported && !pkEnEsteAparato ? botonPasskey(false) : null}
        {(googleReady || pkSupported) && (
          <div className="flex items-center gap-3 text-xs text-ink-subtle">
            <span className="h-px flex-1 bg-line" />o<span className="h-px flex-1 bg-line" />
          </div>
        )}
        {/* §10.6 — `autoComplete` explícito: sin él los gestores de contraseñas no
            rellenan de forma fiable, lo que empuja a la gente a usar claves memorizables
            (o a escribirlas en otra parte). Es una medida de seguridad, no de comodidad.
            P4 — `webauthn` al final es lo que hace que el navegador ofrezca el passkey DENTRO
            de este campo (mediación condicional). Sin ese token la librería aborta la ceremonia
            y el autocompletado desaparece sin ningún error a la vista. `username` en vez de
            `email`: es el token que documentan Chrome y Safari para esto, y los gestores lo
            rellenan igual (el campo sigue siendo `type="email"`). El foco va acá cuando el
            aparato ya tiene passkey: enfocarlo es lo que despliega la hoja de Face ID. */}
        <label className="block text-sm">
          Email
          <input
            type="email"
            autoComplete="username webauthn"
            autoFocus={pkEnEsteAparato}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={input}
            required
          />
        </label>
        <label className="block text-sm">
          Contraseña
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} required />
        </label>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button type="submit" disabled={loading} className={btn}>{loading ? "Entrando…" : "Entrar"}</button>
        {/* §10.5 — la salida cuando se olvidó la contraseña. Sin esto el único camino era
            pedirle a alguien del equipo que la restableciera a mano. */}
        <p className="text-center text-sm text-ink-muted">
          <a href="/recuperar" className="hover:text-ink">¿Olvidaste tu contraseña?</a>
        </p>
        <p className="text-center text-sm text-ink-muted">
          ¿No tienes cuenta?{" "}
          <a href="/registro" className="font-medium text-brand-600 hover:text-brand-700">Crear cuenta gratis</a>
        </p>
      </form>
    </main>
  );
}

/** Los errores de WebAuthn llegan con nombres del estándar; no se muestran crudos. */
function mensajeDeErrorPasskey(e: unknown): string {
  const nombre = (e as { name?: string })?.name ?? "";
  if (nombre === "InvalidStateError") return "Este aparato no está activado en ninguna cuenta. Entra con tu contraseña y actívalo en Mi perfil.";
  const msg = (e as Error)?.message;
  if (msg && msg.length < 200) return msg;
  return "No se pudo entrar con este aparato. Usa tu correo y contraseña.";
}
