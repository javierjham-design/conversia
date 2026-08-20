"use client";

import { useEffect, useState } from "react";
import { Bell, X } from "lucide-react";
import { enablePush, permissionState, pushSupport } from "@/lib/push";
import { useToast } from "@/components/ui";

// "No volver a mostrar" (persistente) vs "No por ahora" (solo esta sesión → reaparece en la
// próxima visita / otro navegador). Si ya está concedido o bloqueado, no se muestra.
const NEVER = "notifPromptNever";
const SNOOZE = "notifPromptSnoozed";

/**
 * Banner que aparece la PRIMERA vez (o en un navegador nuevo) para activar las
 * notificaciones, con 3 opciones: Activar · No por ahora · No volver a mostrar.
 * Si el usuario elige "No volver a mostrar", no se ofrece nunca más aquí — la
 * activación queda solo dentro de Ajustes → Notificaciones.
 */
export function NotificationsPrompt() {
  const toast = useToast();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pushSupport().supported) return; // no soportado / iOS sin instalar
    if (permissionState() !== "default") return; // ya activado o bloqueado
    if (localStorage.getItem(NEVER) === "1") return; // eligió no volver a mostrar
    if (sessionStorage.getItem(SNOOZE) === "1") return; // "no por ahora" en esta sesión
    const t = setTimeout(() => setShow(true), 1500); // sin chocar con la carga inicial
    return () => clearTimeout(t);
  }, []);

  async function activate() {
    setBusy(true);
    const r = await enablePush();
    setBusy(false);
    setShow(false);
    if (r.status === "granted") toast.push("Notificaciones activadas ✔", "ok");
    else if (r.status === "denied") toast.push("Quedaron bloqueadas. Puedes habilitarlas en los permisos del navegador (candado junto a la URL).", "error");
    else if (r.status === "unsupported") toast.push(r.detail ?? "Este dispositivo no puede recibir notificaciones todavía.", "info");
    else toast.push(`No se pudo activar${r.detail ? `: ${r.detail}` : ". Prueba desde Ajustes → Notificaciones."}`, "error");
  }
  function notNow() { sessionStorage.setItem(SNOOZE, "1"); setShow(false); }
  function never() { localStorage.setItem(NEVER, "1"); setShow(false); }

  if (!show) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] w-[min(92vw,360px)] rounded-xl border border-line bg-panel p-4 shadow-2xl">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-brand-600 dark:text-brand-400"><Bell size={20} /></span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Activa las notificaciones</p>
          <p className="mt-0.5 text-xs text-ink-muted">Te avisamos cuando llegue un mensaje que necesita a un humano o la IA escale un caso — en este dispositivo.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => void activate()} disabled={busy} className="rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50">
              {busy ? "Activando…" : "Activar"}
            </button>
            <button onClick={notNow} className="rounded-lg border border-line-strong px-3 py-1.5 text-xs hover:bg-app">No por ahora</button>
            <button onClick={never} className="text-xs text-ink-subtle hover:text-ink">No volver a mostrar</button>
          </div>
        </div>
        <button onClick={notNow} aria-label="Cerrar" className="shrink-0 text-ink-subtle hover:text-ink"><X size={14} /></button>
      </div>
    </div>
  );
}
