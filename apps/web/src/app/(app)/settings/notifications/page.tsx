"use client";

/** Preferencias de notificaciones (personales — solo te afectan a ti). */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Skeleton, useToast } from "@/components/ui";

interface Prefs {
  assignedToMe: boolean;
  aiEscalation: boolean;
  integrationError: boolean;
  dailySummary: boolean;
  dataJobs: boolean;
}

const ITEMS: { key: keyof Prefs; label: string; desc: string }[] = [
  { key: "assignedToMe", label: "Conversación asignada a mí", desc: "Correo cuando alguien te asigna una conversación en la Bandeja." },
  { key: "aiEscalation", label: "Escalamiento de un agente IA", desc: "Correo cuando el bot deriva a humano y nadie responde (si tu email está en los destinatarios de escalamiento)." },
  { key: "integrationError", label: "Integración con error", desc: "Errores y avisos de integraciones en la campana 🔔 del panel." },
  { key: "dailySummary", label: "Resumen diario por correo", desc: "El resumen del día (si el correo del negocio está configurado y tu email está en los destinatarios)." },
  { key: "dataJobs", label: "Import/export terminado", desc: "Correo cuando un export de datos que pediste queda listo." },
];

export default function NotificationsSettingsPage() {
  const toast = useToast();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<Prefs>("/settings/notifications").then(setPrefs).catch(() => setPrefs(null));
  }, []);

  async function toggle(key: keyof Prefs) {
    if (!prefs) return;
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    setBusy(true);
    try {
      await api("/settings/notifications", { method: "PUT", body: JSON.stringify({ [key]: next[key] }) });
    } catch (err) {
      toast.push((err as Error).message, "error");
      setPrefs(prefs); // revertir
    } finally {
      setBusy(false);
    }
  }

  if (!prefs) return <div className="mx-auto max-w-xl p-6"><Skeleton className="h-64" /></div>;

  return (
    <div className="mx-auto max-w-xl p-6">
      <h2 className="text-lg font-semibold">Notificaciones</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Preferencias personales — solo te afectan a ti, no al resto del equipo. Por defecto todo activado menos el
        resumen diario.
      </p>

      <div className="mt-4 space-y-1 rounded-card border border-line bg-panel p-2 shadow-card">
        {ITEMS.map((item) => (
          <label key={item.key} className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 hover:bg-app">
            <span className="min-w-0">
              <span className="block text-sm font-medium">{item.label}</span>
              <span className="block text-xs text-ink-subtle">{item.desc}</span>
            </span>
            <input type="checkbox" checked={prefs[item.key]} disabled={busy} onChange={() => void toggle(item.key)} className="h-4 w-4 shrink-0" />
          </label>
        ))}
      </div>
    </div>
  );
}
