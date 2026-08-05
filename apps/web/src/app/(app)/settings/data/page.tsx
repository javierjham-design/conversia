"use client";

/** Retención y privacidad: cuánto se conservan los datos + derechos del titular. */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Skeleton, useToast } from "@/components/ui";

interface DataPolicy {
  conversationsMonths: number;
  transcriptionsMonths: number;
  lastPurgeAt: string | null;
}

const OPTIONS = [
  { v: 0, label: "Indefinido (no se borran)" },
  { v: 6, label: "6 meses" },
  { v: 12, label: "1 año" },
  { v: 24, label: "2 años" },
];

export default function DataSettingsPage() {
  const toast = useToast();
  const [policy, setPolicy] = useState<DataPolicy | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<DataPolicy>("/settings/data").then(setPolicy).catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save(patch: Partial<DataPolicy>) {
    if (!policy) return;
    // Advertencia clara al REDUCIR la retención (implica borrar datos).
    const reducing =
      (patch.conversationsMonths !== undefined && policy.conversationsMonths === 0 && patch.conversationsMonths > 0) ||
      (patch.conversationsMonths !== undefined && policy.conversationsMonths > 0 && patch.conversationsMonths < policy.conversationsMonths) ||
      (patch.transcriptionsMonths !== undefined && policy.transcriptionsMonths === 0 && patch.transcriptionsMonths > 0) ||
      (patch.transcriptionsMonths !== undefined && policy.transcriptionsMonths > 0 && patch.transcriptionsMonths < policy.transcriptionsMonths);
    if (reducing && !confirm("Reducir la retención BORRA de forma permanente los datos más antiguos que el nuevo plazo, en la próxima purga (diaria). Esta acción no se puede deshacer. ¿Continuar?")) {
      return;
    }
    setBusy(true);
    try {
      await api("/settings/data", { method: "PUT", body: JSON.stringify(patch) });
      setPolicy({ ...policy, ...patch });
      toast.push("Política de retención guardada ✔", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!policy) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-64" /></div>;
  const sel = "mt-1 w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm";

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Retención y privacidad</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Define cuánto tiempo conservas los datos. El default es <b>indefinido</b> (no se borra nada). Reducir el plazo
        borra de forma permanente lo más antiguo en la purga diaria.
      </p>

      <div className="mt-4 space-y-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <label className="block text-sm">
          <span className="font-medium">Conservar conversaciones y mensajes</span>
          <select className={sel} value={policy.conversationsMonths} disabled={busy} onChange={(e) => void save({ conversationsMonths: Number(e.target.value) })}>
            {OPTIONS.map((o) => (<option key={o.v} value={o.v}>{o.label}</option>))}
          </select>
          <span className="mt-1 block text-[11px] text-ink-subtle">Las conversaciones más antiguas se eliminan por completo (con sus mensajes y adjuntos). El contacto se conserva.</span>
        </label>

        <label className="block text-sm">
          <span className="font-medium">Conservar transcripciones de audio</span>
          <select className={sel} value={policy.transcriptionsMonths} disabled={busy} onChange={(e) => void save({ transcriptionsMonths: Number(e.target.value) })}>
            {OPTIONS.map((o) => (<option key={o.v} value={o.v}>{o.label}</option>))}
          </select>
          <span className="mt-1 block text-[11px] text-ink-subtle">Se borra solo el texto transcrito de los audios antiguos; el mensaje se conserva.</span>
        </label>

        {policy.lastPurgeAt && (
          <p className="text-[11px] text-ink-subtle">Última purga aplicada: {new Date(policy.lastPurgeAt).toLocaleString("es-CL")}.</p>
        )}
      </div>

      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <p className="text-sm font-medium">Derechos del titular</p>
        <p className="mt-1 text-xs text-ink-muted">
          Para responder solicitudes de acceso o borrado de una persona, ve a <b>Contactos</b>, abre su ficha y usa
          <b> «Exportar datos»</b> o <b>«Eliminar datos del titular»</b>. El borrado anonimiza la ficha (no rompe reportes
          ni facturación) y queda registrado en Auditoría.
        </p>
      </div>
    </div>
  );
}
