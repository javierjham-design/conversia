"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bot } from "lucide-react";
import { api } from "@/lib/api";
import { EmptyState, Select, cn } from "@/components/ui";

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
        <div className="mb-4 flex items-center justify-between rounded-xl border border-brand-200 bg-brand-50 px-4 py-3 dark:bg-brand-500/10 dark:border-brand-500/30">
          <p className="text-sm text-brand-900 dark:text-brand-200">
            Tus agentes aún no tienen canal: <b>conecta WhatsApp</b> para que respondan conversaciones reales.
          </p>
          <a href="/channels" className="rounded-lg bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800">
            Conectar WhatsApp
          </a>
        </div>
      )}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Agentes IA</h1>
          <p className="text-sm text-ink-muted">
            Cada agente tiene su propio prompt, modelo, herramientas y versiones — independientes entre sí.
          </p>
        </div>
        <button
          onClick={() => setShowNew(!showNew)}
          className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
        >
          + Nuevo agente
        </button>
      </div>

      {showNew && (
        <form onSubmit={createAgent} className="mb-6 flex flex-wrap items-end gap-3 rounded-xl border border-brand-200 bg-brand-50/50 p-4 dark:border-brand-500/30">
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
            <Select
              value={newKind}
              onChange={(e) => setNewKind(e.target.value)}
              className="mt-1 block"
            >
              {Object.entries(KIND_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
          </label>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 disabled:opacity-50"
          >
            Crear y configurar
          </button>
          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        </form>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((a) => {
          // Posible duplicado: mismo tipo + mismo modelo y AMBOS activos —
          // dato del tenant (no se borra nada), pero la lista lo advierte.
          const twin = a.active && agents.find((b) => b.id !== a.id && b.active && b.kind === a.kind && b.model === a.model);
          return (
          <button
            key={a.id}
            onClick={() => router.push(`/agents/${a.id}`)}
            className={cn(
              "rounded-xl border bg-panel p-4 text-left shadow-sm transition-colors hover:border-brand-300",
              a.active ? "border-line" : "border-dashed border-line opacity-70",
            )}
          >
            <div className="flex items-center justify-between">
              <h2 className="font-medium">{a.name}</h2>
              <span className={`text-[10px] ${a.active ? "text-emerald-600 dark:text-emerald-400" : "text-ink-subtle"}`}>
                {a.active ? "● activo" : "○ inactivo"}
              </span>
            </div>
            <p className="text-xs text-ink-subtle">{KIND_LABELS[a.kind] ?? a.kind} · {a.model ?? "—"}</p>
            {a.description ? (
              <p className="mt-2 line-clamp-2 text-sm text-ink-muted">{a.description}</p>
            ) : (
              <p className="mt-2 text-sm text-brand-700 underline decoration-dotted underline-offset-2 dark:text-brand-400">
                Agregar una descripción…
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
              {a.publishedVersion ? (
                <span className="rounded bg-emerald-50 px-2 py-0.5 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">v{a.publishedVersion} publicada</span>
              ) : (
                <span className="rounded bg-app px-2 py-0.5 text-ink-muted">sin publicar</span>
              )}
              {a.hasDraft && <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">borrador pendiente</span>}
              {twin && (
                <span
                  className="rounded bg-amber-50 px-2 py-0.5 font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                  title={`«${a.name}» y «${twin.name}» son del mismo tipo y modelo y están ambos activos — revisa si uno sobra.`}
                >
                  ⚠ posible duplicado de «{twin.name}»
                </span>
              )}
            </div>
          </button>
          );
        })}
        {agents.length === 0 && (
          <EmptyState
            icon={<Bot size={28} />}
            title="Aún no tienes agentes"
            description="Crea tu primer agente de IA para que atienda, agende y responda por ti con la información de tu negocio."
            action={
              <button
                onClick={() => setShowNew(true)}
                className="rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800"
              >
                + Nuevo agente
              </button>
            }
          />
        )}
      </div>
    </div>
  );
}
