"use client";

/** Preferencias de notificaciones (personales — solo te afectan a ti). */
import { useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";
import { api } from "@/lib/api";
import { Checkbox, Skeleton, useToast } from "@/components/ui";
import { disablePush, enablePush, permissionState, pushSupport } from "@/lib/push";

/** Activar/desactivar Web Push EN ESTE DISPOSITIVO (navegador o PWA del celular). */
function PushActivation() {
  const toast = useToast();
  const [state, setState] = useState<"granted" | "default" | "denied" | "unsupported" | "ios-needs-install" | "loading">("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = pushSupport();
    if (!s.supported) { setState(s.reason === "ios-needs-install" ? "ios-needs-install" : "unsupported"); return; }
    const p = permissionState();
    setState(p === "unsupported" ? "unsupported" : p);
  }, []);

  async function activate() {
    setBusy(true);
    const r = await enablePush();
    setBusy(false);
    if (r.status === "granted") { setState("granted"); toast.push("Notificaciones activadas en este dispositivo ✔", "ok"); }
    else if (r.status === "denied") { setState("denied"); toast.push("Bloqueaste las notificaciones. Habilítalas en los permisos del navegador para este sitio.", "error"); }
    else if (r.status === "unsupported") toast.push(r.detail ?? "Este dispositivo no puede recibir notificaciones.", "error");
    else toast.push(`No se pudo activar${r.detail ? `: ${r.detail}` : ". Intenta de nuevo."}`, "error");
  }
  async function deactivate() {
    setBusy(true);
    await disablePush();
    setBusy(false);
    setState("default");
    toast.push("Notificaciones desactivadas en este dispositivo", "info");
  }
  async function sendTest() {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; webDevices: number; vapidConfigured: boolean }>("/notifications/test", { method: "POST" });
      if (!r.vapidConfigured) toast.push("El servidor no tiene VAPID configurado — el push no puede salir.", "error");
      else if (r.webDevices === 0) toast.push("Este navegador no aparece suscrito. Toca «Activar» y permite las notificaciones.", "error");
      else toast.push(`Prueba enviada a ${r.webDevices} dispositivo(s). Si no llega en unos segundos, revisa los permisos del navegador y del sistema (No molestar / Focus).`, "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  const active = state === "granted";
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-card border border-line bg-panel p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span className={active ? "text-brand-600 dark:text-brand-400" : "text-ink-subtle"}>{active ? <Bell size={20} /> : <BellOff size={20} />}</span>
        <div>
          <p className="text-sm font-medium text-ink">Notificaciones en este dispositivo</p>
          <p className="text-xs text-ink-subtle">
            {active && "Activadas ✔ — recibirás avisos aquí cuando lleguen mensajes o escalamientos."}
            {state === "default" && "Actívalas para que te avisemos cuando llegue un mensaje que necesita a un humano."}
            {state === "denied" && "Están bloqueadas. Habilítalas en los permisos del navegador (candado junto a la URL) y vuelve a intentar."}
            {state === "ios-needs-install" && "En iPhone/iPad primero instala la app: Compartir → «Agregar a inicio», luego actívalas desde la app."}
            {state === "unsupported" && "Este navegador no soporta notificaciones push."}
            {state === "loading" && "…"}
          </p>
        </div>
      </div>
      {active ? (
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={() => void sendTest()} disabled={busy} className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{busy ? "…" : "Enviar prueba"}</button>
          <button onClick={() => void deactivate()} disabled={busy} className="rounded-lg border border-line-strong px-3 py-1.5 text-sm hover:bg-app disabled:opacity-50">Desactivar</button>
        </div>
      ) : (state === "default" || state === "denied") ? (
        <button onClick={() => void activate()} disabled={busy} className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50">{busy ? "Activando…" : "Activar"}</button>
      ) : null}
    </div>
  );
}

/** Sustituye las variables de plantilla del catálogo por texto legible. */
function humanizeTemplate(s: string): string {
  const WORDS: Record<string, string> = {
    contactName: "un contacto",
    minutes: "N",
    reason: "el motivo",
    source: "el origen",
    excerpt: "el mensaje",
    stageName: "la etapa",
    workflowName: "el flujo",
    channelName: "el canal",
    agentName: "el agente",
    userName: "el usuario",
  };
  return s.replace(/\{(\w+)\}/g, (_, k: string) => WORDS[k] ?? "…");
}

type Channel = "in_app" | "web_push" | "email";
interface EventDef {
  key: string;
  title: string;
  urgency: "critical" | "info";
  channels: string[];
  defaultChannels: string[];
  lockedChannels: string[];
}
interface Prefs {
  matrix: Record<string, Partial<Record<string, boolean>>>;
  quietHours: { enabled: boolean; start: string; end: string };
  whatsapp: { enabled: boolean; throttlePerHour: number; delayMinutes: number };
}
interface Estimate {
  escalations30d: number;
  perNoticeClp: number;
  monthlyClp: number;
  note: string;
}

const CHANNELS: { key: Channel; label: string }[] = [
  { key: "in_app", label: "Campana" },
  { key: "web_push", label: "Push" },
  { key: "email", label: "Correo" },
];

interface WaTemplate {
  name: string;
  language: string;
  canEdit: boolean;
}

export default function NotificationsSettingsPage() {
  const toast = useToast();
  const [events, setEvents] = useState<EventDef[] | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [waTpl, setWaTpl] = useState<WaTemplate | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([
      api<{ events: EventDef[] }>("/notifications/catalog"),
      api<Prefs>("/notifications/preferences"),
    ])
      .then(([c, p]) => {
        setEvents(c.events);
        setPrefs(p);
      })
      .catch((e) => toast.push((e as Error).message, "error"));
    void api<Estimate>("/notifications/whatsapp/estimate").then(setEstimate).catch(() => undefined);
    void api<WaTemplate>("/notifications/whatsapp-template").then(setWaTpl).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveWaTemplate() {
    if (!waTpl) return;
    setBusy(true);
    try {
      await api("/notifications/whatsapp-template", { method: "POST", body: JSON.stringify({ name: waTpl.name, language: waTpl.language }) });
      toast.push("Plantilla conectada ✔", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  function isOn(ev: EventDef, ch: Channel): boolean {
    if (ev.lockedChannels.includes(ch)) return true;
    const o = prefs?.matrix?.[ev.key]?.[ch];
    return o !== undefined ? o : ev.defaultChannels.includes(ch);
  }

  async function save(next: Prefs) {
    setPrefs(next);
    setBusy(true);
    try {
      await api("/notifications/preferences", { method: "POST", body: JSON.stringify(next) });
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  function toggle(ev: EventDef, ch: Channel) {
    if (!prefs || ev.lockedChannels.includes(ch) || !ev.channels.includes(ch)) return;
    const matrix = { ...prefs.matrix, [ev.key]: { ...(prefs.matrix[ev.key] ?? {}) } };
    matrix[ev.key][ch] = !isOn(ev, ch);
    void save({ ...prefs, matrix });
  }

  if (!events || !prefs) return <div className="mx-auto max-w-4xl p-6"><Skeleton className="h-64" /></div>;

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h2 className="text-lg font-semibold">Notificaciones</h2>
      <p className="mt-1 mb-4 text-xs text-ink-muted">Preferencias personales — solo te afectan a ti. Algunos avisos críticos no se pueden apagar.</p>

      {/* Activar Web Push en este dispositivo (navegador o PWA del celular) */}
      <PushActivation />

      {/* Matriz evento × canal */}
      <div className="mt-4 overflow-hidden rounded-card border border-line bg-panel shadow-card">
        <div className="flex items-center border-b border-line px-3 py-2 text-[11px] font-semibold uppercase text-ink-subtle">
          <span className="flex-1">Evento</span>
          {CHANNELS.map((c) => (
            <span key={c.key} className="w-14 text-center">{c.label}</span>
          ))}
        </div>
        {events.map((ev) => (
          <div key={ev.key} className="flex items-center border-b border-line px-3 py-2.5 last:border-0">
            <span className="flex-1 pr-2">
              {/* Los títulos del catálogo traen variables ({contactName}) — se
                  humanizan para mostrar, jamás se pinta la llave cruda (B3). */}
              <span className="block text-sm text-ink">{humanizeTemplate(ev.title)}</span>
              {ev.urgency === "critical" && <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">crítico</span>}
            </span>
            {CHANNELS.map((c) => {
              const allowed = ev.channels.includes(c.key);
              const locked = ev.lockedChannels.includes(c.key);
              return (
                <span key={c.key} className="w-14 text-center">
                  {allowed ? (
                    <Checkbox
                      checked={isOn(ev, c.key)}
                      disabled={busy || locked}
                      onChange={() => toggle(ev, c.key)}
                      title={locked ? "Obligatorio" : undefined}
                    />
                  ) : (
                    <span className="text-ink-subtle">—</span>
                  )}
                </span>
              );
            })}
          </div>
        ))}
      </div>

      {/* Horario silencioso */}
      <div className="mt-4 rounded-card border border-line bg-panel p-4 shadow-card">
        <label className="flex items-center justify-between">
          <span>
            <span className="block text-sm font-medium">Horario silencioso</span>
            <span className="block text-xs text-ink-subtle">Silencia push en la franja indicada. Los avisos <b>críticos</b> igual llegan.</span>
          </span>
          <Checkbox
            checked={prefs.quietHours.enabled}
            disabled={busy}
            onChange={() => void save({ ...prefs, quietHours: { ...prefs.quietHours, enabled: !prefs.quietHours.enabled } })}
          />
        </label>
        {prefs.quietHours.enabled && (
          <div className="mt-3 flex items-center gap-2 text-sm">
            <span className="text-ink-muted">Desde</span>
            <input type="time" value={prefs.quietHours.start} onChange={(e) => void save({ ...prefs, quietHours: { ...prefs.quietHours, start: e.target.value } })} className="rounded-lg border border-line-strong bg-app px-2 py-1" />
            <span className="text-ink-muted">hasta</span>
            <input type="time" value={prefs.quietHours.end} onChange={(e) => void save({ ...prefs, quietHours: { ...prefs.quietHours, end: e.target.value } })} className="rounded-lg border border-line-strong bg-app px-2 py-1" />
          </div>
        )}
      </div>

      {/* Escalera de WhatsApp */}
      <div className="mt-4 rounded-card border border-line bg-panel p-4 shadow-card">
        <label className="flex items-center justify-between">
          <span>
            <span className="block text-sm font-medium">Aviso por WhatsApp en eventos críticos</span>
            <span className="block text-xs text-ink-subtle">Si un evento crítico no se atiende en unos minutos, te avisamos por WhatsApp. Se cancela solo si lo abres a tiempo.</span>
          </span>
          <Checkbox
            checked={prefs.whatsapp.enabled}
            disabled={busy}
            onChange={() => void save({ ...prefs, whatsapp: { ...prefs.whatsapp, enabled: !prefs.whatsapp.enabled } })}
          />
        </label>
        {estimate && (
          <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            Cada aviso consume una plantilla de tu WhatsApp, aprox. <b>${estimate.perNoticeClp} CLP</b>. Según tus últimos 30 días
            ({estimate.escalations30d} escalamientos), la proyección sería <b>~${estimate.monthlyClp.toLocaleString("es-CL")} CLP/mes</b> como máximo. {estimate.note}
          </p>
        )}
        {prefs.whatsapp.enabled && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="text-ink-muted">Esperar</span>
              <input type="number" min={1} max={60} value={prefs.whatsapp.delayMinutes} onChange={(e) => void save({ ...prefs, whatsapp: { ...prefs.whatsapp, delayMinutes: Number(e.target.value) } })} className="w-16 rounded-lg border border-line-strong bg-app px-2 py-1" />
              <span className="text-ink-muted">min</span>
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-ink-muted">Máx.</span>
              <input type="number" min={1} max={20} value={prefs.whatsapp.throttlePerHour} onChange={(e) => void save({ ...prefs, whatsapp: { ...prefs.whatsapp, throttlePerHour: Number(e.target.value) } })} className="w-16 rounded-lg border border-line-strong bg-app px-2 py-1" />
              <span className="text-ink-muted">por hora</span>
            </label>
          </div>
        )}
        {/* Config POR TENANT: cada tenant conecta SU propia plantilla HSM. */}
        {waTpl?.canEdit ? (
          <div className="mt-3 rounded-lg border border-line bg-app p-3">
            <p className="mb-1.5 text-xs font-medium text-ink">Plantilla HSM de tu WhatsApp (para el equipo)</p>
            <p className="mb-2 text-[11px] text-ink-subtle">
              Crea una plantilla de <b>utilidad</b> en Meta (WhatsApp Manager → Plantillas) con un texto tipo
              “Tienes una conversación sin atender: {"{{1}}"}”. Cuando Meta la apruebe, pega su nombre aquí.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={waTpl.name}
                onChange={(e) => setWaTpl({ ...waTpl, name: e.target.value })}
                placeholder="nombre_de_la_plantilla"
                className="min-w-0 flex-1 rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-sm"
              />
              <input
                value={waTpl.language}
                onChange={(e) => setWaTpl({ ...waTpl, language: e.target.value })}
                placeholder="es"
                className="w-16 rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-sm"
              />
              <button onClick={() => void saveWaTemplate()} disabled={busy} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
                Conectar
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-ink-subtle">Requiere una plantilla HSM aprobada en el WhatsApp de tu negocio. Pídele a un administrador que la conecte.</p>
        )}
      </div>
    </div>
  );
}
