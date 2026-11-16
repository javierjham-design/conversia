"use client";

/**
 * Entrar a TuBot con Face ID / huella (passkeys, WebAuthn) — inscribir, renombrar y quitar
 * aparatos.
 *
 * Lo que conviene saber al leer esto: la huella y la cara NO salen del teléfono. El aparato
 * guarda una llave privada en su chip seguro y la biometría solo la DESTRABA; acá viaja
 * únicamente la llave pública. Por eso esta tarjeta no pide ningún permiso de cámara ni de
 * sensores: el diálogo lo muestra el SISTEMA, no la página.
 *
 * El backend ya está hecho y es consciente de la marca (PR #654): un Origin de `tubot.cl` emite
 * para el RP ID `tubot.cl`. Un passkey de Conversia NO sirve acá y al revés —son dominios
 * distintos, luego RP distintos—, así que quien use las dos marcas tiene que activar el aparato
 * en cada una. No es un error: es cómo funciona WebAuthn.
 *
 * Esto es el espejo en TuBot de `apps/conversia-web/src/components/PasskeysSettings.tsx`: misma
 * lógica, pero con el sistema de componentes de TuBot (`@/components/ui`) en vez de estilos en
 * línea. Diseño de fondo en `docs/PROMPT_PASSKEYS_BIOMETRIA.md`; encargo en
 * `docs/PROMPT_PASSKEYS_TUBOT.md`.
 */
import { useEffect, useState } from "react";
import { Check, Fingerprint, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startRegistration } from "@simplewebauthn/browser";
import { api } from "@/lib/api";
import { Button, IconButton, cn, useToast } from "@/components/ui";

type Aparato = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  sincronizada: boolean;
};

/**
 * Nombre que se le propone al aparato recién inscrito. Es solo un punto de partida editable:
 * leer el `userAgent` para adivinar el modelo exacto es una carrera que no se gana, y lo que la
 * persona necesita es distinguir "el iPhone" de "el computador del mostrador".
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

function fecha(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("es-CL", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "";
  }
}

export function PasskeysCard() {
  const toast = useToast();
  // `null` = todavía no se sabe (la comprobación del autenticador es asíncrona). Importa
  // distinguirlo de `false`: decir "tu equipo no puede" mientras se averigua es mentir.
  const [soporte, setSoporte] = useState<{ webauthn: boolean; plataforma: boolean } | null>(null);
  const [aparatos, setAparatos] = useState<Aparato[]>([]);
  const [cargando, setCargando] = useState(true);
  const [ocupado, setOcupado] = useState(false);
  const [editando, setEditando] = useState<{ id: string; label: string } | null>(null);

  async function cargar() {
    const r = await api<{ aparatos: Aparato[] }>("/auth/passkeys").catch(() => null);
    // Defensa ante datos incompletos (el smoke e2e-robustez manda cuerpos vacíos/null): si no
    // viene `aparatos`, lista vacía — nunca un `.map` sobre `undefined`.
    setAparatos(Array.isArray(r?.aparatos) ? r!.aparatos : []);
  }

  useEffect(() => {
    if (!browserSupportsWebAuthn()) {
      setSoporte({ webauthn: false, plataforma: false });
      setCargando(false);
      return;
    }
    Promise.all([platformAuthenticatorIsAvailable().catch(() => false), cargar()])
      .then(([plataforma]) => setSoporte({ webauthn: true, plataforma }))
      .finally(() => setCargando(false));
  }, []);

  async function activar() {
    setOcupado(true);
    try {
      // Paso 1: el servidor arma el desafío. Paso 2: el SISTEMA pide la cara o el dedo. Paso 3:
      // el servidor verifica la firma y guarda la llave pública.
      const opciones = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/auth/passkeys/options", {
        method: "POST",
        body: "{}",
      });
      const response = await startRegistration({ optionsJSON: opciones });
      await api("/auth/passkeys", { method: "POST", body: JSON.stringify({ response, label: nombreSugerido() }) });
      await cargar();
      toast.push("Listo. La próxima vez que entres, este aparato te va a pedir la cara o el dedo.", "ok");
    } catch (e) {
      toast.push(mensajeDeError(e), "error");
    } finally {
      setOcupado(false);
    }
  }

  async function quitar(a: Aparato) {
    // Quitar el último aparato no deja a nadie afuera: la contraseña sigue siendo la puerta de
    // siempre. Por eso alcanza con confirmar, sin advertencias dramáticas.
    if (!window.confirm(`¿Quitar «${a.label}»? Para entrar desde ese aparato tendrás que usar tu contraseña.`)) return;
    setOcupado(true);
    try {
      await api(`/auth/passkeys/${encodeURIComponent(a.id)}`, { method: "DELETE" });
      await cargar();
      toast.push(`Se quitó «${a.label}».`, "info");
    } catch (e) {
      toast.push((e as Error).message, "error");
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
      await api(`/auth/passkeys/${encodeURIComponent(editando.id)}`, { method: "PATCH", body: JSON.stringify({ label }) });
      setEditando(null);
      await cargar();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setOcupado(false);
    }
  }

  const activos = aparatos.length > 0;
  const input = "w-full rounded-lg border border-line-strong bg-panel px-2.5 py-1.5 text-sm";

  return (
    <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Entrar con Face ID o huella</p>
          <p className="mt-0.5 text-xs text-ink-subtle">
            Entra sin escribir tu contraseña. Tu huella y tu cara <strong>no salen de tu teléfono</strong>: el aparato
            guarda una llave y tu biometría solo la destraba.
          </p>
        </div>
        {!cargando && soporte?.webauthn && (
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
              activos ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-app text-ink-subtle",
            )}
          >
            {activos ? "Activa" : "Inactiva"}
          </span>
        )}
      </div>

      {cargando ? (
        <p className="mt-3 flex items-center gap-2 text-xs text-ink-subtle">
          <Loader2 size={14} className="animate-spin" /> Revisando este dispositivo…
        </p>
      ) : !soporte?.webauthn ? (
        <p className="mt-3 text-xs text-ink-muted">
          Este navegador no admite esta forma de entrar. Puedes activarla desde tu teléfono y seguir usando tu
          contraseña acá.
        </p>
      ) : (
        <>
          {aparatos.length > 0 && (
            <ul className="mt-3 grid gap-2">
              {aparatos.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-app px-3 py-2.5">
                  <Fingerprint size={18} className="shrink-0 text-brand-600" aria-hidden />
                  <div className="min-w-0 flex-1 basis-40">
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
                        className={input}
                      />
                    ) : (
                      <p className="truncate text-sm font-medium">{a.label}</p>
                    )}
                    <p className="mt-0.5 text-[11px] text-ink-subtle">
                      Activado el {fecha(a.createdAt)}
                      {a.lastUsedAt ? ` · usado el ${fecha(a.lastUsedAt)}` : " · sin usar todavía"}
                      {a.sincronizada ? " · se recupera en un equipo nuevo" : ""}
                    </p>
                  </div>
                  {editando?.id === a.id ? (
                    <div className="flex gap-1">
                      <IconButton label={`Guardar el nombre de ${a.label}`} onClick={() => void guardarNombre()} disabled={ocupado}>
                        <Check size={16} />
                      </IconButton>
                      <IconButton label="Cancelar" onClick={() => setEditando(null)}>
                        <X size={16} />
                      </IconButton>
                    </div>
                  ) : (
                    <div className="flex gap-1">
                      <IconButton label={`Renombrar ${a.label}`} onClick={() => setEditando({ id: a.id, label: a.label })}>
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton label={`Quitar ${a.label}`} destructive onClick={() => void quitar(a)} disabled={ocupado}>
                        <Trash2 size={16} />
                      </IconButton>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-3">
            <Button onClick={() => void activar()} disabled={ocupado}>
              {ocupado ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              Activar en este dispositivo
            </Button>
          </div>

          {soporte.webauthn && !soporte.plataforma && (
            <p className="mt-2 text-[11px] text-ink-subtle">
              Este equipo no tiene lector de huella ni reconocimiento facial, pero puedes usar tu teléfono para entrar
              acá: al activar, elige «usar otro dispositivo».
            </p>
          )}

          <p className="mt-3 border-t border-line pt-3 text-[11px] text-ink-subtle">
            Tu contraseña sigue funcionando: el passkey es una vía más para entrar, nunca la única. Si también usas
            Conversia, actívalo por separado allá (son cuentas y dominios distintos).
          </p>
        </>
      )}
    </div>
  );
}

/**
 * Los errores de WebAuthn llegan con nombres del estándar y no se pueden mostrar crudos. El caso
 * importante es `NotAllowedError`: es lo que pasa cuando la persona CANCELA el diálogo del
 * sistema o se le vence el tiempo. No es una falla y no se cuenta como tal.
 */
function mensajeDeError(e: unknown): string {
  const nombre = (e as { name?: string })?.name ?? "";
  if (nombre === "NotAllowedError") return "Se canceló. Puedes intentarlo otra vez cuando quieras.";
  if (nombre === "InvalidStateError") return "Este aparato ya estaba activado en tu cuenta.";
  if (nombre === "AbortError") return "Se canceló.";
  const msg = (e as Error)?.message;
  return msg && msg.length < 200 ? msg : "No se pudo activar este aparato. Intenta de nuevo.";
}
