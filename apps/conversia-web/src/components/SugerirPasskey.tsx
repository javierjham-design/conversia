"use client";
import { useEffect, useState } from "react";
import { Fingerprint, X } from "lucide-react";
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startRegistration } from "@simplewebauthn/browser";
import { api } from "@/lib/api";
import { convieneSugerirPasskey, noOfrecerPasskeyEnEsteAparato, recordarPasskeyEnEsteAparato } from "@/lib/passkey-aparato";

/**
 * P4 — SUGERENCIA de activar Face ID / huella en ESTE aparato.
 *
 * El valor de los passkeys se pierde entero si nadie los activa, y la pantalla donde se activan
 * (Ajustes → Acceso) no la visita quien no sabe que existe. Así que se ofrece una vez, donde la
 * persona ya está, y se acepta el «no» como definitivo (ver `passkey-aparato`).
 *
 * VA EN EL FLUJO, nunca flotando. Un aviso `position: fixed` abajo ya se envió una vez a
 * producción y tapaba la barra de pestañas, que en teléfono es el menú ENTERO: el aviso recibía
 * el toque en vez del botón de abajo, y un `toBeVisible` no lo ve porque los dos elementos
 * están visibles. Lo encierra `passkeys-permisos.test.ts`.
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
      // persona no lo activó ni lo rechazó acá. `platformAuthenticatorIsAvailable` es el que
      // evita ofrecérselo a un escritorio sin ningún sensor.
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
      setError(msg && msg.length < 200 ? msg : "No se pudo activar este aparato. Puedes hacerlo en Ajustes → Acceso.");
    } finally {
      setOcupado(false);
    }
  }

  function ahoraNo() {
    noOfrecerPasskeyEnEsteAparato();
    setMostrar(false);
  }

  if (!mostrar) return null;

  const base: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 16px",
    margin: "12px 16px 0",
    borderRadius: 12,
    background: "var(--acc-dim)",
    color: "var(--acc-deep)",
    fontSize: 13,
  };

  if (listo) {
    return (
      <div style={base}>
        <Fingerprint size={16} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1 }}>Listo. La próxima vez que entres, este aparato te va a pedir la cara o el dedo.</span>
        <button onClick={() => setMostrar(false)} aria-label="Cerrar" style={{ border: "none", background: "transparent", cursor: "pointer", color: "inherit", opacity: 0.7, display: "flex" }}>
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <div style={{ ...base, flexWrap: "wrap" }}>
      <Fingerprint size={16} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 180 }}>
        {error ?? "Activa Face ID o huella en este aparato y entra sin escribir tu contraseña."}
      </span>
      <button
        onClick={() => void activar()}
        disabled={ocupado}
        style={{ border: "none", background: "var(--acc)", color: "var(--acc-ink)", borderRadius: 8, padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: ocupado ? "default" : "pointer", opacity: ocupado ? 0.6 : 1 }}
      >
        {ocupado ? "Activando…" : "Activar"}
      </button>
      <button onClick={ahoraNo} style={{ border: "none", background: "transparent", color: "inherit", fontSize: 12, cursor: "pointer", opacity: 0.75, textDecoration: "underline" }}>
        Ahora no
      </button>
    </div>
  );
}

/** El mismo nombre que pone la tarjeta de Ajustes, para que la lista se lea igual. */
function nombreDelAparato(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Teléfono Android";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Computador Windows";
  return "Este dispositivo";
}
