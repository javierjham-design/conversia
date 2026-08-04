"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Ban,
  Bookmark,
  ChevronDown,
  Columns3,
  Contact2,
  Filter,
  Plus,
  Search,
  Download,
  GitMerge,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Tag,
  Trash2,
  Upload,
  UserCog,
  Users2,
  Workflow,
  X,
} from "lucide-react";
import { api, getToken } from "@/lib/api";
import { Button, ConfirmDialog, EmptyState, Modal, Skeleton, cn, useToast } from "@/components/ui";
import { ContactDrawer } from "./contact-drawer";
import { DuplicatesModal, ImportModal } from "./contact-import-merge";

// ------------------------------- Tipos -------------------------------

interface ContactRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  profileName: string | null;
  phone: string | null;
  email: string | null;
  country: string | null;
  locale: string | null;
  blocked: boolean;
  acquisitionSource: string | null;
  createdAt: string;
  lastContactAt: string | null;
  stage: { code: string; name: string; color: string | null } | null;
  conversation: { id: string; status: string; assignedUserId: string | null; assignedTeamId: string | null; activeAgentId: string | null } | null;
  channels: string[];
  tags: { name: string; color: string | null }[];
}
interface ListResp {
  page: number;
  pageSize: number;
  total: number;
  items: ContactRow[];
}
interface Meta {
  counts: { all: number; blocked: number };
  lifecycle: { code: string; name: string; color: string | null; category: string; count: number }[];
  agents: { id: string; name: string; slug: string; count: number }[];
  users: { id: string; name: string }[];
  teams: { id: string; name: string }[];
  tags: { id: string; name: string; color: string | null }[];
  countries: string[];
  campaigns: { id: string; name: string }[];
  segments: { id: string; name: string; isDefault: boolean }[];
}

type Primary = { kind: "all" | "blocked" | "stage" | "agent" | "segment"; value?: string };

// --------------------------- Utilidades UI ---------------------------

const CHANNEL_LABEL: Record<string, string> = {
  WHATSAPP_CLOUD: "WhatsApp",
  WHATSAPP: "WhatsApp",
  MOCK: "Simulación",
  INSTAGRAM: "Instagram",
  MESSENGER: "Messenger",
  WEBCHAT: "Webchat",
};
const CONV_STATUS: Record<string, { label: string; className: string }> = {
  OPEN: { label: "Abierta", className: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" },
  PENDING: { label: "Pendiente", className: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" },
  RESOLVED: { label: "Resuelta", className: "bg-app text-ink-muted" },
  CLOSED: { label: "Cerrada", className: "bg-app text-ink-muted" },
  SNOOZED: { label: "Pospuesta", className: "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300" },
};

/** Código ISO-2 → emoji de bandera (indicadores regionales). */
function flag(iso: string | null): string {
  if (!iso || iso.length !== 2) return "";
  const cp = [...iso.toUpperCase()].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...cp);
}
function displayName(c: ContactRow): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.profileName || c.phone || "Sin nombre";
}
function initials(c: ContactRow): string {
  const n = displayName(c).trim();
  if (n === "Sin nombre") return "?";
  const parts = n.split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}
function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("es-CL", { day: "2-digit", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "2-digit" });
}

// ------------------------------ Columnas ------------------------------

type ColKey =
  | "channel" | "stage" | "email" | "phone" | "tags" | "country" | "locale" | "conv" | "assigned" | "lastContactAt" | "createdAt";
const COLUMNS: { key: ColKey; label: string; def: boolean }[] = [
  { key: "channel", label: "Canal", def: true },
  { key: "stage", label: "Etapa", def: true },
  { key: "phone", label: "Teléfono", def: true },
  { key: "email", label: "Email", def: true },
  { key: "tags", label: "Etiquetas", def: true },
  { key: "country", label: "País", def: true },
  { key: "locale", label: "Idioma", def: false },
  { key: "conv", label: "Conversación", def: true },
  { key: "assigned", label: "Asignado", def: false },
  { key: "lastContactAt", label: "Último mensaje", def: true },
  { key: "createdAt", label: "Creado", def: false },
];

// Segmentos sugeridos (presets genéricos, sin fila en BD).
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const SUGGESTED: { key: string; label: string; sec: Record<string, string> }[] = [
  { key: "new7", label: "Nuevos (7 días)", sec: { dateFrom: daysAgo(7) } },
  { key: "ads", label: "Vinieron de anuncios", sec: { source: "ad" } },
  { key: "organic", label: "Orgánicos", sec: { source: "organic" } },
];
function isPresetActive(preset: { sec: Record<string, string> }, primary: Primary, sec: Record<string, any>): boolean {
  if (primary.kind !== "all") return false;
  const active = Object.entries(sec).filter(([, v]) => v);
  const keys = Object.keys(preset.sec);
  return active.length === keys.length && keys.every((k) => sec[k] === preset.sec[k]);
}

// =============================== Página ===============================

export default function ContactsPage() {
  const toast = useToast();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [runWfTarget, setRunWfTarget] = useState<{ id: string; name: string } | null>(null);
  const [data, setData] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(true);

  // Filtro primario (sidebar) + secundarios (barra de filtros) + búsqueda.
  const [primary, setPrimary] = useState<Primary>({ kind: "all" });
  const [sec, setSec] = useState<{ tag?: string; channel?: string; country?: string; source?: string; campaign?: string; dateFrom?: string; dateTo?: string }>({});
  const [q, setQ] = useState("");
  const [searchInput, setSearchInput] = useState("");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [sortBy, setSortBy] = useState<"createdAt" | "lastContactAt" | "firstName">("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [visibleCols, setVisibleCols] = useState<Set<ColKey>>(new Set(COLUMNS.filter((c) => c.def).map((c) => c.key)));
  const [colMenu, setColMenu] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [confirmBulkDel, setConfirmBulkDel] = useState(false);
  const [saveSegOpen, setSaveSegOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const agentName = useMemo(() => new Map(meta?.agents.map((a) => [a.id, a.name]) ?? []), [meta]);
  const userName = useMemo(() => new Map(meta?.users.map((u) => [u.id, u.name]) ?? []), [meta]);

  const secCount = Object.values(sec).filter(Boolean).length;

  // Debounce de la búsqueda (300 ms) → resetea a la página 1.
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadMeta = useCallback(() => {
    void api<Meta>("/contacts/meta").then(setMeta).catch(() => undefined);
    // Flujos publicados+activos, para el disparo manual masivo.
    void api<{ id: string; name: string; status: string }[]>("/workflows")
      .then((r) => setWorkflows(r.filter((w) => w.status === "published").map((w) => ({ id: w.id, name: w.name }))))
      .catch(() => setWorkflows([]));
  }, []);
  useEffect(loadMeta, [loadMeta]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    p.set("page", String(page));
    p.set("pageSize", String(pageSize));
    p.set("sortBy", sortBy);
    p.set("sortDir", sortDir);
    if (q) p.set("q", q);
    if (primary.kind === "blocked") p.set("blocked", "true");
    if (primary.kind === "stage" && primary.value) p.set("stage", primary.value);
    if (primary.kind === "agent" && primary.value) p.set("assignedAgent", primary.value);
    if (primary.kind === "segment" && primary.value) p.set("segmentId", primary.value);
    if (sec.tag) p.set("tag", sec.tag);
    if (sec.channel) p.set("channel", sec.channel);
    if (sec.country) p.set("country", sec.country);
    if (sec.source) p.set("source", sec.source);
    if (sec.campaign) p.set("campaign", sec.campaign);
    if (sec.dateFrom) p.set("dateFrom", sec.dateFrom);
    if (sec.dateTo) p.set("dateTo", sec.dateTo);
    return p.toString();
  }, [page, pageSize, sortBy, sortDir, q, primary, sec]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api<ListResp>(`/contacts?${query}`)
      .then((r) => alive && setData(r))
      .catch((e) => alive && toast.push(e.message ?? "Error al cargar contactos", "error"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [query, refreshKey, toast]);

  // Al cambiar filtros primarios/secundarios, vuelve a la página 1 y limpia selección.
  function setPrimaryReset(p: Primary) {
    setPrimary(p);
    setPage(1);
    setSelected(new Set());
  }
  function setSecReset(patch: Partial<typeof sec>) {
    setSec((s) => ({ ...s, ...patch }));
    setPage(1);
    setSelected(new Set());
  }
  function applyPreset(nextSec: Record<string, string>) {
    setPrimary({ kind: "all" });
    setSec(nextSec);
    setPage(1);
    setSelected(new Set());
  }
  async function deleteSegment(id: string) {
    try {
      await api(`/contacts/segments/${id}`, { method: "DELETE" });
      if (primary.kind === "segment" && primary.value === id) setPrimary({ kind: "all" });
      toast.push("Segmento eliminado", "ok");
      loadMeta();
    } catch (e: any) {
      toast.push(e.message ?? "Error al eliminar", "error");
    }
  }

  function refresh() {
    setRefreshKey((k) => k + 1);
    loadMeta();
  }
  async function downloadExport() {
    setExporting(true);
    try {
      const res = await fetch(`/backend/contacts/export?${query}`, { headers: getToken() ? { authorization: `Bearer ${getToken()}` } : {} });
      if (!res.ok) throw new Error("No se pudo exportar");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `contactos_${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.push(e.message ?? "Error al exportar", "error");
    } finally {
      setExporting(false);
    }
  }
  async function runBulk(action: string, params: Record<string, unknown> = {}) {
    try {
      const r = await api<{ affected: number }>("/contacts/bulk", { method: "POST", body: JSON.stringify({ ids: [...selected], action, ...params }) });
      toast.push(`${r.affected} contacto(s) actualizados`, "ok");
      setSelected(new Set());
      refresh();
    } catch (e: any) {
      toast.push(e.message ?? "Error en la acción masiva", "error");
    }
  }

  /** Disparo manual masivo: ejecuta un flujo publicado sobre los seleccionados. */
  async function runWorkflowBulk(workflowId: string) {
    const ids = [...selected];
    try {
      await api(`/workflows/${workflowId}/run-bulk`, { method: "POST", body: JSON.stringify({ contactIds: ids }) });
      toast.push(`Flujo ejecutado sobre ${ids.length} contacto(s)`, "ok");
      setSelected(new Set());
    } catch (e: any) {
      toast.push(e.message ?? "No se pudo ejecutar el flujo", "error");
    }
  }

  // Definición del filtro actual (para guardarlo como segmento).
  const currentDefinition = useMemo(() => {
    const def: Record<string, unknown> = {};
    if (primary.kind === "blocked") def.blocked = "true";
    if (primary.kind === "stage" && primary.value) def.stage = primary.value;
    if (primary.kind === "agent" && primary.value) def.assignedAgent = primary.value;
    if (q) def.q = q;
    Object.entries(sec).forEach(([k, v]) => v && (def[k] = v));
    return def;
  }, [primary, sec, q]);
  const canSaveSegment = Object.keys(currentDefinition).length > 0;

  const rows = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const allOnPageSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function toggleSort(col: "createdAt" | "lastContactAt" | "firstName") {
    if (sortBy === col) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortBy(col);
      setSortDir(col === "firstName" ? "asc" : "desc");
    }
    setPage(1);
  }

  return (
    <div className="flex h-full">
      {/* ---------------------------- Sidebar ---------------------------- */}
      <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-line bg-panel md:flex">
        <div className="p-3">
          <SideItem icon={<Users2 size={15} />} label="Todos" count={meta?.counts.all} active={primary.kind === "all"} onClick={() => setPrimaryReset({ kind: "all" })} />
          <SideItem icon={<Ban size={15} />} label="Bloqueados" count={meta?.counts.blocked} active={primary.kind === "blocked"} onClick={() => setPrimaryReset({ kind: "blocked" })} />
        </div>

        <SideGroup title="Ciclo de vida">
          {(meta?.lifecycle ?? []).map((s) => (
            <SideItem
              key={s.code}
              dot={s.color ?? "#94a3b8"}
              label={s.name}
              count={s.count}
              active={primary.kind === "stage" && primary.value === s.code}
              onClick={() => setPrimaryReset({ kind: "stage", value: s.code })}
            />
          ))}
        </SideGroup>

        {(meta?.agents.length ?? 0) > 0 && (
          <SideGroup title="Agentes IA">
            {meta!.agents.map((a) => (
              <SideItem
                key={a.id}
                icon={<Contact2 size={15} />}
                label={a.name}
                count={a.count}
                active={primary.kind === "agent" && primary.value === a.id}
                onClick={() => setPrimaryReset({ kind: "agent", value: a.id })}
              />
            ))}
          </SideGroup>
        )}

        <SideGroup title="Sugeridos">
          {SUGGESTED.map((s) => (
            <SideItem key={s.key} icon={<Sparkles size={15} />} label={s.label} active={isPresetActive(s, primary, sec)} onClick={() => applyPreset(s.sec)} />
          ))}
        </SideGroup>

        {(meta?.segments.length ?? 0) > 0 && (
          <SideGroup title="Segmentos">
            {meta!.segments.map((s) => (
              <SideItem
                key={s.id}
                icon={<Bookmark size={15} />}
                label={s.name}
                active={primary.kind === "segment" && primary.value === s.id}
                onClick={() => setPrimaryReset({ kind: "segment", value: s.id })}
                onDelete={() => void deleteSegment(s.id)}
              />
            ))}
          </SideGroup>
        )}
      </aside>

      {/* --------------------------- Contenido --------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Barra de herramientas */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
          <div className="relative flex-1 min-w-[220px]">
            <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Buscar por nombre, teléfono o email…"
              className="w-full rounded-lg border border-line-strong bg-panel py-1.5 pl-8 pr-3 text-sm outline-none focus:border-brand-500"
            />
          </div>
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={cn("inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium", showFilters || secCount ? "border-brand-300 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300 dark:border-brand-500/40" : "border-line-strong bg-panel text-ink-muted hover:bg-app")}
          >
            <Filter size={15} /> Filtros {secCount > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] text-white">{secCount}</span>}
          </button>
          <div className="relative">
            <button onClick={() => setColMenu((v) => !v)} className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-panel px-3 py-1.5 text-sm font-medium text-ink-muted hover:bg-app">
              <Columns3 size={15} /> Columnas
            </button>
            {colMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setColMenu(false)} />
                <div className="absolute right-0 z-20 mt-1 w-52 rounded-xl border border-line bg-panel p-1.5 shadow-pop">
                  {COLUMNS.map((c) => (
                    <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-app">
                      <input
                        type="checkbox"
                        checked={visibleCols.has(c.key)}
                        onChange={(e) =>
                          setVisibleCols((prev) => {
                            const next = new Set(prev);
                            e.target.checked ? next.add(c.key) : next.delete(c.key);
                            return next;
                          })
                        }
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
              </>
            )}
          </div>
          <Button variant="secondary" onClick={() => setDupOpen(true)} title="Buscar y fusionar duplicados">
            <GitMerge size={15} /> Duplicados
          </Button>
          <Button variant="secondary" onClick={downloadExport} disabled={exporting}>
            <Download size={15} /> {exporting ? "Exportando…" : "Exportar"}
          </Button>
          <Button variant="secondary" onClick={() => setImportOpen(true)}>
            <Upload size={15} /> Importar
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus size={15} /> Añadir contacto
          </Button>
        </div>

        {/* Panel de filtros combinables */}
        {showFilters && meta && (
          <div className="flex flex-wrap items-end gap-3 border-b border-line bg-app px-4 py-3 text-sm">
            <FilterSelect label="Etiqueta" value={sec.tag} onChange={(v) => setSecReset({ tag: v })} options={meta.tags.map((t) => ({ value: t.id, label: t.name }))} />
            <FilterSelect
              label="Canal"
              value={sec.channel}
              onChange={(v) => setSecReset({ channel: v })}
              options={Object.entries(CHANNEL_LABEL).filter(([k]) => ["WHATSAPP_CLOUD", "MOCK", "INSTAGRAM"].includes(k)).map(([value, label]) => ({ value, label }))}
            />
            <FilterSelect label="País" value={sec.country} onChange={(v) => setSecReset({ country: v })} options={meta.countries.map((c) => ({ value: c, label: `${flag(c)} ${c}` }))} />
            {meta.campaigns.length > 0 && (
              <FilterSelect label="Campaña" value={sec.campaign} onChange={(v) => setSecReset({ campaign: v })} options={meta.campaigns.map((c) => ({ value: c.id, label: c.name }))} />
            )}
            <FilterSelect label="Origen" value={sec.source} onChange={(v) => setSecReset({ source: v })} options={[{ value: "ad", label: "Anuncio (CTWA)" }, { value: "organic", label: "Orgánico" }]} />
            <div>
              <p className="mb-1 text-xs font-medium text-ink-muted">Creado desde</p>
              <input type="date" value={sec.dateFrom ?? ""} onChange={(e) => setSecReset({ dateFrom: e.target.value || undefined })} className="rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-sm" />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium text-ink-muted">hasta</p>
              <input type="date" value={sec.dateTo ?? ""} onChange={(e) => setSecReset({ dateTo: e.target.value || undefined })} className="rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-sm" />
            </div>
            {secCount > 0 && (
              <button onClick={() => setSecReset({ tag: undefined, channel: undefined, country: undefined, source: undefined, dateFrom: undefined, dateTo: undefined })} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-ink-muted hover:text-ink">
                <X size={14} /> Limpiar
              </button>
            )}
            {canSaveSegment && (
              <button onClick={() => setSaveSegOpen(true)} className="inline-flex items-center gap-1 rounded-lg border border-brand-300 bg-panel px-2.5 py-1.5 font-medium text-brand-700 hover:bg-brand-50 dark:text-brand-300 dark:border-brand-500/40">
                <Bookmark size={14} /> Guardar segmento
              </button>
            )}
          </div>
        )}

        {/* Barra de acciones masivas */}
        {selected.size > 0 && meta && (
          <div className="flex flex-wrap items-center gap-2 border-b border-brand-200 bg-brand-50 px-4 py-2 text-sm dark:bg-brand-500/10 dark:border-brand-500/30">
            <span className="font-medium text-brand-800 dark:text-brand-300">{selected.size} seleccionados</span>
            <BulkMenu icon={<Tag size={14} />} label="Etiquetar" options={meta.tags.map((t) => ({ label: t.name, onClick: () => runBulk("tag_add", { tagId: t.id }) }))} empty="Sin etiquetas" />
            <BulkMenu icon={<SlidersHorizontal size={14} />} label="Etapa" options={meta.lifecycle.map((s) => ({ label: s.name, onClick: () => runBulk("stage", { statusCode: s.code }) }))} />
            <BulkMenu
              icon={<UserCog size={14} />}
              label="Asignar"
              options={[
                ...meta.agents.map((a) => ({ label: `🤖 ${a.name}`, onClick: () => runBulk("assign", { activeAgentId: a.id, assignedUserId: null }) })),
                ...meta.users.map((u) => ({ label: `👤 ${u.name}`, onClick: () => runBulk("assign", { assignedUserId: u.id, activeAgentId: null }) })),
              ]}
            />
            <BulkMenu
              icon={<Workflow size={14} />}
              label="Ejecutar flujo"
              options={workflows.map((w) => ({ label: w.name, onClick: () => setRunWfTarget(w) }))}
              empty="Sin flujos publicados"
            />
            <Button variant="secondary" className="px-2.5 py-1" onClick={() => runBulk("block")}><Ban size={14} /> Bloquear</Button>
            <Button variant="secondary" className="px-2.5 py-1" onClick={() => runBulk("unblock")}><ShieldCheck size={14} /> Desbloquear</Button>
            <Button variant="danger" className="px-2.5 py-1" onClick={() => setConfirmBulkDel(true)}><Trash2 size={14} /> Eliminar</Button>
            <button onClick={() => setSelected(new Set())} className="ml-auto text-brand-600 hover:underline dark:text-brand-400">Deseleccionar</button>
          </div>
        )}

        {/* Tabla */}
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-[1] bg-app text-left text-[12px] uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="w-10 px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={(e) => {
                      const next = new Set(selected);
                      rows.forEach((r) => (e.target.checked ? next.add(r.id) : next.delete(r.id)));
                      setSelected(next);
                    }}
                  />
                </th>
                <Th sortable active={sortBy === "firstName"} dir={sortDir} onSort={() => toggleSort("firstName")}>Contacto</Th>
                {visibleCols.has("channel") && <Th>Canal</Th>}
                {visibleCols.has("stage") && <Th>Etapa</Th>}
                {visibleCols.has("phone") && <Th>Teléfono</Th>}
                {visibleCols.has("email") && <Th>Email</Th>}
                {visibleCols.has("tags") && <Th>Etiquetas</Th>}
                {visibleCols.has("country") && <Th>País</Th>}
                {visibleCols.has("locale") && <Th>Idioma</Th>}
                {visibleCols.has("conv") && <Th>Conversación</Th>}
                {visibleCols.has("assigned") && <Th>Asignado</Th>}
                {visibleCols.has("lastContactAt") && (
                  <Th sortable active={sortBy === "lastContactAt"} dir={sortDir} onSort={() => toggleSort("lastContactAt")}>Último mensaje</Th>
                )}
                {visibleCols.has("createdAt") && (
                  <Th sortable active={sortBy === "createdAt"} dir={sortDir} onSort={() => toggleSort("createdAt")}>Creado</Th>
                )}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0
                ? Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-3 py-3" colSpan={13}>
                        <Skeleton className="h-6 w-full" />
                      </td>
                    </tr>
                  ))
                : rows.map((c) => {
                    const assigned = c.conversation?.activeAgentId
                      ? agentName.get(c.conversation.activeAgentId)
                      : c.conversation?.assignedUserId
                        ? userName.get(c.conversation.assignedUserId)
                        : null;
                    return (
                      <tr
                        key={c.id}
                        onClick={() => setOpenId(c.id)}
                        className={cn("cursor-pointer border-t border-line hover:bg-app/70", selected.has(c.id) && "bg-brand-50/40")}
                      >
                        <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selected.has(c.id)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              e.target.checked ? next.add(c.id) : next.delete(c.id);
                              setSelected(next);
                            }}
                          />
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700 dark:bg-brand-500/15 dark:text-brand-300">{initials(c)}</span>
                            <div className="min-w-0">
                              <p className="flex items-center gap-1.5 truncate font-medium text-ink">
                                {displayName(c)}
                                {c.blocked && <Ban size={12} className="shrink-0 text-red-500" />}
                              </p>
                              {c.profileName && displayName(c) !== c.profileName && <p className="truncate text-xs text-ink-subtle">wa: {c.profileName}</p>}
                            </div>
                          </div>
                        </td>
                        {visibleCols.has("channel") && <td className="px-3 py-2.5 text-ink-muted">{(c.channels ?? []).map((ch) => CHANNEL_LABEL[ch] ?? ch).join(", ") || "—"}</td>}
                        {visibleCols.has("stage") && (
                          <td className="px-3 py-2.5">
                            {c.stage ? (
                              <span className="inline-flex items-center gap-1.5 rounded-full bg-app px-2 py-0.5 text-xs font-medium text-ink">
                                <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.stage.color ?? "#94a3b8" }} />
                                {c.stage.name}
                              </span>
                            ) : (
                              <span className="text-ink-subtle">—</span>
                            )}
                          </td>
                        )}
                        {visibleCols.has("phone") && <td className="px-3 py-2.5 font-mono text-xs text-ink-muted">{c.phone ?? "—"}</td>}
                        {visibleCols.has("email") && <td className="max-w-[180px] truncate px-3 py-2.5 text-ink-muted">{c.email ?? "—"}</td>}
                        {visibleCols.has("tags") && (
                          <td className="px-3 py-2.5">
                            <div className="flex flex-wrap gap-1">
                              {(c.tags ?? []).length === 0 && <span className="text-ink-subtle">—</span>}
                              {(c.tags ?? []).slice(0, 3).map((t) => (
                                <span key={t.name} className="rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ background: (t.color ?? "#64748b") + "22", color: t.color ?? "#475569" }}>
                                  {t.name}
                                </span>
                              ))}
                              {(c.tags ?? []).length > 3 && <span className="text-[11px] text-ink-subtle">+{(c.tags ?? []).length - 3}</span>}
                            </div>
                          </td>
                        )}
                        {visibleCols.has("country") && <td className="px-3 py-2.5 text-ink-muted">{c.country ? `${flag(c.country)} ${c.country}` : "—"}</td>}
                        {visibleCols.has("locale") && <td className="px-3 py-2.5 uppercase text-ink-muted">{c.locale ?? "—"}</td>}
                        {visibleCols.has("conv") && (
                          <td className="px-3 py-2.5">
                            {c.conversation ? (
                              <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", CONV_STATUS[c.conversation.status]?.className ?? "bg-app text-ink-muted")}>
                                {CONV_STATUS[c.conversation.status]?.label ?? c.conversation.status}
                              </span>
                            ) : (
                              <span className="text-ink-subtle">—</span>
                            )}
                          </td>
                        )}
                        {visibleCols.has("assigned") && <td className="px-3 py-2.5 text-ink-muted">{assigned ?? "—"}</td>}
                        {visibleCols.has("lastContactAt") && <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">{fmtDate(c.lastContactAt)}</td>}
                        {visibleCols.has("createdAt") && <td className="whitespace-nowrap px-3 py-2.5 text-ink-muted">{fmtDate(c.createdAt)}</td>}
                      </tr>
                    );
                  })}
            </tbody>
          </table>

          {!loading && rows.length === 0 && (
            <div className="p-10">
              <EmptyState
                icon={<Contact2 size={30} />}
                title="Sin contactos"
                description={q || secCount || primary.kind !== "all" ? "Ningún contacto coincide con los filtros actuales." : "Aún no hay contactos. Se crean solos cuando alguien escribe por WhatsApp, o añádelos manualmente."}
                action={<Button onClick={() => setAddOpen(true)}><Plus size={15} /> Añadir contacto</Button>}
              />
            </div>
          )}
        </div>

        {/* Paginación */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-panel px-4 py-2.5 text-sm text-ink-muted">
          <div className="flex items-center gap-2">
            <span>{total.toLocaleString("es-CL")} contactos</span>
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              className="rounded-lg border border-line-strong bg-panel px-2 py-1 text-sm"
            >
              {[25, 50, 100].map((n) => (
                <option key={n} value={n}>{n} / página</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="secondary" className="px-2.5 py-1" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Anterior</Button>
            <span className="px-2">Página {page} de {totalPages}</span>
            <Button variant="secondary" className="px-2.5 py-1" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Siguiente</Button>
          </div>
        </div>
      </div>

      <AddContactModal open={addOpen} onClose={() => setAddOpen(false)} onCreated={() => { setAddOpen(false); loadMeta(); setPrimaryReset({ kind: "all" }); }} />

      <ContactDrawer id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />

      <ConfirmDialog
        open={confirmBulkDel}
        onClose={() => setConfirmBulkDel(false)}
        onConfirm={() => runBulk("delete")}
        title={`Eliminar ${selected.size} contacto(s)`}
        description="Se dan de baja (borrado lógico). Sus conversaciones se conservan."
        confirmLabel="Eliminar"
        danger
      />

      <ConfirmDialog
        open={runWfTarget !== null}
        onClose={() => setRunWfTarget(null)}
        onConfirm={() => runWfTarget && runWorkflowBulk(runWfTarget.id)}
        title={`Ejecutar «${runWfTarget?.name ?? ""}»`}
        description={`Se ejecutará el flujo sobre los ${selected.size} contacto(s) seleccionados. Cada uno inicia una ejecución independiente (según sus condiciones).`}
        confirmLabel="Ejecutar flujo"
      />

      <SaveSegmentModal open={saveSegOpen} onClose={() => setSaveSegOpen(false)} definition={currentDefinition} onSaved={() => { setSaveSegOpen(false); loadMeta(); }} />

      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={refresh} />
      <DuplicatesModal open={dupOpen} onClose={() => setDupOpen(false)} onDone={refresh} />
    </div>
  );
}

// --------------------------- Subcomponentes ---------------------------

function SideGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-line px-3 py-2">
      <p className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">{title}</p>
      {children}
    </div>
  );
}

function SideItem({
  icon,
  dot,
  label,
  count,
  active,
  onClick,
  onDelete,
}: {
  icon?: React.ReactNode;
  dot?: string;
  label: string;
  count?: number;
  active?: boolean;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className={cn(
        "group mb-0.5 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13.5px] transition-colors",
        active ? "bg-brand-50 font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300" : "text-ink-muted hover:bg-app",
      )}
    >
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        {dot ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} /> : <span className="shrink-0 text-ink-subtle">{icon}</span>}
        <span className="flex-1 truncate">{label}</span>
      </button>
      {onDelete ? (
        <button onClick={onDelete} className="hidden shrink-0 text-ink-subtle hover:text-red-500 group-hover:block" aria-label="Eliminar segmento" title="Eliminar segmento">
          <X size={13} />
        </button>
      ) : (
        count !== undefined && <span className={cn("shrink-0 text-xs", active ? "text-brand-500" : "text-ink-subtle")}>{count}</span>
      )}
    </div>
  );
}

function Th({
  children,
  sortable,
  active,
  dir,
  onSort,
}: {
  children: React.ReactNode;
  sortable?: boolean;
  active?: boolean;
  dir?: "asc" | "desc";
  onSort?: () => void;
}) {
  return (
    <th className="whitespace-nowrap px-3 py-2.5 font-semibold">
      {sortable ? (
        <button onClick={onSort} className={cn("inline-flex items-center gap-1 hover:text-ink", active && "text-ink")}>
          {children}
          <ChevronDown size={13} className={cn("transition-transform", active && dir === "asc" && "rotate-180", !active && "opacity-30")} />
        </button>
      ) : (
        children
      )}
    </th>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value?: string;
  onChange: (v: string | undefined) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-ink-muted">{label}</p>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="min-w-[130px] rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-sm"
      >
        <option value="">Todos</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function AddContactModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ firstName: "", lastName: "", phone: "", email: "", country: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setForm({ firstName: "", lastName: "", phone: "", email: "", country: "", notes: "" });
      setTimeout(() => firstRef.current?.focus(), 50);
    }
  }, [open]);

  async function submit() {
    if (!form.firstName && !form.lastName && !form.phone && !form.email) {
      toast.push("Indica al menos nombre, teléfono o email", "error");
      return;
    }
    setSaving(true);
    try {
      await api("/contacts", { method: "POST", body: JSON.stringify(form) });
      toast.push("Contacto creado", "ok");
      onCreated();
    } catch (e: any) {
      toast.push(e.message ?? "No se pudo crear", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Añadir contacto">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nombre"><input ref={firstRef} value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className={inputCls} /></Field>
          <Field label="Apellido"><input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className={inputCls} /></Field>
        </div>
        <Field label="Teléfono" hint="Se normaliza a formato E.164 (+56…)"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+56 9 1234 5678" className={inputCls} /></Field>
        <Field label="Email"><input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputCls} /></Field>
        <Field label="País (ISO-2)" hint="Ej.: CL, PE, MX"><input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase().slice(0, 2) })} className={inputCls} /></Field>
        <Field label="Nota"><textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className={inputCls} /></Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button onClick={submit} disabled={saving}>{saving ? "Guardando…" : "Crear contacto"}</Button>
      </div>
    </Modal>
  );
}

const inputCls = "w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm outline-none focus:border-brand-500";
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[11px] text-ink-subtle">{hint}</span>}
    </label>
  );
}

function BulkMenu({ icon, label, options, empty }: { icon: React.ReactNode; label: string; options: { label: string; onClick: () => void }[]; empty?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-panel px-2.5 py-1 text-sm font-medium text-ink-muted hover:bg-app">
        {icon} {label} <ChevronDown size={13} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 max-h-64 w-52 overflow-y-auto rounded-xl border border-line bg-panel p-1.5 shadow-pop">
            {options.length === 0 && <p className="px-2 py-1.5 text-sm text-ink-subtle">{empty ?? "Sin opciones"}</p>}
            {options.map((o, i) => (
              <button
                key={i}
                onClick={() => {
                  o.onClick();
                  setOpen(false);
                }}
                className="block w-full truncate rounded-lg px-2 py-1.5 text-left text-sm hover:bg-app"
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SaveSegmentModal({ open, onClose, definition, onSaved }: { open: boolean; onClose: () => void; definition: Record<string, unknown>; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setName("");
  }, [open]);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api("/contacts/segments", { method: "POST", body: JSON.stringify({ name: name.trim(), definition }) });
      toast.push("Segmento guardado", "ok");
      onSaved();
    } catch (e: any) {
      toast.push(e.message ?? "No se pudo guardar", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Guardar segmento">
      <p className="mb-3 text-sm text-ink-muted">Se guardan los filtros actuales como una vista reutilizable en el panel lateral.</p>
      <Field label="Nombre del segmento">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="Ej.: Prospectos de anuncios" className={inputCls} autoFocus />
      </Field>
      <div className="mt-3 flex flex-wrap gap-1">
        {Object.entries(definition).map(([k, v]) => (
          <span key={k} className="rounded bg-app px-1.5 py-0.5 text-[11px] text-ink-muted">{k}: {String(v)}</span>
        ))}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancelar</Button>
        <Button onClick={save} disabled={saving || !name.trim()}>{saving ? "Guardando…" : "Guardar"}</Button>
      </div>
    </Modal>
  );
}
