"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  publishedVersion: number | null;
  hasDraft: boolean;
  trigger: string | null;
  runsTotal: number;
  runsWaiting: number;
}

const TRIGGER_LABELS: Record<string, string> = {
  conversation_started: "Conversación nueva",
  message_received: "Cada mensaje",
  keyword: "Palabra clave",
};

export default function WorkflowsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<WorkflowRow[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(await api<WorkflowRow[]>("/workflows"));
  }, []);

  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const wf = await api<{ id: string }>("/workflows", { method: "POST", body: JSON.stringify({ name }) });
      router.push(`/workflows/${wf.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function toggleActive(w: WorkflowRow) {
    await api(`/workflows/${w.id}/active`, { method: "POST", body: JSON.stringify({ active: !w.active }) });
    await load();
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Flujos de trabajo</h1>
          <p className="text-sm text-slate-500">
            Automatizaciones sin código: seguimientos, respuestas, esperas y acciones sobre leads.
          </p>
        </div>
        <button onClick={() => setShowNew(!showNew)} className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800">
          + Nuevo flujo
        </button>
      </div>

      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {showNew && (
        <form onSubmit={create} className="mb-6 flex items-end gap-3 rounded-xl border border-cyan-200 bg-cyan-50/40 p-4">
          <label className="text-sm">
            Nombre del flujo
            <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} placeholder="p.ej. Seguimiento de leads fríos" className="mt-1 block w-72 rounded-lg border border-slate-300 bg-white px-3 py-2" />
          </label>
          <button type="submit" className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800">
            Crear y editar
          </button>
        </form>
      )}

      <div className="space-y-3">
        {rows.map((w) => (
          <div key={w.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
            <button onClick={() => router.push(`/workflows/${w.id}`)} className="flex-1 text-left">
              <h3 className="font-medium">{w.name}</h3>
              <p className="text-xs text-slate-400">
                Disparador: {w.trigger ? (TRIGGER_LABELS[w.trigger] ?? w.trigger) : "—"} · {w.runsTotal} ejecuciones
                {w.runsWaiting > 0 ? ` (${w.runsWaiting} en espera)` : ""}
              </p>
              <div className="mt-1 flex gap-2 text-[11px]">
                {w.publishedVersion ? (
                  <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-700">v{w.publishedVersion} publicada</span>
                ) : (
                  <span className="rounded bg-slate-100 px-2 py-0.5 text-slate-500">sin publicar</span>
                )}
                {w.hasDraft && <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">borrador</span>}
              </div>
            </button>
            <button
              onClick={() => void toggleActive(w)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium ${w.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`}
            >
              {w.active ? "● Activo" : "○ Pausado"}
            </button>
          </div>
        ))}
        {rows.length === 0 && <p className="text-sm text-slate-400">Sin flujos aún. Digital Dent trae 2 de ejemplo tras el seed.</p>}
      </div>
    </div>
  );
}
