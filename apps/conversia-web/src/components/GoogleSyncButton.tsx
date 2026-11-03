"use client";
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, MoreHorizontal, RefreshCw, X } from "lucide-react";
import { api } from "@/lib/api";
import { sugerirParaEquipo, type CalendarOption } from "@/lib/google-sugerencias";

/**
 * ETAPA 4 — "Sincronizar con Google Calendar" en la cabecera de la Agenda.
 *
 * Por qué acá y no en Integraciones: este panel no tiene esa pantalla, y además el dueño de
 * una barbería no entra a "Integraciones" — entra a su agenda. El flujo completo (autorizar,
 * elegir calendarios, activar) cabe en un popup y un paso.
 *
 * Tres estados, como pidió el encargo:
 *  1. sin conectar → botón que abre el OAuth y, al volver, el asistente de 1 paso
 *  2. conectado    → "sincronizado hace X min" con punto verde; al apretarlo, fuerza el sync
 *  3. con error    → ámbar "Reconectar", y a la vuelta todo queda como estaba
 */

interface ProLite {
  id: string;
  name: string;
  specialty: string | null;
}
interface ProCal {
  calendarId: string;
  readBusy: boolean;
  writeEvents: boolean;
}
export interface GoogleStatus {
  connected: boolean;
  plataformaLista: boolean;
  /** El rol puede configurar integraciones. Sin esto solo se muestra el estado. */
  puedeConfigurar?: boolean;
  professionals: ProLite[];
  config: { businessCalendarId: string; calendarSync: boolean; businessReadBusy: boolean; calendars: Record<string, ProCal> };
  calendarOptions: CalendarOption[] | null;
  permisos: { calendar: boolean; faltanParaCalendar: string[] } | null;
  status: string | null;
  lastError: string | null;
  accountEmail: string | null;
  lastSyncAt: string | null;
  lastPull?: { at?: string; movidas?: number; eliminadas?: number } | null;
}

const AYUDA_COMPARTIR =
  "En el Google Calendar de esa persona: Configuración del calendario → Compartir con determinadas personas → agregar el correo de la cuenta que conectaste, con el permiso " +
  '"Hacer cambios en eventos". Después vuelve acá y actualiza: su calendario va a aparecer en la lista.';

function haceCuanto(iso: string | null | undefined): string {
  if (!iso) return "nunca";
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

const BTN: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, padding: "8px 12px", borderRadius: 10,
  border: "1px solid var(--line)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 13,
};

/** Logo de Google en SVG (sin pedirle una imagen a un dominio externo: la CSP lo bloquearía). */
function GoogleLogo({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.0 6.1 29.3 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.0 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.6 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.2 5.2C40.9 35.6 44 30.3 44 24c0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  );
}

export function GoogleSyncButton({ onChanged }: { onChanged?: () => void }) {
  const [st, setSt] = useState<GoogleStatus | null>(null);
  const [cargando, setCargando] = useState(true);
  const [asistente, setAsistente] = useState(false);
  const [menu, setMenu] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const cargar = useCallback(async () => {
    try {
      setSt(await api<GoogleStatus>("/integrations/google/status"));
    } catch {
      setSt(null); // sin permiso de integraciones o api vieja: el botón no se muestra
    } finally {
      setCargando(false);
    }
  }, []);
  useEffect(() => {
    void cargar();
  }, [cargar]);

  /** Abre el popup de OAuth y espera el postMessage de la api. */
  async function autorizar(alVolver: () => void) {
    setErr(null);
    try {
      const { url } = await api<{ url: string }>("/integrations/oauth/google/authorize?feature=calendar");
      const popup = window.open(url, "google-oauth", "width=520,height=680");
      const onMsg = (e: MessageEvent) => {
        const d = e.data as { source?: string; provider?: string; result?: string } | null;
        if (d?.source !== "conversia-oauth" || d.provider !== "google") return;
        window.removeEventListener("message", onMsg);
        if (d.result === "connected") {
          void cargar().then(alVolver);
        } else {
          setErr(d.result === "denied" ? "Cancelaste la autorización en Google." : "Google no pudo completar la conexión. Inténtalo otra vez.");
        }
      };
      window.addEventListener("message", onMsg);
      if (!popup) setErr("Tu navegador bloqueó la ventana de Google. Permite las ventanas emergentes.");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function sincronizarAhora() {
    setOcupado(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await api<{ citasEnviadas: number }>("/integrations/google/sync-now", { method: "POST" });
      // El sondeo corre en el worker; se espera un momento y se lee su resumen.
      await new Promise((res) => setTimeout(res, 2500));
      const nuevo = await api<GoogleStatus>("/integrations/google/status");
      setSt(nuevo);
      const traidos = (nuevo.lastPull?.movidas ?? 0) + (nuevo.lastPull?.eliminadas ?? 0);
      setMsg(`${traidos} cambio(s) traído(s) de Google · ${r.citasEnviadas} cita(s) enviada(s)`);
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  async function desconectar() {
    if (!confirm("¿Desconectar Google Calendar? Tus citas dejarán de aparecer ahí y el asistente volverá a ofrecer las horas que tengas ocupadas en Google.")) return;
    setOcupado(true);
    try {
      await api("/integrations/google", { method: "DELETE" });
      setMenu(false);
      await cargar();
      onChanged?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setOcupado(false);
    }
  }

  if (cargando || !st || !st.plataformaLista) return null;

  // Sin permiso de integraciones: solo el estado, sin acciones (el encargo lo pide, y
  // además evita ofrecer un botón que la api va a rechazar con 403).
  if (st.puedeConfigurar === false) {
    return st.connected ? (
      <span className="text-dim" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span style={{ width: 7, height: 7, borderRadius: 7, background: "var(--ok)", display: "inline-block" }} />
        Google Calendar · {haceCuanto(st.lastSyncAt)}
      </span>
    ) : null;
  }

  // ---------- Estado 3: hay que reconectar ----------
  const reconectar = st.connected && (st.status === "reauthorize" || (st.permisos && !st.permisos.calendar));
  if (reconectar) {
    return (
      <div style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
        <button style={{ ...BTN, borderColor: "var(--warn, #c90)", color: "var(--warn, #c90)" }} onClick={() => autorizar(() => setMsg("Listo, volvió a quedar conectado."))}>
          <GoogleLogo /> Reconectar Google Calendar
        </button>
        {err ? <span style={{ color: "var(--danger)", fontSize: 11 }}>{err}</span> : null}
      </div>
    );
  }

  // ---------- Estado 1: sin conectar ----------
  if (!st.connected) {
    return (
      <>
        <div style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
          <button style={BTN} onClick={() => autorizar(() => setAsistente(true))} data-copilot="conectar-google">
            <GoogleLogo /> Sincronizar con Google Calendar
          </button>
          {err ? <span style={{ color: "var(--danger)", fontSize: 11 }}>{err}</span> : null}
        </div>
        {asistente ? <Asistente st={st} onClose={() => setAsistente(false)} onListo={(m) => { setAsistente(false); setMsg(m); void cargar(); onChanged?.(); }} /> : null}
      </>
    );
  }

  // ---------- Estado 2: conectado ----------
  return (
    <>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, position: "relative" }}>
        <button style={BTN} onClick={sincronizarAhora} disabled={ocupado} title="Traer los cambios de Google ahora">
          <span style={{ width: 7, height: 7, borderRadius: 7, background: "var(--ok)", display: "inline-block" }} />
          {ocupado ? "Sincronizando…" : `Google Calendar · ${haceCuanto(st.lastSyncAt)}`}
          {ocupado ? null : <RefreshCw size={12} />}
        </button>
        <button style={{ ...BTN, padding: "8px 8px" }} onClick={() => setMenu((v) => !v)} aria-label="Más opciones"><MoreHorizontal size={15} /></button>
        {menu ? (
          <div className="card" style={{ position: "absolute", top: "110%", right: 0, zIndex: 40, padding: 6, minWidth: 190 }}>
            <button style={{ ...BTN, border: "none", width: "100%", justifyContent: "flex-start" }} onClick={() => { setMenu(false); setAsistente(true); }}>Configurar calendarios</button>
            <button style={{ ...BTN, border: "none", width: "100%", justifyContent: "flex-start", color: "var(--danger)" }} onClick={desconectar} disabled={ocupado}>Desconectar</button>
          </div>
        ) : null}
      </div>
      {msg ? <span style={{ color: "var(--ok)", fontSize: 12, marginLeft: 8 }}>{msg}</span> : null}
      {err ? <span style={{ color: "var(--danger)", fontSize: 12, marginLeft: 8 }}>{err}</span> : null}
      {asistente ? <Asistente st={st} onClose={() => setAsistente(false)} onListo={(m) => { setAsistente(false); setMsg(m); void cargar(); onChanged?.(); }} /> : null}
    </>
  );
}

/**
 * EL ASISTENTE DE UN PASO.
 *
 * Con un solo profesional no pregunta nada: le asigna su calendario principal y queda listo
 * para apretar "Activar sincronización". Con varios, muestra una fila por persona con el
 * calendario sugerido (por coincidencia de nombre o correo) y un selector para cambiarlo.
 * Las dos opciones van ACTIVADAS y plegadas: el 99% de los dueños quiere las dos.
 */
function Asistente({ st, onClose, onListo }: { st: GoogleStatus; onClose: () => void; onListo: (msg: string) => void }) {
  const opciones = st.calendarOptions ?? [];
  const guardadas = st.config.calendars;
  const [elegidos, setElegidos] = useState<Record<string, string>>(() => {
    // Lo ya configurado manda; el resto se sugiere.
    const sugeridos = sugerirParaEquipo(st.professionals, opciones);
    const out: Record<string, string> = {};
    for (const p of st.professionals) out[p.id] = guardadas[p.id]?.calendarId || sugeridos[p.id] || "";
    return out;
  });
  const [bloquear, setBloquear] = useState(true);
  const [crear, setCrear] = useState(true);
  const [avanzado, setAvanzado] = useState(false);
  const [ayuda, setAyuda] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const principal = opciones.find((c) => c.primary)?.id ?? opciones[0]?.id ?? "";

  async function activar() {
    setOcupado(true);
    setErr(null);
    try {
      // El calendario del negocio es el principal: es el respaldo de quien no tenga propio.
      const calendars: Record<string, ProCal> = {};
      for (const p of st.professionals) {
        const calendarId = elegidos[p.id];
        if (calendarId && calendarId !== principal) calendars[p.id] = { calendarId, readBusy: bloquear, writeEvents: crear };
      }
      const r = await api<{ citasEnviadas: number }>("/integrations/google/activate", {
        method: "POST",
        body: JSON.stringify({ calendarId: principal, calendarReadBusy: bloquear, calendars }),
      });
      onListo(`✓ Sincronizado: ${r.citasEnviadas} cita(s) enviada(s) a Google`);
    } catch (e) {
      setErr((e as Error).message);
      setOcupado(false);
    }
  }

  const campo: React.CSSProperties = { width: "100%", padding: "8px 10px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 13 };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", padding: 16, zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 480, padding: 22, maxHeight: "90dvh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
          <h2 className="display" style={{ fontSize: 19, margin: 0 }}>Sincronizar con Google Calendar</h2>
          <button type="button" onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }} aria-label="Cerrar"><X size={20} /></button>
        </div>
        <p className="text-dim" style={{ fontSize: 13, margin: "0 0 16px" }}>
          Conectado como <strong>{st.accountEmail ?? "tu cuenta"}</strong>. Tus citas van a aparecer en Google y el asistente dejará de ofrecer las horas que ya tengas ocupadas ahí.
        </p>

        {st.professionals.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--danger)" }}>Primero agrega al menos una persona en Configurar agenda.</p>
        ) : st.professionals.length === 1 ? (
          <p style={{ fontSize: 13, margin: "0 0 12px" }}>
            Se usará tu calendario <strong>{opciones.find((c) => c.id === elegidos[st.professionals[0].id])?.name ?? "principal"}</strong>.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 13, margin: "0 0 8px", fontWeight: 600 }}>Calendario de cada persona</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 6 }}>
              {st.professionals.map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, flex: "0 0 38%", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
                  <select style={{ ...campo, flex: 1 }} value={elegidos[p.id] ?? ""} onChange={(e) => setElegidos({ ...elegidos, [p.id]: e.target.value })}>
                    <option value="">— el del negocio —</option>
                    {opciones.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}{c.primary ? " (principal)" : ""}</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <button onClick={() => setAyuda((v) => !v)} className="text-accent" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 12, padding: 0 }}>
              ¿Cómo comparto el calendario de mi equipo?
            </button>
            {ayuda ? <p className="text-dim" style={{ fontSize: 12, margin: "6px 0 0", lineHeight: 1.55 }}>{AYUDA_COMPARTIR}</p> : null}
          </>
        )}

        <button onClick={() => setAvanzado((v) => !v)} className="text-dim" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 12, padding: 0, marginTop: 16, display: "inline-flex", alignItems: "center", gap: 4 }}>
          <ChevronDown size={13} style={{ transform: avanzado ? "rotate(180deg)" : "none" }} /> Opciones avanzadas
        </button>
        {avanzado ? (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={bloquear} onChange={(e) => setBloquear(e.target.checked)} /> Bloquear las horas que ya tengo ocupadas en Google
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={crear} onChange={(e) => setCrear(e.target.checked)} /> Crear mis citas en Google
            </label>
          </div>
        ) : null}

        {err ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{err}</p> : null}
        <button className="btn-accent" onClick={activar} disabled={ocupado || st.professionals.length === 0} style={{ width: "100%", marginTop: 18, opacity: ocupado ? 0.6 : 1 }}>
          {ocupado ? "Activando…" : "Activar sincronización"}
        </button>
      </div>
    </div>
  );
}
