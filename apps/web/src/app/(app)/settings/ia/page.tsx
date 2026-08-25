"use client";

/** Ajustes de IA: modelo/tope solo lectura + transcripción, idioma y biblioteca de prompts por agente. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Checkbox, ConfirmDialog, IconButton, Modal, Select, Skeleton, cn, useToast } from "@/components/ui";

interface IaSettings {
  managed: { model: string; maxTokens: number; maxToolRounds: number; dailyTokenBudget: number };
  transcription: boolean;
  vision: boolean;
  assistantLanguage: string;
}
interface PromptTpl {
  id: string;
  name: string;
  body: string;
  type: string;
  agentIds: string[];
}
interface AgentOpt {
  id: string;
  name: string;
}

const TYPES: [string, string][] = [
  ["instructions", "Instrucciones"],
  ["indications", "Indicaciones"],
  ["tone", "Tono"],
  ["policy", "Política"],
  ["script", "Guion"],
];
const typeLabel = (t: string) => TYPES.find(([k]) => k === t)?.[1] ?? t;

export default function IaSettingsPage() {
  const toast = useToast();
  const [data, setData] = useState<IaSettings | null>(null);
  const [templates, setTemplates] = useState<PromptTpl[]>([]);
  const [agents, setAgents] = useState<AgentOpt[]>([]);
  const [typeFilter, setTypeFilter] = useState("all");
  const [agentFilter, setAgentFilter] = useState("all");
  const [editing, setEditing] = useState<PromptTpl | null>(null);
  const [creating, setCreating] = useState<Partial<PromptTpl> | null>(null);
  const [deleting, setDeleting] = useState<PromptTpl | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void api<IaSettings>("/settings/ia").then(setData).catch(() => setData(null));
    void api<PromptTpl[]>("/settings/prompt-templates").then((r) => setTemplates(r.map((t) => ({ ...t, agentIds: Array.isArray(t.agentIds) ? t.agentIds : [] })))).catch(() => setTemplates([]));
    void api<AgentOpt[]>("/agents/assignable").then(setAgents).catch(() => setAgents([]));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(
    () =>
      templates.filter(
        (t) =>
          (typeFilter === "all" || t.type === typeFilter) &&
          (agentFilter === "all" || t.agentIds.length === 0 || t.agentIds.includes(agentFilter)),
      ),
    [templates, typeFilter, agentFilter],
  );

  async function saveToggles(patch: { transcription?: boolean; vision?: boolean; assistantLanguage?: string }) {
    setBusy(true);
    try {
      await api("/settings/ia", { method: "PUT", body: JSON.stringify(patch) });
      toast.push("Ajustes guardados ✔", "ok");
      load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="mx-auto max-w-3xl p-6"><Skeleton className="h-72" /></div>;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h2 className="text-lg font-semibold">Ajustes de IA</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Los agentes se crean en{" "}
        <a href="/agents" className="inline-flex items-center gap-0.5 text-brand-700 underline dark:text-brand-300">Agentes IA <ExternalLink size={10} /></a>.
      </p>

      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <p className="text-sm font-medium">Modelo y límites</p>
        <p className="text-xs text-ink-subtle">Administrado por TuBot según tu plan.</p>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <div><dt className="text-[10px] uppercase text-ink-subtle">Modelo</dt><dd className="font-mono text-xs">{data.managed.model}</dd></div>
          <div><dt className="text-[10px] uppercase text-ink-subtle">Máx. tokens/resp.</dt><dd>{data.managed.maxTokens}</dd></div>
          <div><dt className="text-[10px] uppercase text-ink-subtle">Rondas de tools</dt><dd>{data.managed.maxToolRounds}</dd></div>
          <div><dt className="text-[10px] uppercase text-ink-subtle">Tope diario tokens</dt><dd>{data.managed.dailyTokenBudget.toLocaleString("es-CL")}</dd></div>
        </dl>
      </div>

      <div className="mt-4 space-y-3 rounded-card border border-line bg-panel p-5 shadow-card">
        <label className="flex items-center justify-between text-sm">
          <span>
            <span className="font-medium">Transcripción de notas de voz</span>
            <span className="block text-xs text-ink-subtle">Convierte los audios entrantes a texto (Bandeja + agentes).</span>
          </span>
          <Checkbox checked={data.transcription} disabled={busy} onChange={(e) => void saveToggles({ transcription: e.target.checked })} />
        </label>
        <label className="flex items-center justify-between border-t border-line pt-3 text-sm">
          <span>
            <span className="font-medium">Análisis de imágenes (visión)</span>
            <span className="block text-xs text-ink-subtle">El agente "ve" las imágenes que envía el contacto y responde según su contenido.</span>
          </span>
          <Checkbox checked={data.vision} disabled={busy} onChange={(e) => void saveToggles({ vision: e.target.checked })} />
        </label>
        <label className="flex items-center justify-between border-t border-line pt-3 text-sm">
          <span>
            <span className="font-medium">Idioma del asistente del compositor</span>
            <span className="block text-xs text-ink-subtle">Sugerir/mejorar/traducir/resumir responden en este idioma.</span>
          </span>
          <Select value={data.assistantLanguage} disabled={busy} onChange={(e) => void saveToggles({ assistantLanguage: e.target.value })}>
            <option value="es">Español</option>
            <option value="en">Inglés</option>
            <option value="pt">Portugués</option>
          </Select>
        </label>
      </div>

      {/* ---------------- Biblioteca de plantillas de prompt ---------------- */}
      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Biblioteca de plantillas de prompt</p>
          <Button onClick={() => setCreating({ type: "instructions", agentIds: [] })}><Plus size={14} /> Nueva plantilla</Button>
        </div>
        <p className="mt-1 text-xs text-ink-muted">
          Textos reutilizables que aparecen en el menú «Plantillas de prompt» del editor de agentes, según el agente al
          que las asignes. Buen uso: 🎙 <b>Tono</b> «Trato cercano, de tú, sin tecnicismos dentales»; 📋 <b>Política</b>{" "}
          «Nunca prometas resultados clínicos ni des diagnósticos»; 🎯 <b>Guion</b> «Si preguntan por implantes: valor
          referencial + ofrecer evaluación gratuita».
        </p>

        <div className="mt-3 flex gap-2">
          <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="text-xs">
            <option value="all">Todos los tipos</option>
            {TYPES.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
          </Select>
          <Select value={agentFilter} onChange={(e) => setAgentFilter(e.target.value)} className="text-xs">
            <option value="all">Todos los agentes</option>
            {agents.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
          </Select>
        </div>

        <ul className="mt-3 space-y-1.5">
          {filtered.length === 0 && (
            <p className="rounded-lg border border-dashed border-line p-4 text-center text-xs text-ink-subtle">
              {templates.length === 0 ? "Aún no hay plantillas — crea la primera." : "Nada calza con los filtros."}
            </p>
          )}
          {filtered.map((t) => (
            <li key={t.id} className="rounded-lg border border-line p-2.5">
              <div className="flex items-center gap-2">
                <span className="rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">{typeLabel(t.type)}</span>
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{t.name}</p>
                <span className="shrink-0 text-[10px] text-ink-subtle">
                  {t.agentIds.length === 0 ? "Todos los agentes" : `${t.agentIds.length} agente(s)`}
                </span>
                <IconButton label="Editar" onClick={() => setEditing(t)}><Pencil size={13} /></IconButton>
                <IconButton label="Duplicar" onClick={() => setCreating({ name: `${t.name} (copia)`, body: t.body, type: t.type, agentIds: t.agentIds })}><Copy size={13} /></IconButton>
                <IconButton label="Eliminar" destructive onClick={() => setDeleting(t)}><Trash2 size={13} /></IconButton>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-ink-muted">{t.body}</p>
            </li>
          ))}
        </ul>
      </div>

      {(editing || creating) && (
        <TemplateEditor
          tpl={editing}
          initial={creating ?? undefined}
          agents={agents}
          onClose={() => { setEditing(null); setCreating(null); }}
          onSaved={() => { setEditing(null); setCreating(null); load(); }}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          void api(`/settings/prompt-templates/${deleting.id}`, { method: "DELETE" })
            .then(() => { toast.push("Plantilla eliminada", "info"); setDeleting(null); load(); })
            .catch((err) => toast.push((err as Error).message, "error"));
        }}
        title={`¿Eliminar «${deleting?.name}»?`}
        description={
          deleting?.agentIds.length === 0
            ? "Está disponible para TODOS los agentes — dejará de aparecer en sus menús de plantillas."
            : `Está asignada a ${deleting?.agentIds.length} agente(s) — dejará de aparecer en sus menús de plantillas.`
        }
        confirmLabel="Eliminar"
        danger
      />
    </div>
  );
}

function TemplateEditor({
  tpl,
  initial,
  agents,
  onClose,
  onSaved,
}: {
  tpl: PromptTpl | null;
  initial?: Partial<PromptTpl>;
  agents: AgentOpt[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(tpl?.name ?? initial?.name ?? "");
  const [type, setType] = useState(tpl?.type ?? initial?.type ?? "instructions");
  const [body, setBody] = useState(tpl?.body ?? initial?.body ?? "");
  const [agentIds, setAgentIds] = useState<string[]>(tpl?.agentIds ?? initial?.agentIds ?? []);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const payload = { name: name.trim(), type, body: body.trim(), agentIds };
      if (tpl) await api(`/settings/prompt-templates/${tpl.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await api("/settings/prompt-templates", { method: "POST", body: JSON.stringify(payload) });
      toast.push(tpl ? "Plantilla actualizada" : "Plantilla creada", "ok");
      onSaved();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={tpl ? `Editar «${tpl.name}»` : "Nueva plantilla de prompt"} wide>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Nombre</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="p. ej. Tono cercano de la clínica" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Tipo</span>
          <Select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 w-full">
            {TYPES.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
          </Select>
        </label>
      </div>

      <label className="mt-3 block text-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-muted">Contenido</span>
          <span className="text-[10px] text-ink-subtle">{body.length}/8000</span>
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value.slice(0, 8000))} rows={6} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
      </label>

      <div className="mt-3">
        <p className="text-xs text-ink-muted">Disponible para</p>
        <div className="mt-1 flex flex-wrap gap-2">
          <label className={cn("flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", agentIds.length === 0 ? "border-brand-400 bg-brand-50 text-brand-800 dark:bg-brand-500/10 dark:text-brand-300" : "border-line text-ink-muted")}>
            <input type="checkbox" checked={agentIds.length === 0} onChange={() => setAgentIds([])} className="hidden" />
            🤖 Todos los agentes
          </label>
          {agents.map((a) => {
            const on = agentIds.includes(a.id);
            return (
              <label key={a.id} className={cn("flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs", on ? "border-brand-400 bg-brand-50 text-brand-800 dark:bg-brand-500/10 dark:text-brand-300" : "border-line text-ink-muted")}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setAgentIds(on ? agentIds.filter((x) => x !== a.id) : [...agentIds, a.id])}
                  className="hidden"
                />
                {a.name}
              </label>
            );
          })}
        </div>
      </div>

      {body.trim() && (
        <div className="mt-3 rounded-lg border border-line bg-app p-3">
          <p className="text-[10px] font-medium uppercase text-ink-subtle">Vista previa</p>
          <p className="mt-1 whitespace-pre-wrap font-mono text-xs text-ink-muted">{body.slice(0, 600)}{body.length > 600 ? "…" : ""}</p>
        </div>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button onClick={() => void save()} disabled={busy || name.trim().length < 2 || body.trim().length < 5}>
          {tpl ? "Guardar cambios" : "Crear plantilla"}
        </Button>
      </div>
    </Modal>
  );
}
