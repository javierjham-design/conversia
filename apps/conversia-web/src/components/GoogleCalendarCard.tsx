"use client";
import { useState } from "react";
import { CalendarCheck, ExternalLink, HelpCircle, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";

/**
 * GOOGLE CALENDAR en la Agenda (Etapa 1).
 *
 * Vive acá y NO en Integraciones porque el panel de Conversia no tiene esa pantalla: el dueño
 * de la barbería configura sus calendarios donde está su agenda. Un calendario por
 * profesional, con el del negocio como respaldo para quien no tenga uno propio.
 *
 * Los tokens nunca pasan por acá: el popup de Google habla con la api y esta pantalla solo ve
 * qué calendarios hay disponibles y cuál quedó elegido.
 */

export interface ProCal {
  calendarId: string;
  readBusy: boolean;
  writeEvents: boolean;
}
export interface GoogleStatus {
  connected: boolean;
  plataformaLista: boolean;
  professionals: Array<{ id: string; name: string; specialty: string | null }>;
  config: { businessCalendarId: string; calendarSync: boolean; businessReadBusy: boolean; calendars: Record<string, ProCal> };
  calendarOptions: Array<{ id: string; name: string; primary: boolean }> | null;
  permisos: { calendar: boolean; faltanParaCalendar: string[] } | null;
  status: string | null;
  lastError: string | null;
  accountEmail: string | null;
  lastSyncAt: string | null;
}

const FIELD: React.CSSProperties = { width: "100%", padding: "8px 10px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 13 };
const AYUDA_COMPARTIR =
  "Para que el calendario de un miembro del equipo aparezca en esta lista, él tiene que compartirlo con la cuenta que conectaste: " +
  "en su Google Calendar, Configuración del calendario → Compartir con determinadas personas → agregar el correo de la cuenta conectada " +
  'con el permiso "Hacer cambios en eventos". Después vuelve acá y actualiza.';

export function GoogleCalendarCard({ google, onSaved }: { google: GoogleStatus; onSaved: () => void }) {
  const [cfg, setCfg] = useState(google.config);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prueba, setPrueba] = useState<Array<{ calendarId: string; ok: boolean; eventos: number; nuestros?: number; detail: string | null }> | null>(null);
  const [ayuda, setAyuda] = useState(false);

  const opciones = google.calendarOptions ?? [];
  const nombreDe = (id: string) => opciones.find((c) => c.id === id)?.name ?? id;

  async function conectar() {
    setErr(null);
    try {
      const { url } = await api<{ url: string }>("/integrations/oauth/google/authorize?feature=calendar");
      const popup = window.open(url, "google-oauth", "width=520,height=680");
      // La api responde el popup con un postMessage; si el navegador lo bloqueó, el usuario
      // vuelve solo y el botón Actualizar trae el estado nuevo.
      const onMsg = (e: MessageEvent) => {
        const d = e.data as { source?: string; provider?: string; result?: string } | null;
        if (d?.source !== "conversia-oauth" || d.provider !== "google") return;
        window.removeEventListener("message", onMsg);
        if (d.result === "connected") onSaved();
        else setErr(d.result === "denied" ? "Cancelaste la autorización en Google." : "Google no pudo completar la conexión. Inténtalo otra vez.");
      };
      window.addEventListener("message", onMsg);
      if (!popup) setErr("Tu navegador bloqueó la ventana de Google. Permite las ventanas emergentes y vuelve a intentar.");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function guardar() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await api("/integrations/google/config", {
        method: "PUT",
        body: JSON.stringify({
          calendarId: cfg.businessCalendarId,
          calendarSync: cfg.calendarSync,
          calendarReadBusy: cfg.businessReadBusy,
          calendars: cfg.calendars,
        }),
      });
      setMsg("Guardado.");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function probar() {
    setBusy(true);
    setErr(null);
    setPrueba(null);
    try {
      const r = await api<{ ok: boolean; detail?: string; calendars: NonNullable<typeof prueba> }>("/integrations/google/calendars/test", { method: "POST" });
      setPrueba(r.calendars);
      if (!r.calendars.length && r.detail) setErr(r.detail);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function setPro(proId: string, patch: Partial<ProCal>) {
    setCfg((c) => {
      const actual = c.calendars[proId] ?? { calendarId: "", readBusy: true, writeEvents: true };
      const siguiente = { ...actual, ...patch };
      const calendars = { ...c.calendars };
      if (!siguiente.calendarId) delete calendars[proId];
      else calendars[proId] = siguiente;
      return { ...c, calendars };
    });
  }

  if (!google.plataformaLista) {
    return (
      <div className="card" style={{ padding: 20 }}>
        <h2 className="display" style={{ fontSize: 17, margin: "0 0 6px" }}>Google Calendar</h2>
        <p className="text-dim" style={{ margin: 0, fontSize: 14 }}>La conexión con Google todavía no está habilitada en la plataforma. Escríbenos y la activamos.</p>
      </div>
    );
  }

  if (!google.connected) {
    return (
      <div className="card" style={{ padding: 20 }} data-copilot="google-calendar">
        <h2 className="display" style={{ fontSize: 17, margin: "0 0 6px" }}>Google Calendar</h2>
        <p className="text-dim" style={{ margin: "0 0 14px", fontSize: 14 }}>
          Conecta tu Google Calendar y las citas aparecerán ahí solas. Podrás manejar tu agenda desde el teléfono y el bot dejará de ofrecer las horas que ya tengas ocupadas.
        </p>
        <button className="btn-accent" onClick={conectar}>Conectar Google Calendar</button>
        {err ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 10 }}>{err}</p> : null}
      </div>
    );
  }

  const reconectar = google.status === "reauthorize" || (google.permisos && !google.permisos.calendar);

  return (
    <div className="card" style={{ padding: 20 }} data-copilot="google-calendar">
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 className="display" style={{ fontSize: 17, margin: 0 }}>Google Calendar</h2>
        <span className="text-dim" style={{ fontSize: 12 }}>{google.accountEmail ?? "cuenta conectada"}</span>
        <button onClick={onSaved} title="Actualizar" style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}>
          <RefreshCw size={13} /> Actualizar
        </button>
      </div>

      {reconectar ? (
        <div style={{ marginTop: 12, padding: 12, borderRadius: 10, border: "1px solid var(--warn, #c90)", fontSize: 13 }}>
          <p style={{ margin: "0 0 8px" }}>
            {google.status === "reauthorize"
              ? "Google dejó de aceptar la conexión. Vuelve a conectar la cuenta."
              : "Falta el permiso de calendario. Vuelve a conectar para autorizarlo."}
          </p>
          <button className="btn-accent" onClick={conectar}>Reconectar Google Calendar</button>
        </div>
      ) : null}

      {google.lastError && !reconectar ? <p style={{ color: "var(--danger)", fontSize: 12, marginTop: 10 }}>Último error: {google.lastError}</p> : null}

      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, fontSize: 14, cursor: "pointer" }}>
        <input type="checkbox" checked={cfg.calendarSync} onChange={(e) => setCfg({ ...cfg, calendarSync: e.target.checked })} />
        Crear mis citas en Google Calendar
      </label>

      <label style={{ fontSize: 12, color: "var(--ink-dim)", display: "block", marginTop: 14 }}>
        Calendario del negocio
        <select style={{ ...FIELD, marginTop: 5 }} value={cfg.businessCalendarId} onChange={(e) => setCfg({ ...cfg, businessCalendarId: e.target.value })}>
          <option value="">— sin calendario del negocio —</option>
          {opciones.map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.primary ? " (principal)" : ""}</option>
          ))}
        </select>
      </label>
      <p className="text-dim" style={{ fontSize: 12, margin: "6px 0 0" }}>
        Se usa para quien no tenga calendario propio. Si marcas abajo que bloquee horas, lo que pongas ahí bloquea a <strong>todo el equipo</strong> (feriados, cierre del local).
      </p>
      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 13, cursor: "pointer" }}>
        <input type="checkbox" checked={cfg.businessReadBusy} onChange={(e) => setCfg({ ...cfg, businessReadBusy: e.target.checked })} disabled={!cfg.businessCalendarId} />
        Bloquear a todos con las horas ocupadas de este calendario
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "22px 0 8px" }}>
        <h3 style={{ fontSize: 14, margin: 0, fontWeight: 600 }}>Calendario de cada persona</h3>
        <button onClick={() => setAyuda((v) => !v)} className="text-accent" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}>
          <HelpCircle size={13} /> ¿Cómo comparto el calendario de mi equipo?
        </button>
      </div>
      {ayuda ? <p className="text-dim" style={{ fontSize: 12, margin: "0 0 10px", lineHeight: 1.55 }}>{AYUDA_COMPARTIR}</p> : null}

      {google.professionals.length === 0 ? (
        <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Primero agrega personas en “Equipo y recursos”.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {google.professionals.map((p) => {
            const v = cfg.calendars[p.id];
            return (
              <div key={p.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 10 }}>
                <p style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 600 }}>
                  {p.name}
                  {!v ? <span className="text-dim" style={{ fontSize: 11, fontWeight: 400 }}> · usa el calendario del negocio</span> : null}
                </p>
                <select style={FIELD} value={v?.calendarId ?? ""} onChange={(e) => setPro(p.id, { calendarId: e.target.value })}>
                  <option value="">— el del negocio —</option>
                  {opciones.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}{c.primary ? " (principal)" : ""}</option>
                  ))}
                </select>
                {v ? (
                  <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                      <input type="checkbox" checked={v.readBusy} onChange={(e) => setPro(p.id, { readBusy: e.target.checked })} />
                      Bloquear horas ocupadas
                    </label>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}>
                      <input type="checkbox" checked={v.writeEvents} onChange={(e) => setPro(p.id, { writeEvents: e.target.checked })} />
                      Crear citas en Google
                    </label>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18, flexWrap: "wrap" }}>
        <button className="btn-accent" onClick={guardar} disabled={busy} style={{ opacity: busy ? 0.6 : 1 }}>{busy ? "Guardando…" : "Guardar calendarios"}</button>
        <button onClick={probar} disabled={busy} className="text-accent" style={{ border: "1px solid var(--line)", background: "transparent", cursor: "pointer", borderRadius: 10, padding: "8px 12px", fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6 }}>
          <CalendarCheck size={14} /> Probar
        </button>
        {msg ? <span style={{ color: "var(--ok)", fontSize: 13 }}>{msg}</span> : null}
        {err ? <span style={{ color: "var(--danger)", fontSize: 13 }}>{err}</span> : null}
      </div>

      {prueba ? (
        <div style={{ marginTop: 12, fontSize: 13 }}>
          {prueba.map((r) => (
            <p key={r.calendarId} style={{ margin: "4px 0" }}>
              {r.ok ? "✅" : "✖"} <strong>{nombreDe(r.calendarId)}</strong>{" "}
              {r.ok ? (
                <span className="text-dim">
                  {r.eventos === 0 ? "sin eventos hoy" : `${r.eventos} evento(s) hoy${r.nuestros ? ` · ${r.nuestros} creado(s) desde acá` : ""}`}
                </span>
              ) : (
                <span style={{ color: "var(--danger)" }}>{r.detail}</span>
              )}
            </p>
          ))}
        </div>
      ) : null}

      <a href="https://calendar.google.com" target="_blank" rel="noopener noreferrer" className="text-dim" style={{ fontSize: 12, marginTop: 12, display: "inline-flex", alignItems: "center", gap: 4, textDecoration: "none" }}>
        Abrir Google Calendar <ExternalLink size={12} />
      </a>
    </div>
  );
}
