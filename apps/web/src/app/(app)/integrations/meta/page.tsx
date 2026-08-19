"use client";

/** Centro de integraciones Meta Business Suite. */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  FileSpreadsheet,
  Megaphone,
  MessageCircle,
  Phone,
  Send,
  Target,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  Skeleton,
  StatusBadge,
  Tabs,
  cn,
  useToast,
} from "@/components/ui";
import { EventMappingEditor, FieldMappingEditor, LeadAdsPagesPanel, MetaWizard, PermissionChecklist } from "./panels";

interface Asset {
  id: string;
  kind: string;
  externalId: string;
  name: string;
  enabled: boolean;
}

export interface MetaOverview {
  connection: { status: string; mode: string; businessId: string | null; businessName: string | null; lastError: string | null } | null;
  embeddedSignup: { available: boolean; pendingReason: string };
  mockAllowed: boolean;
  assets: {
    pages: Asset[];
    adAccounts: Asset[];
    wabas: Asset[];
    phoneNumbers: Asset[];
    instagram: Asset[];
    datasets: Asset[];
    leadForms: Asset[];
  };
  whatsapp: { numbers: Array<{ id: string; phoneNumberId: string; displayPhone: string; status: string }>; channels: Array<{ id: string; name: string; status: string }> };
  leadMapping: { mappings: Array<{ source: string; target: string }>; config: Record<string, any>; active: boolean } | null;
  eventMapping: { datasetId: string | null; testEventCode: string | null; rules: any[]; active: boolean } | null;
  checklist: {
    connected: boolean;
    pageSelected: boolean;
    wabaLinked: boolean;
    phoneConnected: boolean;
    webhookConfigured: boolean;
    leadFormsSubscribed: boolean;
    leadMappingReady: boolean;
    datasetConfigured: boolean;
    capiReady: boolean;
  };
  recentEvents: any[];
}

function AssetNode({ icon, title, items, empty }: { icon: React.ReactNode; title: string; items: Asset[]; empty: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-3.5 shadow-card">
      <p className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink-muted">
        <span className="text-brand-600 dark:text-brand-400">{icon}</span> {title}
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-ink-subtle">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((a) => (
            <li key={a.id} className={cn("flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-[13px]", a.enabled ? "bg-brand-50/60" : "opacity-50")}>
              <span className="truncate">{a.name}</span>
              <span className="shrink-0 font-mono text-[10px] text-ink-subtle">{a.externalId.slice(0, 14)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function MetaCenterPage() {
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState<MetaOverview | null>(null);
  const [tab, setTab] = useState("resumen");
  const [wizardOpen, setWizardOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [leadStatuses, setLeadStatuses] = useState<Array<{ code: string; name: string }>>([]);
  const [activity, setActivity] = useState<any[] | null>(null);

  const load = useCallback(async () => {
    const [overview, catalog] = await Promise.all([
      api<MetaOverview>("/integrations/meta"),
      api<{ leadStatuses: Array<{ code: string; name: string }> }>("/workflows/meta/catalog"),
    ]);
    setData(overview);
    setLeadStatuses(catalog.leadStatuses);
  }, []);

  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  useEffect(() => {
    if (tab === "actividad") {
      setActivity(null);
      void api<any[]>("/integrations/activity?take=80").then((rows) =>
        setActivity(rows.filter((r) => ["meta", "lead_ads", "capi", "whatsapp", "events"].includes(r.provider))),
      );
    }
  }, [tab]);

  async function disconnect() {
    await api("/integrations/meta/disconnect", { method: "POST" });
    toast.push("Conexión Meta desconectada", "info");
    await load();
  }

  const connection = data?.connection;
  const statusKind = !connection || connection.status === "DISCONNECTED"
    ? "disconnected"
    : connection.mode === "MOCK"
      ? "mock"
      : connection.status === "CONNECTED"
        ? "connected"
        : connection.status === "ERROR"
          ? "error"
          : "incomplete";

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] px-6 py-6 lg:px-8">
        <PageHeader
          title="Meta Business Suite"
          description="Una conexión, todo el ecosistema: WhatsApp, Lead Ads, Conversions API y — pronto — Instagram y Messenger."
          actions={
            <>
              <Button variant="secondary" onClick={() => router.push("/integrations")}>← Integraciones</Button>
              {connection && connection.status !== "DISCONNECTED" ? (
                <>
                  <Button variant="secondary" onClick={() => setWizardOpen(true)}>Reconfigurar</Button>
                  <Button variant="danger" onClick={() => setConfirmDisconnect(true)}>Desconectar</Button>
                </>
              ) : (
                <Button onClick={() => setWizardOpen(true)}>Conectar Meta</Button>
              )}
            </>
          }
        />

        {!data ? (
          <div className="space-y-4">
            <Skeleton className="h-24" />
            <Skeleton className="h-64" />
          </div>
        ) : (
          <>
            {/* Estado de conexión */}
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-panel p-5 shadow-card">
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-navy-900 text-accent-400">
                  <Building2 size={24} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-semibold">{connection?.businessName ?? "Sin conexión con Meta"}</p>
                    <StatusBadge kind={statusKind as any} />
                  </div>
                  <p className="text-xs text-ink-subtle">
                    {connection
                      ? `Modo: ${connection.mode === "MOCK" ? "simulación de desarrollo (no toca Meta)" : connection.mode === "MANUAL" ? "manual (ids + token)" : "Embedded Signup"}`
                      : "Conecta tu Business Portfolio para habilitar los módulos"}
                  </p>
                  {connection?.lastError && <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{connection.lastError}</p>}
                </div>
              </div>
              {data.connection?.mode === "MOCK" && (
                <p className="max-w-xs rounded-lg bg-violet-50 px-3 py-2 text-xs text-violet-700 dark:bg-violet-500/10 dark:text-violet-300">
                  Conexión simulada para desarrollo: los envíos hacia Meta se registran pero <b>no</b> salen de la plataforma.
                </p>
              )}
            </div>

            <Tabs
              tabs={[
                { id: "resumen", label: "Resumen" },
                { id: "leadads", label: "Lead Ads", badge: data.checklist.leadMappingReady ? "activo" : undefined },
                { id: "capi", label: "Conversions API", badge: data.checklist.capiReady ? "activo" : undefined },
                { id: "actividad", label: "Actividad" },
              ]}
              active={tab}
              onChange={setTab}
            />

            <div className="py-6">
              {tab === "resumen" && (
                <>
                <div className="grid gap-6 lg:grid-cols-3">
                  <div className="lg:col-span-2">
                    <h2 className="mb-3 text-[15px] font-semibold">Mapa de activos del ecosistema</h2>
                    <div className="grid gap-3 md:grid-cols-2">
                      <AssetNode icon={<Building2 size={15} />} title="Business Portfolio" items={connection?.status === "CONNECTED" ? [{ id: "biz", kind: "business", externalId: connection.businessId ?? "—", name: connection.businessName ?? "Negocio", enabled: true }] : []} empty="Sin conexión" />
                      <AssetNode icon={<Megaphone size={15} />} title="Páginas y cuentas publicitarias" items={[...data.assets.pages, ...data.assets.adAccounts]} empty="Sin páginas detectadas" />
                      <AssetNode icon={<MessageCircle size={15} />} title="WhatsApp Business (WABA)" items={data.assets.wabas} empty="Sin WABA — conecta un número en Canales" />
                      <AssetNode
                        icon={<Phone size={15} />}
                        title="Números de WhatsApp"
                        items={data.assets.phoneNumbers.length ? data.assets.phoneNumbers : data.whatsapp.numbers.map((n) => ({ id: n.id, kind: "phone_number", externalId: n.phoneNumberId, name: n.displayPhone, enabled: n.status === "active" }))}
                        empty="Sin números conectados"
                      />
                      <AssetNode icon={<FileSpreadsheet size={15} />} title="Formularios instantáneos" items={data.assets.leadForms} empty="Se detectan al conectar Lead Ads" />
                      <AssetNode icon={<Target size={15} />} title="Datasets de conversiones" items={data.assets.datasets} empty="Configura el dataset en Conversions API" />
                    </div>
                  </div>
                  <div>
                    <h2 className="mb-3 text-[15px] font-semibold">Checklist de configuración</h2>
                    <div className="rounded-card border border-line bg-panel p-4 shadow-card">
                      <PermissionChecklist checklist={data.checklist} />
                      <Button className="mt-4 w-full" variant="secondary" onClick={() => setWizardOpen(true)}>
                        Abrir asistente de conexión
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="mt-6"><SystemUserTokenPanel onConnected={() => void load()} /></div>
                </>
              )}

              {tab === "leadads" && (
                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="rounded-card border border-line bg-panel p-5 shadow-card">
                    <h2 className="mb-1 font-semibold">Mapeo de campos</h2>
                    <p className="mb-4 text-[13px] text-ink-muted">
                      Cómo se transforma cada campo del formulario de Meta en datos de TuBot. Se aplica sede, estado
                      inicial, etiquetas y dispara los workflows con trigger <code className="text-xs">lead_created</code>.
                    </p>
                    <FieldMappingEditor initial={data.leadMapping} leadStatuses={leadStatuses} onSaved={() => void load()} />
                  </div>
                  <div className="space-y-4">
                    <div className="rounded-card border border-line bg-panel p-5 shadow-card">
                      <LeadAdsPagesPanel onConnected={() => void load()} />
                    </div>
                    <div className="rounded-card border border-line bg-panel p-5 shadow-card">
                      <h2 className="mb-2 font-semibold">Probar recepción</h2>
                      <p className="mb-3 text-[13px] text-ink-muted">
                        Encola un lead de prueba por el pipeline real (contacto → lead → workflows → actividad).
                      </p>
                      <Button
                        variant="secondary"
                        onClick={async () => {
                          const r = await api<{ detail: string }>("/integrations/meta/lead-test", { method: "POST" });
                          toast.push(r.detail, "ok");
                        }}
                      >
                        <Send size={14} /> Simular lead entrante
                      </Button>
                    </div>
                    <div className="rounded-card border border-line bg-panel p-5 shadow-card">
                      <h2 className="mb-2 font-semibold">Últimos leads recibidos</h2>
                      <RecentEvents provider="lead_ads" />
                    </div>
                  </div>
                </div>
              )}

              {tab === "capi" && (
                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="rounded-card border border-line bg-panel p-5 shadow-card">
                    <h2 className="mb-1 font-semibold">Reglas de conversión</h2>
                    <p className="mb-4 text-[13px] text-ink-muted">
                      Qué eventos del ciclo del lead se envían a Meta y con qué nombre. Con la conexión simulada los
                      envíos se registran como <b>[SIMULADO]</b> sin salir a Meta.
                    </p>
                    <EventMappingEditor initial={data.eventMapping} onSaved={() => void load()} />
                  </div>
                  <div className="space-y-4">
                    <div className="rounded-card border border-line bg-panel p-5 shadow-card">
                      <h2 className="mb-2 font-semibold">Evento de prueba</h2>
                      <Button
                        variant="secondary"
                        onClick={async () => {
                          const r = await api<{ detail: string }>("/integrations/meta/capi-test", { method: "POST", body: JSON.stringify({}) });
                          toast.push(r.detail, "ok");
                        }}
                      >
                        <Send size={14} /> Enviar evento de prueba
                      </Button>
                    </div>
                    <div className="rounded-card border border-line bg-panel p-5 shadow-card">
                      <h2 className="mb-2 font-semibold">Registro de envíos</h2>
                      <RecentEvents provider="capi" />
                    </div>
                  </div>
                </div>
              )}

              {tab === "actividad" && (
                <div className="rounded-card border border-line bg-panel p-5 shadow-card">
                  {activity === null ? (
                    <Skeleton className="h-48" />
                  ) : activity.length === 0 ? (
                    <EmptyState title="Sin actividad del ecosistema Meta" description="Conecta, prueba un lead o envía un evento para ver el registro aquí." />
                  ) : (
                    <ul className="space-y-1.5">
                      {activity.map((a) => (
                        <li key={a.id} className="flex items-start justify-between gap-3 rounded-lg border border-line px-3 py-2 text-[13px]">
                          <div>
                            <span className="mr-2 rounded bg-app px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-muted">{a.provider}</span>
                            <span className={a.status === "error" ? "text-red-600 dark:text-red-400" : a.status === "warning" ? "text-amber-700 dark:text-amber-300" : "text-ink"}>
                              {a.message ?? a.type}
                            </span>
                          </div>
                          <span className="shrink-0 text-xs text-ink-subtle">{new Date(a.createdAt).toLocaleString("es-CL")}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <MetaWizard open={wizardOpen} onClose={() => { setWizardOpen(false); void load(); }} data={data} onChanged={() => void load()} />
            <ConfirmDialog
              open={confirmDisconnect}
              onClose={() => setConfirmDisconnect(false)}
              onConfirm={() => void disconnect()}
              title="¿Desconectar Meta?"
              description="Se detiene la recepción de leads y el envío de conversiones. Los números de WhatsApp conectados en Canales no se eliminan."
              confirmLabel="Desconectar"
              danger
            />
          </>
        )}
      </div>
    </div>
  );
}

function RecentEvents({ provider }: { provider: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    void api<any[]>(`/integrations/activity?provider=${provider}&take=10`).then(setRows).catch(() => setRows([]));
  }, [provider]);
  if (rows === null) return <Skeleton className="h-20" />;
  if (rows.length === 0) return <p className="text-sm text-ink-subtle">Sin registros todavía.</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map((a) => (
        <li key={a.id} className="flex items-start justify-between gap-2 rounded-lg border border-line px-3 py-2 text-xs">
          <span className={a.status === "error" ? "text-red-600 dark:text-red-400" : a.status === "warning" ? "text-amber-700 dark:text-amber-300" : "text-ink-muted"}>
            {a.message ?? a.type}
          </span>
          <span className="shrink-0 text-ink-subtle">{new Date(a.createdAt).toLocaleString("es-CL")}</span>
        </li>
      ))}
    </ul>
  );
}

interface TokenInfo {
  ok: boolean;
  scopes: string[];
  adAccounts: { id: string; name: string; status: number }[];
  name: string | null;
  hasAdsRead: boolean;
  hasBusinessManagement: boolean;
  error?: string;
}

/**
 * Carga manual de un token de Usuario del Sistema (permanente) de Meta. Lo valida
 * contra Graph mostrando permisos + cuentas publicitarias antes de guardar.
 * Alternativa al OAuth (Facebook Login) para cuentas donde el usuario es admin.
 */
function SystemUserTokenPanel({ onConnected }: { onConnected: () => void }) {
  const toast = useToast();
  const [token, setToken] = useState("");
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  async function validate() {
    if (token.trim().length < 20) return;
    setBusy(true);
    setInfo(null);
    try {
      const r = await api<TokenInfo>("/integrations/meta/token/validate", { method: "POST", body: JSON.stringify({ accessToken: token.trim() }) });
      if (!r.ok) {
        toast.push(r.error ?? "Token inválido", "error");
        return;
      }
      setInfo(r);
      setPicked(new Set(r.adAccounts.map((a) => a.id)));
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    try {
      const r = await api<{ adAccounts: number; hasAdsRead: boolean }>("/integrations/meta/token/connect", { method: "POST", body: JSON.stringify({ accessToken: token.trim(), adAccountIds: [...picked] }) });
      toast.push(`Conectado: ${r.adAccounts} cuenta(s) publicitaria(s)${r.hasAdsRead ? " · ads_read ✓" : ""}`, "ok");
      setToken("");
      setInfo(null);
      onConnected();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-card border border-line bg-panel p-4 shadow-card">
      <h2 className="text-[15px] font-semibold">Conectar con token de Usuario del Sistema</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Pega un token <b>permanente</b> de Usuario del Sistema (Business Manager). Inclúyele{" "}
        <code>ads_read</code> (para <b>seleccionar campañas activas</b> en los flujos),{" "}
        <code>business_management</code> y, si vas a medir conversiones de anuncios,{" "}
        <code>whatsapp_business_manage_events</code>. Un mismo token cubre las tres cosas. Lo validamos contra Meta y te
        mostramos qué trae antes de guardarlo; se guarda cifrado.
      </p>
      <textarea
        value={token}
        onChange={(e) => setToken(e.target.value)}
        rows={2}
        placeholder="EAAG… (token de Usuario del Sistema)"
        className="mt-2 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 font-mono text-xs"
      />
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" onClick={() => void validate()} disabled={busy || token.trim().length < 20}>
          {busy && !info ? "Validando…" : "Validar token"}
        </Button>
        {info && (
          <Button onClick={() => void connect()} disabled={busy}>
            {busy ? "Conectando…" : "Conectar"}
          </Button>
        )}
      </div>

      {info && (
        <div className="mt-3 space-y-2 rounded-card border border-line bg-app p-3 text-xs">
          {info.name && <p className="font-medium text-ink">{info.name}</p>}
          <div className="flex flex-wrap gap-1">
            {["ads_read", "business_management", "whatsapp_business_messaging", "whatsapp_business_manage_events"].map((s) => (
              <span key={s} className={cn("rounded px-1.5 py-0.5 text-[10px]", info.scopes.includes(s) ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-app text-ink-subtle line-through")}>{s}</span>
            ))}
            <span className="text-[10px] text-ink-subtle">+{Math.max(0, info.scopes.length - 4)} más</span>
          </div>
          {!info.hasAdsRead && <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">⚠ El token no trae <code>ads_read</code>: no podrás listar anuncios. Regenéralo con ese permiso.</p>}
          <div>
            <p className="mb-1 font-medium text-ink-muted">Cuentas publicitarias con acceso ({info.adAccounts.length}):</p>
            {info.adAccounts.length === 0 ? (
              <p className="text-ink-subtle">Ninguna. El token no da acceso a cuentas publicitarias.</p>
            ) : (
              <div className="max-h-40 space-y-0.5 overflow-y-auto">
                {info.adAccounts.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-panel">
                    <input
                      type="checkbox"
                      checked={picked.has(a.id)}
                      onChange={() => setPicked((prev) => { const n = new Set(prev); n.has(a.id) ? n.delete(a.id) : n.add(a.id); return n; })}
                      className="h-3.5 w-3.5"
                    />
                    <span className="truncate text-ink">{a.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-subtle">{a.id}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
