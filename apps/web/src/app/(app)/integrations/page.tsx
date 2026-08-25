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
  ShoppingBag,
  Store,
  Utensils,
  Webhook,
  Zap,
} from "lucide-react";
import {
  GoogleAnalyticsIcon,
  HubSpotIcon,
  MakeIcon,
  ShopifyIcon,
  WooCommerceIcon,
  ZapierIcon,
} from "@/components/brand-icons";
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
import { ApiPresetsDrawer, AutomationDrawer, ClarivaDrawer, CustomSchedulingDrawer, DentalinkDrawer, EmailDrawer, EventsManagerDrawer, Ga4Drawer, GoogleDrawer, HubspotDrawer, WebhooksDrawer, type AutomationState, type ClarivaState, type CustomSchedState, type DentalinkState, type EmailState, type Ga4State, type GoogleState, type HubspotState, type WebhookRow } from "./drawers";
import { CatalogDrawer } from "./catalog-drawer";

interface CatalogItem {
  key: string;
  name: string;
  category: "meta" | "agenda" | "datos" | "crm" | "comercio";
  status: "disponible" | "beta" | "proximamente" | "config_pendiente";
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
  metaCrm: { status: string; mode: string; businessName: string | null; lastError: string | null } | null;
  messagingChannels?: { messenger: boolean; instagram: boolean };
  clariva: ClarivaState | null;
  email: EmailState | null;
  platformEmailReady: boolean;
  apiPresets: { count: number; status: string | null };
  ga4: Ga4State | null;
  customScheduling: CustomSchedState | null;
  dentalink: DentalinkState | null;
  google: GoogleState | null;
  platformGoogleReady: boolean;
  hubspot: HubspotState | null;
  platformHubspotReady: boolean;
  capiConfigured: boolean;
  automations: { zapier: AutomationState | null; make: AutomationState | null };
  webhooks: WebhookRow[];
  availableEvents: string[];
  catalog: CatalogItem[];
}

const CATEGORY_LABELS: Record<string, string> = {
  meta: "Meta y mensajería",
  agenda: "Agenda y reservas",
  datos: "Productividad y datos",
  crm: "CRM y analítica",
  comercio: "Catálogo y comercio",
};

const CATALOG_ICONS: Record<string, React.ReactNode> = {
  meta: <MetaLogo size={20} />,
  meta_crm: <MetaLogo size={20} />,
  meta_leads: <MetaLogo size={20} />,
  meta_capi: <MetaLogo size={20} />,
  events_manager: <MetaLogo size={20} />,
  whatsapp: <MessageCircle size={20} />,
  clariva: <CalendarCheck size={20} />,
  google_calendar: <CalendarCheck size={20} />,
  custom_scheduling: <CalendarCheck size={20} />,
  dentalink: <CalendarCheck size={20} />,
  webhooks: <Webhook size={20} />,
  custom_api: <Webhook size={20} />,
  sheets: <Webhook size={20} />,
  zapier: <ZapierIcon size={20} />,
  make: <MakeIcon size={20} />,
  hubspot: <HubSpotIcon size={20} />,
  ga4: <GoogleAnalyticsIcon size={20} />,
  woocommerce: <WooCommerceIcon size={20} />,
  shopify: <ShopifyIcon size={20} />,
  jumpseller: <ShoppingBag size={20} />,
  bsale: <Store size={20} />,
  fudo: <Utensils size={20} />,
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
  const [customSchedOpen, setCustomSchedOpen] = useState(false);
  const [googleOpen, setGoogleOpen] = useState(false);
  const [dentalinkOpen, setDentalinkOpen] = useState(false);
  const [hubspotOpen, setHubspotOpen] = useState(false);
  const [automationOpen, setAutomationOpen] = useState<"zapier" | "make" | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activity, setActivity] = useState<any[] | null>(null);
  const [catalogSource, setCatalogSource] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const o = await api<Overview>("/integrations");
      // Blinda los arrays que la UI recorre (un tenant sin nada podría no traerlos).
      setData({ ...o, webhooks: o.webhooks ?? [], availableEvents: o.availableEvents ?? [], catalog: o.catalog ?? [] });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Resultado del retorno OAuth (Google/HubSpot redirigen a /integrations?provider=estado)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    for (const provider of ["google", "hubspot"] as const) {
      const result = params.get(provider);
      if (!result) continue;
      const label = provider === "google" ? "Google" : "HubSpot";
      if (result === "connected") {
        toast.push(`${label} conectado ✔ — ya puedes configurarlo`, "ok");
        if (provider === "google") setGoogleOpen(true);
        if (provider === "hubspot") setHubspotOpen(true);
      } else if (result === "denied") {
        toast.push(`Conexión con ${label} cancelada`, "info");
      } else {
        toast.push(`No se pudo conectar ${label} — intenta de nuevo`, "error");
      }
      window.history.replaceState(null, "", "/integrations");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Aviso del popup OAuth (la ventanita hace postMessage y se cierra sola)
  useEffect(() => {
    function onOAuthMessage(e: MessageEvent) {
      const d = e.data as { source?: string; provider?: string; result?: string } | null;
      if (!d || d.source !== "conversia-oauth") return;
      if (d.provider !== "google" && d.provider !== "hubspot") return;
      const label = d.provider === "google" ? "Google" : "HubSpot";
      if (d.result === "connected") {
        toast.push(`${label} conectado ✔`, "ok");
        void load();
        if (d.provider === "google") setGoogleOpen(true);
        else setHubspotOpen(true);
      } else if (d.result === "denied") {
        toast.push(`Conexión con ${label} cancelada`, "info");
      } else {
        toast.push(`No se pudo conectar ${label} — intenta de nuevo`, "error");
      }
    }
    window.addEventListener("message", onOAuthMessage);
    return () => window.removeEventListener("message", onOAuthMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (data.metaCrm && data.metaCrm.status !== "DISCONNECTED") {
      rows.push({
        key: "meta-crm",
        name: "Meta CRM (Lead Ads)",
        category: "Meta y mensajería",
        icon: <MetaLogo size={22} />,
        status: data.metaCrm.status === "CONNECTED" ? "connected" : data.metaCrm.status === "ERROR" ? "error" : "incomplete",
        detail: data.metaCrm.businessName ?? "Leads de formularios → CRM",
        health: data.metaCrm.status === "ERROR" ? "error" : "ok",
        onManage: () => router.push("/integrations/meta-crm"),
      });
    }
    if (data.messagingChannels?.instagram) {
      rows.push({
        key: "instagram",
        name: "Instagram",
        category: "Meta y mensajería",
        icon: <MessageCircle size={22} />,
        status: "connected",
        detail: "DMs en la bandeja con agentes IA",
        health: "ok",
        onManage: () => router.push("/channels"),
      });
    }
    if (data.messagingChannels?.messenger) {
      rows.push({
        key: "messenger",
        name: "Messenger",
        category: "Meta y mensajería",
        icon: <MessageCircle size={22} />,
        status: "connected",
        detail: "Mensajes de la página en la bandeja",
        health: "ok",
        onManage: () => router.push("/channels"),
      });
    }
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
        category: "Agenda y reservas",
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
    for (const kind of ["zapier", "make"] as const) {
      const auto = data.automations?.[kind];
      if (!auto) continue;
      const ep = data.webhooks.find((w) => w.id === auto.webhookEndpointId);
      const failing = ep?.successRate !== null && ep !== undefined && (ep.successRate as number) < 80 && (ep.deliveries7d ?? 0) > 0;
      rows.push({
        key: kind,
        name: kind === "zapier" ? "Zapier" : "Make",
        category: "Productividad y datos",
        icon: <Webhook size={22} />,
        status: failing ? "attention" : "connected",
        detail: ep
          ? `${ep.deliveries7d} entrega(s) 7d${ep.successRate !== null ? ` · ${ep.successRate}% OK` : ""}`
          : "sin entregas aún",
        health: failing ? "warn" : "ok",
        onManage: () => setAutomationOpen(kind),
      });
    }
    if (data.customScheduling) {
      rows.push({
        key: "custom_scheduling",
        name: "Agenda personalizada",
        category: "Agenda y reservas",
        icon: <CalendarCheck size={22} />,
        status: data.customScheduling.status === "error" ? "attention" : "connected",
        detail: data.customScheduling.baseUrl ?? "",
        health: data.customScheduling.status === "error" ? "warn" : "ok",
        onManage: () => setCustomSchedOpen(true),
      });
    }
    if (data.dentalink) {
      rows.push({
        key: "dentalink",
        name: "Dentalink",
        category: "Agenda y reservas",
        icon: <CalendarCheck size={22} />,
        status: data.dentalink.status === "error" ? "attention" : "connected",
        detail: `Ventana ${data.dentalink.workStartHour}:00–${data.dentalink.workEndHour}:00 · bloques de ${data.dentalink.slotMinutes} min`,
        health: data.dentalink.status === "error" ? "warn" : "ok",
        onManage: () => setDentalinkOpen(true),
      });
    }
    if (data.google) {
      rows.push({
        key: "google",
        name: "Google Calendar y Sheets",
        category: "Agenda y reservas",
        icon: <CalendarCheck size={22} />,
        status: data.google.status === "reauthorize" ? "error" : data.google.lastError ? "attention" : "connected",
        statusLabel: data.google.status === "reauthorize" ? "Reconectar" : undefined,
        detail: data.google.calendarSync
          ? `Espejo de citas activo${data.google.lastSyncAt ? ` · sync ${new Date(data.google.lastSyncAt).toLocaleString("es-CL")}` : ""}`
          : "Cuenta conectada (espejo de citas apagado)",
        health: data.google.status === "reauthorize" ? "error" : data.google.lastError ? "warn" : "ok",
        onManage: () => setGoogleOpen(true),
      });
    }
    if (data.hubspot) {
      rows.push({
        key: "hubspot",
        name: "HubSpot",
        category: "CRM y analítica",
        icon: <Plug size={22} />,
        status: data.hubspot.status === "reauthorize" ? "error" : data.hubspot.lastError ? "attention" : "connected",
        statusLabel: data.hubspot.status === "reauthorize" ? "Reconectar" : undefined,
        detail: `${data.hubspot.syncAuto ? "Sync automático activo" : "Sync manual"}${data.hubspot.lastSyncAt ? ` · última ${new Date(data.hubspot.lastSyncAt).toLocaleString("es-CL")}` : ""}`,
        health: data.hubspot.status === "reauthorize" ? "error" : data.hubspot.lastError ? "warn" : "ok",
        onManage: () => setHubspotOpen(true),
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

  // Lo conectado se marca DENTRO del catálogo (una sola lista, sin sección
  // duplicada arriba). Los alias resuelven claves distintas entre la conexión
  // y el catálogo (meta-crm↔meta_crm; google cubre Calendar y Sheets; la
  // conexión Meta cubre WhatsApp y CAPI).
  const connectedByKey = useMemo(() => {
    const alias: Record<string, string[]> = {
      "meta-crm": ["meta_crm"],
      google: ["google_calendar", "sheets"],
      meta: ["meta", "whatsapp", "meta_capi"],
    };
    const m = new Map<string, (typeof connected)[number]>();
    for (const c of connected) for (const k of alias[c.key] ?? [c.key]) m.set(k, c);
    return m;
  }, [connected]);

  const filteredCatalog = useMemo(() => {
    if (!data) return [];
    return data.catalog.filter((c) => {
      const conn = connectedByKey.get(c.key);
      if (categoryFilter !== "todas" && c.category !== categoryFilter) return false;
      if (statusFilter === "conectadas" && !conn) return false;
      if (statusFilter === "atencion" && !(conn && (conn.status === "attention" || conn.status === "error" || conn.status === "incomplete"))) return false;
      if (statusFilter === "disponibles" && (conn || c.status === "proximamente" || c.status === "config_pendiente")) return false;
      if (statusFilter === "proximamente" && c.status !== "proximamente") return false;
      if (search && !`${c.name} ${c.description}`.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [data, categoryFilter, statusFilter, search, connectedByKey]);

  async function notifyInterest(key: string) {
    await api("/integrations/interest", { method: "POST", body: JSON.stringify({ key }) });
    toast.push("Anotado — te avisaremos cuando esté disponible", "ok");
  }

  function catalogAction(item: CatalogItem) {
    switch (item.key) {
      case "meta_crm":
      case "instagram":
      case "messenger":
        return router.push("/integrations/meta-crm");
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
      case "custom_scheduling":
        return setCustomSchedOpen(true);
      case "google_calendar":
      case "sheets":
        return setGoogleOpen(true);
      case "dentalink":
        return setDentalinkOpen(true);
      case "hubspot":
        return setHubspotOpen(true);
      case "zapier":
      case "make":
        return setAutomationOpen(item.key);
      case "woocommerce":
        return setCatalogSource("woocommerce");
      case "jumpseller":
        return setCatalogSource("jumpseller");
      case "fudo":
        return setCatalogSource("fudo");
      case "shopify":
        return setCatalogSource("shopify");
      case "bsale":
        return setCatalogSource("bsale");
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
          description="Todo lo que se conecta con tu cuenta además de los canales: campañas y leads de Meta, agenda, datos, CRM y comercio. Los canales de conversación (WhatsApp, Instagram, Messenger) se administran en Canales."
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
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar integración…"
                className="w-64 rounded-lg border border-line-strong bg-panel py-2 pl-9 pr-3 text-sm"
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
                      ? "border-brand-300 bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300 dark:border-brand-500/40"
                      : "border-line bg-panel text-ink-muted hover:border-line-strong",
                  )}
                >
                  {label}
                </button>
              ))}
              <span className="mx-1 w-px bg-line" aria-hidden />
              {(["todas", "meta", "agenda", "datos", "crm", "comercio"] as const).map((value) => (
                <button
                  key={value}
                  onClick={() => setCategoryFilter(value)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-medium",
                    categoryFilter === value
                      ? "border-accent-500/40 bg-accent-500/10 text-accent-600 dark:text-accent-400"
                      : "border-line bg-panel text-ink-muted hover:border-line-strong",
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

        {/* Catálogo ÚNICO: lo conectado se marca aquí mismo (sin sección aparte) */}
        <section id="catalogo">
          {!data ? (
            <Skeleton className="h-64" />
          ) : filteredCatalog.length === 0 ? (
            statusFilter === "conectadas" ? (
              <EmptyState
                icon={<Plug size={32} />}
                title="Todavía no hay integraciones conectadas"
                description="Empieza por Meta Business Suite para WhatsApp y campañas, o conecta tu agenda y tus sistemas."
                action={<Button onClick={() => router.push("/integrations/meta")}>Conectar Meta</Button>}
              />
            ) : (
              <EmptyState title="Sin resultados" description="Prueba con otros filtros o términos de búsqueda." />
            )
          ) : (
            (["meta", "agenda", "datos", "crm", "comercio"] as const).map((cat) => {
              const items = filteredCatalog.filter((c) => c.category === cat);
              if (items.length === 0) return null;
              return (
                <div key={cat} className="mb-8">
                  <h3 className="mb-2.5 text-[13px] font-semibold uppercase tracking-wide text-ink-subtle">
                    {CATEGORY_LABELS[cat]}
                  </h3>
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                    {items.map((item) => {
                      const conn = connectedByKey.get(item.key);
                      return (
                      <div
                        key={item.key}
                        className={cn(
                          "flex flex-col rounded-card border bg-panel p-4 shadow-card transition-shadow",
                          item.status === "proximamente" ? "border-line opacity-80" : conn ? "border-brand-200 hover:shadow-pop dark:border-brand-500/30" : "border-line hover:shadow-pop",
                        )}
                      >
                        <div className="flex items-start justify-between">
                          {/* El MISMO logo conectada o no (el de la conexión gana) */}
                          <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg", conn ? "bg-navy-900 text-accent-400" : "bg-app text-ink-muted")}>
                            {conn?.icon ?? CATALOG_ICONS[item.key] ?? <Plug size={20} />}
                          </div>
                          <div className="flex items-center gap-1.5">
                            {conn && <HealthDot level={conn.health} />}
                            <StatusBadge
                              kind={conn ? conn.status : item.status === "disponible" ? "connected" : item.status === "beta" ? "beta" : item.status === "config_pendiente" ? "incomplete" : "soon"}
                              label={conn ? (conn.statusLabel ?? "Conectada") : item.status === "disponible" ? "Disponible" : item.status === "config_pendiente" ? "Requiere configuración" : undefined}
                            />
                          </div>
                        </div>
                        <p className="mt-2.5 font-semibold">{item.name}</p>
                        <p className="mt-0.5 flex-1 text-[13px] leading-relaxed text-ink-muted">{item.description}</p>
                        {conn?.detail && <p className="mt-1.5 truncate text-xs text-ink-subtle">{conn.detail}</p>}
                        <div className="mt-2.5 flex flex-wrap gap-1">
                          {(item.capabilities ?? []).map((cap) => (
                            <span key={cap} className="rounded bg-app px-1.5 py-0.5 text-[10px] text-ink-muted">{cap}</span>
                          ))}
                        </div>
                        <div className="mt-3 border-t border-line pt-3">
                          {item.status === "proximamente" ? (
                            <Button variant="ghost" className="w-full" onClick={() => void notifyInterest(item.key)}>
                              <Bell size={14} /> Avisarme cuando esté disponible
                            </Button>
                          ) : (
                            <Button variant="secondary" className="w-full" onClick={() => (conn ? conn.onManage() : catalogAction(item))}>
                              {conn ? "Administrar" : "Conectar"}
                              <ArrowRight size={14} />
                            </Button>
                          )}
                        </div>
                      </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </section>
      </div>

      {/* Drawers */}
      <CatalogDrawer open={catalogSource !== null} source={catalogSource ?? ""} onClose={() => setCatalogSource(null)} onChanged={() => void load()} />
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
      <CustomSchedulingDrawer open={customSchedOpen} onClose={() => setCustomSchedOpen(false)} state={data?.customScheduling ?? null} onChanged={() => void load()} />
      <GoogleDrawer open={googleOpen} onClose={() => setGoogleOpen(false)} state={data?.google ?? null} platformReady={data?.platformGoogleReady ?? false} onChanged={() => void load()} />
      <DentalinkDrawer open={dentalinkOpen} onClose={() => setDentalinkOpen(false)} state={data?.dentalink ?? null} onChanged={() => void load()} />
      <HubspotDrawer open={hubspotOpen} onClose={() => setHubspotOpen(false)} state={data?.hubspot ?? null} platformReady={data?.platformHubspotReady ?? false} onChanged={() => void load()} />
      {(["zapier", "make"] as const).map((kind) => (
        <AutomationDrawer
          key={kind}
          open={automationOpen === kind}
          onClose={() => setAutomationOpen(null)}
          kind={kind}
          state={data?.automations?.[kind] ?? null}
          webhooks={data?.webhooks ?? []}
          onChanged={() => void load()}
        />
      ))}
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
              <li key={a.id} className="rounded-lg border border-line px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase text-ink-subtle">{a.provider}</span>
                  <span className="text-ink-subtle">{new Date(a.createdAt).toLocaleString("es-CL")}</span>
                </div>
                <p className={cn("mt-0.5", a.status === "error" ? "text-red-600 dark:text-red-400" : a.status === "warning" ? "text-amber-700 dark:text-amber-300" : "text-ink-muted")}>
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
