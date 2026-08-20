"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Button, Modal, StatusBadge, cn, useToast } from "@/components/ui";
import { AGENT_HELP, AGENT_VARIABLES, AGENT_VARIABLE_KEYS, PROMPT_SNIPPETS, type SectionHelp } from "@/lib/agent-help";
import { AGENT_ACTIONS, ACTION_GROUPS, deriveTools, inferActions, type AgentActionDef } from "@/lib/agent-actions";
import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agent-templates";

type ActionState = Record<string, { enabled: boolean; instructions: string }>;
interface Mention { label: string; type: "equipo" | "usuario" | "agente" }
interface KnowledgeBase { id: string; name: string; description: string | null; publishedDocs: number }

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
    <div className="mb-4 rounded-xl border border-line bg-panel p-4">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-ink">{title}</h2>
          {subtitle && <p className="text-xs text-ink-subtle">{subtitle}</p>}
        </div>
        {helpKey && onHelp && (
          <button onClick={() => onHelp(helpKey)} className="shrink-0 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
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
      <span className={cn("absolute top-0.5 h-4 w-4 rounded-full bg-panel transition-all", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

function ActionCard({ def, state, onToggle, onInstructions, mentions }: { def: AgentActionDef; state?: { enabled: boolean; instructions: string }; onToggle: (en: boolean) => void; onInstructions: (v: string) => void; mentions?: Mention[] }) {
  const enabled = state?.enabled ?? false;
  return (
    <div className={cn("rounded-lg border p-3", enabled ? "border-brand-300 bg-brand-50/40 dark:border-brand-500/40" : "border-line")}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">{def.label}</p>
          <p className="text-xs text-ink-muted">{def.description}</p>
        </div>
        <Toggle checked={enabled} onChange={onToggle} />
      </div>
      {enabled && (
        <div className="mt-2">
          <label className="text-xs text-ink-muted">¿Cuándo y cómo debe ejecutarse esta acción?</label>
          {mentions ? (
            <MentionTextarea value={state?.instructions ?? ""} onChange={onInstructions} placeholder={def.placeholder} mentions={mentions} />
          ) : (
            <textarea value={state?.instructions ?? ""} onChange={(e) => onInstructions(e.target.value)} rows={2} placeholder={def.placeholder} className="mt-1 w-full rounded-lg border border-line-strong px-2 py-1.5 text-sm" />
          )}
        </div>
      )}
    </div>
  );
}

// Etiqueta legible + estilo del badge por tipo de mención. El agente de IA se distingue
// claramente ("IA") para asegurar que la derivación va a ESE agente, no a una persona.
const MENTION_BADGE: Record<Mention["type"], { label: string; className: string }> = {
  agente: { label: "IA", className: "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300" },
  usuario: { label: "persona", className: "bg-app text-ink-subtle" },
  equipo: { label: "equipo", className: "bg-app text-ink-subtle" },
};

// Disparador del @: acepta letras con acento, números, espacios, guiones y guion bajo
// (antes solo \w\s → un nombre con "ó" cortaba el menú a mitad de tipeo).
const MENTION_RE = /@([\p{L}\p{N}\s_-]{0,30})$/u;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Textarea con menciones @ "vivas": al elegir de la lista, la mención queda marcada en AZUL
 * (como un hipervínculo) y se comporta como una sola unidad — un Backspace/Suprimir la borra
 * COMPLETA, no letra por letra. Técnica de overlay: un backdrop resalta las menciones conocidas
 * detrás del textarea (texto transparente, cursor visible), alineado 1:1 con el mismo layout.
 */
function MentionTextarea({ value, onChange, placeholder, mentions }: { value: string; onChange: (v: string) => void; placeholder?: string; mentions: Mention[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState<string | null>(null);

  // Alternancia de menciones conocidas (más largas primero para no cortar una dentro de otra).
  const labelAlt = useMemo(
    () => mentions.map((m) => m.label).filter(Boolean).sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"),
    [mentions],
  );

  function handle(v: string) {
    onChange(v);
    const pos = ref.current?.selectionStart ?? v.length;
    const m = v.slice(0, pos).match(MENTION_RE);
    setQuery(m ? m[1] : null);
  }
  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const filtered = query != null ? mentions.filter((mm) => norm(mm.label).includes(norm(query))).slice(0, 8) : [];
  function pick(label: string) {
    const pos = ref.current?.selectionStart ?? value.length;
    const before = value.slice(0, pos).replace(MENTION_RE, `@${label} `);
    onChange(before + value.slice(pos));
    setQuery(null);
    requestAnimationFrame(() => ref.current?.focus());
  }

  // Borrado ATÓMICO de la mención (Backspace hacia atrás, Suprimir hacia adelante).
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const el = ref.current;
    if (!el || !labelAlt || el.selectionStart !== el.selectionEnd) return;
    const pos = el.selectionStart;
    if (e.key === "Backspace") {
      const m = value.slice(0, pos).match(new RegExp(`@(?:${labelAlt})[ ]?$`, "u"));
      if (m) {
        e.preventDefault();
        const start = pos - m[0].length;
        onChange(value.slice(0, start) + value.slice(pos));
        requestAnimationFrame(() => { if (ref.current) ref.current.selectionStart = ref.current.selectionEnd = start; });
      }
    } else if (e.key === "Delete") {
      const m = value.slice(pos).match(new RegExp(`^[ ]?@(?:${labelAlt})`, "u"));
      if (m) {
        e.preventDefault();
        onChange(value.slice(0, pos) + value.slice(pos + m[0].length));
        requestAnimationFrame(() => { if (ref.current) ref.current.selectionStart = ref.current.selectionEnd = pos; });
      }
    }
  }

  // Backdrop: mismo texto que el textarea, con las menciones conocidas en azul.
  const nodes = useMemo(() => {
    if (!labelAlt) return [value] as React.ReactNode[];
    const re = new RegExp(`@(?:${labelAlt})`, "gu");
    const out: React.ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value))) {
      if (m.index > last) out.push(value.slice(last, m.index));
      out.push(
        <span key={m.index} className="rounded bg-brand-50 text-brand-600 underline decoration-brand-400/60 dark:bg-brand-500/15 dark:text-brand-300">{m[0]}</span>,
      );
      last = m.index + m[0].length;
    }
    out.push(value.slice(last));
    return out;
  }, [value, labelAlt]);

  const empty = query != null && filtered.length === 0;
  // Mismo box-model en backdrop y textarea para que el resaltado quede alineado 1:1.
  const BOX = "w-full rounded-lg border border-line-strong px-2 py-1.5 text-sm leading-5";

  return (
    <div className="relative mt-1">
      <div ref={backdropRef} aria-hidden className={cn(BOX, "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-ink")}>
        {nodes}
        {"​"}
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => handle(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={() => { if (backdropRef.current && ref.current) backdropRef.current.scrollTop = ref.current.scrollTop; }}
        rows={2}
        placeholder={placeholder}
        spellCheck={false}
        // Inline (beats the unlayered `textarea{color/background}` in globals.css): texto y fondo
        // transparentes para que se vea SOLO el backdrop resaltado; el cursor queda visible.
        style={{ color: "transparent", backgroundColor: "transparent", caretColor: "var(--ink)" }}
        className={cn(BOX, "relative resize-none")}
      />
      {query != null && (filtered.length > 0 || empty) && (
        <div className="absolute z-20 mt-1 w-64 rounded-lg border border-line bg-panel p-1 shadow-pop">
          {filtered.map((mm) => {
            const badge = MENTION_BADGE[mm.type];
            return (
              <button key={`${mm.type}-${mm.label}`} type="button" onMouseDown={(e) => { e.preventDefault(); pick(mm.label); }} className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-app">
                <span className="truncate">{mm.label}</span>
                <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", badge.className)}>{badge.label}</span>
              </button>
            );
          })}
          {empty && <p className="px-2 py-1.5 text-xs text-ink-subtle">Sin coincidencias</p>}
        </div>
      )}
      <p className="mt-1 text-[10px] text-ink-subtle">Escribe @, elige de la lista y la mención queda marcada; al borrar se elimina completa.</p>
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
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [knowledgeSources, setKnowledgeSources] = useState<string[]>([]);

  const [snapshot, setSnapshot] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState<SectionHelp | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  const load = useCallback(async () => {
    const [detail, chans, users, teams, agents, kbs] = await Promise.all([
      api<AgentDetail>(`/agents/${id}`),
      api<Channel[]>("/organizations/me/channels").catch(() => []),
      api<{ userId: string; name: string }[]>("/users/assignable").catch(() => []),
      api<{ id: string; name: string }[]>("/users/teams").catch(() => []),
      api<{ id: string; name: string }[]>("/agents/assignable").catch(() => []),
      api<KnowledgeBase[]>("/agents/meta/knowledge").catch(() => []),
    ]);
    setAgent(detail);
    setChannels(chans);
    setKnowledgeBases(kbs);
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
    // Fuentes de conocimiento: selección explícita del agente o, si es antiguo, todas.
    const nextKnowledge: string[] = Array.isArray(cfg.knowledgeSources) ? cfg.knowledgeSources : kbs.map((k) => k.id);
    setEmoji(nextEmoji);
    setSystemPrompt(nextPrompt);
    setModel(nextModel);
    setMaxTokens(nextMaxTokens);
    setMaxToolRounds(nextRounds);
    setActions(nextActions);
    setExtraTools(nextExtra);
    setKnowledgeSources(nextKnowledge);
    setSnapshot(
      JSON.stringify({ emoji: nextEmoji, name: detail.name, kind: detail.kind, description: detail.description ?? "", systemPrompt: nextPrompt, model: nextModel, maxTokens: nextMaxTokens, maxToolRounds: nextRounds, actions: nextActions, knowledgeSources: nextKnowledge }),
    );
  }, [id]);

  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const current = JSON.stringify({ emoji, name, kind, description, systemPrompt, model, maxTokens, maxToolRounds, actions, knowledgeSources });
  const dirty = snapshot !== "" && current !== snapshot;

  function toggleKnowledge(kbId: string, on: boolean) {
    setKnowledgeSources((prev) => (on ? [...new Set([...prev, kbId])] : prev.filter((x) => x !== kbId)));
  }

  // Tools efectivas: las de las acciones + extras preservadas; si hay al menos
  // una fuente de conocimiento activa, el agente necesita poder buscarla.
  const derivedTools = useMemo(() => {
    const base = deriveTools(actions, extraTools);
    if (knowledgeSources.length > 0 && !base.includes("searchKnowledgeBase")) base.push("searchKnowledgeBase");
    return base;
  }, [actions, extraTools, knowledgeSources]);

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
  function applyTemplate(t: AgentTemplate) {
    setEmoji(t.emoji);
    setKind(t.kind);
    setSystemPrompt(t.systemPrompt);
    setActions(t.actions);
    setExtraTools([]);
    if (t.model) setModel(t.model);
    if (!name.trim()) setName(t.name);
    if (!description.trim()) {
      setDescription(t.description);
      setShowDescription(true);
    }
    setShowTemplates(false);
    toast.push("Plantilla aplicada — revisa las instrucciones y guarda", "ok");
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
          config: { model, maxTokens, maxToolRounds, language: "es", emoji, actions, knowledgeSources },
          tools: derivedTools,
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

  if (!agent) return <div className="p-6 text-ink-subtle">Cargando…</div>;
  const published = agent.publishedVersion != null;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-panel px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="text-2xl">{emoji}</span>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-ink">{name || "Agente"}</h1>
              <StatusBadge kind={published && agent.active ? "connected" : "beta"} label={published ? (agent.active ? "activo" : "inactivo") : "borrador"} />
              {dirty && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">cambios sin guardar</span>}
            </div>
            <p className="text-[11px] text-ink-subtle">
              {published ? `v${agent.publishedVersion} en producción` : "nunca publicado"}
              {agent.draftVersion ? ` · borrador v${agent.draftVersion}` : ""} · {agent.slug}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={cancel} className="rounded-lg border border-line-strong px-3 py-2 text-sm hover:bg-app">Cancelar</button>
          <Button variant="secondary" disabled={busy} onClick={() => void saveDraft()}>Guardar borrador</Button>
          <Button disabled={busy} onClick={() => void publish()}>Publicar</Button>
        </div>
      </header>

      {/* Dos columnas */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Izquierda: formulario */}
        <div className="min-w-0 flex-1 overflow-y-auto bg-app p-5">
          <div className="mx-auto max-w-2xl">
            {/* Punto de partida: plantillas */}
            <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-brand-200 bg-brand-50/50 p-3 dark:border-brand-500/30">
              <p className="text-sm text-ink">
                ¿Quieres un punto de partida? Aplica una <span className="font-medium">plantilla</span> y ajústala a tu negocio.
              </p>
              <button
                onClick={() => setShowTemplates(true)}
                className="shrink-0 rounded-lg border border-brand-300 bg-panel px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:border-brand-500/40"
              >
                Ver plantillas
              </button>
            </div>

            {/* Configuración */}
            <Section title="Configuración">
              <div className="flex gap-3">
                <div>
                  <label className="text-xs text-ink-muted">Ícono</label>
                  <input value={emoji} onChange={(e) => setEmoji(e.target.value.slice(0, 2))} className="mt-1 h-11 w-14 rounded-lg border border-line-strong text-center text-xl" />
                </div>
                <label className="flex-1 text-sm">
                  <span className="text-xs text-ink-muted">Nombre</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Recepcionista" className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2.5" />
                </label>
                <label className="text-sm">
                  <span className="text-xs text-ink-muted">Tipo</span>
                  <select value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 block rounded-lg border border-line-strong bg-panel px-3 py-2.5 text-sm">
                    {KINDS.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
                  </select>
                </label>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {QUICK_EMOJIS.map((e) => (
                  <button key={e} onClick={() => setEmoji(e)} className={cn("rounded-lg border px-2 py-1 text-lg", emoji === e ? "border-brand-400 bg-brand-50 dark:bg-brand-500/10" : "border-line hover:bg-app")}>{e}</button>
                ))}
              </div>
              {!showDescription ? (
                <button onClick={() => setShowDescription(true)} className="mt-3 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">+ Mostrar descripción</button>
              ) : (
                <label className="mt-3 block text-sm">
                  <span className="text-xs text-ink-muted">Descripción interna (para tu equipo)</span>
                  <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para qué sirve este agente" className="mt-1 block w-full rounded-lg border border-line-strong px-3 py-2" />
                </label>
              )}
            </Section>

            {/* Instrucciones */}
            <Section title="Instrucciones" subtitle="El cerebro del agente: quién es, qué sabe, cómo habla y qué puede hacer." helpKey="instrucciones" onHelp={(k) => setHelp(AGENT_HELP[k])}>
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <PromptTemplateMenu onPick={insertSnippet} agentId={id} />
                <span className="text-xs text-ink-subtle">~{approxTokens.toLocaleString("es-CL")} tokens</span>
              </div>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={16}
                placeholder="Eres el asistente de {{organization.name}}…"
                className="w-full rounded-lg border border-line-strong px-3 py-2 font-mono text-[13px] leading-relaxed"
              />
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-ink-subtle">Variables:</span>
                {AGENT_VARIABLES.map((v) => (
                  <button key={v.key} onClick={() => setSystemPrompt((p) => `${p}{{${v.key}}}`)} title={v.label} className="rounded bg-app px-1.5 py-0.5 font-mono text-ink-muted hover:bg-line">
                    {"{{"}{v.key}{"}}"}
                  </button>
                ))}
              </div>
              {unknownVars.length > 0 && (
                <p className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                  Variables no reconocidas: {unknownVars.map((v) => `{{${v}}}`).join(", ")}. Se reemplazarán por vacío. Usa solo las de la lista.
                </p>
              )}
            </Section>

            {/* Acciones */}
            <Section title="Acciones" subtitle="Qué puede hacer el agente. Activa una acción y explica en tus palabras cuándo y cómo usarla." helpKey="acciones" onHelp={(k) => setHelp(AGENT_HELP[k])}>
              <div className="space-y-5">
                {ACTION_GROUPS.map((g) => {
                  const items = AGENT_ACTIONS.filter((a) => a.group === g.key);
                  if (items.length === 0) return null;
                  return (
                    <div key={g.key} className="space-y-2">
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{g.label}</p>
                        <p className="text-[11px] text-ink-subtle">{g.description}</p>
                      </div>
                      {items.map((a) => (
                        <ActionCard
                          key={a.key}
                          def={a}
                          state={actions[a.key]}
                          onToggle={(en) => setAction(a.key, { enabled: en })}
                          onInstructions={(v) => setAction(a.key, { instructions: v })}
                          mentions={
                            a.mentions
                              ? a.key === "transfer"
                                ? mentions.filter((m) => m.type === "agente") // derivar SOLO a otros agentes de IA
                                : mentions // asignar/escalar: personas, equipos Y agentes (assignConversation también deriva a agentes)
                              : undefined
                          }
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            </Section>

            {/* Fuentes de conocimiento — Fase 5 */}
            <Section title="Fuentes de conocimiento" subtitle="Qué bases de conocimiento puede consultar este agente para responder dudas." helpKey="knowledge" onHelp={(k) => setHelp(AGENT_HELP[k])}>
              {knowledgeBases.length === 0 ? (
                <p className="text-sm text-ink-subtle">Aún no hay bases de conocimiento cargadas para esta organización.</p>
              ) : (
                <div className="space-y-2">
                  {knowledgeBases.map((kb) => {
                    const on = knowledgeSources.includes(kb.id);
                    return (
                      <div key={kb.id} className={cn("flex items-start justify-between gap-3 rounded-lg border p-3", on ? "border-brand-300 bg-brand-50/40 dark:border-brand-500/40" : "border-line")}>
                        <div>
                          <p className="text-sm font-medium text-ink">{kb.name}</p>
                          <p className="text-xs text-ink-muted">
                            {kb.description || "Sin descripción"} · {kb.publishedDocs} doc{kb.publishedDocs === 1 ? "" : "s"} publicado{kb.publishedDocs === 1 ? "" : "s"}
                          </p>
                        </div>
                        <Toggle checked={on} onChange={(v) => toggleKnowledge(kb.id, v)} />
                      </div>
                    );
                  })}
                  {knowledgeSources.length === 0 && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">Ninguna fuente activa: el agente no consultará la base de conocimiento.</p>
                  )}
                </div>
              )}
            </Section>

            {/* Avanzado */}
            <div className="rounded-xl border border-line bg-panel">
              <button onClick={() => setShowAdvanced((v) => !v)} className="flex w-full items-center justify-between p-4 text-left">
                <span className="font-semibold text-ink">Configuración avanzada</span>
                <span className="text-ink-subtle">{showAdvanced ? "−" : "+"}</span>
              </button>
              {showAdvanced && (
                <div className="space-y-4 border-t border-line p-4">
                  <div className="rounded-lg bg-app p-3 text-xs text-ink-muted">
                    El modelo de IA y sus límites (tokens por respuesta y rondas de herramientas) los administra tu proveedor para toda tu plataforma. No se configuran por agente.
                  </div>
                  <div>
                    <p className="mb-1 text-xs font-medium text-ink-muted">Canales que atiende por defecto</p>
                    {channels.length === 0 && <p className="text-xs text-ink-subtle">Sin canales configurados.</p>}
                    {channels.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 py-0.5 text-sm">
                        <input type="checkbox" checked={c.defaultAgentId === agent.id} onChange={(e) => void setChannelDefault(c.id, e.target.checked)} />
                        {c.name} <span className="text-[10px] text-ink-subtle">({c.type})</span>
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center justify-between border-t border-line pt-3">
                    <button onClick={() => void toggleActive()} className="rounded-lg border border-line-strong px-3 py-1.5 text-sm hover:bg-app">{agent.active ? "Desactivar agente" : "Activar agente"}</button>
                    <button onClick={() => void removeAgent()} className="text-sm text-red-600 hover:underline dark:text-red-400">Eliminar agente</button>
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
          tools={derivedTools}
          knowledgeSources={knowledgeSources}
        />
      </div>

      {/* Modal de ayuda por sección */}
      <Modal open={!!help} onClose={() => setHelp(null)} title={help?.title} wide>
        {help && <HelpContent help={help} />}
      </Modal>

      {/* Galería de plantillas */}
      <Modal open={showTemplates} onClose={() => setShowTemplates(false)} title="Plantillas de agente" wide>
        <p className="mb-3 text-sm text-ink-muted">
          Aplica una plantilla como punto de partida. Reemplaza las instrucciones y las acciones actuales; luego ajústalas a tu negocio.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {AGENT_TEMPLATES.map((t) => (
            <div key={t.key} className="flex flex-col rounded-xl border border-line p-4">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{t.emoji}</span>
                <p className="font-semibold text-ink">{t.name}</p>
              </div>
              <p className="mt-1 flex-1 text-sm text-ink-muted">{t.description}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {Object.entries(t.actions)
                  .filter(([, a]) => a.enabled)
                  .map(([k]) => (
                    <span key={k} className="rounded bg-app px-1.5 py-0.5 text-[10px] text-ink-muted">
                      {AGENT_ACTIONS.find((a) => a.key === k)?.label ?? k}
                    </span>
                  ))}
              </div>
              <button
                onClick={() => applyTemplate(t)}
                className="mt-3 rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700"
              >
                Usar esta plantilla
              </button>
            </div>
          ))}
        </div>
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
  transfer?: { slug: string; name: string; reply: string | null; toolEvents?: { name: string; input: unknown; output: string; isError: boolean }[] } | null;
  humanHandoff?: boolean;
};

function AgentTester({ id, systemPrompt, model, maxTokens, maxToolRounds, actions, tools, knowledgeSources }: {
  id: string;
  systemPrompt: string;
  model: string;
  maxTokens: number;
  maxToolRounds: number;
  actions: ActionState;
  tools: string[];
  knowledgeSources: string[];
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
        knowledgeSources,
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
      if (r.transfer) {
        // Igual que en producción: el agente destino responde en el mismo turno.
        extras.push({ role: "system", content: `Derivado a «${r.transfer.name}» — responde ahora:` });
        extras.push({
          role: "assistant",
          content: r.transfer.reply || "(el agente destino no devolvió texto en este turno)",
          meta: { toolEvents: r.transfer.toolEvents },
        });
      }
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
    <aside className="hidden w-96 shrink-0 flex-col border-l border-line bg-panel lg:flex">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <div>
          <h2 className="font-semibold text-ink">Probar Agente IA</h2>
          <p className="text-[11px] text-ink-subtle">Lee datos reales · simula acciones · no envía nada.</p>
        </div>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])} className="text-xs text-ink-subtle hover:text-ink-muted">Reiniciar</button>
        )}
      </div>
      <div className="flex gap-1 border-b border-line px-2 pt-2">
        {(["chat", "contact"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "rounded-t-lg px-3 py-1.5 text-sm",
              tab === t ? "bg-app font-medium text-ink" : "text-ink-muted hover:text-ink",
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
              <p className="mt-8 text-center text-sm text-ink-subtle">
                Escribe un mensaje como si fueras el cliente para probar el comportamiento del agente.
              </p>
            )}
            {messages.map((m, i) => (
              <TesterBubble key={i} m={m} />
            ))}
            {loading && <p className="text-xs text-ink-subtle">El agente está pensando…</p>}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="border-t border-line p-2">
            <div className="flex items-end gap-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                rows={1}
                placeholder="Escribe como el cliente…"
                className="max-h-24 flex-1 resize-none rounded-lg border border-line-strong px-3 py-2 text-sm"
              />
              <Button type="submit" disabled={loading || !input.trim()}>Enviar</Button>
            </div>
          </form>
        </>
      ) : (
        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <p className="text-xs text-ink-muted">Datos del contacto simulado. El agente los lee y puede actualizarlos durante la prueba.</p>
          {([["firstName", "Nombre"], ["lastName", "Apellido"], ["email", "Email"], ["phone", "Teléfono"]] as const).map(([key, label]) => (
            <label key={key} className="block">
              <span className="text-xs text-ink-muted">{label}</span>
              <input
                value={contact[key]}
                onChange={(e) => setContact((c) => ({ ...c, [key]: e.target.value }))}
                className="mt-1 w-full rounded-lg border border-line-strong px-2 py-1.5 text-sm"
              />
            </label>
          ))}
          <p className="text-[11px] text-ink-subtle">Si dejas un campo vacío se usa un valor por defecto (teléfono ficticio para poder agendar).</p>
        </div>
      )}
    </aside>
  );
}

function TesterBubble({ m }: { m: TestMsg }) {
  if (m.role === "system") {
    return <div className="mx-auto max-w-[90%] rounded-lg bg-amber-50 px-3 py-1.5 text-center text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{m.content}</div>;
  }
  const isUser = m.role === "user";
  const tools = m.meta?.toolEvents?.filter((t) => !["transferToAgent", "transferToHuman"].includes(t.name)) ?? [];
  const hasFooter = tools.length > 0 || (m.meta?.simulated?.length ?? 0) > 0 || !!m.meta?.usage;
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[85%] rounded-2xl px-3 py-2 text-sm", isUser ? "bg-brand-600 text-white" : "bg-app text-ink")}>
        <p className="whitespace-pre-wrap">{m.content}</p>
        {!isUser && hasFooter && (
          <div className="mt-2 space-y-1 border-t border-line pt-1.5 text-[11px] text-ink-muted">
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

const TENANT_TPL_TYPES: Record<string, string> = {
  instructions: "Instrucciones",
  indications: "Indicaciones",
  tone: "Tono",
  policy: "Política",
  script: "Guion",
};

function PromptTemplateMenu({ onPick, agentId }: { onPick: (text: string) => void; agentId?: string }) {
  const [open, setOpen] = useState(false);
  const [tenantTpls, setTenantTpls] = useState<{ id: string; name: string; body: string; type: string }[]>([]);

  useEffect(() => {
    if (!open) return;
    // Plantillas del tenant asignadas a ESTE agente ([] = todos) — Configuración → IA
    const qs = agentId ? `?agentId=${agentId}` : "";
    void api<{ id: string; name: string; body: string; type: string }[]>(`/settings/prompt-templates${qs}`)
      .then(setTenantTpls)
      .catch(() => setTenantTpls([]));
  }, [open, agentId]);

  const byType = tenantTpls.reduce<Record<string, typeof tenantTpls>>((acc, t) => {
    (acc[t.type] = acc[t.type] ?? []).push(t);
    return acc;
  }, {});

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="rounded-lg border border-line-strong px-2.5 py-1.5 text-xs font-medium hover:bg-app">
        Plantillas de prompt ▾
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border border-line bg-panel p-1 shadow-pop">
            {Object.entries(byType).map(([type, tpls]) => (
              <div key={type}>
                <p className="px-2 pt-1.5 text-[9px] font-semibold uppercase text-cyan-600 dark:text-cyan-400">{TENANT_TPL_TYPES[type] ?? type} · tu biblioteca</p>
                {tpls.map((t) => (
                  <button key={t.id} onClick={() => { onPick(t.body); setOpen(false); }} className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-cyan-50" title={t.body.slice(0, 200)}>
                    {t.name}
                  </button>
                ))}
              </div>
            ))}
            {tenantTpls.length > 0 && <div className="my-1 border-t border-line" />}
            <p className="px-2 pt-1 text-[9px] font-semibold uppercase text-ink-subtle">Genéricas del sistema</p>
            {PROMPT_SNIPPETS.map((sn) => (
              <button key={sn.label} onClick={() => { onPick(sn.text); setOpen(false); }} className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-app">
                {sn.label}
              </button>
            ))}
            <a href="/settings/ia" className="mt-1 block border-t border-line px-2 py-1.5 text-[11px] text-cyan-700 underline dark:text-cyan-300">
              Administrar mi biblioteca ↗
            </a>
          </div>
        </>
      )}
    </div>
  );
}

function HelpContent({ help }: { help: SectionHelp }) {
  return (
    <div className="space-y-3 text-sm text-ink">
      <p>{help.intro}</p>
      <ul className="list-disc space-y-1 pl-5">
        {help.points.map((p, i) => (<li key={i}>{p}</li>))}
      </ul>
      {help.examples && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 dark:bg-emerald-500/10 dark:border-emerald-500/30">
            <p className="mb-1 text-xs font-semibold text-emerald-800 dark:text-emerald-300">✓ Buen ejemplo</p>
            <p className="text-xs text-emerald-900 dark:text-emerald-200">{help.examples.good}</p>
          </div>
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:bg-red-500/10 dark:border-red-500/30">
            <p className="mb-1 text-xs font-semibold text-red-800 dark:text-red-300">✗ Evita esto</p>
            <p className="text-xs text-red-900 dark:text-red-200">{help.examples.bad}</p>
          </div>
        </div>
      )}
      {help.showVariables && (
        <div>
          <p className="mb-1 text-xs font-semibold text-ink-muted">Variables disponibles</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {AGENT_VARIABLES.map((v) => (
              <div key={v.key} className="rounded bg-app px-2 py-1 text-xs">
                <span className="font-mono text-ink">{"{{"}{v.key}{"}}"}</span> <span className="text-ink-subtle">— {v.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
