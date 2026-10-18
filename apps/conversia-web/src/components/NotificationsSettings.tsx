"use client";
import { useEffect, useState } from "react";
import { Bell, BellOff, Loader2, Send, Smartphone } from "lucide-react";
import { api } from "@/lib/api";
import { enablePush, disablePush, permissionState, pushSupport } from "@/lib/push";

/* M2 — Ajustes › Notificaciones. Conecta conversia-web al backend de push EXISTENTE
 * (/notifications/*). Switch maestro (pide permiso en un gesto), preferencias por tipo y
 * aviso para iOS (el permiso solo existe con la PWA instalada). */

type Ev = { key: string; title: string; urgency: string; channels: string[]; defaultChannels: string[]; lockedChannels: string[] };
type Matrix = Record<string, Record<string, boolean>>;

export function NotificationsSettings() {
  const [support, setSupport] = useState<ReturnType<typeof pushSupport> | null>(null);
  const [perm, setPerm] = useState<string>("default");
  const [vapidOk, setVapidOk] = useState(true);
  const [deviceCount, setDeviceCount] = useState(0);
  const [events, setEvents] = useState<Ev[]>([]);
  const [matrix, setMatrix] = useState<Matrix>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refreshDevices() {
    const d = await api<{ vapidConfigured: boolean; count: number }>("/notifications/devices").catch(() => null);
    if (d) {
      setVapidOk(d.vapidConfigured);
      setDeviceCount(d.count);
    }
  }

  useEffect(() => {
    setSupport(pushSupport());
    setPerm(permissionState());
    Promise.all([
      api<{ events: Ev[] }>("/notifications/catalog").catch(() => ({ events: [] as Ev[] })),
      api<{ matrix: Matrix }>("/notifications/preferences").catch(() => ({ matrix: {} as Matrix })),
      refreshDevices(),
    ])
      .then(([cat, prefs]) => {
        // Solo eventos que admiten push y no son solo-opt-in sin canal.
        setEvents(cat.events.filter((e) => e.channels.includes("web_push")));
        setMatrix(prefs.matrix ?? {});
      })
      .finally(() => setLoading(false));
  }, []);

  const pushOn = perm === "granted" && deviceCount > 0;

  async function toggleMaster() {
    setBusy(true);
    setMsg(null);
    try {
      if (pushOn) {
        await disablePush();
        setMsg("Notificaciones desactivadas en este dispositivo.");
      } else {
        const r = await enablePush();
        if (r.status === "granted") setMsg("¡Listo! Recibirás avisos en este dispositivo.");
        else if (r.status === "denied") setMsg("El navegador bloqueó los permisos. Actívalos en la configuración del sitio y reintenta.");
        else if (r.status === "unsupported" && r.detail === "ios-needs-install") setMsg("En iPhone instala primero la app (Compartir → Añadir a inicio) y vuelve aquí.");
        else setMsg("No se pudo activar: " + (r.detail ?? r.status));
      }
      setPerm(permissionState());
      await refreshDevices();
    } finally {
      setBusy(false);
    }
  }

  function effective(e: Ev): boolean {
    const locked = e.lockedChannels.includes("web_push");
    if (locked) return true;
    const override = matrix[e.key]?.web_push;
    return override ?? e.defaultChannels.includes("web_push");
  }

  async function toggleEvent(e: Ev) {
    if (e.lockedChannels.includes("web_push")) return; // siempre activo
    const next: Matrix = { ...matrix, [e.key]: { ...(matrix[e.key] ?? {}), web_push: !effective(e) } };
    setMatrix(next);
    await api("/notifications/preferences", { method: "POST", body: JSON.stringify({ matrix: next }) }).catch(() => undefined);
  }

  async function sendTest() {
    setBusy(true);
    setMsg(null);
    try {
      await api("/notifications/test", { method: "POST" });
      setMsg("Prueba enviada — debería llegarte en unos segundos.");
    } catch (e) {
      setMsg("No se pudo enviar la prueba: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const iosNeedsInstall = support && !support.supported && support.reason === "ios-needs-install";

  return (
    <div className="card" style={{ padding: 20, marginBottom: 16 }}>
      <h2 className="display" style={{ fontSize: 18, margin: "0 0 4px" }}>Notificaciones</h2>
      <p className="text-dim" style={{ fontSize: 13, margin: "0 0 14px" }}>Recibe avisos en tu teléfono o computador aunque la app esté cerrada.</p>

      {loading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--ink-dim)", fontSize: 13 }}><Loader2 size={15} className="lp-spin" /> Cargando…</div>
      ) : (
        <>
          {/* Switch maestro */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "1px solid var(--line)" }}>
            <span style={{ width: 40, height: 40, borderRadius: 11, background: pushOn ? "var(--acc-dim)" : "var(--line)", color: pushOn ? "var(--acc-deep)" : "var(--ink-dim)", display: "grid", placeItems: "center", flexShrink: 0 }}>
              {pushOn ? <Bell size={19} /> : <BellOff size={19} />}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 14.5 }}>Avisos en este dispositivo</p>
              <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12.5 }}>
                {pushOn ? `Activadas · ${deviceCount} dispositivo${deviceCount === 1 ? "" : "s"}` : "Desactivadas"}
              </p>
            </div>
            {iosNeedsInstall ? (
              <span className="text-dim" style={{ fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}><Smartphone size={14} /> Instala la app primero</span>
            ) : (
              <button onClick={toggleMaster} disabled={busy} className={pushOn ? "card" : "btn-accent"} style={{ border: pushOn ? undefined : "none", cursor: "pointer", fontSize: 13, padding: "8px 16px", whiteSpace: "nowrap" }}>
                {busy ? "…" : pushOn ? "Desactivar" : "Activar"}
              </button>
            )}
          </div>

          {!vapidOk ? (
            <p className="text-dim" style={{ fontSize: 12, margin: "10px 0 0" }}>El servidor aún no tiene las claves de notificaciones configuradas (VAPID). El equipo lo deja listo.</p>
          ) : null}

          {/* Preferencias por tipo */}
          <p className="text-dim" style={{ fontSize: 13, margin: "16px 0 8px" }}>¿De qué quieres que te avisemos?</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {events.map((e) => {
              const on = effective(e);
              const locked = e.lockedChannels.includes("web_push");
              return (
                <label key={e.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", fontSize: 13.5, cursor: locked ? "default" : "pointer", opacity: pushOn ? 1 : 0.55 }}>
                  <input type="checkbox" checked={on} disabled={locked || !pushOn} onChange={() => toggleEvent(e)} />
                  <span style={{ flex: 1 }}>{e.title}</span>
                  {e.urgency === "critical" ? <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--warn)" }}>importante</span> : null}
                  {locked ? <span className="text-dim" style={{ fontSize: 11 }}>siempre</span> : null}
                </label>
              );
            })}
          </div>

          {pushOn ? (
            <button onClick={sendTest} disabled={busy} className="card" style={{ marginTop: 14, cursor: "pointer", fontSize: 13, padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 7 }}>
              <Send size={14} /> Enviar una prueba
            </button>
          ) : null}

          {msg ? <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--ink)" }}>{msg}</p> : null}
        </>
      )}
      <style>{`.lp-spin { animation: lpspin 1s linear infinite; } @keyframes lpspin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
