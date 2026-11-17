"use client";

import { useEffect, useState } from "react";
import { Fingerprint, X } from "lucide-react";
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startRegistration } from "@simplewebauthn/browser";
import { api } from "@/lib/api";
import { convieneSugerirPasskey, noOfrecerPasskeyEnEsteAparato, recordarPasskeyEnEsteAparato } from "@/lib/passkey-aparato";

/**
 * P4 — SUGERENCIA de activar Face ID / huella en ESTE aparato. Gemelo del de conversia-web.
 *
 * El valor de los passkeys se pierde entero si nadie los activa, y la pantalla donde se activan
 * (Ajustes → Mi perfil) no la visita quien no sabe que existe. Así que se ofrece una vez, donde
 * la persona ya está, y se acepta el «no» como definitivo (ver `passkey-aparato`).
 *
 * VA EN EL FLUJO (banner delgado con borde, como el de activación), nunca flotando: un aviso
 * fijo abajo tapa la navegación en teléfono y un `toBeVisible` no lo caza.
 */
export function SugerirPasskey() {
  const [mostrar, setMostrar] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [listo, setListo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    (async () => {
      // Tres condiciones: el navegador puede, el aparato tiene lector (cara/dedo/Hello) y esta
      // persona no lo activó ni lo rechazó acá.
      if (!browserSupportsWebAuthn() || !convieneSugerirPasskey()) return;
      const hayLector = await platformAuthenticatorIsAvailable().catch(() => false);
      if (vivo && hayLector) setMostrar(true);
    })();
    return () => {
      vivo = false;
    };
  }, []);

  async function activar() {
    setError(null);
    setOcupado(true);
    try {
      const opciones = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/auth/passkeys/options", { method: "POST" });
      const response = await startRegistration({ optionsJSON: opciones });
      await api("/auth/passkeys", { method: "POST", body: JSON.stringify({ response, label: nombreDelAparato() }) });
      recordarPasskeyEnEsteAparato();
      setListo(true);
    } catch (e) {
      const nombre = (e as { name?: string })?.name ?? "";
      // Cancelar no es una falla: el aviso se queda como estaba, sin texto rojo.
      if (nombre === "NotAllowedError" || nombre === "AbortError") return;
      if (nombre === "InvalidStateError") {
        // Ya estaba activado en esta cuenta: la pista estaba mal, se corrige y el aviso se va.
        recordarPasskeyEnEsteAparato();
        setMostrar(false);
        return;
      }
      const msg = (e as Error)?.message;
      setError(msg && msg.length < 200 ? msg : "No se pudo activar este aparato. Puedes hacerlo en Ajustes → Mi perfil.");
    } finally {
      setOcupado(false);
    }
  }

  if (!mostrar) return null;

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-line bg-gradient-to-r from-brand-600/10 to-accent-500/10 px-4 py-2 text-[13px]">
      <Fingerprint size={16} className="shrink-0 text-brand-600 dark:text-accent-400" />
      <span className="flex-1 text-ink">
        {listo
          ? "Listo. La próxima vez que entres, este aparato te va a pedir la cara o el dedo."
          : (error ?? "Activa Face ID o huella en este aparato y entra sin escribir tu contraseña.")}
      </span>
      {!listo && (
        <>
          <button
            onClick={() => void activar()}
            disabled={ocupado}
            className="whitespace-nowrap rounded-lg bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {ocupado ? "Activando…" : "Activar"}
          </button>
          <button
            onClick={() => {
              noOfrecerPasskeyEnEsteAparato();
              setMostrar(false);
            }}
            className="whitespace-nowrap text-xs text-ink-muted underline hover:text-ink"
          >
            Ahora no
          </button>
        </>
      )}
      <button onClick={() => setMostrar(false)} aria-label="Ocultar" className="text-ink-subtle hover:text-ink">
        <X size={15} />
      </button>
    </div>
  );
}

/** El mismo nombre que pone la tarjeta de Mi perfil, para que la lista se lea igual. */
function nombreDelAparato(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Teléfono Android";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Computador Windows";
  return "Este dispositivo";
}
