"use client";
import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { padmin } from "@/lib/platform-api";
import { AGENT_HELP, AGENT_VARIABLES, AGENT_VARIABLE_KEYS, PROMPT_SNIPPETS, type SectionHelp } from "@/lib/agent-help";
import { AGENT_ACTIONS, ACTION_GROUPS, deriveTools, inferActions, type AgentActionDef } from "@/lib/agent-actions";
import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agent-templates";

/**
 * CONFIGURADOR COMPLETO de agentes IA en la consola de plataforma (super admin de Conversia).
 * Paridad funcional con el editor de TuBot (apps/web) pero con el design system "Nocturna".
 * SOLO clases/estilo Nocturna + vars CSS; nada de Tailwind. Todo vía `padmin` contra la API
 * de plataforma (espejo del controller de agentes del tenant, bajo /platform). orgId = [id].
 */

type ActionState = Record<string, { enabled: boolean; instructions: string }>;

interface VersionRow { version: number; status: string; changelog?: string | null; publishedAt: string | null; createdAt: string }
interface KnowledgeBase { id: string; name: string; description: string | null; publishedDocs: number }
interface Professional { id: string; name: string; specialty: string | null }
interface Channel { id: string; type: string; name: string; status: string; defaultAgentId?: string | null }

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
    config: Record<string, unknown>;
    tools: string[];
    status: string;
    version: number;
  } | null;
  versions: VersionRow[];
}

interface OrgAiInfo {
  availableModels: string[];
  ai: { model: string | null; maxTokens: number | null; maxToolRounds: number | null; platformDefaultModel: string };
  agents?: { id: string; name: string; model: string | null; effectiveModel: string }[];
}

const KINDS: [string, string][] = [
  ["orchestrator", "Recepcionista / Orquestador"],
  ["receptionist", "Recepcionista"],
  ["recepcion", "Recepcionista"],
  ["sales", "Ventas / Especialista"],
  ["ventas", "Ventas"],
  ["scheduler", "Agendamiento"],
  ["agendamiento", "Agendamiento"],
  ["follow_up", "Seguimiento"],
  ["support", "Soporte"],
  ["soporte", "Soporte"],
  ["router", "Derivador"],
  ["custom", "Personalizado"],
];

// Biblioteca curada de emojis para el avatar del agente (selector simple, Nocturna).
const EMOJIS = ["🤖", "💬", "📅", "🎯", "🛍️", "🛟", "🔀", "🧑‍💼", "💡", "✨", "🛒", "📞", "🦷", "❤️", "🚀", "☕", "⚡", "🔔"];
const DEFAULT_EMOJI = "🤖";

// Estilos compartidos (Nocturna).
const FIELD: React.CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };
const LABEL: React.CSSProperties = { fontSize: 12, color: "var(--ink-dim)", display: "block", marginBottom: 4 };
const CARD: React.CSSProperties = { padding: 18, marginBottom: 14 };

function Section({ id, title, subtitle, helpKey, onHelp, children }: { id?: string; title: string; subtitle?: string; helpKey?: string; onHelp?: (k: string) => void; children: React.ReactNode }) {
  return (
    <div id={id} className="card" style={{ ...CARD, scrollMarginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: subtitle ? 2 : 10 }}>
        <div>
          <h2 className="display" style={{ fontSize: 17, margin: 0 }}>{title}</h2>
          {subtitle ? <p className="text-dim" style={{ fontSize: 12, margin: "2px 0 0" }}>{subtitle}</p> : null}
        </div>
        {helpKey && onHelp ? (
          <button onClick={() => onHelp(helpKey)} className="text-accent" style={{ flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
            Aprende a escribir esto
          </button>
        ) : null}
      </div>
      {subtitle ? <div style={{ marginTop: 12 }}>{children}</div> : children}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      style={{
        position: "relative", width: 38, height: 22, flexShrink: 0, borderRadius: 999, border: "none", cursor: "pointer",
        background: checked ? "var(--acc)" : "var(--line)", transition: "background 0.15s",
      }}
    >
      <span style={{ position: "absolute", top: 3, left: checked ? 19 : 3, width: 16, height: 16, borderRadius: "50%", background: checked ? "var(--acc-ink)" : "var(--surface-solid)", transition: "left 0.15s" }} />
    </button>
  );
}

function ActionCard({ def, state, onToggle, onInstructions, mentionHint }: { def: AgentActionDef; state?: { enabled: boolean; instructions: string }; onToggle: (en: boolean) => void; onInstructions: (v: string) => void; mentionHint?: string }) {
  const enabled = state?.enabled ?? false;
  return (
    <div style={{ borderRadius: 12, border: `1px solid ${enabled ? "var(--acc)" : "var(--line)"}`, background: enabled ? "var(--acc-dim)" : "transparent", padding: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{def.label}</p>
          <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>{def.description}</p>
        </div>
        <Toggle checked={enabled} onChange={onToggle} />
      </div>
      {enabled ? (
        <div style={{ marginTop: 10 }}>
          <label className="text-dim" style={{ fontSize: 12 }}>¿Cuándo y cómo debe ejecutarse esta acción?</label>
          <textarea
            value={state?.instructions ?? ""}
            onChange={(e) => onInstructions(e.target.value)}
            rows={2}
            placeholder={def.placeholder}
            style={{ ...FIELD, marginTop: 4, resize: "vertical", minHeight: 52 }}
          />
          {mentionHint ? <p className="text-dim" style={{ fontSize: 11, margin: "4px 0 0" }}>{mentionHint}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

export default function AgentConfigurator({ params }: { params: Promise<{ id: string; agentId: string }> }) {
  const { id: orgId, agentId } = use(params);
  const router = useRouter();

  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [orgAi, setOrgAi] = useState<OrgAiInfo | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [professionals, setProfessionals] = useState<Professional[]>([]);
  const [assignableAgents, setAssignableAgents] = useState<{ id: string; name: string; slug: string }[]>([]);

  // Estado editable del formulario.
  const [emoji, setEmoji] = useState(DEFAULT_EMOJI);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("custom");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [model, setModel] = useState("");
  const [modelOverride, setModelOverride] = useState<string | null>(null); // override del super admin (POST .../model)
  const [maxTokens, setMaxTokens] = useState<string>("");
  const [maxToolRounds, setMaxToolRounds] = useState<string>("");
  const [language, setLanguage] = useState("es");
  const [actions, setActions] = useState<ActionState>({});
  const [extraTools, setExtraTools] = useState<string[]>([]);
  const [knowledgeSources, setKnowledgeSources] = useState<string[]>([]);
  const [schedulingProfs, setSchedulingProfs] = useState<string[]>([]);
  const [apptDuration, setApptDuration] = useState<string>("");
  // Config del paquete vertical que trajo el agente (se muestra primero en plantillas).
  const [packageTemplate, setPackageTemplate] = useState<{ systemPrompt?: string; label?: string } | null>(null);

  const [snapshot, setSnapshot] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [help, setHelp] = useState<SectionHelp | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    const [detail, ai, chans, kbs, profs, agents] = await Promise.all([
      padmin<AgentDetail>(`/platform/organizations/${orgId}/agents/${agentId}`),
      padmin<OrgAiInfo>(`/platform/organizations/${orgId}`).catch(() => null),
      padmin<{ connections: Channel[] }>(`/platform/organizations/${orgId}/channels`).then((x) => x.connections ?? []).catch(() => [] as Channel[]),
      padmin<KnowledgeBase[]>(`/platform/organizations/${orgId}/agents/meta/knowledge`).catch(() => [] as KnowledgeBase[]),
      padmin<{ resources: Professional[] }>(`/platform/organizations/${orgId}/agents/meta/professionals`).then((x) => x.resources ?? []).catch(() => [] as Professional[]),
      padmin<AgentRowLite[]>(`/platform/organizations/${orgId}/agents`).catch(() => [] as AgentRowLite[]),
    ]);

    setAgent(detail);
    setOrgAi(ai);
    setChannels(chans);
    setKnowledgeBases(kbs);
    setProfessionals(profs);
    setAssignableAgents(agents.filter((a) => a.id !== agentId).map((a) => ({ id: a.id, name: a.name, slug: a.slug })));

    setName(detail.name);
    setKind(detail.kind);
    setDescription(detail.description ?? "");

    const cfg = (detail.editing?.config ?? {}) as Record<string, any>;
    const nextEmoji = typeof cfg.emoji === "string" && cfg.emoji ? cfg.emoji : DEFAULT_EMOJI;
    const nextPrompt = detail.editing?.systemPrompt ?? "";
    const nextModel = typeof cfg.model === "string" ? cfg.model : "";
    const nextMaxTokens = typeof cfg.maxTokens === "number" ? String(cfg.maxTokens) : "";
    const nextRounds = typeof cfg.maxToolRounds === "number" ? String(cfg.maxToolRounds) : "";
    const nextLang = typeof cfg.language === "string" ? cfg.language : "es";
    const nextTools = (detail.editing?.tools as string[]) ?? [];
    const nextActions: ActionState = cfg.actions && typeof cfg.actions === "object" ? cfg.actions : inferActions(nextTools);
    const actionTools = new Set(AGENT_ACTIONS.flatMap((a) => a.tools));
    const nextExtra = nextTools.filter((t) => !actionTools.has(t) && t !== "searchKnowledgeBase");
    const nextKnowledge: string[] = Array.isArray(cfg.knowledgeSources) ? cfg.knowledgeSources : kbs.map((k) => k.id);
    const nextScheduling: string[] = Array.isArray(cfg.scheduling?.professionalIds) ? cfg.scheduling.professionalIds : [];
    const nextApptDuration: string = typeof cfg.scheduling?.appointmentDurationMin === "number" ? String(cfg.scheduling.appointmentDurationMin) : "";

    // Config del paquete vertical, si el agente la trae (se muestra primero en plantillas).
    const pkg = cfg.verticalTemplate ?? cfg.packageTemplate ?? null;
    setPackageTemplate(pkg && typeof pkg === "object" ? { systemPrompt: pkg.systemPrompt, label: pkg.label ?? pkg.name } : null);

    setEmoji(nextEmoji);
    setSystemPrompt(nextPrompt);
    setModel(nextModel);
    setMaxTokens(nextMaxTokens);
    setMaxToolRounds(nextRounds);
    setLanguage(nextLang);
    setActions(nextActions);
    setExtraTools(nextExtra);
    setKnowledgeSources(nextKnowledge);
    setSchedulingProfs(nextScheduling);
    setApptDuration(nextApptDuration);
    // Override de modelo del super admin: viene del detalle de la org (agents[].model override).
    const over = ai?.agents?.find((a) => a.id === agentId);
    setModelOverride(over?.model ?? null);

    setSnapshot(JSON.stringify({ emoji: nextEmoji, name: detail.name, kind: detail.kind, description: detail.description ?? "", systemPrompt: nextPrompt, model: nextModel, maxTokens: nextMaxTokens, maxToolRounds: nextRounds, language: nextLang, actions: nextActions, knowledgeSources: nextKnowledge, schedulingProfs: nextScheduling, apptDuration: nextApptDuration }));
  }, [orgId, agentId]);

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
  }, [load]);

  const current = JSON.stringify({ emoji, name, kind, description, systemPrompt, model, maxTokens, maxToolRounds, language, actions, knowledgeSources, schedulingProfs, apptDuration });
  const dirty = snapshot !== "" && current !== snapshot;

  // Aviso de cambios sin guardar al cerrar la pestaña/navegar fuera.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // Tools efectivas: las de las acciones + extras preservadas; si hay conocimiento activo, searchKnowledgeBase.
  const derivedTools = useMemo(() => {
    const base = deriveTools(actions, extraTools);
    if (knowledgeSources.length > 0 && !base.includes("searchKnowledgeBase")) base.push("searchKnowledgeBase");
    return base;
  }, [actions, extraTools, knowledgeSources]);

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

  // Inserta texto en la posición del cursor del textarea de instrucciones.
  function insertAtCursor(text: string) {
    const el = promptRef.current;
    if (!el) { setSystemPrompt((p) => (p.trim() ? `${p}${text}` : text)); return; }
    const start = el.selectionStart ?? systemPrompt.length;
    const end = el.selectionEnd ?? systemPrompt.length;
    const next = systemPrompt.slice(0, start) + text + systemPrompt.slice(end);
    setSystemPrompt(next);
    requestAnimationFrame(() => { el.focus(); const pos = start + text.length; el.selectionStart = el.selectionEnd = pos; });
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
    if (!description.trim()) setDescription(t.description);
    setShowTemplates(false);
    setMsg("Plantilla aplicada — revisa las instrucciones y guarda.");
  }

  async function saveDraft(): Promise<boolean> {
    setBusy(true); setError(null); setMsg(null);
    try {
      await padmin(`/platform/organizations/${orgId}/agents/${agentId}/draft`, {
        method: "PUT",
        body: JSON.stringify({
          name,
          kind,
          description: description || null,
          systemPrompt,
          config: {
            ...(model ? { model } : {}),
            ...(maxTokens && Number(maxTokens) > 0 ? { maxTokens: Number(maxTokens) } : {}),
            ...(maxToolRounds !== "" ? { maxToolRounds: Number(maxToolRounds) } : {}),
            language,
            emoji,
            actions,
            knowledgeSources,
            scheduling: { professionalIds: schedulingProfs, ...(apptDuration && Number(apptDuration) >= 5 ? { appointmentDurationMin: Number(apptDuration) } : {}) },
          },
          tools: derivedTools,
        }),
      });
      setMsg("Borrador guardado.");
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function publish() {
    if (!(await saveDraft())) return;
    setBusy(true); setError(null);
    try {
      const r = await padmin<{ publishedVersion: number }>(`/platform/organizations/${orgId}/agents/${agentId}/publish`, { method: "POST" });
      setMsg(`Versión ${r.publishedVersion} publicada — ya responde en producción.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function toggleActive() {
    if (!agent) return;
    try { await padmin(`/platform/organizations/${orgId}/agents/${agentId}/active`, { method: "POST", body: JSON.stringify({ active: !agent.active }) }); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function saveModelOverride(value: string) {
    try {
      await padmin(`/platform/organizations/${orgId}/agents/${agentId}/model`, { method: "POST", body: JSON.stringify({ model: value || null }) });
      setModelOverride(value || null);
      setMsg(value ? `Modelo forzado a ${value} para este agente.` : "Override de modelo quitado (usa el del tenant/plataforma).");
    } catch (e) { setError((e as Error).message); }
  }
  async function setChannelDefault(channelId: string, use: boolean) {
    try {
      await padmin(`/platform/organizations/${orgId}/channels/${channelId}/default-agent`, { method: "POST", body: JSON.stringify({ agentId: use ? agentId : null }) });
      const chans = await padmin<{ connections: Channel[] }>(`/platform/organizations/${orgId}/channels`).then((x) => x.connections ?? []).catch(() => [] as Channel[]);
      setChannels(chans);
    } catch (e) { setError((e as Error).message); }
  }
  async function removeAgent() {
    if (!confirm("¿Eliminar este agente? Las conversaciones históricas conservan su trazabilidad.")) return;
    try { await padmin(`/platform/organizations/${orgId}/agents/${agentId}`, { method: "DELETE" }); router.push(`/admin/organizations/${orgId}/agents`); }
    catch (e) { setError((e as Error).message); }
  }
  function goBack() {
    if (dirty && !confirm("Tienes cambios sin guardar. ¿Salir y descartarlos?")) return;
    router.push(`/admin/organizations/${orgId}/agents`);
  }

  function toggleKnowledge(kbId: string, on: boolean) {
    setKnowledgeSources((prev) => (on ? [...new Set([...prev, kbId])] : prev.filter((x) => x !== kbId)));
  }
  function toggleSchedulingProf(pId: string, on: boolean) {
    setSchedulingProfs((prev) => (on ? [...new Set([...prev, pId])] : prev.filter((x) => x !== pId)));
  }

  if (error && !agent) return <div style={{ maxWidth: 900 }}><a href={`/admin/organizations/${orgId}/agents`} className="text-dim" style={{ fontSize: 13, textDecoration: "none" }}>← Agentes</a><p style={{ color: "var(--danger)", marginTop: 12 }}>{error}</p></div>;
  if (!agent) return <p className="text-dim">Cargando configurador…</p>;

  const published = agent.publishedVersion != null;
  const availableModels = orgAi?.availableModels ?? [];
  const platformDefault = orgAi?.ai.platformDefaultModel ?? "";

  return (
    <div style={{ maxWidth: 1180 }}>
      {/* Encabezado */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
        <button onClick={goBack} className="text-dim" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13 }}>← Volver a la ficha</button>
        <span className="text-dim" style={{ fontSize: 13 }}>/ Agentes</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginBottom: 6 }}>
        <span aria-hidden style={{ width: 44, height: 44, display: "grid", placeItems: "center", borderRadius: 12, background: "var(--acc-dim)", fontSize: 22 }}>{emoji}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <h1 className="display" style={{ fontSize: 24, margin: 0 }}>{name || "Agente"}</h1>
            <span style={{ fontSize: 11, fontWeight: 600, color: published && agent.active ? "var(--ok)" : published ? "var(--ink-dim)" : "var(--warn)" }}>
              ● {published ? (agent.active ? "activo" : "inactivo") : "borrador"}
            </span>
            {dirty ? <span style={{ fontSize: 11, fontWeight: 600, color: "var(--warn)", background: "var(--acc-dim)", padding: "2px 8px", borderRadius: 999 }}>cambios sin guardar</span> : null}
          </div>
          <p className="text-dim" style={{ fontSize: 11, margin: "2px 0 0" }}>
            {published ? `v${agent.publishedVersion} en producción` : "nunca publicado"}
            {agent.draftVersion ? ` · borrador v${agent.draftVersion}` : ""} · {agent.slug}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={goBack} className="nav-item" style={{ width: "auto", height: 40, padding: "0 14px", border: "1px solid var(--line)", background: "transparent", cursor: "pointer", fontSize: 13 }}>Cancelar</button>
          <button onClick={() => void saveDraft()} disabled={busy} className="nav-item" style={{ width: "auto", height: 40, padding: "0 14px", border: "1px solid var(--line)", background: "transparent", cursor: "pointer", fontSize: 13, opacity: busy ? 0.6 : 1 }}>Guardar borrador</button>
          <button onClick={() => void publish()} disabled={busy} className="btn-accent" style={{ opacity: busy ? 0.6 : 1 }}>Publicar</button>
        </div>
      </div>

      {msg ? <p style={{ color: "var(--ok)", fontSize: 13, margin: "6px 0" }}>{msg}</p> : null}
      {error ? <p style={{ color: "var(--danger)", fontSize: 13, margin: "6px 0" }}>{error}</p> : null}

      {/* Dos columnas: formulario + probador */}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", marginTop: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Punto de partida: plantillas */}
          <div className="card" style={{ padding: 14, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", borderColor: "var(--acc)" }}>
            <p style={{ margin: 0, fontSize: 14 }}>¿Quieres un punto de partida? Aplica una <strong>plantilla</strong> y ajústala al negocio.</p>
            <button onClick={() => setShowTemplates(true)} className="nav-item" style={{ width: "auto", height: 36, padding: "0 14px", border: "1px solid var(--acc)", background: "transparent", color: "var(--acc-deep)", cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Ver plantillas</button>
          </div>

          {/* Identidad */}
          <Section title="Identidad">
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 220px" }}>
                <label style={LABEL}>Nombre</label>
                <input style={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Recepcionista" />
              </div>
              <div style={{ flex: "1 1 200px" }}>
                <label style={LABEL}>Tipo</label>
                <select style={FIELD} value={kind} onChange={(e) => setKind(e.target.value)}>
                  {KINDS.filter((k, i, arr) => arr.findIndex(([v]) => v === k[0]) === i).map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
                </select>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={LABEL}>Descripción interna (para tu equipo)</label>
              <input style={FIELD} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Para qué sirve este agente" />
            </div>
            <div style={{ marginTop: 12 }}>
              <label style={LABEL}>Avatar del agente</label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {EMOJIS.map((e) => {
                  const active = emoji === e;
                  return (
                    <button key={e} type="button" onClick={() => setEmoji(e)} aria-pressed={active} style={{ width: 38, height: 38, borderRadius: 10, fontSize: 19, cursor: "pointer", border: active ? "2px solid var(--acc)" : "1px solid var(--line)", background: active ? "var(--acc-dim)" : "var(--surface-solid)" }}>{e}</button>
                  );
                })}
              </div>
            </div>
          </Section>

          {/* Instrucciones (prompt del sistema) */}
          <Section title="Instrucciones" subtitle="El cerebro del agente: quién es, qué sabe, cómo habla y qué puede hacer." helpKey="instrucciones" onHelp={(k) => setHelp(AGENT_HELP[k])}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              <PromptTemplateMenu onPick={insertSnippet} packageTemplate={packageTemplate} />
              <span className="text-dim" style={{ fontSize: 12 }}>~{approxTokens.toLocaleString("es-CL")} tokens</span>
            </div>
            <textarea
              ref={promptRef}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={16}
              placeholder="Eres el asistente de {{organization.name}}…"
              style={{ ...FIELD, fontFamily: "ui-monospace, SFMono-Regular, monospace", fontSize: 13, lineHeight: 1.55, resize: "vertical" }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 8, fontSize: 11 }}>
              <span className="text-dim">Variables:</span>
              {AGENT_VARIABLES.map((v) => (
                <button key={v.key} onClick={() => insertAtCursor(`{{${v.key}}}`)} title={v.label} style={{ borderRadius: 6, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink-dim)", cursor: "pointer", padding: "2px 6px", fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                  {"{{"}{v.key}{"}}"}
                </button>
              ))}
            </div>
            {unknownVars.length > 0 ? (
              <p style={{ marginTop: 8, borderRadius: 8, background: "var(--acc-dim)", color: "var(--warn)", padding: "6px 10px", fontSize: 11 }}>
                Variables no reconocidas: {unknownVars.map((v) => `{{${v}}}`).join(", ")}. Se reemplazarán por vacío. Usa solo las de la lista.
              </p>
            ) : null}
          </Section>

          {/* Modelo e inteligencia */}
          <Section title="Modelo e inteligencia" subtitle="Modelo de IA, límite de tokens por respuesta, rondas de herramientas e idioma.">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12 }}>
              <div>
                <label style={LABEL}>Modelo (del borrador){platformDefault ? ` · default ${platformDefault}` : ""}</label>
                <select style={FIELD} value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">— por defecto del tenant —</option>
                  {availableModels.map((m) => (<option key={m} value={m}>{m}</option>))}
                </select>
              </div>
              <div>
                <label style={LABEL}>Máx. tokens por respuesta</label>
                <input style={FIELD} inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="1500" />
              </div>
              <div>
                <label style={LABEL}>Máx. rondas de herramientas</label>
                <input style={FIELD} inputMode="numeric" value={maxToolRounds} onChange={(e) => setMaxToolRounds(e.target.value)} placeholder="5" />
              </div>
              <div>
                <label style={LABEL}>Idioma</label>
                <select style={FIELD} value={language} onChange={(e) => setLanguage(e.target.value)}>
                  <option value="es">Español</option>
                  <option value="en">Inglés</option>
                  <option value="pt">Portugués</option>
                </select>
              </div>
            </div>
            {/* Override del super admin (fuera del borrador: se aplica al instante vía POST .../model) */}
            <div style={{ marginTop: 14, borderTop: "1px solid var(--hairline)", paddingTop: 14 }}>
              <label style={LABEL}>Override de modelo (super admin · fuerza el modelo de ESTE agente, ignora el del tenant)</label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select style={{ ...FIELD, flex: "1 1 220px" }} value={modelOverride ?? ""} onChange={(e) => void saveModelOverride(e.target.value)}>
                  <option value="">— sin override (usa el del tenant/plataforma) —</option>
                  {availableModels.map((m) => (<option key={m} value={m}>{m}</option>))}
                </select>
              </div>
              <p className="text-dim" style={{ fontSize: 11, margin: "6px 0 0" }}>Se guarda al instante (no depende del borrador). Útil para probar un modelo más potente en un solo agente.</p>
            </div>
          </Section>

          {/* Acciones */}
          <Section title="Acciones" subtitle="Qué puede hacer el agente. Activa una acción y explica en tus palabras cuándo y cómo usarla." helpKey="acciones" onHelp={(k) => setHelp(AGENT_HELP[k])}>
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              {ACTION_GROUPS.map((g) => {
                const items = AGENT_ACTIONS.filter((a) => a.group === g.key);
                if (items.length === 0) return null;
                return (
                  <div key={g.key} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div>
                      <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--ink-dim)" }}>{g.label}</p>
                      <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 11 }}>{g.description}</p>
                    </div>
                    {items.map((a) => (
                      <ActionCard
                        key={a.key}
                        def={a}
                        state={actions[a.key]}
                        onToggle={(en) => setAction(a.key, { enabled: en })}
                        onInstructions={(v) => setAction(a.key, { instructions: v })}
                        mentionHint={
                          a.key === "transfer"
                            ? `Deriva a otro agente de IA por su nombre o slug${assignableAgents.length ? ` (disponibles: ${assignableAgents.map((x) => "@" + x.name).join(", ")})` : ""}. Escríbelo con @ en las instrucciones.`
                            : a.key === "assign"
                              ? "Menciona al equipo, la persona o el agente de IA con @ en las instrucciones (p. ej. @Ventas)."
                              : undefined
                        }
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          </Section>

          {/* Agendamiento */}
          <Section title="Agendamiento: con quién agenda" subtitle="Limita los profesionales/recursos con los que ESTE agente puede agendar (p. ej. la campaña de implantes solo con quienes los hacen). Vacío = todos.">
            {professionals.length === 0 ? (
              <p className="text-dim" style={{ fontSize: 13 }}>Aún no hay profesionales/recursos. Configura el equipo en la Agenda del tenant (entra como soporte desde la ficha → Configurar agenda).</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <p className="text-dim" style={{ fontSize: 12, margin: 0 }}>{schedulingProfs.length === 0 ? "Puede agendar con TODOS los profesionales." : `Habilitados: ${schedulingProfs.length} de ${professionals.length}.`}</p>
                  {schedulingProfs.length > 0 ? <button onClick={() => setSchedulingProfs([])} className="text-accent" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 12 }}>Permitir todos</button> : null}
                </div>
                {professionals.map((p) => {
                  const on = schedulingProfs.includes(p.id);
                  return (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderRadius: 10, border: `1px solid ${on ? "var(--acc)" : "var(--line)"}`, background: on ? "var(--acc-dim)" : "transparent", padding: 12 }}>
                      <div>
                        <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{p.name}</p>
                        {p.specialty ? <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>{p.specialty}</p> : null}
                      </div>
                      <Toggle checked={on} onChange={(v) => toggleSchedulingProf(p.id, v)} />
                    </div>
                  );
                })}
                <div style={{ borderRadius: 10, border: "1px solid var(--line)", padding: 12 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Duración de la cita</p>
                  <p className="text-dim" style={{ margin: "2px 0 8px", fontSize: 12 }}>Cuánto dura cada cita que agenda ESTE agente. Vacío = usar la duración del bloque de la agenda.</p>
                  <select style={{ ...FIELD, maxWidth: 260 }} value={apptDuration} onChange={(e) => setApptDuration(e.target.value)} aria-label="Duración de la cita en minutos">
                    <option value="">Según el bloque de la agenda</option>
                    <option value="15">15 minutos</option>
                    <option value="20">20 minutos</option>
                    <option value="30">30 minutos</option>
                    <option value="45">45 minutos</option>
                    <option value="60">60 minutos</option>
                  </select>
                </div>
              </div>
            )}
          </Section>

          {/* Fuentes de conocimiento */}
          <Section title="Fuentes de conocimiento" subtitle="Qué bases de conocimiento puede consultar este agente para responder dudas." helpKey="knowledge" onHelp={(k) => setHelp(AGENT_HELP[k])}>
            {knowledgeBases.length === 0 ? (
              <p className="text-dim" style={{ fontSize: 13 }}>Aún no hay bases de conocimiento cargadas para este tenant.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {knowledgeBases.map((kb) => {
                  const on = knowledgeSources.includes(kb.id);
                  return (
                    <div key={kb.id} style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, borderRadius: 10, border: `1px solid ${on ? "var(--acc)" : "var(--line)"}`, background: on ? "var(--acc-dim)" : "transparent", padding: 12 }}>
                      <div>
                        <p style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{kb.name}</p>
                        <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>{kb.description || "Sin descripción"} · {kb.publishedDocs} doc{kb.publishedDocs === 1 ? "" : "s"} publicado{kb.publishedDocs === 1 ? "" : "s"}</p>
                      </div>
                      <Toggle checked={on} onChange={(v) => toggleKnowledge(kb.id, v)} />
                    </div>
                  );
                })}
                {knowledgeSources.length === 0 ? <p style={{ fontSize: 11, color: "var(--warn)" }}>Ninguna fuente activa: el agente no consultará la base de conocimiento.</p> : null}
              </div>
            )}
          </Section>

          {/* Avanzado: canales por defecto, estado, eliminar */}
          <div className="card" style={{ marginBottom: 14 }}>
            <button onClick={() => setShowAdvanced((v) => !v)} style={{ display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between", padding: 16, background: "transparent", border: "none", cursor: "pointer", color: "var(--ink)" }}>
              <span className="display" style={{ fontSize: 16 }}>Configuración avanzada</span>
              <span className="text-dim">{showAdvanced ? "−" : "+"}</span>
            </button>
            {showAdvanced ? (
              <div style={{ borderTop: "1px solid var(--hairline)", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 600, color: "var(--ink-dim)" }}>Canales que atiende por defecto</p>
                  {channels.length === 0 ? <p className="text-dim" style={{ fontSize: 12 }}>Sin canales conectados.</p> : null}
                  {channels.map((c) => (
                    <label key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontSize: 14 }}>
                      <input type="checkbox" checked={c.defaultAgentId === agentId} onChange={(e) => void setChannelDefault(c.id, e.target.checked)} />
                      {c.name} <span className="text-dim" style={{ fontSize: 11 }}>({c.type})</span>
                    </label>
                  ))}
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: "1px solid var(--hairline)", paddingTop: 14 }}>
                  <button onClick={() => void toggleActive()} className="nav-item" style={{ width: "auto", height: 38, padding: "0 14px", border: "1px solid var(--line)", background: "transparent", cursor: "pointer", fontSize: 13 }}>{agent.active ? "Desactivar agente" : "Activar agente"}</button>
                  <button onClick={() => void removeAgent()} style={{ border: "none", background: "transparent", color: "var(--danger)", cursor: "pointer", fontSize: 13 }}>Eliminar agente</button>
                </div>
              </div>
            ) : null}
          </div>

          {/* Historial de versiones */}
          <Section title="Historial de versiones" subtitle="Cada publicación crea una versión. La última publicada es la que responde en producción.">
            {agent.versions.length === 0 ? (
              <p className="text-dim" style={{ fontSize: 13 }}>Aún no hay versiones. Publica para crear la primera.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
                {agent.versions.map((v) => (
                  <div key={v.version} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px solid var(--hairline)", fontSize: 13 }}>
                    <span style={{ fontWeight: 600, minWidth: 44 }}>v{v.version}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: v.status === "published" ? "var(--ok)" : "var(--ink-dim)" }}>{v.status === "published" ? "publicada" : v.status === "draft" ? "borrador" : v.status}</span>
                    <span className="text-dim" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{v.changelog || "—"}</span>
                    <span className="text-dim" style={{ fontSize: 11 }}>{new Date(v.publishedAt ?? v.createdAt).toLocaleDateString("es-CL", { day: "2-digit", month: "short", year: "numeric" })}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>

        {/* Probador en vivo */}
        <AgentTester
          orgId={orgId}
          agentId={agentId}
          systemPrompt={systemPrompt}
          model={model || modelOverride || platformDefault}
          maxTokens={maxTokens && Number(maxTokens) > 0 ? Number(maxTokens) : 1500}
          maxToolRounds={maxToolRounds !== "" ? Number(maxToolRounds) : 5}
          actions={actions}
          tools={derivedTools}
          knowledgeSources={knowledgeSources}
          schedulingProfs={schedulingProfs}
          apptDurationMin={apptDuration && Number(apptDuration) >= 5 ? Number(apptDuration) : null}
        />
      </div>

      {/* Modal de ayuda por sección */}
      {help ? <HelpModal help={help} onClose={() => setHelp(null)} /> : null}

      {/* Galería de plantillas */}
      {showTemplates ? (
        <TemplatesModal packageTemplate={packageTemplate} onApply={applyTemplate} onApplyPackage={(sp) => { setSystemPrompt(sp); setShowTemplates(false); setMsg("Prompt del paquete vertical aplicado — ajústalo y guarda."); }} onClose={() => setShowTemplates(false)} />
      ) : null}
    </div>
  );
}

type AgentRowLite = { id: string; name: string; slug: string };

// ---------------------------------------------------------------------------
// Biblioteca de plantillas de prompt (menú desplegable: paquete vertical primero,
// luego snippets genéricos del sistema). Inserta en las instrucciones.
// ---------------------------------------------------------------------------
function PromptTemplateMenu({ onPick, packageTemplate }: { onPick: (text: string) => void; packageTemplate: { systemPrompt?: string; label?: string } | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button onClick={() => setOpen((v) => !v)} className="nav-item" style={{ width: "auto", height: 34, padding: "0 12px", border: "1px solid var(--line)", background: "transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Plantillas de prompt ▾</button>
      {open ? (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 10 }} onClick={() => setOpen(false)} />
          <div className="card" style={{ position: "absolute", left: 0, top: 40, zIndex: 20, width: 280, maxHeight: 340, overflowY: "auto", padding: 6 }}>
            {packageTemplate?.systemPrompt ? (
              <>
                <p style={{ padding: "6px 8px 2px", margin: 0, fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: "var(--acc-deep)" }}>Paquete del rubro</p>
                <button onClick={() => { onPick(packageTemplate.systemPrompt!); setOpen(false); }} style={{ display: "block", width: "100%", textAlign: "left", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", padding: "8px 10px", fontSize: 13, color: "var(--ink)" }} title={packageTemplate.systemPrompt.slice(0, 200)}>
                  {packageTemplate.label || "Prompt del paquete vertical"}
                </button>
                <div style={{ borderTop: "1px solid var(--hairline)", margin: "4px 0" }} />
              </>
            ) : null}
            <p style={{ padding: "4px 8px 2px", margin: 0, fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: "var(--ink-dim)" }}>Genéricas del sistema</p>
            {PROMPT_SNIPPETS.map((sn) => (
              <button key={sn.label} onClick={() => { onPick(sn.text); setOpen(false); }} style={{ display: "block", width: "100%", textAlign: "left", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", padding: "8px 10px", fontSize: 13, color: "var(--ink)" }} title={sn.text.slice(0, 200)}>
                {sn.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Probador en vivo. Envía el estado ACTUAL del formulario a POST .../test
// (lecturas reales, escrituras simuladas). Igual que AgentTester de TuBot.
// ---------------------------------------------------------------------------
type TestMeta = { simulated?: { action: string; detail: string }[]; toolEvents?: { name: string; isError: boolean }[]; usage?: { inputTokens: number; outputTokens: number; costUsd: number }; latencyMs?: number };
type TestMsg = { role: "user" | "assistant" | "system"; content: string; meta?: TestMeta };
type TestResponse = {
  ok: boolean; blocked?: boolean; error?: string; reply?: string | null;
  toolEvents?: { name: string; input: unknown; output: string; isError: boolean }[];
  simulated?: { action: string; detail: string }[];
  contact?: { firstName: string | null; lastName: string | null; email: string | null; phone: string | null };
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  latencyMs?: number; stopReason?: string;
  transfer?: { slug: string; name: string; reply: string | null; toolEvents?: { name: string; input: unknown; output: string; isError: boolean }[] } | null;
  humanHandoff?: boolean;
};

function AgentTester({ orgId, agentId, systemPrompt, model, maxTokens, maxToolRounds, actions, tools, knowledgeSources, schedulingProfs, apptDurationMin }: {
  orgId: string; agentId: string; systemPrompt: string; model: string; maxTokens: number; maxToolRounds: number;
  actions: ActionState; tools: string[]; knowledgeSources: string[]; schedulingProfs: string[]; apptDurationMin: number | null;
}) {
  const [tab, setTab] = useState<"chat" | "contact">("chat");
  const [messages, setMessages] = useState<TestMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [contact, setContact] = useState({ firstName: "", lastName: "", email: "", phone: "" });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [messages, loading]);

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
        config: { model, maxTokens, maxToolRounds, scheduling: { professionalIds: schedulingProfs, ...(apptDurationMin ? { appointmentDurationMin: apptDurationMin } : {}) } },
        tools,
        actions,
        knowledgeSources,
        messages: nextMsgs.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })),
        contact: { firstName: contact.firstName || null, lastName: contact.lastName || null, email: contact.email || null, phone: contact.phone || null },
      };
      const r = await padmin<TestResponse>(`/platform/organizations/${orgId}/agents/${agentId}/test`, { method: "POST", body: JSON.stringify(payload) });
      if (!r.ok) {
        setMessages((m) => [...m, { role: "system", content: r.error ?? "No se pudo completar la prueba" }]);
        return;
      }
      if (r.contact) setContact({ firstName: r.contact.firstName ?? "", lastName: r.contact.lastName ?? "", email: r.contact.email ?? "", phone: r.contact.phone ?? "" });
      const extras: TestMsg[] = [];
      if (r.humanHandoff) extras.push({ role: "system", content: "El agente escaló a un humano — en producción dejaría de responder." });
      if (r.transfer) {
        extras.push({ role: "system", content: `Derivado a «${r.transfer.name}» — responde ahora:` });
        extras.push({ role: "assistant", content: r.transfer.reply || "(el agente destino no devolvió texto en este turno)", meta: { toolEvents: r.transfer.toolEvents } });
      }
      setMessages((m) => [
        ...m,
        { role: "assistant", content: r.reply || "(el agente no devolvió texto en este turno)", meta: { simulated: r.simulated, toolEvents: r.toolEvents, usage: r.usage, latencyMs: r.latencyMs } },
        ...extras,
      ]);
    } catch (e) {
      setMessages((m) => [...m, { role: "system", content: (e as Error).message }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <aside className="card" style={{ width: 380, flexShrink: 0, display: "flex", flexDirection: "column", maxHeight: "calc(100dvh - 120px)", position: "sticky", top: 16, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid var(--hairline)" }}>
        <div>
          <h2 className="display" style={{ fontSize: 16, margin: 0 }}>Probar agente</h2>
          <p className="text-dim" style={{ fontSize: 11, margin: "2px 0 0" }}>Lee datos reales · simula acciones · no envía nada.</p>
        </div>
        {messages.length > 0 ? <button onClick={() => setMessages([])} className="text-dim" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 12 }}>Reiniciar</button> : null}
      </div>

      <div style={{ display: "flex", gap: 4, padding: "8px 8px 0" }}>
        {(["chat", "contact"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} style={{ borderRadius: "8px 8px 0 0", border: "none", cursor: "pointer", padding: "6px 12px", fontSize: 13, background: tab === t ? "var(--acc-dim)" : "transparent", color: tab === t ? "var(--acc-deep)" : "var(--ink-dim)", fontWeight: tab === t ? 600 : 400 }}>
            {t === "chat" ? "Chat" : "Campos del contacto"}
          </button>
        ))}
      </div>

      {tab === "chat" ? (
        <>
          <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 10, minHeight: 240 }}>
            {messages.length === 0 ? <p className="text-dim" style={{ textAlign: "center", fontSize: 13, marginTop: 28 }}>Escribe un mensaje como si fueras el cliente para probar el comportamiento del agente.</p> : null}
            {messages.map((m, i) => (<TesterBubble key={i} m={m} />))}
            {loading ? <p className="text-dim" style={{ fontSize: 12 }}>El agente está pensando…</p> : null}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); void send(); }} style={{ borderTop: "1px solid var(--hairline)", padding: 10 }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
                rows={1}
                placeholder="Escribe como el cliente…"
                style={{ ...FIELD, flex: 1, maxHeight: 96, resize: "none" }}
              />
              <button type="submit" disabled={loading || !input.trim()} className="btn-accent" style={{ opacity: loading || !input.trim() ? 0.6 : 1 }}>Enviar</button>
            </div>
          </form>
        </>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <p className="text-dim" style={{ fontSize: 12, margin: 0 }}>Datos del contacto simulado. El agente los lee y puede actualizarlos durante la prueba.</p>
          {([["firstName", "Nombre"], ["lastName", "Apellido"], ["email", "Email"], ["phone", "Teléfono"]] as const).map(([key, lbl]) => (
            <div key={key}>
              <label style={LABEL}>{lbl}</label>
              <input style={FIELD} value={contact[key]} onChange={(e) => setContact((c) => ({ ...c, [key]: e.target.value }))} />
            </div>
          ))}
          <p className="text-dim" style={{ fontSize: 11, margin: 0 }}>Si dejas un campo vacío se usa un valor por defecto (teléfono ficticio para poder agendar).</p>
        </div>
      )}
    </aside>
  );
}

function TesterBubble({ m }: { m: TestMsg }) {
  if (m.role === "system") {
    return <div style={{ margin: "0 auto", maxWidth: "90%", borderRadius: 10, background: "var(--acc-dim)", color: "var(--warn)", padding: "6px 12px", textAlign: "center", fontSize: 12 }}>{m.content}</div>;
  }
  const isUser = m.role === "user";
  const tools = m.meta?.toolEvents?.filter((t) => !["transferToAgent", "transferToHuman"].includes(t.name)) ?? [];
  const hasFooter = tools.length > 0 || (m.meta?.simulated?.length ?? 0) > 0;
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
      <div style={{ maxWidth: "85%", borderRadius: 16, padding: "8px 12px", fontSize: 13, background: isUser ? "var(--acc)" : "var(--surface-solid)", color: isUser ? "var(--acc-ink)" : "var(--ink)", border: isUser ? "none" : "1px solid var(--hairline)" }}>
        <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{m.content}</p>
        {!isUser && hasFooter ? (
          <div style={{ marginTop: 8, borderTop: "1px solid var(--hairline)", paddingTop: 6, display: "flex", flexDirection: "column", gap: 3, fontSize: 11, color: "var(--ink-dim)" }}>
            {tools.map((t, i) => (<div key={`t${i}`}>🛠 {t.name}{t.isError ? " (error)" : ""}</div>))}
            {m.meta?.simulated?.map((s, i) => (<div key={`s${i}`}>✓ {s.action}: {s.detail} <span style={{ opacity: 0.6 }}>(simulado)</span></div>))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function HelpModal({ help, onClose }: { help: SectionHelp; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 640, padding: 24, maxHeight: "90dvh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h2 className="display" style={{ fontSize: 19, margin: 0 }}>{help.title}</h2>
          <button onClick={onClose} className="text-dim" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12, fontSize: 14 }}>
          <p style={{ margin: 0 }}>{help.intro}</p>
          <ul style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 4 }}>
            {help.points.map((p, i) => (<li key={i}>{p}</li>))}
          </ul>
          {help.examples ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
              <div style={{ borderRadius: 10, border: "1px solid var(--ok)", padding: 12 }}>
                <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 700, color: "var(--ok)" }}>✓ Buen ejemplo</p>
                <p style={{ margin: 0, fontSize: 12 }}>{help.examples.good}</p>
              </div>
              <div style={{ borderRadius: 10, border: "1px solid var(--danger)", padding: 12 }}>
                <p style={{ margin: "0 0 4px", fontSize: 12, fontWeight: 700, color: "var(--danger)" }}>✗ Evita esto</p>
                <p style={{ margin: 0, fontSize: 12 }}>{help.examples.bad}</p>
              </div>
            </div>
          ) : null}
          {help.showVariables ? (
            <div>
              <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 600, color: "var(--ink-dim)" }}>Variables disponibles</p>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 6 }}>
                {AGENT_VARIABLES.map((v) => (
                  <div key={v.key} style={{ borderRadius: 8, background: "var(--surface-solid)", border: "1px solid var(--hairline)", padding: "6px 8px", fontSize: 12 }}>
                    <span style={{ fontFamily: "ui-monospace, monospace" }}>{"{{"}{v.key}{"}}"}</span> <span className="text-dim">— {v.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TemplatesModal({ packageTemplate, onApply, onApplyPackage, onClose }: { packageTemplate: { systemPrompt?: string; label?: string } | null; onApply: (t: AgentTemplate) => void; onApplyPackage: (sp: string) => void; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 720, padding: 24, maxHeight: "90dvh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <h2 className="display" style={{ fontSize: 19, margin: 0 }}>Plantillas de agente</h2>
          <button onClick={onClose} className="text-dim" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>
        <p className="text-dim" style={{ fontSize: 13, margin: "0 0 14px" }}>Aplica una plantilla como punto de partida. Reemplaza las instrucciones y las acciones actuales; luego ajústalas al negocio.</p>

        {packageTemplate?.systemPrompt ? (
          <div className="card" style={{ padding: 16, marginBottom: 14, borderColor: "var(--acc)" }}>
            <p style={{ margin: 0, fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--acc-deep)" }}>Del paquete del rubro</p>
            <p style={{ margin: "4px 0 10px", fontWeight: 600 }}>{packageTemplate.label || "Prompt del paquete vertical instalado"}</p>
            <button onClick={() => onApplyPackage(packageTemplate.systemPrompt!)} className="btn-accent">Usar el prompt del rubro</button>
          </div>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
          {AGENT_TEMPLATES.map((t) => (
            <div key={t.key} className="card" style={{ padding: 16, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 22 }}>{t.emoji}</span>
                <p style={{ margin: 0, fontWeight: 600 }}>{t.name}</p>
              </div>
              <p className="text-dim" style={{ margin: "6px 0 0", fontSize: 13, flex: 1 }}>{t.description}</p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4, margin: "8px 0" }}>
                {Object.entries(t.actions).filter(([, a]) => a.enabled).map(([k]) => (
                  <span key={k} style={{ borderRadius: 6, background: "var(--surface-solid)", border: "1px solid var(--hairline)", padding: "2px 6px", fontSize: 10, color: "var(--ink-dim)" }}>
                    {AGENT_ACTIONS.find((a) => a.key === k)?.label ?? k}
                  </span>
                ))}
              </div>
              <button onClick={() => onApply(t)} className="btn-accent" style={{ marginTop: "auto" }}>Usar esta plantilla</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
