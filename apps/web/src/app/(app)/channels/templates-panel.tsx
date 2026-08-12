"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";

// Gestión de plantillas de mensaje de WhatsApp (HSM) de la WABA del canal.
// El cuerpo se escribe con CAMPOS REALES de la plataforma ({{Nombre del contacto}});
// al crear se convierten a las variables numéricas {{1}},{{2}}… que exige Meta y el
// mapeo posición→campo se guarda en el canal para resolver los valores al enviar.

interface Template {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
  rejectedReason: string | null;
  components: { type: string; text?: string; format?: string }[];
  variableFields: string[] | null;
}

// Catálogo de campos disponibles como variables. Fuente de verdad:
// TEMPLATE_FIELDS en packages/types/src/index.ts (mantener en sincronía).
const FIELDS = [
  { id: "contact.firstName", label: "Nombre del contacto", sample: "María" },
  { id: "contact.lastName", label: "Apellido del contacto", sample: "Pérez" },
  { id: "contact.fullName", label: "Nombre completo", sample: "María Pérez" },
  { id: "contact.phone", label: "Teléfono del contacto", sample: "+56 9 1234 5678" },
  { id: "appointment.date", label: "Fecha de la cita", sample: "martes 5 de agosto" },
  { id: "appointment.time", label: "Hora de la cita", sample: "15:30" },
  { id: "appointment.service", label: "Servicio de la cita", sample: "Control dental" },
  { id: "appointment.professional", label: "Profesional de la cita", sample: "Dra. Soto" },
  { id: "organization.name", label: "Nombre del negocio", sample: "Clínica Sonrisa" },
] as const;

const FIELD_BY_LABEL = new Map(FIELDS.map((f) => [f.label as string, f]));
const FIELD_BY_ID = new Map(FIELDS.map((f) => [f.id as string, f]));

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

/** Tokens {{…}} del cuerpo, separados en numéricos y con nombre. */
function parseTokens(body: string): { named: string[]; numeric: number[] } {
  const named: string[] = [];
  const numeric: number[] = [];
  for (const m of body.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    const inner = m[1];
    if (/^\d+$/.test(inner)) numeric.push(Number(inner));
    else named.push(inner);
  }
  return { named, numeric };
}

/**
 * Convierte el cuerpo con campos con nombre al formato de Meta: cada campo
 * distinto recibe un número (por orden de aparición; repetirlo reutiliza el
 * mismo número). Devuelve también los ejemplos y el mapeo posición→campo.
 */
function compileBody(body: string): { bodyText: string; examples: string[]; fields: string[]; unknown: string[] } {
  const order: string[] = []; // ids de campo en orden de asignación
  const unknown: string[] = [];
  const bodyText = body.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (raw, inner: string) => {
    if (/^\d+$/.test(inner)) return raw; // numérica manual: se deja tal cual
    const field = FIELD_BY_LABEL.get(inner.trim());
    if (!field) {
      if (!unknown.includes(inner.trim())) unknown.push(inner.trim());
      return raw;
    }
    let idx = order.indexOf(field.id);
    if (idx === -1) {
      order.push(field.id);
      idx = order.length - 1;
    }
    return `{{${idx + 1}}}`;
  });
  return {
    bodyText,
    examples: order.map((id) => FIELD_BY_ID.get(id)!.sample),
    fields: order,
    unknown,
  };
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "APPROVED"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
      : status === "REJECTED"
        ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"
        : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300";
  const label = status === "APPROVED" ? "Aprobada" : status === "REJECTED" ? "Rechazada" : "En revisión";
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>{label}</span>;
}

export function TemplatesPanel({ channelId }: { channelId: string }) {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  // Entitlement de mensajes de plantilla (plan + switch del tenant). Si no está
  // habilitado, se muestra el estado "no incluido" con CTA para contratarlo.
  const [ent, setEnt] = useState<{ planAllows: boolean; switchOn: boolean; enabled: boolean; activation: { priceClp: number | null; priceUsd: number | null } } | null>(null);

  const [form, setForm] = useState({
    name: "",
    category: "UTILITY",
    language: "es",
    headerText: "",
    bodyText: "",
    footerText: "",
    quickReplies: "",
  });

  // Análisis en vivo del cuerpo: campos usados, numéricas manuales, desconocidos.
  const compiled = useMemo(() => compileBody(form.bodyText), [form.bodyText]);
  const hasNumeric = useMemo(() => parseTokens(form.bodyText).numeric.length > 0, [form.bodyText]);

  // Vista previa con los valores de ejemplo (lo que verá el revisor de Meta).
  const preview = useMemo(
    () =>
      form.bodyText.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (raw, inner: string) => {
        const field = FIELD_BY_LABEL.get(inner.trim());
        return field ? field.sample : raw;
      }),
    [form.bodyText],
  );

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
    void api<{ planAllows: boolean; switchOn: boolean; enabled: boolean; activation: { priceClp: number | null; priceUsd: number | null } }>(`/channels/templates/entitlement`)
      .then(setEnt)
      .catch(() => setEnt(null));
  }, []);

  // Solo cargamos las plantillas de Meta si la función está habilitada (evita
  // llamadas a Graph cuando no aplica).
  useEffect(() => {
    if (ent?.enabled) void load();
  }, [ent?.enabled, load]);

  /** Inserta {{Etiqueta del campo}} en la posición del cursor del cuerpo. */
  function insertField(label: string) {
    const el = bodyRef.current;
    const token = `{{${label}}}`;
    if (!el) {
      setForm((f) => ({ ...f, bodyText: f.bodyText + token }));
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    setForm((f) => ({ ...f, bodyText: next }));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (compiled.unknown.length) {
      setError(`Campo desconocido: ${compiled.unknown.join(", ")}. Usa los botones de "Insertar campo".`);
      return;
    }
    if (hasNumeric && compiled.fields.length) {
      setError("Mezclar variables numéricas {{1}} con campos con nombre no está soportado: usa solo los campos.");
      return;
    }
    setSaving(true);
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
          bodyText: compiled.bodyText,
          footerText: form.footerText || undefined,
          bodyExamples: compiled.examples.length ? compiled.examples : undefined,
          variableFields: compiled.fields.length ? compiled.fields : undefined,
          quickReplies: quickReplies.length ? quickReplies : undefined,
        }),
      });
      setNotice("Plantilla enviada a Meta ✔ — queda «En revisión» hasta que la aprueben (suele tardar minutos).");
      setShowForm(false);
      setForm({ name: "", category: "UTILITY", language: "es", headerText: "", bodyText: "", footerText: "", quickReplies: "" });
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

  /** Cuerpo de una plantilla existente con sus campos por nombre (si hay mapeo). */
  function displayBody(t: Template): string {
    const body = t.components.find((c) => c.type === "BODY")?.text ?? "";
    if (!t.variableFields?.length) return body;
    return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (raw, n: string) => {
      const field = FIELD_BY_ID.get(t.variableFields![Number(n) - 1] ?? "");
      return field ? `{{${field.label}}}` : raw;
    });
  }

  return (
    <div className="mt-3 rounded-lg border border-line bg-app/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-ink-muted">
          Plantillas de mensaje{" "}
          <span className="font-normal text-ink-subtle">— necesarias para escribir fuera de la ventana de 24 h</span>
        </p>
        {ent?.enabled && (
          <div className="flex items-center gap-2">
            <button onClick={() => void load()} className="rounded-lg border border-line-strong bg-panel px-2.5 py-1 text-xs hover:bg-app">
              Actualizar
            </button>
            <button
              onClick={() => setShowForm(!showForm)}
              className="rounded-lg bg-brand-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-700"
            >
              {showForm ? "Cancelar" : "Nueva plantilla"}
            </button>
          </div>
        )}
      </div>

      {/* Función no incluida: estado claro con CTA (no oculta ni rota). */}
      {ent && !ent.enabled && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-center dark:border-amber-500/40 dark:bg-amber-500/10">
          <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">
            {ent.planAllows ? "Mensajes de plantilla no activados" : "Función no incluida en tu plan"}
          </p>
          <p className="mx-auto mt-1 max-w-md text-xs text-amber-800 dark:text-amber-300/90">
            {ent.planAllows
              ? "Tu plan incluye los mensajes de plantilla de WhatsApp, pero aún no están activados en tu cuenta. Actívalos para escribir a tus contactos fuera de la ventana de 24 h (recordatorios, confirmaciones, reactivaciones)."
              : "Los mensajes de plantilla de WhatsApp te permiten escribir fuera de la ventana de 24 h (recordatorios de cita, confirmaciones, reactivaciones). Esta capacidad no está incluida en tu plan actual."}
            {(ent.activation.priceClp || ent.activation.priceUsd) ? (
              <>
                {" "}Activación:{" "}
                <b>
                  {ent.activation.priceClp ? `$${ent.activation.priceClp.toLocaleString("es-CL")} CLP` : ""}
                  {ent.activation.priceClp && ent.activation.priceUsd ? " / " : ""}
                  {ent.activation.priceUsd ? `US$${ent.activation.priceUsd}` : ""}
                </b>
                .
              </>
            ) : null}
          </p>
          <a
            href="/settings/plan"
            className="mt-3 inline-flex rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
          >
            {ent.planAllows ? "Contratar activación" : "Ver planes"}
          </a>
        </div>
      )}

      {ent && !ent.enabled ? null : (
      <>
      {notice && <p className="mb-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{notice}</p>}
      {error && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p>}

      {showForm && (
        <form onSubmit={create} className="mb-3 rounded-lg border border-line bg-panel p-3">
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-xs text-ink-muted">
              Nombre (snake_case)
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]+/g, "_") })}
                required
                placeholder="recordatorio_cita"
                className="mt-1 w-full rounded-lg border border-line-strong px-2.5 py-1.5 font-mono text-xs"
              />
            </label>
            <label className="text-xs text-ink-muted">
              Categoría
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                className="mt-1 w-full rounded-lg border border-line-strong bg-panel px-2.5 py-1.5 text-xs"
              >
                {Object.entries(CATEGORY_LABEL).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              Idioma
              <select
                value={form.language}
                onChange={(e) => setForm({ ...form, language: e.target.value })}
                className="mt-1 w-full rounded-lg border border-line-strong bg-panel px-2.5 py-1.5 text-xs"
              >
                {LANGUAGES.map((l) => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="mt-2 block text-xs text-ink-muted">
            Encabezado (opcional, texto)
            <input
              value={form.headerText}
              onChange={(e) => setForm({ ...form, headerText: e.target.value })}
              maxLength={60}
              className="mt-1 w-full rounded-lg border border-line-strong px-2.5 py-1.5 text-xs"
            />
          </label>

          <div className="mt-2">
            <p className="text-xs text-ink-muted">Cuerpo del mensaje</p>
            <div className="mt-1 flex flex-wrap gap-1">
              {FIELDS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => insertField(f.label)}
                  title={`Ejemplo: ${f.sample}`}
                  className="rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-[10px] text-cyan-800 hover:bg-cyan-100 dark:bg-cyan-500/10 dark:text-cyan-300 dark:border-cyan-500/30"
                >
                  + {f.label}
                </button>
              ))}
            </div>
            <textarea
              ref={bodyRef}
              value={form.bodyText}
              onChange={(e) => setForm({ ...form, bodyText: e.target.value })}
              required
              rows={3}
              maxLength={1024}
              placeholder="Hola {{Nombre del contacto}}, te recordamos tu cita el {{Fecha de la cita}} a las {{Hora de la cita}}. Responde CONFIRMAR para confirmarla."
              className="mt-1.5 w-full rounded-lg border border-line-strong px-2.5 py-1.5 text-xs"
            />
            <p className="text-[10px] text-ink-subtle">
              Pulsa un campo para insertarlo donde esté el cursor. Al crear, la plataforma lo convierte al formato de Meta y
              recuerda qué dato real va en cada posición.
            </p>
          </div>

          {form.bodyText.trim() && (
            <div className="mt-2 rounded-lg bg-app p-2.5">
              <p className="text-[10px] font-medium uppercase text-ink-subtle">Vista previa (con datos de ejemplo)</p>
              <div className="mt-1.5 max-w-md rounded-xl rounded-tl-sm bg-emerald-50 px-3 py-2 text-xs text-ink shadow-sm dark:bg-emerald-500/10">
                {form.headerText && <p className="mb-1 font-semibold">{form.headerText}</p>}
                <p className="whitespace-pre-wrap">{preview}</p>
                {form.footerText && <p className="mt-1 text-[10px] text-ink-subtle">{form.footerText}</p>}
              </div>
              {compiled.fields.length > 0 && (
                <p className="mt-1.5 text-[10px] text-ink-subtle">
                  Campos cableados:{" "}
                  {compiled.fields.map((id) => FIELD_BY_ID.get(id)?.label ?? id).join(" · ")}
                </p>
              )}
            </div>
          )}

          <div className="mt-2 grid gap-3 md:grid-cols-2">
            <label className="text-xs text-ink-muted">
              Pie (opcional)
              <input
                value={form.footerText}
                onChange={(e) => setForm({ ...form, footerText: e.target.value })}
                maxLength={60}
                className="mt-1 w-full rounded-lg border border-line-strong px-2.5 py-1.5 text-xs"
              />
            </label>
            <label className="text-xs text-ink-muted">
              Botones de respuesta rápida (opcional, separados por coma, máx. 3)
              <input
                value={form.quickReplies}
                onChange={(e) => setForm({ ...form, quickReplies: e.target.value })}
                placeholder="Confirmar, Reagendar"
                className="mt-1 w-full rounded-lg border border-line-strong px-2.5 py-1.5 text-xs"
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
        <p className="text-xs text-ink-subtle">Cargando plantillas…</p>
      ) : templates.length === 0 ? (
        <p className="text-xs text-ink-subtle">Esta WABA aún no tiene plantillas.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] uppercase text-ink-subtle">
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
                const body = displayBody(t);
                return (
                  <tr key={t.id} className="border-t border-line align-top">
                    <td className="py-1.5 pr-3 font-mono">{t.name}</td>
                    <td className="py-1.5 pr-3">
                      <StatusBadge status={t.status} />
                      {t.rejectedReason && t.rejectedReason !== "NONE" && (
                        <p className="mt-0.5 text-[10px] text-red-500">{t.rejectedReason}</p>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">{CATEGORY_LABEL[t.category] ?? t.category}</td>
                    <td className="py-1.5 pr-3 font-mono">{t.language}</td>
                    <td className="max-w-[360px] py-1.5 pr-3 text-ink-muted">{body.length > 160 ? `${body.slice(0, 160)}…` : body}</td>
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
      </>
      )}
    </div>
  );
}
