"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";

interface ToolMeta {
  name: string;
  description: string;
}
interface VersionRow {
  version: number;
  status: string;
  changelog: string | null;
  publishedAt: string | null;
  createdAt: string;
}
interface AgentDetail {
  id: string;
  slug: string;
  name: string;
  kind: string;
  description: string | null;
  active: boolean;
  publishedVersion: number | null;
  draftVersion: number | null;
  editing: {
    systemPrompt: string;
    config: { model?: string; maxTokens?: number; maxToolRounds?: number };
    tools: string[];
    status: string;
    version: number;
  } | null;
  versions: VersionRow[];
}
interface Channel {
  id: string;
  name: string;
  type: string;
  defaultAgentId: string | null;
}

const MODELS = [
  { id: "claude-opus-4-8", label: "claude-opus-4-8 — máxima calidad (recomendado)" },
  { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6 — rápido y económico" },
  { id: "claude-haiku-4-5", label: "claude-haiku-4-5 — tareas simples" },
];

const KINDS = [
  ["orchestrator", "Recepcionista / Orquestador"],
  ["receptionist", "Recepcionista"],
  ["sales", "Ventas / Especialista"],
  ["scheduler", "Agendamiento"],
  ["follow_up", "Seguimiento"],
  ["custom", "Personalizado"],
];

export default function AgentEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [toolCatalog, setToolCatalog] = useState<ToolMeta[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);

  const [name, setName] = useState("");
  const [kind, setKind] = useState("custom");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState("claude-opus-4-8");
  const [maxTokens, setMaxTokens] = useState(400);
  const [maxToolRounds, setMaxToolRounds] = useState(5);
  const [tools, setTools] = useState<string[]>([]);

  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [detail, catalog, chans] = await Promise.all([
      api<AgentDetail>(`/agents/${id}`),
      api<ToolMeta[]>("/agents/meta/tools"),
      api<Channel[]>("/organizations/me/channels"),
    ]);
    setAgent(detail);
    setToolCatalog(catalog);
    setChannels(chans);
    setName(detail.name);
    setKind(detail.kind);
    setDescription(detail.description ?? "");
    if (detail.editing) {
      setSystemPrompt(detail.editing.systemPrompt);
      setModel(detail.editing.config.model ?? "claude-opus-4-8");
      setMaxTokens(detail.editing.config.maxTokens ?? 400);
      setMaxToolRounds(detail.editing.config.maxToolRounds ?? 5);
      setTools((detail.editing.tools as string[]) ?? []);
    }
  }, [id]);

  useEffect(() => {
    void load().catch((e) => setMsg({ kind: "error", text: (e as Error).message }));
  }, [load]);

  function toggleTool(toolName: string) {
    setTools((prev) => (prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName]));
  }

  async function saveDraft(): Promise<boolean> {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/agents/${id}/draft`, {
        method: "PUT",
        body: JSON.stringify({
          name,
          kind,
          description: description || null,
          systemPrompt,
          config: { model, maxTokens, maxToolRounds, language: "es" },
          tools,
        }),
      });
      setMsg({ kind: "ok", text: "Borrador guardado" });
      await load();
      return true;
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!(await saveDraft())) return;
    setBusy(true);
    try {
      const r = await api<{ publishedVersion: number }>(`/agents/${id}/publish`, { method: "POST" });
      setMsg({ kind: "ok", text: `Versión ${r.publishedVersion} publicada — ya responde en producción` });
      await load();
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function setChannelDefault(channelId: string, useThisAgent: boolean) {
    try {
      await api(`/organizations/me/channels/${channelId}/default-agent`, {
        method: "PUT",
        body: JSON.stringify({ agentId: useThisAgent ? id : null }),
      });
      setChannels(await api<Channel[]>("/organizations/me/channels"));
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  async function toggleActive() {
    if (!agent) return;
    await api(`/agents/${id}/active`, { method: "POST", body: JSON.stringify({ active: !agent.active }) });
    await load();
  }

  async function removeAgent() {
    if (!window.confirm("¿Eliminar este agente? Las conversaciones históricas conservan su trazabilidad.")) return;
    try {
      await api(`/agents/${id}`, { method: "DELETE" });
      router.push("/agents");
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message });
    }
  }

  if (!agent) return <div className="p-6 text-slate-400">Cargando…</div>;

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <button onClick={() => router.push("/agents")} className="text-xs text-slate-400 hover:text-slate-600">
            ← Volver a agentes
          </button>
          <h1 className="text-xl font-semibold">{agent.name}</h1>
          <p className="text-xs text-slate-400">
            {agent.publishedVersion ? `v${agent.publishedVersion} en producción` : "nunca publicado"}
            {agent.draftVersion ? ` · borrador v${agent.draftVersion}` : ""} · slug: {agent.slug}
          </p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => void toggleActive()} className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">
            {agent.active ? "Desactivar" : "Activar"}
          </button>
          <button onClick={() => void saveDraft()} disabled={busy} className="rounded-lg border border-cyan-600 px-3 py-2 text-sm text-cyan-700 hover:bg-cyan-50 disabled:opacity-50">
            Guardar borrador
          </button>
          <button onClick={() => void publish()} disabled={busy} className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800 disabled:opacity-50">
            Publicar
          </button>
        </div>
      </div>

      {msg && (
        <p className={`mb-4 rounded-lg px-3 py-2 text-sm ${msg.kind === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
          {msg.text}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="space-y-4 lg:col-span-2">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-sm">
                Nombre
                <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
              </label>
              <label className="text-sm">
                Tipo
                <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2">
                  {KINDS.map(([v, l]) => (
                    <option key={v} value={v}>{l}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="mt-3 block text-sm">
              Descripción interna
              <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para qué sirve este agente" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
            </label>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-1 font-medium">Prompt del sistema (contexto e instrucciones)</h2>
            <p className="mb-2 text-xs text-slate-400">
              Variables disponibles: {"{{organization.name}}"} {"{{clinic.name}}"} {"{{clinic.city}}"} {"{{clinic.address}}"} {"{{contact.firstName}}"} {"{{agent.name}}"}
            </p>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={14}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
            />
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 font-medium">Herramientas habilitadas</h2>
            <p className="mb-3 text-xs text-slate-400">
              Solo lo marcado aquí puede ejecutar este agente. La información (precios, agenda, conocimiento) sale siempre de los datos reales de la clínica.
            </p>
            <div className="grid gap-2 md:grid-cols-2">
              {toolCatalog.map((t) => (
                <label key={t.name} className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-sm ${tools.includes(t.name) ? "border-cyan-300 bg-cyan-50/50" : "border-slate-200"}`}>
                  <input type="checkbox" checked={tools.includes(t.name)} onChange={() => toggleTool(t.name)} className="mt-1" />
                  <span>
                    <span className="font-mono text-xs font-medium">{t.name}</span>
                    <span className="block text-xs text-slate-500">{t.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 font-medium">Modelo y límites</h2>
            <label className="block text-sm">
              Modelo de IA
              <select value={model} onChange={(e) => setModel(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-sm">
              Máx. tokens por respuesta
              <input type="number" min={50} max={4000} value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="mt-3 block text-sm">
              Máx. rondas de herramientas
              <input type="number" min={0} max={10} value={maxToolRounds} onChange={(e) => setMaxToolRounds(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" />
            </label>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 font-medium">Canales que atiende por defecto</h2>
            <p className="mb-2 text-xs text-slate-400">Las conversaciones nuevas del canal parten con este agente. Las existentes mantienen el suyo.</p>
            {channels.length === 0 && <p className="text-xs text-slate-400">Sin canales configurados.</p>}
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={c.defaultAgentId === agent.id}
                  onChange={(e) => void setChannelDefault(c.id, e.target.checked)}
                />
                {c.name} <span className="text-[10px] text-slate-400">({c.type})</span>
              </label>
            ))}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 font-medium">Versiones</h2>
            <ul className="space-y-1 text-sm">
              {agent.versions.map((v) => (
                <li key={v.version} className="flex items-center justify-between">
                  <span>v{v.version}</span>
                  <span className={`text-[10px] ${v.status === "PUBLISHED" ? "text-emerald-600" : v.status === "DRAFT" ? "text-amber-600" : "text-slate-400"}`}>
                    {v.status.toLowerCase()}
                    {v.publishedAt ? ` · ${new Date(v.publishedAt).toLocaleDateString("es-CL")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          <button onClick={() => void removeAgent()} className="w-full rounded-lg border border-red-200 px-3 py-2 text-sm text-red-600 hover:bg-red-50">
            Eliminar agente
          </button>
        </aside>
      </div>
    </div>
  );
}
