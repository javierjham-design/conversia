"use client";

/** Reglas de la Bandeja: auto-cierre, retoma del bot y objetivo de 1.ª respuesta. */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Skeleton, useToast } from "@/components/ui";

interface InboxRules {
  autoCloseDays: number;
  autoCloseNote: string;
  botResumeMinutes: number;
  firstResponseTargetMinutes: number;
}

export default function ConversationRulesPage() {
  const toast = useToast();
  const [rules, setRules] = useState<InboxRules | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<InboxRules>("/settings/inbox").then(setRules).catch(() => setRules(null));
  }, []);

  async function save() {
    if (!rules) return;
    setBusy(true);
    try {
      await api("/settings/inbox", { method: "PUT", body: JSON.stringify(rules) });
      toast.push("Reglas guardadas ✔ — se aplican dentro de los próximos 10 minutos", "ok");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!rules) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-64" /></div>;
  const input = "mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm";
  const set = (patch: Partial<InboxRules>) => setRules({ ...rules, ...patch });

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Conversaciones — reglas de la Bandeja</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Reglas automáticas que el sistema aplica cada 10 minutos sobre la Bandeja.
      </p>

      <div className="mt-4 space-y-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <div>
          <p className="text-sm font-medium">Auto-cierre por inactividad</p>
          <p className="text-xs text-ink-subtle">Cierra conversaciones sin mensajes hace X días (0 = apagado). Deja una nota interna en el hilo.</p>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <label className="block text-sm">
              <span className="text-xs text-ink-muted">Días de inactividad</span>
              <input type="number" min={0} max={90} value={rules.autoCloseDays} onChange={(e) => set({ autoCloseDays: Number(e.target.value) })} className={input} />
            </label>
            <label className="block text-sm">
              <span className="text-xs text-ink-muted">Nota de cierre (interna, opcional)</span>
              <input value={rules.autoCloseNote} onChange={(e) => set({ autoCloseNote: e.target.value })} placeholder="p. ej. Sin respuesta del contacto" className={input} />
            </label>
          </div>
        </div>

        <div className="border-t border-line pt-3">
          <p className="text-sm font-medium">El bot retoma tras intervención humana</p>
          <p className="text-xs text-ink-subtle">
            Cuando alguien toma el control y deja de responder, la IA retoma sola después de estos minutos (0 = nunca
            retoma sola). El bot vuelve con el historial completo y las indicaciones activas.
          </p>
          <label className="mt-2 block max-w-48 text-sm">
            <span className="text-xs text-ink-muted">Minutos</span>
            <input type="number" min={0} max={1440} value={rules.botResumeMinutes} onChange={(e) => set({ botResumeMinutes: Number(e.target.value) })} className={input} />
          </label>
        </div>

        <div className="border-t border-line pt-3">
          <p className="text-sm font-medium">Tiempo objetivo de primera respuesta</p>
          <p className="text-xs text-ink-subtle">La Bandeja marca en rojo ⏱ las conversaciones no respondidas que superan este objetivo.</p>
          <label className="mt-2 block max-w-48 text-sm">
            <span className="text-xs text-ink-muted">Minutos</span>
            <input type="number" min={1} max={1440} value={rules.firstResponseTargetMinutes} onChange={(e) => set({ firstResponseTargetMinutes: Number(e.target.value) })} className={input} />
          </label>
        </div>

        <div className="flex justify-end border-t border-line pt-3">
          <Button onClick={() => void save()} disabled={busy}>Guardar reglas</Button>
        </div>
      </div>
    </div>
  );
}
