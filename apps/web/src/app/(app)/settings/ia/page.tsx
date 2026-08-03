"use client";

/** Ajustes de IA del tenant: modelo/tope solo lectura + transcripción, idioma y biblioteca de prompts. */
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Skeleton, useToast } from "@/components/ui";

interface IaSettings {
  managed: { model: string; maxTokens: number; maxToolRounds: number; dailyTokenBudget: number };
  transcription: boolean;
  assistantLanguage: string;
}
interface PromptTpl {
  id: string;
  name: string;
  body: string;
}

export default function IaSettingsPage() {
  const toast = useToast();
  const [data, setData] = useState<IaSettings | null>(null);
  const [templates, setTemplates] = useState<PromptTpl[]>([]);
  const [tplName, setTplName] = useState("");
  const [tplBody, setTplBody] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    void api<IaSettings>("/settings/ia").then(setData).catch(() => setData(null));
    void api<PromptTpl[]>("/settings/prompt-templates").then(setTemplates).catch(() => setTemplates([]));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: { transcription?: boolean; assistantLanguage?: string }) {
    setBusy(true);
    try {
      await api("/settings/ia", { method: "PUT", body: JSON.stringify(patch) });
      toast.push("Ajustes guardados ✔", "ok");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function addTemplate() {
    try {
      await api("/settings/prompt-templates", { method: "POST", body: JSON.stringify({ name: tplName.trim(), body: tplBody.trim() }) });
      setTplName("");
      setTplBody("");
      toast.push("Plantilla guardada en tu biblioteca", "ok");
      await load();
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }

  if (!data) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-72" /></div>;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Ajustes de IA</h2>
      <p className="mt-1 text-xs text-slate-500">
        Configuración de IA del espacio. Los agentes se crean y editan en{" "}
        <a href="/agents" className="inline-flex items-center gap-0.5 text-cyan-700 underline">Agentes IA <ExternalLink size={10} /></a>.
      </p>

      <div className="mt-4 rounded-card border border-slate-200 bg-white p-5 shadow-card">
        <p className="text-sm font-medium">Modelo y límites</p>
        <p className="text-xs text-slate-400">Administrado por TuBot según tu plan.</p>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
          <div><dt className="text-[10px] uppercase text-slate-400">Modelo</dt><dd className="font-mono text-xs">{data.managed.model}</dd></div>
          <div><dt className="text-[10px] uppercase text-slate-400">Máx. tokens/resp.</dt><dd>{data.managed.maxTokens}</dd></div>
          <div><dt className="text-[10px] uppercase text-slate-400">Rondas de tools</dt><dd>{data.managed.maxToolRounds}</dd></div>
          <div><dt className="text-[10px] uppercase text-slate-400">Tope diario tokens</dt><dd>{data.managed.dailyTokenBudget.toLocaleString("es-CL")}</dd></div>
        </dl>
      </div>

      <div className="mt-4 space-y-3 rounded-card border border-slate-200 bg-white p-5 shadow-card">
        <label className="flex items-center justify-between text-sm">
          <span>
            <span className="font-medium">Transcripción de notas de voz</span>
            <span className="block text-xs text-slate-400">Convierte los audios entrantes a texto (visible en la Bandeja y usable por los agentes).</span>
          </span>
          <input type="checkbox" checked={data.transcription} disabled={busy} onChange={(e) => void save({ transcription: e.target.checked })} />
        </label>
        <label className="flex items-center justify-between border-t border-slate-100 pt-3 text-sm">
          <span>
            <span className="font-medium">Idioma del asistente del compositor</span>
            <span className="block text-xs text-slate-400">Sugerir/mejorar/traducir/resumir responden en este idioma.</span>
          </span>
          <select
            value={data.assistantLanguage}
            disabled={busy}
            onChange={(e) => void save({ assistantLanguage: e.target.value })}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="es">Español</option>
            <option value="en">Inglés</option>
            <option value="pt">Portugués</option>
          </select>
        </label>
      </div>

      <div className="mt-4 rounded-card border border-slate-200 bg-white p-5 shadow-card">
        <p className="text-sm font-medium">Biblioteca de plantillas de prompt</p>
        <p className="text-xs text-slate-400">
          Textos reutilizables para tus agentes (tono de la clínica, políticas, guiones). Cópialas al editor de agentes
          cuando las necesites.
        </p>
        <div className="mt-2 space-y-2">
          <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="Nombre (p. ej. Tono Digital Dent)" className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
          <textarea value={tplBody} onChange={(e) => setTplBody(e.target.value)} rows={3} placeholder="Contenido del prompt…" className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs" />
          <Button onClick={() => void addTemplate()} disabled={tplName.trim().length < 2 || tplBody.trim().length < 5}><Plus size={14} /> Guardar plantilla</Button>
        </div>
        <ul className="mt-3 space-y-1.5">
          {templates.map((t) => (
            <li key={t.id} className="rounded-lg border border-slate-100 p-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">{t.name}</p>
                <span className="flex gap-2">
                  <button
                    onClick={() => { void navigator.clipboard.writeText(t.body); toast.push("Copiada al portapapeles", "info"); }}
                    className="text-[11px] text-cyan-700 underline"
                  >
                    Copiar
                  </button>
                  <button onClick={() => void api(`/settings/prompt-templates/${t.id}`, { method: "DELETE" }).then(load)} className="text-slate-300 hover:text-red-500">✕</button>
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{t.body}</p>
            </li>
          ))}
          {templates.length === 0 && <p className="py-2 text-center text-xs text-slate-400">Aún no hay plantillas guardadas.</p>}
        </ul>
      </div>
    </div>
  );
}
