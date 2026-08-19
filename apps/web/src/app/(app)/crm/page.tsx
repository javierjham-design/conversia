"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { KanbanSquare, Megaphone, MessageSquare, RefreshCw, Search, User2, X } from "lucide-react";
import { api } from "@/lib/api";
import { EmptyState, Skeleton, cn, useToast } from "@/components/ui";

// ------------------------------- Tipos -------------------------------

interface BoardLead {
  id: string;
  contactId: string;
  name: string;
  phone: string | null;
  email: string | null;
  country: string | null;
  source: string | null;
  formId: string | null;
  campaignId: string | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BoardStage {
  id: string;
  code: string;
  name: string;
  emoji: string | null;
  color: string | null;
  category: "OPEN" | "WON" | "LOST" | "FROZEN";
  count: number;
  leads: BoardLead[];
}

interface Filters {
  sources: { value: string; count: number }[];
  forms: { id: string; name: string }[];
}

const SOURCE_LABEL: Record<string, string> = {
  meta_lead_ads: "Formulario Meta",
  whatsapp: "WhatsApp",
  import: "Import",
  clariva: "Cláriva",
  manual: "Manual",
};

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "ahora";
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d`;
}

// ------------------------------- Página -------------------------------

export default function CrmBoardPage() {
  const toast = useToast();
  const [stages, setStages] = useState<BoardStage[] | null>(null);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState<Filters | null>(null);
  const [source, setSource] = useState("");
  const [formId, setFormId] = useState("");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [dragging, setDragging] = useState<{ leadId: string; fromCode: string } | null>(null);
  const [overCode, setOverCode] = useState<string | null>(null);
  const [busyLead, setBusyLead] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 350);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (source) params.set("source", source);
    if (formId) params.set("formId", formId);
    if (qDebounced) params.set("q", qDebounced);
    try {
      const r = await api<{ stages: BoardStage[]; total: number }>(`/crm/board?${params.toString()}`);
      setStages(r.stages);
      setTotal(r.total);
    } catch (e: any) {
      toast.push(e.message ?? "Error al cargar el tablero", "error");
    }
  }, [source, formId, qDebounced, toast]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    api<Filters>("/crm/filters").then(setFilters).catch(() => setFilters({ sources: [], forms: [] }));
  }, []);

  const hasFilters = Boolean(source || formId || q);

  async function moveLead(leadId: string, fromCode: string, toCode: string) {
    if (fromCode === toCode) return;
    setBusyLead(leadId);
    // Optimista: mover la tarjeta de columna al tiro
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
      void load(); // revertir al estado real
    } finally {
      setBusyLead(null);
    }
  }

  const board = useMemo(() => stages ?? [], [stages]);

  return (
    <div className="flex h-full flex-col">
      {/* Cabecera + filtros */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <KanbanSquare size={20} className="text-brand-600" />
          <h1 className="text-lg font-semibold text-slate-800">CRM</h1>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">{total} leads</span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar nombre, teléfono, email…"
              className="w-56 rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-3 text-sm outline-none focus:border-brand-500"
            />
          </div>
          <select value={source} onChange={(e) => setSource(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
            <option value="">Todos los orígenes</option>
            {(filters?.sources ?? []).map((s) => (
              <option key={s.value} value={s.value}>
                {SOURCE_LABEL[s.value] ?? s.value} ({s.count})
              </option>
            ))}
          </select>
          {(filters?.forms.length ?? 0) > 0 && (
            <select value={formId} onChange={(e) => setFormId(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
              <option value="">Todos los formularios</option>
              {filters!.forms.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          )}
          {hasFilters && (
            <button
              onClick={() => {
                setSource("");
                setFormId("");
                setQ("");
              }}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-slate-500 hover:bg-slate-100"
            >
              <X size={13} /> Limpiar
            </button>
          )}
          <button onClick={() => void load()} className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100" title="Actualizar">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {/* Tablero */}
      {!stages ? (
        <div className="flex gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-72 w-72 shrink-0 rounded-xl" />
          ))}
        </div>
      ) : board.length === 0 ? (
        <EmptyState icon={<KanbanSquare size={28} />} title="Sin etapas del ciclo de vida" description="Configura las etapas en Configuración → Ciclo de vida." />
      ) : (
        <div className="flex flex-1 gap-3 overflow-x-auto pb-3">
          {board.map((stage) => (
            <div
              key={stage.id}
              onDragOver={(e) => {
                e.preventDefault();
                setOverCode(stage.code);
              }}
              onDragLeave={() => setOverCode((c) => (c === stage.code ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                setOverCode(null);
                if (dragging) void moveLead(dragging.leadId, dragging.fromCode, stage.code);
                setDragging(null);
              }}
              className={cn(
                "flex w-72 shrink-0 flex-col rounded-xl border bg-slate-50/70",
                overCode === stage.code ? "border-brand-400 bg-brand-50/50" : "border-slate-200",
              )}
            >
              <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
                <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: stage.color ?? "#94a3b8" }} />
                <p className="truncate text-sm font-medium text-slate-700">
                  {stage.emoji ? `${stage.emoji} ` : ""}
                  {stage.name}
                </p>
                <span className="ml-auto rounded-full bg-white px-2 py-0.5 text-xs text-slate-500">{stage.count}</span>
              </div>
              <div className="flex-1 space-y-2 overflow-y-auto p-2">
                {stage.leads.length === 0 ? (
                  <p className="py-6 text-center text-xs text-slate-400">Sin leads</p>
                ) : (
                  stage.leads.map((lead) => (
                    <div
                      key={lead.id}
                      draggable
                      onDragStart={() => setDragging({ leadId: lead.id, fromCode: stage.code })}
                      onDragEnd={() => setDragging(null)}
                      className={cn(
                        "cursor-grab rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm transition-opacity",
                        busyLead === lead.id && "opacity-50",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <Link href={`/contacts?open=${lead.contactId}`} className="min-w-0 truncate text-sm font-medium text-slate-800 hover:text-brand-600">
                          {lead.name}
                        </Link>
                        {lead.conversationId && (
                          <Link href={`/inbox?c=${lead.conversationId}`} className="shrink-0 rounded p-1 text-slate-400 hover:bg-brand-50 hover:text-brand-600" title="Abrir conversación">
                            <MessageSquare size={14} />
                          </Link>
                        )}
                      </div>
                      {lead.phone && <p className="mt-0.5 truncate text-xs text-slate-500">{lead.phone}</p>}
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {lead.source === "meta_lead_ads" ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
                            <Megaphone size={10} /> {SOURCE_LABEL.meta_lead_ads}
                          </span>
                        ) : lead.source ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                            <User2 size={10} /> {SOURCE_LABEL[lead.source] ?? lead.source}
                          </span>
                        ) : null}
                        <span className="ml-auto text-[10px] text-slate-400" title={new Date(lead.updatedAt).toLocaleString("es-CL")}>
                          {timeAgo(lead.updatedAt)}
                        </span>
                      </div>
                      {/* Mover sin drag (móvil / accesibilidad) */}
                      <select
                        value={stage.code}
                        onChange={(e) => void moveLead(lead.id, stage.code, e.target.value)}
                        className="mt-1.5 w-full rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-[11px] text-slate-500"
                      >
                        {board.map((s) => (
                          <option key={s.code} value={s.code}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
