"use client";

/** Registro de auditoría del tenant (solo Owner/Admin). */
import { useCallback, useEffect, useState } from "react";
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
  ["agent.", "Agentes IA"],
  ["contact.", "Contactos"],
  ["user.", "Usuarios"],
  ["organization.", "Organización"],
];

export default function AuditSettingsPage() {
  const [items, setItems] = useState<AuditRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [module, setModule] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

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

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h2 className="text-lg font-semibold">Registro de auditoría</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Quién hizo qué y cuándo en tu espacio (acciones de usuarios, agentes y sistema). Solo visible para Owner/Admin.
      </p>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        <Select value={module} onChange={(e) => setModule(e.target.value)} className="text-xs">
          {MODULES.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
        </Select>
        <DateInput value={from} onChange={(e) => setFrom(e.target.value)} className="text-xs" />
        <DateInput value={to} onChange={(e) => setTo(e.target.value)} className="text-xs" />
      </div>

      {!items ? (
        <Skeleton className="mt-4 h-64" />
      ) : (
        <ul className="mt-3 space-y-1">
          {items.length === 0 && <p className="rounded-lg border border-dashed border-line p-4 text-center text-sm text-ink-subtle">Sin registros con estos filtros.</p>}
          {items.map((r) => (
            <li key={r.id} className="rounded-lg border border-line bg-panel px-3 py-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] text-brand-800 dark:text-brand-300">{r.action}</span>
                <span className="shrink-0 text-ink-subtle">{new Date(r.createdAt).toLocaleString("es-CL")}</span>
              </div>
              <p className="text-ink-muted">
                {r.actorType === "user" ? `👤 ${r.actorName ?? "usuario"}` : r.actorType === "agent" ? "🤖 agente IA" : "⚙ sistema"}
                {r.entityType ? ` · ${r.entityType}${r.entityId ? ` (${r.entityId.slice(0, 10)}…)` : ""}` : ""}
                {r.after ? ` · ${JSON.stringify(r.after).slice(0, 120)}` : ""}
              </p>
            </li>
          ))}
          {nextCursor && (
            <button onClick={() => void load(nextCursor)} className="block w-full py-2 text-center text-xs text-brand-700 hover:underline dark:text-brand-300">
              Cargar más
            </button>
          )}
        </ul>
      )}
    </div>
  );
}
