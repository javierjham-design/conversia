"use client";

/** Exports de datos en background (expiran a los 7 días; descarga auditada). */
import { useCallback, useEffect, useState } from "react";
import { Download } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { Button, DateInput, Select, Skeleton, StatusBadge, useToast } from "@/components/ui";

interface ExportRow {
  id: string;
  type: string;
  status: string;
  rows: number | null;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  expired: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  contacts: "Contactos",
  conversations: "Conversaciones (transcripciones)",
  appointments: "Citas",
};

export default function ExportSettingsPage() {
  const toast = useToast();
  const [jobs, setJobs] = useState<ExportRow[] | null>(null);
  const [type, setType] = useState("contacts");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setJobs(await api<ExportRow[]>("/settings/exports").catch(() => []));
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  async function create() {
    setBusy(true);
    try {
      await api("/settings/exports", { method: "POST", body: JSON.stringify({ type, from: from || undefined, to: to || undefined }) });
      toast.push("Exportación en proceso — aparecerá abajo cuando esté lista", "ok");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function download(job: ExportRow) {
    const res = await fetch(`/backend/settings/exports/${job.id}/download`, { headers: { authorization: `Bearer ${getToken() ?? ""}` } });
    if (!res.ok) {
      toast.push("No se pudo descargar (puede haber expirado)", "error");
      return;
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tubot-${job.type}-${job.createdAt.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  if (!jobs) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-64" /></div>;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Exportar datos</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Las exportaciones se generan en segundo plano y quedan disponibles aquí por <b>7 días</b>. Cada descarga queda
        registrada en el Registro de auditoría (dato sensible).
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-2 rounded-card border border-line bg-panel p-4 shadow-card">
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Qué exportar</span>
          <span className="mt-1 block">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {Object.entries(TYPE_LABELS).map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
            </Select>
          </span>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Desde (opcional)</span>
          <DateInput value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 block" />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Hasta (opcional)</span>
          <DateInput value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 block" />
        </label>
        <Button onClick={() => void create()} disabled={busy}>Generar exportación</Button>
      </div>

      <ul className="mt-4 space-y-1.5">
        {jobs.length === 0 && <p className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-ink-subtle">Sin exportaciones aún.</p>}
        {jobs.map((j) => (
          <li key={j.id} className="flex items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 text-xs">
            <span className="min-w-0 flex-1">
              <span className="font-medium">{TYPE_LABELS[j.type] ?? j.type}</span>
              <span className="ml-2 text-ink-subtle">
                {new Date(j.createdAt).toLocaleString("es-CL")} · por {j.createdBy ?? "—"}
                {j.rows !== null ? ` · ${j.rows} fila(s)` : ""}
              </span>
              {j.error && <span className="ml-2 text-red-500">{j.error.slice(0, 80)}</span>}
            </span>
            <StatusBadge
              kind={j.status === "DONE" ? (j.expired ? "soon" : "connected") : j.status === "FAILED" ? "error" : "beta"}
              label={j.status === "DONE" ? (j.expired ? "Expirado" : "Listo") : j.status === "FAILED" ? "Falló" : "Procesando…"}
            />
            {j.status === "DONE" && !j.expired && (
              <Button variant="ghost" className="!px-2 !py-1 text-xs" onClick={() => void download(j)}>
                <Download size={13} /> CSV
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
