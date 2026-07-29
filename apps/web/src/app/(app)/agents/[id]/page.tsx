"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button, Modal, StatusBadge, cn, useToast } from "@/components/ui";
import { AGENT_HELP, AGENT_VARIABLES, AGENT_VARIABLE_KEYS, PROMPT_SNIPPETS, type SectionHelp } from "@/lib/agent-help";
import { AGENT_ACTIONS, deriveTools, inferActions, type AgentActionDef } from "@/lib/agent-actions";

type ActionState = Record<string, { enabled: boolean; instructions: string }>;
interface Mention { label: string; type: "equipo" | "usuario" | "agente" }

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

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} aria-pressed={checked} className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-brand-600" : "bg-slate-300")}>
      <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

function ActionCard({ def, state, onToggle, onInstructions, mentions }: { def: AgentActionDef; state?: { enabled: boolean; instructions: string }; onToggle: (en: boolean) => void; onInstructions: (v: string) => void; mentions?: Mention[] }) {
  const enabled = state?.enabled ?? false;
  return (
    <div className={cn("rounded-lg border p-3", enabled ? "border-brand-300 bg-brand-50/40" : "border-slate-200")}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-navy-900">{def.label}</p>
          <p className="text-xs text-slate-500">{def.description}</p>
        </div>
        <Toggle checked={enabled} onChange={onToggle} />
      </div>
      {enabled && (
        <div className="mt-2">
          <label className="text-xs text-slate-500">¿Cuándo y cómo debe ejecutarse esta acción?</label>
          {mentions ? (
            <MentionTextarea value={state?.instructions ?? ""} onChange={onInstructions} placeholder={def.placeholder} mentions={mentions} />
          ) : (
            <textarea value={state?.instructions ?? ""} onChange={(e) => onInstructions(e.target.value)} rows={2} placeholder={def.placeholder} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
          )}
        </div>
      )}
    </div>
  );
}

function MentionTextarea({ value, onChange, placeholder, mentions }: { value: string; onChange: (v: string) => void; placeholder?: string; mentions: Mention[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  function handle(v: string) {
    onChange(v);
    const pos = ref.current?.selectionStart ?? v.length;
    const m = v.slice(0, pos).match(/@([\w\s]{0,20})$/);
    setQuery(m ? m[1] : null);
  }
  const filtered = query != null ? mentions.filter((mm) => mm.label.toLowerCase().includes(query.toLowerCase())).slice(0, 6) : [];
  function pick(label: string) {
    const pos = ref.current?.selectionStart ?? value.length;
    const before = value.slice(0, pos).replace(/@([\w\s]{0,20})$/, `@${label} `);
    onChange(before + value.slice(pos));
    setQuery(null);
    ref.current?.focus();
  }
  return (
    <div className="relative">
      <textarea ref={ref} value={value} onChange={(e) => handle(e.target.value)} rows={2} placeholder={placeholder} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
      {query != null && filtered.length > 0 && (
        <div className="absolute z-20 mt-1 w-56 rounded-lg border border-slate-200 bg-white p-1 shadow-pop">
          {filtered.map((mm) => (
            <button key={`${mm.type}-${mm.label}`} type="button" onClick={() => pick(mm.label)} className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-slate-50">
              <span>{mm.label}</span>
              <span className="text-[10px] text-slate-400">{mm.type}</span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-1 text-[10px] text-slate-400">Escribe @ para mencionar equipos, usuarios u otros agentes.</p>
    </div>
  );
}

export default function AgentEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
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
  const [actions, setActions] = useState<ActionState>({});
  const [extraTools, setExtraTools] = useState<string[]>([]);
  const [mentions, setMentions] = useState<Mention[]>([]);

  const [snapshot, setSnapshot] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState<SectionHelp | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const load = useCallback(async () => {
    const [detail, chans, users, teams, agents] = await Promise.all([
      api<AgentDetail>(`/agents/${id}`),
      api<Channel[]>("/organizations/me/channels").catch(() => []),
      api<{ userId: string; name: string }[]>("/users/assignable").catch(() => []),
      api<{ id: string; name: string }[]>("/users/teams").catch(() => []),
      api<{ id: string; name: string }[]>("/agents/assignable").catch(() => []),
    ]);
    setAgent(detail);
    setChannels(chans);
    setMentions([
      ...teams.map((t) => ({ label: t.name, type: "equipo" as const })),
      ...users.map((u) => ({ label: u.name, type: "usuario" as const })),
      ...agents.filter((a) => a.id !== id).map((a) => ({ label: a.name, type: "agente" as const })),
    ]);
    setName(detail.name);
    setKind(detail.kind);
    setDescription(detail.description ?? "");
    setShowDescription(!!detail.description);
    const e = detail.editing;
    const cfg = (e?.config ?? {}) as any;
    const nextEmoji = cfg.emoji ?? "🤖";
    const nextPrompt = e?.systemPrompt ?? "";
    const nextModel = cfg.model ?? "gpt-4o-mini";
    const nextMaxTokens = cfg.maxTokens ?? 400;
    const nextRounds = cfg.maxToolRounds ?? 5;
    const nextTools = (e?.tools as string[]) ?? [];
    const nextActions: ActionState = cfg.actions && typeof cfg.actions === "object" ? cfg.actions : inferActions(nextTools);
    const actionTools = new Set(AGENT_ACTIONS.flatMap((a) => a.tools));
    const nextExtra = nextTools.filter((t) => !actionTools.has(t));
    setEmoji(nextEmoji);
    setSystemPrompt(nextPrompt);
    setModel(nextModel);
    setMaxTokens(nextMaxTokens);
    setMaxToolRounds(nextRounds);
    setActions(nextActions);
    setExtraTools(nextExtra);
    setSnapshot(
      JSON.stringify({ emoji: nextEmoji, name: detail.name, kind: detail.kind, description: detail.description ?? "", systemPrompt: nextPrompt, model: nextModel, maxTokens: nextMaxTokens, maxToolRounds: nextRounds, actions: nextActions }),
    );
  }, [id]);

  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const current = JSON.stringify({ emoji, name, kind, description, systemPrompt, model, maxTokens, maxToolRounds, actions });
  const dirty = snapshot !== "" && current !== snapshot;

  // Validación de variables {{...}} contra las disponibles.
  const unknownVars = useMemo(() => {
    const used = [...systemPrompt.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
    return [...new Set(used.filter((v) => !AGENT_VARIABLE_KEYS.includes(v)))];
  }, [systemPrompt]);
  const approxTokens = Math.ceil(systemPrompt.length / 4);

  function setAction(key: string, patch: Partial<{ enabled: boolean; instructions: string }>) {
    setActions((prev) => {
      const cur = prev[key] ?? { enabled: false, instructions: "" };
      return { ...prev, [key]: { ...cur, ...patch } };
    });
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
          config: { model, maxTokens, maxToolRounds, language: "es", emoji, actions },
          tools: deriveTools(actions, extraTools),
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

            {/* Acciones */}
            <Section title="Acciones" subtitle="Qué puede hacer el agente. Activa una acción y explica en tus palabras cuándo y cómo usarla." helpKey="acciones" onHelp={(k) => setHelp(AGENT_HELP[k])}>
              <div className="space-y-2">
                {AGENT_ACTIONS.map((a) => (
                  <ActionCard
                    key={a.key}
                    def={a}
                    state={actions[a.key]}
                    onToggle={(en) => setAction(a.key, { enabled: en })}
                    onInstructions={(v) => setAction(a.key, { instructions: v })}
                    mentions={a.mentions ? mentions : undefined}
                  />
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
        <AgentTester
          id={id}
          systemPrompt={systemPrompt}
          model={model}
          maxTokens={maxTokens}
          maxToolRounds={maxToolRounds}
          actions={actions}
          tools={deriveTools(actions, extraTools)}
        />
      </div>

      {/* Modal de ayuda por sección */}
      <Modal open={!!help} onClose={() => setHelp(null)} title={help?.title} wide>
        {help && <HelpContent help={help} />}
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Probador en vivo (Fase 4). Envía el estado ACTUAL del editor a
// POST /agents/:id/test (lecturas reales, escrituras simuladas).
// ---------------------------------------------------------------------------

type TestMeta = {
  simulated?: { action: string; detail: string }[];
  toolEvents?: { name: string; isError: boolean }[];
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs?: number;
};
type TestMsg = { role: "user" | "assistant" | "system"; content: string; meta?: TestMeta };
type TestResponse = {
  ok: boolean;
  blocked?: boolean;
  error?: string;
  reply?: string | null;
  toolEvents?: { name: string; input: unknown; output: string; isError: boolean }[];
  simulated?: { action: string; detail: string }[];
  contact?: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null };
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs?: number;
  stopReason?: string;
  transferToAgentSlug?: string | null;
  humanHandoff?: boolean;
};

function AgentTester({ id, systemPrompt, model, maxTokens, maxToolRounds, actions, tools }: {
  id: string;
  systemPrompt: string;
  model: string;
  maxTokens: number;
  maxToolRounds: number;
  actions: ActionState;
  tools: string[];
}) {
  const [tab, setTab] = useState<"chat" | "contact">("chat");
  const [messages, setMessages] = useState<TestMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [contact, setContact] = useState({ firstName: "", lastName: "", email: "", phone: "" });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    const nextMsgs: TestMsg[] = [...messages, { role: "user", content: text }];
    setMessages(nextMsgs);
    setInput("");
    setLoading(true);
    try {
      const payload = {
        systemPrompt,
        config: { model, maxTokens, maxToolRounds },
        tools,
        actions,
        messages: nextMsgs.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
        contact: {
          firstName: contact.firstName || null,
          lastName: contact.lastName || null,
          email: contact.email || null,
          phone: contact.phone || null,
        },
      };
      const r = await api<TestResponse>(`/agents/${id}/test`, { method: "POST", body: JSON.stringify(payload) });
      if (!r.ok) {
        setMessages((m) => [...m, { role: "system", content: r.error ?? "No se pudo completar la prueba" }]);
        return;
      }
      if (r.contact) {
        setContact({
          firstName: r.contact.firstName ?? "",
          lastName: r.contact.lastName ?? "",
          email: r.contact.email ?? "",
          phone: r.contact.phone ?? "",
        });
      }
      const extras: TestMsg[] = [];
      if (r.humanHandoff) extras.push({ role: "system", content: "El agente escaló a un humano — en producción dejaría de responder." });
      if (r.transferToAgentSlug) extras.push({ role: "system", content: `El agente transfirió la conversación a "${r.transferToAgentSlug}".` });
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: r.reply || "(el agente no devolvió texto en este turno)",
          meta: { simulated: r.simulated, toolEvents: r.toolEvents, usage: r.usage, latencyMs: r.latencyMs },
        },
        ...extras,
      ]);
    } catch (e) {
      setMessages((m) => [...m, { role: "system", content: (e as Error).message }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <aside className="hidden w-96 shrink-0 flex-col border-l border-slate-200 bg-white lg:flex">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="font-semibold text-navy-900">Probar Agente IA</h2>
          <p className="text-[11px] text-slate-400">Lee datos reales · simula acciones · no envía nada.</p>
        </div>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])} className="text-xs text-slate-400 hover:text-slate-600">Reiniciar</button>
        )}
      </div>
      <div className="flex gap-1 border-b border-slate-200 px-2 pt-2">
        {(["chat", "contact"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-t-lg px-3 py-1.5 text-sm",
              tab === t ? "bg-slate-100 font-medium text-navy-900" : "text-slate-500 hover:text-slate-700",
            )}
          >
            {t === "chat" ? "Chat" : "Campos del contacto"}
          </button>
        ))}
      </div>

      {tab === "chat" ? (
        <>
          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
            {messages.length === 0 && (
              <p className="mt-8 text-center text-sm text-slate-400">
                Escribe un mensaje como si fueras el cliente para probar el comportamiento del agente.
              </p>
            )}
            {messages.map((m, i) => (
              <TesterBubble key={i} m={m} />
            ))}
            {loading && <p className="text-xs text-slate-400">El agente está pensando…</p>}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="border-t border-slate-200 p-2">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                rows={1}
                placeholder="Escribe como el cliente…"
                className="max-h-24 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <Button type="submit" disabled={loading || !input.trim()}>Enviar</Button>
            </div>
          </form>
        </>
      ) : (
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <p className="text-xs text-slate-500">Datos del contacto simulado. El agente los lee y puede actualizarlos durante la prueba.</p>
          {([["firstName", "Nombre"], ["lastName", "Apellido"], ["email", "Email"], ["phone", "Teléfono"]] as const).map(([key, label]) => (
            <label key={key} className="block">
              <span className="text-xs text-slate-500">{label}</span>
              <input
                value={contact[key]}
                onChange={(e) => setContact((c) => ({ ...c, [key]: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              />
            </label>
          ))}
          <p className="text-[11px] text-slate-400">Si dejas un campo vacío se usa un valor por defecto (teléfono ficticio para poder agendar).</p>
        </div>
      )}
    </aside>
  );
}

function TesterBubble({ m }: { m: TestMsg }) {
  if (m.role === "system") {
    return <div className="mx-auto max-w-[90%] rounded-lg bg-amber-50 px-3 py-1.5 text-center text-xs text-amber-700">{m.content}</div>;
  }
  const isUser = m.role === "user";
  const tools = m.meta?.toolEvents?.filter((t) => !["transferToAgent", "transferToHuman"].includes(t.name)) ?? [];
  const hasFooter = tools.length > 0 || (m.meta?.simulated?.length ?? 0) > 0 || !!m.meta?.usage;
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm", isUser ? "bg-brand-600 text-white" : "bg-slate-100 text-navy-900")}>
        <p className="whitespace-pre-wrap">{m.content}</p>
        {!isUser && hasFooter && (
          <div className="mt-2 space-y-1 border-t border-slate-200 pt-1.5 text-[11px] text-slate-500">
            {tools.map((t, i) => (
              <div key={`t${i}`}>🛠 {t.name}{t.isError ? " (error)" : ""}</div>
            ))}
            {m.meta?.simulated?.map((s, i) => (
              <div key={`s${i}`}>✓ {s.action}: {s.detail} <span className="opacity-60">(simulado)</span></div>
            ))}
            {m.meta?.usage && (
              <div className="opacity-70">
                {m.meta.usage.inputTokens + m.meta.usage.outputTokens} tok · US${m.meta.usage.costUsd.toFixed(5)}
                {m.meta.latencyMs ? ` · ${(m.meta.latencyMs / 1000).toFixed(1)}s` : ""}
              </div>
            )}
          </div>
        )}
      </div>
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
