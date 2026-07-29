"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button, Modal, StatusBadge, cn, useToast } from "@/components/ui";
import { AGENT_HELP, AGENT_VARIABLES, AGENT_VARIABLE_KEYS, PROMPT_SNIPPETS, type SectionHelp } from "@/lib/agent-help";

interface ToolMeta {
  name: string;
  description: string;
}
interface VersionRow {
  version: number;
  status: string;
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
    config: { model?: string; maxTokens?: number; maxToolRounds?: number; emoji?: string };
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
  { id: "gpt-4o-mini", label: "GPT-4o mini — rápido y económico (recomendado)" },
  { id: "gpt-4o", label: "GPT-4o — más capaz" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5 — económico" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — equilibrado" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 — máxima calidad" },
];
const KINDS: [string, string][] = [
  ["orchestrator", "Recepcionista / Orquestador"],
  ["receptionist", "Recepcionista"],
  ["sales", "Ventas / Especialista"],
  ["scheduler", "Agendamiento"],
  ["follow_up", "Seguimiento"],
  ["support", "Soporte"],
  ["custom", "Personalizado"],
];
const QUICK_EMOJIS = ["🤖", "💬", "👩‍💼", "🛎️", "🦷", "🏥", "📅", "💡", "🛒", "🎧", "✨", "📞"];

/** Card de sección con título, ayuda opcional y contenido. */
function Section({ title, subtitle, helpKey, onHelp, children }: { title: string; subtitle?: string; helpKey?: string; onHelp?: (k: string) => void; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-navy-900">{title}</h2>
          {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
        </div>
        {helpKey && onHelp && (
          <button onClick={() => onHelp(helpKey)} className="shrink-0 text-xs font-medium text-brand-600 hover:underline">
            Aprende a escribir esto
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

export default function AgentEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [toolCatalog, setToolCatalog] = useState<ToolMeta[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);

  const [emoji, setEmoji] = useState("🤖");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("custom");
  const [description, setDescription] = useState("");
  const [showDescription, setShowDescription] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [maxTokens, setMaxTokens] = useState(400);
  const [maxToolRounds, setMaxToolRounds] = useState(5);
  const [tools, setTools] = useState<string[]>([]);

  const [snapshot, setSnapshot] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState<SectionHelp | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const load = useCallback(async () => {
    const [detail, catalog, chans] = await Promise.all([
      api<AgentDetail>(`/agents/${id}`),
      api<ToolMeta[]>("/agents/meta/tools"),
      api<Channel[]>("/organizations/me/channels").catch(() => []),
    ]);
    setAgent(detail);
    setToolCatalog(catalog);
    setChannels(chans);
    setName(detail.name);
    setKind(detail.kind);
    setDescription(detail.description ?? "");
    setShowDescription(!!detail.description);
    const e = detail.editing;
    const nextEmoji = e?.config.emoji ?? "🤖";
    const nextPrompt = e?.systemPrompt ?? "";
    const nextModel = e?.config.model ?? "gpt-4o-mini";
    const nextMaxTokens = e?.config.maxTokens ?? 400;
    const nextRounds = e?.config.maxToolRounds ?? 5;
    const nextTools = (e?.tools as string[]) ?? [];
    setEmoji(nextEmoji);
    setSystemPrompt(nextPrompt);
    setModel(nextModel);
    setMaxTokens(nextMaxTokens);
    setMaxToolRounds(nextRounds);
    setTools(nextTools);
    setSnapshot(
      JSON.stringify({ emoji: nextEmoji, name: detail.name, kind: detail.kind, description: detail.description ?? "", systemPrompt: nextPrompt, model: nextModel, maxTokens: nextMaxTokens, maxToolRounds: nextRounds, tools: nextTools }),
    );
  }, [id]);

  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const current = JSON.stringify({ emoji, name, kind, description, systemPrompt, model, maxTokens, maxToolRounds, tools });
  const dirty = snapshot !== "" && current !== snapshot;

  // Validación de variables {{...}} contra las disponibles.
  const unknownVars = useMemo(() => {
    const used = [...systemPrompt.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
    return [...new Set(used.filter((v) => !AGENT_VARIABLE_KEYS.includes(v)))];
  }, [systemPrompt]);
  const approxTokens = Math.ceil(systemPrompt.length / 4);

  function toggleTool(t: string) {
    setTools((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }
  function insertSnippet(text: string) {
    setSystemPrompt((p) => (p.trim() ? `${p.trim()}\n\n${text}` : text));
  }

  async function saveDraft(): Promise<boolean> {
    setBusy(true);
    try {
      await api(`/agents/${id}/draft`, {
        method: "PUT",
        body: JSON.stringify({
          name,
          kind,
          description: description || null,
          systemPrompt,
          config: { model, maxTokens, maxToolRounds, language: "es", emoji },
          tools,
        }),
      });
      toast.push("Borrador guardado", "ok");
      await load();
      return true;
    } catch (e) {
      toast.push((e as Error).message, "error");
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
      toast.push(`Versión ${r.publishedVersion} publicada — ya responde en producción`, "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  function cancel() {
    if (dirty && !window.confirm("Tienes cambios sin guardar. ¿Salir y descartarlos?")) return;
    router.push("/agents");
  }
  async function toggleActive() {
    if (!agent) return;
    await api(`/agents/${id}/active`, { method: "POST", body: JSON.stringify({ active: !agent.active }) });
    await load();
  }
  async function setChannelDefault(channelId: string, use: boolean) {
    await api(`/organizations/me/channels/${channelId}/default-agent`, { method: "PUT", body: JSON.stringify({ agentId: use ? id : null }) });
    setChannels(await api<Channel[]>("/organizations/me/channels").catch(() => []));
  }
  async function removeAgent() {
    if (!window.confirm("¿Eliminar este agente? Las conversaciones históricas conservan su trazabilidad.")) return;
    await api(`/agents/${id}`, { method: "DELETE" });
    router.push("/agents");
  }

  if (!agent) return <div className="p-6 text-slate-400">Cargando…</div>;
  const published = agent.publishedVersion != null;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{emoji}</span>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-navy-900">{name || "Agente"}</h1>
              <StatusBadge kind={published && agent.active ? "connected" : "beta"} label={published ? (agent.active ? "activo" : "inactivo") : "borrador"} />
              {dirty && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">cambios sin guardar</span>}
            </div>
            <p className="text-[11px] text-slate-400">
              {published ? `v${agent.publishedVersion} en producción` : "nunca publicado"}
              {agent.draftVersion ? ` · borrador v${agent.draftVersion}` : ""} · {agent.slug}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={cancel} className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">Cancelar</button>
          <Button variant="secondary" disabled={busy} onClick={() => void saveDraft()}>Guardar borrador</Button>
          <Button disabled={busy} onClick={() => void publish()}>Publicar</Button>
        </div>
      </header>

      {/* Dos columnas */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Izquierda: formulario */}
        <div className="min-w-0 flex-1 overflow-y-auto bg-slate-50 p-5">
          <div className="mx-auto max-w-2xl">
            {/* Configuración */}
            <Section title="Configuración">
              <div className="flex gap-3">
                <div>
                  <label className="text-xs text-slate-500">Ícono</label>
                  <input value={emoji} onChange={(e) => setEmoji(e.target.value.slice(0, 2))} className="mt-1 h-11 w-14 rounded-lg border border-slate-300 text-center text-xl" />
                </div>
                <label className="flex-1 text-sm">
                  <span className="text-xs text-slate-500">Nombre</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Recepcionista" className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2.5" />
                </label>
                <label className="text-sm">
                  <span className="text-xs text-slate-500">Tipo</span>
                  <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm">
                    {KINDS.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
                  </select>
                </label>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {QUICK_EMOJIS.map((e) => (
                  <button key={e} onClick={() => setEmoji(e)} className={cn("rounded-lg border px-2 py-1 text-lg", emoji === e ? "border-brand-400 bg-brand-50" : "border-slate-200 hover:bg-slate-50")}>{e}</button>
                ))}
              </div>
              {!showDescription ? (
                <button onClick={() => setShowDescription(true)} className="mt-3 text-xs font-medium text-brand-600 hover:underline">+ Mostrar descripción</button>
              ) : (
                <label className="mt-3 block text-sm">
                  <span className="text-xs text-slate-500">Descripción interna (para tu equipo)</span>
                  <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para qué sirve este agente" className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" />
                </label>
              )}
            </Section>

            {/* Instrucciones */}
            <Section title="Instrucciones" subtitle="El cerebro del agente: quién es, qué sabe, cómo habla y qué puede hacer." helpKey="instrucciones" onHelp={(k) => setHelp(AGENT_HELP[k])}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <PromptTemplateMenu onPick={insertSnippet} />
                <span className="text-xs text-slate-400">~{approxTokens.toLocaleString("es-CL")} tokens</span>
              </div>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={16}
                placeholder="Eres el asistente de {{organization.name}}…"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-[13px] leading-relaxed"
              />
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-slate-400">Variables:</span>
                {AGENT_VARIABLES.map((v) => (
                  <button key={v.key} onClick={() => setSystemPrompt((p) => `${p}{{${v.key}}}`)} title={v.label} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-600 hover:bg-slate-200">
                    {"{{"}{v.key}{"}}"}
                  </button>
                ))}
              </div>
              {unknownVars.length > 0 && (
                <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">
                  Variables no reconocidas: {unknownVars.map((v) => `{{${v}}}`).join(", ")}. Se reemplazarán por vacío. Usa solo las de la lista.
                </p>
              )}
            </Section>

            {/* Acciones — se rediseña en Fase 3 (por ahora, herramientas) */}
            <Section title="Acciones" subtitle="Qué puede hacer el agente. (Rediseño completo en curso.)" helpKey="acciones" onHelp={(k) => setHelp(AGENT_HELP[k])}>
              <div className="grid gap-2 sm:grid-cols-2">
                {toolCatalog.map((t) => (
                  <label key={t.name} className={cn("flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-sm", tools.includes(t.name) ? "border-brand-300 bg-brand-50/50" : "border-slate-200")}>
                    <input type="checkbox" checked={tools.includes(t.name)} onChange={() => toggleTool(t.name)} className="mt-1" />
                    <span>
                      <span className="font-mono text-xs font-medium">{t.name}</span>
                      <span className="block text-xs text-slate-500">{t.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Section>

            {/* Fuentes de conocimiento — Fase 5 */}
            <Section title="Fuentes de conocimiento" subtitle="Documentos que este agente puede consultar." helpKey="knowledge" onHelp={(k) => setHelp(AGENT_HELP[k])}>
              <p className="text-sm text-slate-400">Selección de fuentes por agente — próxima entrega.</p>
            </Section>

            {/* Avanzado */}
            <div className="rounded-xl border border-slate-200 bg-white">
              <button onClick={() => setShowAdvanced((v) => !v)} className="flex w-full items-center justify-between p-4 text-left">
                <span className="font-semibold text-navy-900">Configuración avanzada</span>
                <span className="text-slate-400">{showAdvanced ? "−" : "+"}</span>
              </button>
              {showAdvanced && (
                <div className="space-y-4 border-t border-slate-100 p-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="text-sm">
                      <span className="text-xs text-slate-500">Modelo de IA</span>
                      <select value={model} onChange={(e) => setModel(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm">
                        {MODELS.map((m) => (<option key={m.id} value={m.id}>{m.label}</option>))}
                      </select>
                    </label>
                    <label className="text-sm">
                      <span className="text-xs text-slate-500">Máx. tokens/respuesta</span>
                      <input type="number" min={50} max={4000} value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" />
                    </label>
                    <label className="text-sm">
                      <span className="text-xs text-slate-500">Máx. rondas de tools</span>
                      <input type="number" min={0} max={10} value={maxToolRounds} onChange={(e) => setMaxToolRounds(Number(e.target.value))} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" />
                    </label>
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium text-slate-600">Canales que atiende por defecto</p>
                    {channels.length === 0 && <p className="text-xs text-slate-400">Sin canales configurados.</p>}
                    {channels.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 py-0.5 text-sm">
                        <input type="checkbox" checked={c.defaultAgentId === agent.id} onChange={(e) => void setChannelDefault(c.id, e.target.checked)} />
                        {c.name} <span className="text-[10px] text-slate-400">({c.type})</span>
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center justify-between border-t border-slate-100 pt-3">
                    <button onClick={() => void toggleActive()} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">{agent.active ? "Desactivar agente" : "Activar agente"}</button>
                    <button onClick={() => void removeAgent()} className="text-sm text-red-600 hover:underline">Eliminar agente</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Derecha: Probar Agente IA (Fase 4) */}
        <aside className="hidden w-96 shrink-0 flex-col border-l border-slate-200 bg-white lg:flex">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="font-semibold text-navy-900">Probar Agente IA</h2>
            <p className="text-[11px] text-slate-400">Conversa con el agente usando la configuración actual, sin efectos reales.</p>
          </div>
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-slate-400">
            El probador en vivo llega en la próxima entrega.
          </div>
        </aside>
      </div>

      {/* Modal de ayuda por sección */}
      <Modal open={!!help} onClose={() => setHelp(null)} title={help?.title} wide>
        {help && <HelpContent help={help} />}
      </Modal>
    </div>
  );
}

function PromptTemplateMenu({ onPick }: { onPick: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-medium hover:bg-slate-50">
        Plantillas de prompt ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-1 shadow-pop">
            {PROMPT_SNIPPETS.map((s) => (
              <button key={s.label} onClick={() => { onPick(s.text); setOpen(false); }} className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-slate-50">
                {s.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function HelpContent({ help }: { help: SectionHelp }) {
  return (
    <div className="space-y-3 text-sm text-slate-700">
      <p>{help.intro}</p>
      <ul className="list-disc space-y-1 pl-5">
        {help.points.map((p, i) => (<li key={i}>{p}</li>))}
      </ul>
      {help.examples && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
            <p className="mb-1 text-xs font-semibold text-emerald-800">✓ Buen ejemplo</p>
            <p className="text-xs text-emerald-900">{help.examples.good}</p>
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50 p-3">
            <p className="mb-1 text-xs font-semibold text-red-800">✗ Evita esto</p>
            <p className="text-xs text-red-900">{help.examples.bad}</p>
          </div>
        </div>
      )}
      {help.showVariables && (
        <div>
          <p className="mb-1 text-xs font-semibold text-slate-600">Variables disponibles</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {AGENT_VARIABLES.map((v) => (
              <div key={v.key} className="rounded bg-slate-50 px-2 py-1 text-xs">
                <span className="font-mono text-slate-700">{"{{"}{v.key}{"}}"}</span> <span className="text-slate-400">— {v.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
