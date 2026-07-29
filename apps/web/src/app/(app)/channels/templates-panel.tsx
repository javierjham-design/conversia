"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";

// Gestión de plantillas de mensaje de WhatsApp (HSM) de la WABA del canal.
// Crear deja la plantilla PENDING hasta que Meta la apruebe; el estado se
// refleja igual que en el WhatsApp Manager.

interface Template {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  rejectedReason: string | null;
  components: { type: string; text?: string; format?: string }[];
}

const CATEGORY_LABEL: Record<string, string> = {
  UTILITY: "Utilidad",
  MARKETING: "Marketing",
  AUTHENTICATION: "Autenticación",
};

const LANGUAGES = [
  { value: "es", label: "Español" },
  { value: "es_MX", label: "Español (México)" },
  { value: "es_AR", label: "Español (Argentina)" },
  { value: "es_ES", label: "Español (España)" },
  { value: "en_US", label: "Inglés (EE. UU.)" },
];

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "APPROVED"
      ? "bg-emerald-50 text-emerald-700"
      : status === "REJECTED"
        ? "bg-red-50 text-red-700"
        : "bg-amber-50 text-amber-700";
  const label = status === "APPROVED" ? "Aprobada" : status === "REJECTED" ? "Rechazada" : "En revisión";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{label}</span>;
}

export function TemplatesPanel({ channelId }: { channelId: string }) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    name: "",
    category: "UTILITY",
    language: "es",
    headerText: "",
    bodyText: "",
    footerText: "",
    quickReplies: "",
  });
  const [examples, setExamples] = useState<string[]>([]);

  // Variables {{n}} usadas en el cuerpo → Meta exige un ejemplo por cada una.
  const varCount = useMemo(() => {
    const nums = [...form.bodyText.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
    return nums.length ? Math.max(...nums) : 0;
  }, [form.bodyText]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ templates: Template[] }>(`/channels/${channelId}/templates`);
      setTemplates(r.templates);
    } catch (err) {
      setError((err as Error).message);
      setTemplates([]);
    }
  }, [channelId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const quickReplies = form.quickReplies
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3);
      await api(`/channels/${channelId}/templates`, {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          category: form.category,
          language: form.language,
          headerText: form.headerText || undefined,
          bodyText: form.bodyText,
          footerText: form.footerText || undefined,
          bodyExamples: varCount > 0 ? examples.slice(0, varCount) : undefined,
          quickReplies: quickReplies.length ? quickReplies : undefined,
        }),
      });
      setNotice("Plantilla enviada a Meta ✔ — queda «En revisión» hasta que la aprueben (suele tardar minutos).");
      setShowForm(false);
      setForm({ name: "", category: "UTILITY", language: "es", headerText: "", bodyText: "", footerText: "", quickReplies: "" });
      setExamples([]);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove(name: string) {
    if (!confirm(`¿Eliminar la plantilla «${name}»? Se borra de la WABA (todas sus variantes de idioma).`)) return;
    setError(null);
    try {
      await api(`/channels/${channelId}/templates/${encodeURIComponent(name)}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-slate-600">
          Plantillas de mensaje{" "}
          <span className="font-normal text-slate-400">— necesarias para escribir fuera de la ventana de 24 h</span>
        </p>
        <div className="flex items-center gap-2">
          <button onClick={() => void load()} className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs hover:bg-slate-50">
            Actualizar
          </button>
          <button
            onClick={() => setShowForm(!showForm)}
            className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700"
          >
            {showForm ? "Cancelar" : "Nueva plantilla"}
          </button>
        </div>
      </div>

      {notice && <p className="mb-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{notice}</p>}
      {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      {showForm && (
        <form onSubmit={create} className="mb-3 rounded-lg border border-slate-200 bg-white p-3">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-xs text-slate-600">
              Nombre (snake_case)
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, "_") })}
                required
                placeholder="recordatorio_cita"
                className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 font-mono text-xs"
              />
            </label>
            <label className="text-xs text-slate-600">
              Categoría
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
              >
                {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-600">
              Idioma
              <select
                value={form.language}
                onChange={(e) => setForm({ ...form, language: e.target.value })}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="mt-2 block text-xs text-slate-600">
            Encabezado (opcional, texto)
            <input
              value={form.headerText}
              onChange={(e) => setForm({ ...form, headerText: e.target.value })}
              maxLength={60}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
            />
          </label>
          <label className="mt-2 block text-xs text-slate-600">
            Cuerpo del mensaje — usa variables {"{{1}}"}, {"{{2}}"}…
            <textarea
              value={form.bodyText}
              onChange={(e) => setForm({ ...form, bodyText: e.target.value })}
              required
              rows={3}
              maxLength={1024}
              placeholder={"Hola {{1}}, te recordamos tu cita el {{2}} a las {{3}}. Responde CONFIRMAR para confirmarla."}
              className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
            />
          </label>
          {varCount > 0 && (
            <div className="mt-2 grid gap-2 md:grid-cols-3">
              {Array.from({ length: varCount }, (_, i) => (
                <label key={i} className="text-xs text-slate-600">
                  Ejemplo para {`{{${i + 1}}}`}
                  <input
                    value={examples[i] ?? ""}
                    onChange={(e) => {
                      const next = [...examples];
                      next[i] = e.target.value;
                      setExamples(next);
                    }}
                    required
                    className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
                  />
                </label>
              ))}
            </div>
          )}
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <label className="text-xs text-slate-600">
              Pie (opcional)
              <input
                value={form.footerText}
                onChange={(e) => setForm({ ...form, footerText: e.target.value })}
                maxLength={60}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </label>
            <label className="text-xs text-slate-600">
              Botones de respuesta rápida (opcional, separados por coma, máx. 3)
              <input
                value={form.quickReplies}
                onChange={(e) => setForm({ ...form, quickReplies: e.target.value })}
                placeholder="Confirmar, Reagendar"
                className="mt-1 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs"
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={saving}
            className="mt-3 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {saving ? "Enviando a Meta…" : "Crear plantilla"}
          </button>
        </form>
      )}

      {templates === null ? (
        <p className="text-xs text-slate-400">Cargando plantillas…</p>
      ) : templates.length === 0 ? (
        <p className="text-xs text-slate-400">Esta WABA aún no tiene plantillas.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] uppercase text-slate-400">
                <th className="py-1 pr-3">Nombre</th>
                <th className="py-1 pr-3">Estado</th>
                <th className="py-1 pr-3">Categoría</th>
                <th className="py-1 pr-3">Idioma</th>
                <th className="py-1 pr-3">Cuerpo</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => {
                const body = t.components.find((c) => c.type === "BODY")?.text ?? "";
                return (
                  <tr key={t.id} className="border-t border-slate-200 align-top">
                    <td className="py-1.5 pr-3 font-mono">{t.name}</td>
                    <td className="py-1.5 pr-3">
                      <StatusBadge status={t.status} />
                      {t.rejectedReason && t.rejectedReason !== "NONE" && (
                        <p className="mt-0.5 text-[10px] text-red-500">{t.rejectedReason}</p>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">{CATEGORY_LABEL[t.category] ?? t.category}</td>
                    <td className="py-1.5 pr-3 font-mono">{t.language}</td>
                    <td className="max-w-[360px] py-1.5 pr-3 text-slate-500">{body.length > 140 ? `${body.slice(0, 140)}…` : body}</td>
                    <td className="py-1.5 text-right">
                      <button onClick={() => void remove(t.name)} className="text-[10px] text-red-500 hover:underline">
                        Eliminar
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
