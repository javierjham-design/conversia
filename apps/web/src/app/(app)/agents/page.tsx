"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  kind: string;
  description: string | null;
  active: boolean;
  publishedVersion: number | null;
  hasDraft: boolean;
  model: string | null;
}

const KIND_LABELS: Record<string, string> = {
  orchestrator: "Recepcionista / Orquestador",
  receptionist: "Recepcionista",
  sales: "Ventas / Especialista",
  scheduler: "Agendamiento",
  follow_up: "Seguimiento",
  custom: "Personalizado",
};

export default function AgentsPage() {
  const router = useRouter();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("custom");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [hasWhatsapp, setHasWhatsapp] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setAgents(await api<AgentRow[]>("/agents"));
  }, []);

  useEffect(() => {
    void load();
    void api<{ type: string; status: string }[]>("/channels")
      .then((ch) => setHasWhatsapp(ch.some((c) => c.type === "WHATSAPP_CLOUD" && c.status !== "inactive")))
      .catch(() => setHasWhatsapp(null));
  }, [load]);

  async function createAgent(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const agent = await api<{ id: string }>("/agents", {
        method: "POST",
        body: JSON.stringify({ name: newName, kind: newKind }),
      });
      router.push(`/agents/${agent.id}`);
    } catch (err) {
      setError((err as Error).message);
      setLoading(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      {hasWhatsapp === false && (
        <div className="mb-4 flex items-center justify-between rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-3 dark:bg-cyan-500/10 dark:border-cyan-500/30">
          <p className="text-sm text-cyan-900 dark:text-cyan-200">
            Tus agentes aún no tienen canal: <b>conecta WhatsApp</b> para que respondan conversaciones reales.
          </p>
          <a href="/channels" className="rounded-lg bg-cyan-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-cyan-800">
            Conectar WhatsApp
          </a>
        </div>
      )}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Agentes de IA</h1>
          <p className="text-sm text-ink-muted">
            Cada agente tiene su propio prompt, modelo, herramientas y versiones — independientes entre sí.
          </p>
        </div>
        <button
          onClick={() => setShowNew(!showNew)}
          className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800"
        >
          + Nuevo agente
        </button>
      </div>

      {showNew && (
        <form onSubmit={createAgent} className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-cyan-200 bg-cyan-50/50 p-4 dark:border-cyan-500/30">
          <label className="text-sm">
            Nombre
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="p.ej. Agente de Ortodoncia"
              required
              minLength={2}
              className="mt-1 block w-64 rounded-lg border border-line-strong bg-panel px-3 py-2"
            />
          </label>
          <label className="text-sm">
            Tipo
            <select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
              className="mt-1 block rounded-lg border border-line-strong bg-panel px-3 py-2"
            >
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800 disabled:opacity-50"
          >
            Crear y configurar
          </button>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </form>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((a) => (
          <button
            key={a.id}
            onClick={() => router.push(`/agents/${a.id}`)}
            className="rounded-xl border border-line bg-panel p-4 text-left shadow-sm hover:border-cyan-300"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-medium">{a.name}</h2>
              <span className={`text-[10px] ${a.active ? "text-emerald-600" : "text-ink-subtle"} dark:text-emerald-400`}>
                {a.active ? "● activo" : "○ inactivo"}
              </span>
            </div>
            <p className="text-xs text-ink-subtle">{KIND_LABELS[a.kind] ?? a.kind} · {a.model ?? "—"}</p>
            <p className="mt-2 line-clamp-2 text-sm text-ink-muted">{a.description ?? "Sin descripción"}</p>
            <div className="mt-3 flex gap-2 text-[11px]">
              {a.publishedVersion ? (
                <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">v{a.publishedVersion} publicada</span>
              ) : (
                <span className="rounded bg-app px-2 py-0.5 text-ink-muted">sin publicar</span>
              )}
              {a.hasDraft && <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">borrador pendiente</span>}
            </div>
          </button>
        ))}
        {agents.length === 0 && (
          <p className="text-sm text-ink-subtle">Aún no hay agentes. Crea el primero con “+ Nuevo agente”.</p>
        )}
      </div>
    </div>
  );
}
