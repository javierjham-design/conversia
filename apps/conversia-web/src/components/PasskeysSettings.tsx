"use client";
import { useEffect, useState } from "react";
import { Check, Fingerprint, Loader2, Pencil, Trash2, X } from "lucide-react";
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startRegistration } from "@simplewebauthn/browser";
import { api } from "@/lib/api";
import { olvidarPasskeyEnEsteAparato, recordarPasskeyEnEsteAparato } from "@/lib/passkey-aparato";

/**
 * P1 — «Entrar con Face ID o huella»: inscribir, renombrar y quitar aparatos.
 *
 * Lo que conviene saber al leer esto: la huella y la cara NO salen del teléfono. El aparato
 * guarda una llave privada en su chip seguro y la biometría solo sirve para destrabarla; acá
 * viaja únicamente la llave pública. Por eso esta pantalla no pide ningún permiso de cámara
 * ni de sensores: el diálogo lo muestra el SISTEMA, no la página.
 *
 * Encargo y plan completo en `docs/PROMPT_PASSKEYS_BIOMETRIA.md`.
 */

type Aparato = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  sincronizada: boolean;
};

/**
 * Nombre que se le propone al aparato recién inscrito. Es solo un punto de partida editable:
 * leer el `userAgent` para adivinar el modelo exacto es una carrera que no se gana, y lo que
 * la persona necesita es distinguir "el iPhone" de "el computador del mostrador".
 */
function nombreSugerido(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Teléfono Android";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Computador Windows";
  return "Este dispositivo";
}

/**
 * La animación del `Loader2` va declarada EN EL COMPONENTE, igual que en
 * `NotificationsSettings`, `canales` y `mini-sitio`: la clase no existe en `globals.css`, así
 * que usarla sin declararla deja el ícono quieto — y eso no lo cazan ni los tipos ni un test.
 */
const EstiloSpin = () => (
  <style>{`.lp-spin { animation: lpspin 1s linear infinite; } @keyframes lpspin { to { transform: rotate(360deg); } }`}</style>
);

function fecha(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("es-CL", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "";
  }
}

export function PasskeysSettings() {
  // `null` = todavía no se sabe (la comprobación del autenticador es asíncrona). Importa
  // distinguirlo de `false`: mostrar "tu equipo no puede" mientras se averigua es mentir.
  const [soporte, setSoporte] = useState<{ webauthn: boolean; plataforma: boolean } | null>(null);
  const [aparatos, setAparatos] = useState<Aparato[]>([]);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<{ id: string; label: string } | null>(null);

  async function cargar() {
    const r = await api<{ aparatos: Aparato[] }>("/auth/passkeys").catch(() => null);
    if (!r) return; // la petición falló: se deja la lista que ya estaba, no se concluye nada
    setAparatos(r.aparatos);
    // P4 — si la cuenta quedó SIN aparatos, con seguridad este tampoco tiene: se borra la pista
    // o el login seguiría ofreciendo Face ID como puerta principal para después fallar.
    // Solo con respuesta BUENA del servidor: una caída de red no significa "no hay ninguno".
    if (r.aparatos.length === 0) olvidarPasskeyEnEsteAparato();
  }

  useEffect(() => {
    const webauthn = browserSupportsWebAuthn();
    if (!webauthn) {
      setSoporte({ webauthn: false, plataforma: false });
      setCargando(false);
      return;
    }
    Promise.all([platformAuthenticatorIsAvailable().catch(() => false), cargar()])
      .then(([plataforma]) => setSoporte({ webauthn: true, plataforma }))
      .finally(() => setCargando(false));
  }, []);

  async function activar() {
    setError(null);
    setMsg(null);
    setOcupado(true);
    try {
      // Paso 1: el servidor arma el desafío. Paso 2: el SISTEMA pide la cara o el dedo.
      // Paso 3: el servidor verifica la firma y guarda la llave pública.
      const opciones = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/auth/passkeys/options", {
        method: "POST",
      });
      const response = await startRegistration({ optionsJSON: opciones });
      await api("/auth/passkeys", {
        method: "POST",
        body: JSON.stringify({ response, label: nombreSugerido() }),
      });
      // P4 — anota que ESTE aparato ya tiene passkey: el login lo pone de puerta principal y la
      // sugerencia de la barra deja de aparecer.
      recordarPasskeyEnEsteAparato();
      await cargar();
      setMsg("Listo. La próxima vez que entres, este aparato te va a pedir la cara o el dedo.");
    } catch (e) {
      setError(mensajeDeError(e));
    } finally {
      setOcupado(false);
    }
  }

  async function quitar(a: Aparato) {
    // Quitar el último aparato no deja a nadie afuera: la contraseña sigue siendo la puerta
    // de siempre. Por eso alcanza con confirmar, sin advertencias dramáticas.
    if (!window.confirm(`¿Quitar «${a.label}»? Para entrar desde ese aparato tendrás que usar tu contraseña.`)) return;
    setError(null);
    setMsg(null);
    setOcupado(true);
    try {
      await api(`/auth/passkeys/${encodeURIComponent(a.id)}`, { method: "DELETE" });
      await cargar();
      setMsg(`Se quitó «${a.label}».`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  async function guardarNombre() {
    if (!editando) return;
    const label = editando.label.trim();
    if (!label) {
      setEditando(null);
      return;
    }
    setOcupado(true);
    try {
      await api(`/auth/passkeys/${encodeURIComponent(editando.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ label }),
      });
      setEditando(null);
      await cargar();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  if (cargando) {
    return (
      <div className="card" style={{ padding: 20, marginBottom: 16 }}>
        <h2 className="display" style={{ fontSize: 18, margin: "0 0 10px" }}>Entrar con Face ID o huella</h2>
        <p className="text-dim" style={{ fontSize: 13, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <Loader2 size={14} className="lp-spin" /> Revisando este dispositivo…
        </p>
        <EstiloSpin />
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 20, marginBottom: 16 }}>
      <h2 className="display" style={{ fontSize: 18, margin: "0 0 4px" }}>Entrar con Face ID o huella</h2>
      <p className="text-dim" style={{ fontSize: 13, margin: "0 0 14px", lineHeight: 1.5 }}>
        Entra sin escribir tu correo ni tu contraseña. Tu huella y tu cara <strong>no salen de tu
        teléfono</strong>: el aparato guarda una llave y tu biometría solo la destraba.
      </p>

      {msg ? <p style={{ color: "var(--ok)", fontSize: 13, margin: "0 0 12px" }}>{msg}</p> : null}
      {error ? <p style={{ color: "var(--danger)", fontSize: 13, margin: "0 0 12px" }}>{error}</p> : null}

      {!soporte?.webauthn ? (
        <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>
          Este navegador no admite esta forma de entrar. Puedes activarla desde tu teléfono y seguir
          usando tu contraseña acá.
        </p>
      ) : (
        <>
          {aparatos.length === 0 ? (
            <p className="text-dim" style={{ fontSize: 13, margin: "0 0 14px" }}>
              Todavía no tienes ningún aparato activado.
            </p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: "0 0 16px", display: "grid", gap: 10 }}>
              {aparatos.map((a) => (
                <li
                  key={a.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 14px",
                    border: "1px solid var(--line)",
                    borderRadius: 12,
                    background: "var(--bg-tint)",
                    flexWrap: "wrap",
                  }}
                >
                  <Fingerprint size={18} style={{ color: "var(--acc)", flexShrink: 0 }} />
                  <div style={{ flex: "1 1 160px", minWidth: 0 }}>
                    {editando?.id === a.id ? (
                      <input
                        value={editando.label}
                        autoFocus
                        maxLength={60}
                        onChange={(e) => setEditando({ id: a.id, label: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void guardarNombre();
                          if (e.key === "Escape") setEditando(null);
                        }}
                        aria-label="Nombre del aparato"
                        style={{
                          width: "100%",
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid var(--line)",
                          background: "var(--surface-solid)",
                          color: "var(--ink)",
                          fontSize: 14,
                        }}
                      />
                    ) : (
                      <p style={{ margin: 0, fontSize: 14, fontWeight: 600, overflowWrap: "anywhere" }}>{a.label}</p>
                    )}
                    <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>
                      Activado el {fecha(a.createdAt)}
                      {a.lastUsedAt ? ` · usado el ${fecha(a.lastUsedAt)}` : " · sin usar todavía"}
                      {a.sincronizada ? " · se recupera en un equipo nuevo" : ""}
                    </p>
                  </div>
                  {editando?.id === a.id ? (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={() => void guardarNombre()}
                        disabled={ocupado}
                        aria-label={`Guardar el nombre de ${a.label}`}
                        style={botonIcono("var(--ok)")}
                      >
                        <Check size={16} />
                      </button>
                      <button onClick={() => setEditando(null)} aria-label="Cancelar" style={botonIcono("var(--ink-dim)")}>
                        <X size={16} />
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button
                        onClick={() => setEditando({ id: a.id, label: a.label })}
                        aria-label={`Renombrar ${a.label}`}
                        style={botonIcono("var(--ink-dim)")}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => void quitar(a)}
                        disabled={ocupado}
                        aria-label={`Quitar ${a.label}`}
                        style={botonIcono("var(--danger)")}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <button
            className="btn-accent"
            onClick={() => void activar()}
            disabled={ocupado}
            style={{ display: "inline-flex", alignItems: "center", gap: 8, opacity: ocupado ? 0.6 : 1 }}
          >
            {ocupado ? <Loader2 size={16} className="lp-spin" /> : <Fingerprint size={16} />}
            Activar en este dispositivo
          </button>

          {soporte.webauthn && !soporte.plataforma ? (
            <p className="text-dim" style={{ fontSize: 12, margin: "10px 0 0" }}>
              Este equipo no tiene lector de huella ni reconocimiento facial, pero puedes usar tu
              teléfono para entrar acá: al activar, elige «usar otro dispositivo».
            </p>
          ) : null}
        </>
      )}
      <EstiloSpin />
    </div>
  );
}

function botonIcono(color: string): React.CSSProperties {
  return {
    display: "grid",
    placeItems: "center",
    width: 34,
    height: 34,
    borderRadius: 10,
    cursor: "pointer",
    border: "1px solid var(--line)",
    background: "transparent",
    color,
    flexShrink: 0,
  };
}

/**
 * Los errores de WebAuthn llegan con nombres del estándar y no se pueden mostrar crudos.
 * El caso importante es `NotAllowedError`: es lo que pasa cuando la persona CANCELA el
 * diálogo del sistema o se le vence el tiempo. No es una falla y no se cuenta como tal.
 */
function mensajeDeError(e: unknown): string {
  const nombre = (e as { name?: string })?.name ?? "";
  if (nombre === "NotAllowedError") return "Se canceló. Puedes intentarlo otra vez cuando quieras.";
  if (nombre === "InvalidStateError") return "Este aparato ya estaba activado en tu cuenta.";
  if (nombre === "AbortError") return "Se canceló.";
  const msg = (e as Error)?.message;
  return msg && msg.length < 200 ? msg : "No se pudo activar este aparato. Intenta de nuevo.";
}
