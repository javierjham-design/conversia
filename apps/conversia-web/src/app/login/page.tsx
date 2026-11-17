"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Fingerprint } from "lucide-react";
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication, WebAuthnAbortService } from "@simplewebauthn/browser";
import { api, setSession, type SesionDelServidor } from "@/lib/api";
import { hayPasskeyEnEsteAparato, recordarPasskeyEnEsteAparato } from "@/lib/passkey-aparato";

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
  // Passkeys (P2): entrar con Face ID / huella. `browserSupportsWebAuthn` corre solo en cliente.
  const [pkSupported, setPkSupported] = useState(false);
  const [pkBusy, setPkBusy] = useState(false);
  // P4 — ¿este aparato ya entró con Face ID? Solo cambia la PRESENTACIÓN (ver `passkey-aparato`).
  const [pkEnEsteAparato, setPkEnEsteAparato] = useState(false);

  useEffect(() => {
    setPkSupported(browserSupportsWebAuthn());
    setPkEnEsteAparato(hayPasskeyEnEsteAparato());
  }, []);

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
              const r = await api<SesionDelServidor>("/auth/google", {
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

  /** Paso 1 del login por passkey: el desafío del servidor para ESTA marca. */
  function pedirDesafio() {
    return api<{ loginId: string; opciones: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>(
      "/auth/passkey-login/options",
      { method: "POST", body: "{}" },
    );
  }

  /** Paso 3: canjea la firma por la sesión y entra. Compartido por el botón y el autocompletado. */
  async function canjearPasskey(loginId: string, response: Awaited<ReturnType<typeof startAuthentication>>) {
    const res = await api<SesionDelServidor>("/auth/passkey-login", { method: "POST", body: JSON.stringify({ loginId, response }) });
    setSession(res);
    recordarPasskeyEnEsteAparato();
    // Igual que el callback de Google: la ruta se relee del querystring en vez de confiar en el
    // estado, porque este camino puede resolverse mucho después de montar la pantalla.
    router.replace(safeVolver(new URLSearchParams(window.location.search).get("volver")) ?? "/inicio");
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
      // El servidor arma el desafío (sin saber aún quién entra); el SISTEMA pide la cara/dedo y
      // el teléfono elige la cuenta; el servidor verifica y emite la MISMA sesión deslizante.
      const { loginId, opciones } = await pedirDesafio();
      const response = await startAuthentication({ optionsJSON: opciones });
      await canjearPasskey(loginId, response);
    } catch (err) {
      const nombre = (err as { name?: string })?.name ?? "";
      if (nombre === "NotAllowedError" || nombre === "AbortError") return; // canceló: sin ruido
      const msg = (err as Error)?.message;
      setError(msg && msg.length < 200 ? msg : "No se pudo entrar con este aparato. Usa tu correo y contraseña.");
    } finally {
      setPkBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Identidad ÚNICA de plataforma: el MISMO login que TuBot (misma API, mismo JWT).
      const res = await api<SesionDelServidor>("/auth/login", {
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

  /** El botón de Face ID. `destacado` lo pinta con el acento y lo deja arriba de todo (P4). */
  function botonPasskey(destacado: boolean) {
    return (
      <button
        type="button"
        onClick={() => void entrarConPasskey()}
        disabled={pkBusy}
        className={destacado ? "btn-accent" : undefined}
        style={{
          width: "100%",
          marginTop: destacado ? 0 : 12,
          marginBottom: destacado ? 12 : 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          cursor: pkBusy ? "default" : "pointer",
          opacity: pkBusy ? 0.6 : 1,
          ...(destacado
            ? {}
            : { padding: "11px 13px", borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 }),
        }}
      >
        <Fingerprint size={16} aria-hidden />
        {pkBusy ? "Abriendo…" : "Entrar con Face ID o huella"}
      </button>
    );
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
        {/* P4 — en el aparato que YA entró con Face ID, el botón va PRIMERO y acentuado: esa es
            la puerta de esta persona, no una alternativa escondida abajo de Google. En un
            aparato nuevo queda después, como una opción más entre otras. */}
        {pkSupported && pkEnEsteAparato ? botonPasskey(true) : null}
        <div id="google-btn" style={{ display: "flex", justifyContent: "center" }} />
        {pkSupported && !pkEnEsteAparato ? botonPasskey(false) : null}
        {googleReady || pkSupported ? (
          <div className="text-dim" style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0", fontSize: 12 }}>
            <span style={{ height: 1, flex: 1, background: "var(--line)" }} />o<span style={{ height: 1, flex: 1, background: "var(--line)" }} />
          </div>
        ) : null}
        <label style={{ fontSize: 13 }} className="text-dim">
          Correo
          {/* P4 — `webauthn` al final del `autocomplete` es lo que hace que el navegador ofrezca
              el passkey DENTRO de este campo (mediación condicional). Sin ese token la librería
              aborta la ceremonia y el autocompletado desaparece sin ningún error a la vista.
              `username` en vez de `email`: es el token que documentan Chrome y Safari para esto,
              y los gestores de contraseñas lo rellenan igual (sigue siendo `type="email"`).
              El foco va en este campo cuando el aparato ya tiene passkey: en iPhone y Android
              enfocarlo es lo que despliega la hoja de Face ID, sin tocar ningún botón. */}
          <input
            style={field}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username webauthn"
            autoFocus={pkEnEsteAparato}
          />
        </label>
        <label style={{ fontSize: 13, display: "block", marginTop: 14 }} className="text-dim">
          Contraseña
          <input style={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        {error ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{error}</p> : null}
        <button className="btn-accent" type="submit" disabled={loading} style={{ width: "100%", marginTop: 20, opacity: loading ? 0.6 : 1 }}>
          {loading ? "Entrando…" : "Entrar"}
        </button>
        {/* §10.5 — la salida cuando se olvidó la contraseña. Sin esto el único camino era
            escribir a Soporte para que un admin la restableciera a mano. */}
        <p className="text-dim" style={{ fontSize: 13, textAlign: "center", marginTop: 14 }}>
          <a href="/recuperar" className="text-dim" style={{ textDecoration: "none" }}>¿Olvidaste tu contraseña?</a>
        </p>
        <p className="text-dim" style={{ fontSize: 13, textAlign: "center", marginTop: 8 }}>
          ¿No tienes cuenta? <a href="/registro" className="text-accent" style={{ textDecoration: "none" }}>Crear cuenta</a>
        </p>
      </form>
    </main>
  );
}
