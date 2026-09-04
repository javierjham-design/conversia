"use client";

/**
 * Vista TABLERO del módulo de personas (B1.1 de la armonización): el kanban por
 * etapa que antes vivía en /crm, ahora como una vista más de /contacts. Usa los
 * MISMOS endpoints de siempre (/crm/board y /crm/leads/:id/stage — no cambian)
 * y comparte buscador, sidebar y ficha con la vista Tabla.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { KanbanSquare, Megaphone, MessageSquare, User2 } from "lucide-react";
import { api } from "@/lib/api";
import { EmptyState, Select, Skeleton, cn, useToast } from "@/components/ui";

interface BoardLead {
  id: string;
  contactId: string;
  name: string;
  phone: string | null;
  source: string | null;
  conversationId: string | null;
  updatedAt: string;
}

interface BoardStage {
  id: string;
  code: string;
  name: string;
  emoji: string | null;
  color: string | null;
  count: number;
  leads: BoardLead[];
}

const SOURCE_LABEL: Record<string, string> = {
  meta_lead_ads: "Formulario Meta",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  messenger: "Messenger",
  import: "Importación",
  clariva: "Cláriva",
  manual: "Manual",
};
/** Chip de color por origen (coherente con la vista Lista). */
const SOURCE_CLASS: Record<string, string> = {
  meta_lead_ads: "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300",
  whatsapp: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  instagram: "bg-pink-50 text-pink-700 dark:bg-pink-500/10 dark:text-pink-300",
  messenger: "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
  clariva: "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300",
};

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

export function BoardView({
  q,
  stage,
  origin,
  dateFrom,
  dateTo,
  refreshKey,
  onOpenContact,
  onTotal,
}: {
  /** búsqueda ya debounced del módulo */
  q: string;
  /** etapa seleccionada en la sidebar ("" = todas las columnas) */
  stage: string;
  /** origen de captación (Contact.source) — mismo filtro del panel */
  origin?: string;
  /** rango de fechas de ingreso del lead (YYYY-MM-DD) */
  dateFrom?: string;
  dateTo?: string;
  /** bump para recargar desde el padre */
  refreshKey: number;
  /** abre la ficha del contacto (mismo drawer de la vista Tabla) */
  onOpenContact: (contactId: string) => void;
  onTotal?: (total: number) => void;
}) {
  const toast = useToast();
  const [stages, setStages] = useState<BoardStage[] | null>(null);
  const [dragging, setDragging] = useState<{ leadId: string; fromCode: string } | null>(null);
  const [overCode, setOverCode] = useState<string | null>(null);
  const [busyLead, setBusyLead] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (origin) params.set("source", origin);
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    try {
      const r = await api<{ stages: BoardStage[]; total: number }>(`/crm/board?${params.toString()}`);
      setStages(r.stages);
      onTotal?.(r.total);
    } catch (e: any) {
      toast.push(e.message ?? "Error al cargar el tablero", "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, origin, dateFrom, dateTo, toast]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function moveLead(leadId: string, fromCode: string, toCode: string) {
    if (fromCode === toCode) return;
    setBusyLead(leadId);
    // Optimista: mover la tarjeta al tiro; si falla, recarga el estado real
    setStages((prev) => {
      if (!prev) return prev;
      let card: BoardLead | undefined;
      const without = prev.map((s) => {
        if (s.code !== fromCode) return s;
        card = s.leads.find((l) => l.id === leadId);
        return { ...s, count: Math.max(0, s.count - 1), leads: s.leads.filter((l) => l.id !== leadId) };
      });
      if (!card) return prev;
      return without.map((s) => (s.code === toCode ? { ...s, count: s.count + 1, leads: [{ ...card! }, ...s.leads] } : s));
    });
    try {
      await api(`/crm/leads/${leadId}/stage`, { method: "POST", body: JSON.stringify({ statusCode: toCode }) });
    } catch (e: any) {
      toast.push(e.message ?? "No se pudo mover el lead", "error");
      void load();
    } finally {
      setBusyLead(null);
    }
  }

  if (!stages) {
    return (
      <div className="flex gap-3 p-1">
        {[...Array(4)].map((_, i) => (
          <Skeleton key={i} className="h-72 w-72 shrink-0 rounded-xl" />
        ))}
      </div>
    );
  }
  // La etapa elegida en la sidebar filtra las columnas visibles
  const board = stage ? stages.filter((s) => s.code === stage) : stages;
  if (board.length === 0) {
    return <EmptyState icon={<KanbanSquare size={28} />} title="Sin etapas del ciclo de vida" description="Configura las etapas en Configuración → Etapas del ciclo de vida." />;
  }

  return (
    <div className="flex flex-1 gap-3 overflow-x-auto p-1 pb-3">
      {board.map((col) => (
        <div
          key={col.id}
          onDragOver={(e) => {
            e.preventDefault();
            setOverCode(col.code);
          }}
          onDragLeave={() => setOverCode((c) => (c === col.code ? null : c))}
          onDrop={(e) => {
            e.preventDefault();
            setOverCode(null);
            if (dragging) void moveLead(dragging.leadId, dragging.fromCode, col.code);
            setDragging(null);
          }}
          className={cn(
            "flex w-72 shrink-0 flex-col rounded-xl border bg-app/70",
            overCode === col.code ? "border-brand-400 bg-brand-soft" : "border-line",
          )}
        >
          <div className="flex items-center gap-2 border-b border-line px-3 py-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: col.color ?? "#94a3b8" }} />
            <p className="truncate text-sm font-medium text-ink">
              {col.emoji ? `${col.emoji} ` : ""}
              {col.name}
            </p>
            <span className="ml-auto rounded-full bg-panel px-2 py-0.5 text-xs tnum text-ink-subtle">{col.count}</span>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-2">
            {col.leads.length === 0 ? (
              <p className="py-6 text-center text-xs text-ink-subtle">Sin personas en esta etapa</p>
            ) : (
              col.leads.map((lead) => (
                <div
                  key={lead.id}
                  draggable
                  onDragStart={() => setDragging({ leadId: lead.id, fromCode: col.code })}
                  onDragEnd={() => setDragging(null)}
                  className={cn(
                    "cursor-grab rounded-lg border border-line bg-panel p-2.5 shadow-e1 transition-opacity",
                    busyLead === lead.id && "opacity-50",
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      onClick={() => onOpenContact(lead.contactId)}
                      className="min-w-0 truncate text-left text-sm font-medium text-ink hover:text-brand-600 dark:hover:text-brand-400"
                    >
                      {lead.name}
                    </button>
                    {lead.conversationId && (
                      <Link href={`/inbox?c=${lead.conversationId}`} className="shrink-0 rounded p-1 text-ink-subtle hover:bg-brand-soft hover:text-brand-600" title="Abrir conversación">
                        <MessageSquare size={14} />
                      </Link>
                    )}
                  </div>
                  {lead.phone && <p className="mt-0.5 truncate text-xs tnum text-ink-subtle">{lead.phone}</p>}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {lead.source ? (
                      <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium", SOURCE_CLASS[lead.source] ?? "bg-app text-ink-subtle")}>
                        {lead.source === "meta_lead_ads" ? <Megaphone size={10} /> : <User2 size={10} />}
                        {SOURCE_LABEL[lead.source] ?? lead.source}
                      </span>
                    ) : null}
                    <span className="ml-auto text-[10px] tnum text-ink-subtle" title={`Última actividad: ${new Date(lead.updatedAt).toLocaleString("es-CL")}`}>
                      {timeAgo(lead.updatedAt)}
                    </span>
                  </div>
                  {/* Mover sin arrastrar (móvil / accesibilidad) */}
                  <Select
                    value={col.code}
                    onChange={(e) => void moveLead(lead.id, col.code, e.target.value)}
                    className="mt-1.5 w-full text-[11px]"
                    aria-label="Mover a etapa"
                  >
                    {stages.map((s) => (
                      <option key={s.code} value={s.code}>{s.name}</option>
                    ))}
                  </Select>
                </div>
              ))
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
