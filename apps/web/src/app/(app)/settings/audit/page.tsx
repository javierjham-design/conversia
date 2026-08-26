"use client";

/**
 * Registro de auditoría del tenant (solo Owner/Admin). Cada evento se muestra
 * como una FRASE en español, agrupado por día y con buscador; la clave interna
 * de la acción y el JSON completo quedan detrás de «ver detalle técnico» (B3).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { api } from "@/lib/api";
import { DateInput, Select, Skeleton } from "@/components/ui";

interface AuditRow {
  id: string;
  action: string;
  actorType: string;
  actorName: string | null;
  entityType: string | null;
  entityId: string | null;
  after: unknown;
  createdAt: string;
}

const MODULES: [string, string][] = [
  ["", "Todos los módulos"],
  ["conversation.", "Bandeja"],
  ["settings.", "Configuración"],
  ["lifecycle.", "Etapas"],
  ["integration.", "Integraciones"],
  ["meta_crm.", "Meta CRM"],
  ["agent.", "Agentes IA"],
  ["contact.", "Contactos"],
  ["user.", "Usuarios"],
  ["organization.", "Organización"],
];

/** Frases por acción conocida; {x} se rellena con datos del payload. */
const ACTION_PHRASES: Record<string, string> = {
  "conversation.send_template": "envió la plantilla {template}",
  "conversation.close": "cerró una conversación",
  "conversation.reopen": "reabrió una conversación",
  "conversation.assign": "asignó una conversación",
  "conversation.takeover": "tomó el control de una conversación (IA en pausa)",
  "conversation.release": "devolvió una conversación a la IA",
  "conversation.start_outbound": "inició una conversación con una plantilla",
  "conversation.deleted": "eliminó una conversación y su historial",
  "conversation.message_deleted": "eliminó un mensaje del historial",
  "user.invite": "invitó a un usuario",
  "user.update": "editó un usuario",
  "user.reset_password": "restableció la contraseña de un usuario",
  "meta_crm.page_connect": "conectó una página de Facebook al CRM",
  "contact.create": "creó un contacto",
  "contact.update": "editó un contacto",
  "contact.delete": "eliminó un contacto",
  "settings.update": "actualizó la configuración",
  "agent.publish": "publicó una versión de un agente IA",
};

/** Fallback legible para acciones sin frase: "meta_crm.page_connect" → "page connect en Meta CRM". */
function genericPhrase(action: string): string {
  const [mod, ...rest] = action.split(".");
  const verb = rest.join(" ").replace(/[_.]/g, " ");
  const modLabel = MODULES.find(([v]) => v === `${mod}.`)?.[1] ?? mod;
  return `${verb || action} · ${modLabel}`;
}

function phraseFor(r: AuditRow): string {
  const actor = r.actorType === "user" ? (r.actorName ?? "Un usuario") : r.actorType === "agent" ? "El agente IA" : "El sistema";
  const tpl = ACTION_PHRASES[r.action];
  if (!tpl) return `${actor}: ${genericPhrase(r.action)}`;
  const after = (r.after ?? {}) as Record<string, unknown>;
  const filled = tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(after[k] ?? "")).replace(/\s+«?»?\s*$/, "").trim();
  return `${actor} ${filled}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date();
  yest.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Hoy";
  if (same(d, yest)) return "Ayer";
  return d.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" });
}

export default function AuditSettingsPage() {
  const [items, setItems] = useState<AuditRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [module, setModule] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [q, setQ] = useState("");

  const load = useCallback(
    async (cursor?: string | null) => {
      const params = new URLSearchParams();
      if (module) params.set("module", module);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (cursor) params.set("cursor", cursor);
      const res = await api<{ items: AuditRow[]; nextCursor: string | null }>(`/settings/audit?${params.toString()}`);
      setItems((prev) => (cursor && prev ? [...prev, ...res.items] : res.items));
      setNextCursor(res.nextCursor);
    },
    [module, from, to],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // Buscador local sobre lo cargado (frase + acción + actor)
  const filtered = useMemo(() => {
    if (!items) return null;
    const term = q.trim().toLowerCase();
    if (!term) return items;
    return items.filter((r) => `${phraseFor(r)} ${r.action} ${r.actorName ?? ""}`.toLowerCase().includes(term));
  }, [items, q]);

  // Agrupación por día (sobre el resultado filtrado)
  const groups = useMemo(() => {
    const out: { day: string; rows: AuditRow[] }[] = [];
    for (const r of filtered ?? []) {
      const day = dayLabel(r.createdAt);
      const g = out[out.length - 1];
      if (g && g.day === day) g.rows.push(r);
      else out.push({ day, rows: [r] });
    }
    return out;
  }, [filtered]);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h2 className="text-lg font-semibold">Registro de auditoría</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Quién hizo qué y cuándo en tu cuenta (usuarios, agentes IA y sistema). Solo visible para Propietario y Administrador.
      </p>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar en el registro…"
            className="w-56 rounded-lg border border-line-strong bg-panel py-1.5 pl-8 pr-2 text-xs"
          />
        </div>
        <Select value={module} onChange={(e) => setModule(e.target.value)} className="text-xs">
          {MODULES.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
        </Select>
        <DateInput value={from} onChange={(e) => setFrom(e.target.value)} className="text-xs" aria-label="Desde" />
        <DateInput value={to} onChange={(e) => setTo(e.target.value)} className="text-xs" aria-label="Hasta" />
      </div>

      {!filtered ? (
        <Skeleton className="mt-4 h-64" />
      ) : (
        <div className="mt-3 space-y-4">
          {filtered.length === 0 && <p className="rounded-lg border border-line bg-panel p-4 text-center text-sm text-ink-subtle">Sin registros con estos filtros.</p>}
          {groups.map((g) => (
            <section key={g.day}>
              <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">{g.day}</h3>
              <ul className="space-y-1">
                {g.rows.map((r) => (
                  <li key={r.id} className="rounded-lg border border-line bg-panel px-3 py-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-ink">
                        {r.actorType === "user" ? "👤 " : r.actorType === "agent" ? "🤖 " : "⚙ "}
                        {phraseFor(r)}
                      </p>
                      <span className="shrink-0 tnum text-ink-subtle">
                        {new Date(r.createdAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </div>
                    <details className="mt-1">
                      <summary className="cursor-pointer select-none text-[11px] text-ink-subtle hover:text-ink-muted">ver detalle técnico</summary>
                      <div className="mt-1 rounded bg-app p-2 font-mono text-[10px] text-ink-muted">
                        <p>{r.action}{r.entityType ? ` · ${r.entityType}${r.entityId ? ` (${r.entityId})` : ""}` : ""}</p>
                        {r.after != null && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(r.after, null, 2)}</pre>}
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {nextCursor && (
            <button onClick={() => void load(nextCursor)} className="block w-full py-2 text-center text-xs text-brand-700 hover:underline dark:text-brand-300">
              Cargar más
            </button>
          )}
        </div>
      )}
    </div>
  );
}
