"use client";

/** Preferencias de notificaciones (personales — solo te afectan a ti). */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Skeleton, useToast } from "@/components/ui";

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

export default function NotificationsSettingsPage() {
  const toast = useToast();
  const [events, setEvents] = useState<EventDef[] | null>(null);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  if (!events || !prefs) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-64" /></div>;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Notificaciones</h2>
      <p className="mt-1 text-xs text-ink-muted">Preferencias personales — solo te afectan a ti. Algunos avisos críticos no se pueden apagar.</p>

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
              <span className="block text-sm text-ink">{ev.title}</span>
              {ev.urgency === "critical" && <span className="text-[10px] font-medium text-amber-600 dark:text-amber-400">crítico</span>}
            </span>
            {CHANNELS.map((c) => {
              const allowed = ev.channels.includes(c.key);
              const locked = ev.lockedChannels.includes(c.key);
              return (
                <span key={c.key} className="w-14 text-center">
                  {allowed ? (
                    <input
                      type="checkbox"
                      checked={isOn(ev, c.key)}
                      disabled={busy || locked}
                      onChange={() => toggle(ev, c.key)}
                      title={locked ? "Obligatorio" : undefined}
                      className="h-4 w-4"
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
          <input
            type="checkbox"
            checked={prefs.quietHours.enabled}
            disabled={busy}
            onChange={() => void save({ ...prefs, quietHours: { ...prefs.quietHours, enabled: !prefs.quietHours.enabled } })}
            className="h-4 w-4"
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
          <input
            type="checkbox"
            checked={prefs.whatsapp.enabled}
            disabled={busy}
            onChange={() => void save({ ...prefs, whatsapp: { ...prefs.whatsapp, enabled: !prefs.whatsapp.enabled } })}
            className="h-4 w-4"
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
        <p className="mt-2 text-[11px] text-ink-subtle">Requiere una plantilla HSM aprobada en tu WhatsApp. Si no la tienes, créala en Meta (WhatsApp Manager → Plantillas) y avísanos por Soporte para conectarla.</p>
      </div>
    </div>
  );
}
