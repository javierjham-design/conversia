"use client";

/**
 * Barras de consumo del plan — componente ÚNICO de la plataforma (Bloque 1.3
 * de la armonización). Todas las claves de uso que entrega el API tienen su
 * etiqueta en español; si aparece una clave nueva sin traducir, se muestra
 * capitalizada (nunca la clave cruda tal cual).
 */
import { cn } from "@/components/ui";

export const USAGE_LABELS: Record<string, string> = {
  users: "Usuarios",
  agents: "Agentes IA",
  channels: "Canales",
  workflows: "Flujos",
  contacts: "Contactos",
  clinics: "Sedes",
  aiTokensToday: "Tokens IA (hoy)",
  aiTokensDaily: "Tokens IA (hoy)",
  messagesMonthly: "Mensajes (mes)",
  templatesMonthly: "Mensajes de plantilla (mes)",
};

/** Fallback legible para claves sin etiqueta: "aiTokensToday" → "Ai tokens today". */
function prettify(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function UsageBars({ usage }: { usage: Record<string, { used: number; limit: number | null }> }) {
  const entries = Object.entries(usage ?? {});
  if (entries.length === 0) return <p className="text-xs text-ink-subtle">Sin métricas disponibles.</p>;
  return (
    <ul className="space-y-2.5">
      {entries.map(([key, u]) => {
        const used = u?.used ?? 0;
        const unlimited = u?.limit == null || u.limit === 0;
        const pct = unlimited ? null : Math.min(100, Math.round((used / u.limit!) * 100));
        return (
          <li key={key} className="text-xs">
            <div className="flex justify-between">
              <span className="text-ink-muted">{USAGE_LABELS[key] ?? prettify(key)}</span>
              <span className="tnum text-ink-subtle">
                {used.toLocaleString("es-CL")} / {unlimited ? "∞" : u.limit!.toLocaleString("es-CL")}
              </span>
            </div>
            <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-app">
              <div
                className={cn(
                  "h-full rounded-full transition-all",
                  // Color por estado (no la marca): sano/cerca del límite/excedido.
                  pct === null ? "bg-slate-300 dark:bg-slate-600" : pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-emerald-500",
                )}
                style={{ width: `${pct ?? (used > 0 ? 8 : 0)}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
