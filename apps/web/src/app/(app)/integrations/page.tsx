"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  CalendarCheck,
  Infinity as MetaLogo,
  MessageCircle,
  Plug,
  Search,
  Webhook,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  Button,
  Drawer,
  EmptyState,
  HealthDot,
  MetricCard,
  PageHeader,
  Skeleton,
  StatusBadge,
  cn,
  useToast,
  type StatusKind,
} from "@/components/ui";
import { ApiPresetsDrawer, ClarivaDrawer, EmailDrawer, EventsManagerDrawer, Ga4Drawer, WebhooksDrawer, type ClarivaState, type EmailState, type Ga4State, type WebhookRow } from "./drawers";

interface CatalogItem {
  key: string;
  name: string;
  category: "meta" | "agenda" | "datos" | "crm";
  status: "disponible" | "beta" | "proximamente";
  description: string;
  capabilities: string[];
}

interface Overview {
  metrics: {
    active: number;
    attention: number;
    events24h: number;
    webhookErrors7d: number;
    lastActivityAt: string | null;
    lastSyncAt: string | null;
  };
  meta: { status: string; mode: string; businessName: string | null; lastError: string | null } | null;
  clariva: ClarivaState | null;
  email: EmailState | null;
  platformEmailReady: boolean;
  apiPresets: { count: number; status: string | null };
  ga4: Ga4State | null;
  webhooks: WebhookRow[];
  availableEvents: string[];
  catalog: CatalogItem[];
}

const CATEGORY_LABELS: Record<string, string> = {
  meta: "Meta y mensajería",
  agenda: "Agenda y gestión clínica",
  datos: "Productividad y datos",
  crm: "CRM y analítica",
};

const CATALOG_ICONS: Record<string, React.ReactNode> = {
  meta: <MetaLogo size={20} />,
  whatsapp: <MessageCircle size={20} />,
  clariva: <CalendarCheck size={20} />,
  webhooks: <Webhook size={20} />,
};

export default function IntegrationsPage() {
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"todas" | "conectadas" | "atencion" | "disponibles" | "proximamente">("todas");
  const [categoryFilter, setCategoryFilter] = useState<string>("todas");
  const [clarivaOpen, setClarivaOpen] = useState(false);
  const [webhooksOpen, setWebhooksOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [ga4Open, setGa4Open] = useState(false);
  const [emOpen, setEmOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activity, setActivity] = useState<any[] | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Overview>("/integrations"));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (activityOpen) {
      setActivity(null);
      void api<any[]>("/integrations/activity?take=60").then(setActivity).catch(() => setActivity([]));
    }
  }, [activityOpen]);

  const connected = useMemo(() => {
    if (!data) return [];
    const rows: Array<{
      key: string;
      name: string;
      category: string;
      icon: React.ReactNode;
      status: StatusKind;
      statusLabel?: string;
      detail: string;
      health: "ok" | "warn" | "error";
      onManage: () => void;
    }> = [];
    if (data.meta && data.meta.status !== "DISCONNECTED") {
      rows.push({
        key: "meta",
        name: "Meta Business Suite",
        category: "Meta y mensajería",
        icon: <MetaLogo size={22} />,
        status: data.meta.mode === "MOCK" ? "mock" : data.meta.status === "CONNECTED" ? "connected" : data.meta.status === "ERROR" ? "error" : "incomplete",
        detail: data.meta.businessName ?? "Conexión Meta",
        health: data.meta.status === "ERROR" ? "error" : data.meta.mode === "MOCK" ? "warn" : "ok",
        onManage: () => router.push("/integrations/meta"),
      });
    }
    if (data.clariva && data.clariva.status === "active") {
      rows.push({
        key: "clariva",
        name: "Cláriva",
        category: "Agenda y gestión clínica",
        icon: <CalendarCheck size={22} />,
        status: data.clariva.lastError ? "attention" : "connected",
        detail: `${data.clariva.baseUrl ?? ""} · sync ${data.clariva.lastSyncAt ? new Date(data.clariva.lastSyncAt).toLocaleString("es-CL") : "pendiente"}`,
        health: data.clariva.lastError ? "warn" : "ok",
        onManage: () => setClarivaOpen(true),
      });
    }
    if (data.webhooks.length > 0) {
      const failing = data.webhooks.some((w) => w.successRate !== null && w.successRate < 80);
      rows.push({
        key: "webhooks",
        name: `Webhooks salientes (${data.webhooks.length})`,
        category: "Productividad y datos",
        icon: <Webhook size={22} />,
        status: failing ? "attention" : "connected",
        detail: data.webhooks.map((w) => w.name).slice(0, 3).join(", "),
        health: failing ? "warn" : "ok",
        onManage: () => setWebhooksOpen(true),
      });
    }
    if (data.apiPresets.count > 0) {
      rows.push({
        key: "custom_api",
        name: `API personalizada (${data.apiPresets.count} preset${data.apiPresets.count > 1 ? "s" : ""})`,
        category: "Productividad y datos",
        icon: <Webhook size={22} />,
        status: "connected",
        detail: "Presets del paso «Petición HTTP» con auth cifrada",
        health: "ok",
        onManage: () => setPresetsOpen(true),
      });
    }
    if (data.ga4) {
      rows.push({
        key: "ga4",
        name: "Google Analytics",
        category: "CRM y analítica",
        icon: <Webhook size={22} />,
        status: data.ga4.status === "error" ? "attention" : "connected",
        detail: `${data.ga4.measurementId ?? ""}${data.ga4.mirrorCapi ? " · espejo CAPI activo" : ""}`,
        health: data.ga4.status === "error" ? "warn" : "ok",
        onManage: () => setGa4Open(true),
      });
    }
    if (data.email) {
      const uses = [
        data.email.escalation?.enabled ? "escalamientos" : null,
        data.email.dailySummary?.enabled ? "resumen diario" : null,
        data.email.alerts?.enabled ? "alertas" : null,
      ].filter(Boolean);
      rows.push({
        key: "email",
        name: "Correo electrónico",
        category: "Productividad y datos",
        icon: <MessageCircle size={22} />,
        status: data.email.status === "error" ? "attention" : "connected",
        detail: `${data.email.mode === "smtp" ? "SMTP propio" : "remitente de plataforma"}${uses.length ? ` · ${uses.join(", ")}` : ""}`,
        health: data.email.status === "error" ? "warn" : "ok",
        onManage: () => setEmailOpen(true),
      });
    }
    return rows;
  }, [data, router]);

  const filteredCatalog = useMemo(() => {
    if (!data) return [];
    return data.catalog.filter((c) => {
      if (categoryFilter !== "todas" && c.category !== categoryFilter) return false;
      if (statusFilter === "disponibles" && c.status === "proximamente") return false;
      if (statusFilter === "proximamente" && c.status !== "proximamente") return false;
      if (statusFilter === "conectadas") return false; // conectadas viven en su propia sección
      if (search && !`${c.name} ${c.description}`.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [data, categoryFilter, statusFilter, search]);

  async function notifyInterest(key: string) {
    await api("/integrations/interest", { method: "POST", body: JSON.stringify({ key }) });
    toast.push("Anotado — te avisaremos cuando esté disponible", "ok");
  }

  function catalogAction(item: CatalogItem) {
    switch (item.key) {
      case "meta":
      case "meta_leads":
      case "meta_capi":
        return router.push("/integrations/meta");
      case "whatsapp":
        return router.push("/channels");
      case "clariva":
        return setClarivaOpen(true);
      case "webhooks":
        return setWebhooksOpen(true);
      case "email":
        return setEmailOpen(true);
      case "custom_api":
        return setPresetsOpen(true);
      case "ga4":
        return setGa4Open(true);
      case "events_manager":
        return setEmOpen(true);
      default:
        return void notifyInterest(item.key);
    }
  }

  if (error) {
    return (
      <div className="p-8">
        <EmptyState
          icon={<AlertTriangle size={32} />}
          title="No pudimos cargar las integraciones"
          description={error}
          action={<Button onClick={() => void load()}>Reintentar</Button>}
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] px-6 py-6 lg:px-8">
        <PageHeader
          title="Integraciones"
          description="Conecta Meta, tu agenda clínica y tus sistemas. Todo con credenciales cifradas por organización."
          actions={
            <>
              <Button variant="secondary" onClick={() => (window.location.href = "/integrations/developers")}>
                {"</>"} Desarrolladores
              </Button>
              <Button variant="secondary" onClick={() => setActivityOpen(true)}>
                <Activity size={15} /> Actividad
              </Button>
              <Button onClick={() => document.getElementById("catalogo")?.scrollIntoView({ behavior: "smooth" })}>
                <Plug size={15} /> Conectar integración
              </Button>
            </>
          }
        >
          {/* Buscador + filtros */}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar integración…"
                className="w-64 rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm"
                aria-label="Buscar integración"
              />
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtrar por estado">
              {(
                [
                  ["todas", "Todas"],
                  ["conectadas", "Conectadas"],
                  ["atencion", "Requieren atención"],
                  ["disponibles", "Disponibles"],
                  ["proximamente", "Próximamente"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setStatusFilter(value)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium",
                    statusFilter === value
                      ? "border-brand-300 bg-brand-50 text-brand-700"
                      : "border-slate-200 bg-white text-slate-500 hover:border-slate-300",
                  )}
                >
                  {label}
                </button>
              ))}
              <span className="mx-1 w-px bg-slate-200" aria-hidden />
              {(["todas", "meta", "agenda", "datos", "crm"] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => setCategoryFilter(value)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium",
                    categoryFilter === value
                      ? "border-accent-500/40 bg-accent-500/10 text-accent-600"
                      : "border-slate-200 bg-white text-slate-500 hover:border-slate-300",
                  )}
                >
                  {value === "todas" ? "Todas las categorías" : CATEGORY_LABELS[value]}
                </button>
              ))}
            </div>
          </div>
        </PageHeader>

        {/* Indicadores */}
        {!data ? (
          <div className="mb-8 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
        ) : (
          <div className="mb-8 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <MetricCard label="Integraciones activas" value={data.metrics.active} icon={<Plug size={16} />} />
            <MetricCard
              label="Requieren atención"
              value={data.metrics.attention}
              tone={data.metrics.attention > 0 ? "warn" : "ok"}
              icon={<AlertTriangle size={16} />}
            />
            <MetricCard label="Eventos (24 h)" value={data.metrics.events24h} icon={<Zap size={16} />} />
            <MetricCard
              label="Errores de webhooks (7 d)"
              value={data.metrics.webhookErrors7d}
              tone={data.metrics.webhookErrors7d > 0 ? "danger" : "ok"}
              icon={<Webhook size={16} />}
            />
            <MetricCard
              label="Última sincronización"
              value={data.metrics.lastSyncAt ? new Date(data.metrics.lastSyncAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" }) : "—"}
              hint={data.metrics.lastSyncAt ? new Date(data.metrics.lastSyncAt).toLocaleDateString("es-CL") : "sin sincronizaciones aún"}
            />
          </div>
        )}

        {/* Conectadas */}
        {(statusFilter === "todas" || statusFilter === "conectadas" || statusFilter === "atencion") && (
          <section className="mb-10">
            <h2 className="mb-3 text-lg font-semibold">Conectadas</h2>
            {!data ? (
              <Skeleton className="h-36" />
            ) : connected.length === 0 ? (
              <EmptyState
                icon={<Plug size={32} />}
                title="Todavía no hay integraciones conectadas"
                description="Empieza por Meta Business Suite para WhatsApp y campañas, o conecta tu agenda Cláriva."
                action={<Button onClick={() => router.push("/integrations/meta")}>Conectar Meta</Button>}
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
                {connected
                  .filter((c) => statusFilter !== "atencion" || c.status === "attention" || c.status === "error")
                  .map((c) => (
                    <div key={c.key} className="rounded-card border border-slate-200 bg-white p-5 shadow-card transition-shadow hover:shadow-pop">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-navy-900 text-accent-400">{c.icon}</div>
                          <div>
                            <p className="font-semibold">{c.name}</p>
                            <p className="text-xs text-slate-400">{c.category}</p>
                          </div>
                        </div>
                        <HealthDot level={c.health} />
                      </div>
                      <div className="mt-3 flex items-center gap-2">
                        <StatusBadge kind={c.status} label={c.statusLabel} />
                      </div>
                      <p className="mt-2 truncate text-sm text-slate-500">{c.detail}</p>
                      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
                        <Button variant="secondary" onClick={c.onManage}>
                          Administrar <ArrowRight size={14} />
                        </Button>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </section>
        )}

        {/* Catálogo */}
        <section id="catalogo">
          <h2 className="mb-3 text-lg font-semibold">Catálogo</h2>
          {!data ? (
            <Skeleton className="h-64" />
          ) : filteredCatalog.length === 0 ? (
            <EmptyState title="Sin resultados" description="Prueba con otros filtros o términos de búsqueda." />
          ) : (
            (["meta", "agenda", "datos", "crm"] as const).map((cat) => {
              const items = filteredCatalog.filter((c) => c.category === cat);
              if (items.length === 0) return null;
              return (
                <div key={cat} className="mb-8">
                  <h3 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-slate-400">
                    {CATEGORY_LABELS[cat]}
                  </h3>
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {items.map((item) => (
                      <div
                        key={item.key}
                        className={cn(
                          "flex flex-col rounded-card border bg-white p-4 shadow-card transition-shadow",
                          item.status === "proximamente" ? "border-slate-200 opacity-80" : "border-slate-200 hover:shadow-pop",
                        )}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
                            {CATALOG_ICONS[item.key] ?? <Plug size={20} />}
                          </div>
                          <StatusBadge
                            kind={item.status === "disponible" ? "connected" : item.status === "beta" ? "beta" : "soon"}
                            label={item.status === "disponible" ? "Disponible" : undefined}
                          />
                        </div>
                        <p className="mt-2.5 font-semibold">{item.name}</p>
                        <p className="mt-0.5 flex-1 text-[13px] leading-relaxed text-slate-500">{item.description}</p>
                        <div className="mt-2.5 flex flex-wrap gap-1">
                          {item.capabilities.map((cap) => (
                            <span key={cap} className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{cap}</span>
                          ))}
                        </div>
                        <div className="mt-3 border-t border-slate-100 pt-3">
                          {item.status === "proximamente" ? (
                            <Button variant="ghost" className="w-full" onClick={() => void notifyInterest(item.key)}>
                              <Bell size={14} /> Avisarme cuando esté disponible
                            </Button>
                          ) : (
                            <Button variant="secondary" className="w-full" onClick={() => catalogAction(item)}>
                              {["meta", "clariva", "webhooks", "whatsapp"].includes(item.key) && connected.some((c) => item.key.startsWith(c.key)) ? "Administrar" : "Conectar"}
                              <ArrowRight size={14} />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </section>
      </div>

      {/* Drawers */}
      <ClarivaDrawer open={clarivaOpen} onClose={() => setClarivaOpen(false)} state={data?.clariva ?? null} onChanged={() => void load()} />
      <EmailDrawer
        open={emailOpen}
        onClose={() => setEmailOpen(false)}
        state={data?.email ?? null}
        platformReady={data?.platformEmailReady ?? false}
        onChanged={() => void load()}
      />
      <ApiPresetsDrawer open={presetsOpen} onClose={() => setPresetsOpen(false)} onChanged={() => void load()} />
      <Ga4Drawer open={ga4Open} onClose={() => setGa4Open(false)} state={data?.ga4 ?? null} onChanged={() => void load()} />
      <EventsManagerDrawer open={emOpen} onClose={() => setEmOpen(false)} />
      <WebhooksDrawer
        open={webhooksOpen}
        onClose={() => setWebhooksOpen(false)}
        webhooks={data?.webhooks ?? []}
        availableEvents={data?.availableEvents ?? []}
        onChanged={() => void load()}
      />
      <Drawer open={activityOpen} onClose={() => setActivityOpen(false)} title="Actividad de integraciones">
        {activity === null ? (
          <Skeleton className="h-40" />
        ) : activity.length === 0 ? (
          <EmptyState title="Sin actividad registrada" description="Los eventos, sincronizaciones y errores de tus integraciones aparecerán aquí." />
        ) : (
          <ul className="space-y-1.5">
            {activity.map((a) => (
              <li key={a.id} className="rounded-lg border border-slate-100 px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase text-slate-400">{a.provider}</span>
                  <span className="text-slate-400">{new Date(a.createdAt).toLocaleString("es-CL")}</span>
                </div>
                <p className={cn("mt-0.5", a.status === "error" ? "text-red-600" : a.status === "warning" ? "text-amber-700" : "text-slate-600")}>
                  {a.message ?? a.type}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Drawer>
    </div>
  );
}
