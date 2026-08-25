"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, KanbanSquare, KeyRound, Link2, Megaphone, RefreshCw, Send, Settings2, Unplug } from "lucide-react";
import { api } from "@/lib/api";
import { InstagramIcon, MessengerIcon } from "@/components/brand-icons";
import { Button, ConfirmDialog, PageHeader, Skeleton, StatusBadge, cn, useToast } from "@/components/ui";
import { EventMappingEditor, FieldMappingEditor } from "../meta/panels";

// Integración «Meta CRM (Lead Ads)»: conexión SEPARADA de Meta Business Suite.
// Conectar/desconectar acá jamás toca WhatsApp, anuncios ni la conexión Meta general.

interface CrmStatus {
  connection: { status: string; mode: string; businessName: string | null; scopes: string[]; lastError: string | null } | null;
  pages: Array<{ externalId: string; name: string; enabled: boolean }>;
  forms: Array<{ externalId: string; name: string; pageId?: string | null }>;
  mappingActive: boolean;
  datasetReady: boolean;
}

interface GraphPage {
  id: string;
  name: string;
  connected: boolean;
  pictureUrl?: string | null;
}

type MetaCrmTab = "crm" | "mensajeria" | "conversiones";

export default function MetaCrmPage() {
  const toast = useToast();
  const [data, setData] = useState<CrmStatus | null>(null);
  const [mapping, setMapping] = useState<any>(null);
  const [leadStatuses, setLeadStatuses] = useState<Array<{ code: string; name: string }>>([]);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [tab, setTab] = useState<MetaCrmTab>("crm");

  // Pestaña por URL (?tab=mensajeria) — así Canales puede enlazar directo a la
  // configuración de mensajería sin pasar por el bloque de CRM.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "mensajeria" || t === "conversiones") setTab(t);
  }, []);

  function switchTab(t: MetaCrmTab) {
    setTab(t);
    window.history.replaceState(null, "", t === "crm" ? "/integrations/meta-crm" : `/integrations/meta-crm?tab=${t}`);
  }

  const load = useCallback(async () => {
    try {
      const [status, map, stages] = await Promise.all([
        api<CrmStatus>("/integrations/meta-crm"),
        api<any>("/integrations/meta/lead-mapping").catch(() => null),
        api<Array<{ code: string; name: string }>>("/lifecycle-stages").catch(() => []),
      ]);
      setData(status);
      setMapping(map);
      setLeadStatuses(stages.map((s) => ({ code: s.code, name: s.name })));
    } catch (e: any) {
      toast.push(e.message ?? "Error al cargar", "error");
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Retorno del OAuth "Conectar con Meta" (?oauth=connected|denied|permisos|error)
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get("oauth");
    if (!r) return;
    if (r === "connected") toast.push("Cuenta de Meta conectada ✔", "ok");
    else if (r === "denied") toast.push("Conexión con Meta cancelada", "info");
    else if (r === "permisos") toast.push("Faltaron permisos en la autorización — acepta todos los permisos solicitados", "error");
    else toast.push("No se pudo conectar con Meta — intenta de nuevo", "error");
    const keepTab = new URLSearchParams(window.location.search).get("tab");
    window.history.replaceState(null, "", keepTab === "mensajeria" ? "/integrations/meta-crm?tab=mensajeria" : "/integrations/meta-crm");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connectWithMeta() {
    try {
      const r = await api<{ url: string }>("/integrations/meta-crm/oauth/authorize");
      window.location.href = r.url;
    } catch (e: any) {
      toast.push(e.message ?? "OAuth no disponible — usa el token manual", "error");
    }
  }

  const connected = data?.connection?.status === "CONNECTED";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Centro Meta CRM"
        description="Una sola conexión con Meta, dos capacidades con configuración independiente: Lead Ads al CRM y mensajería de Instagram/Messenger. No toca WhatsApp ni la conexión Meta general."
        actions={
          connected ? (
            <Button variant="secondary" onClick={() => setDisconnectOpen(true)}>
              <Unplug size={14} /> Desconectar
            </Button>
          ) : undefined
        }
      />

      {/* Pestañas: cada capacidad tiene su propio menú de configuración */}
      <div className="flex w-fit gap-1 rounded-xl border border-line bg-panel p-1">
        {(
          [
            ["crm", "📊 Lead Ads (CRM)"],
            ["conversiones", "📈 Conversiones (dataset)"],
            ["mensajeria", "💬 Mensajería · Instagram y Messenger"],
          ] as Array<[MetaCrmTab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => switchTab(key)}
            className={cn(
              "rounded-lg px-4 py-2 text-sm font-medium transition-colors",
              tab === key ? "bg-navy-900 text-white shadow-card" : "text-ink-muted hover:bg-app",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {!data ? (
        <Skeleton className="h-64" />
      ) : tab === "mensajeria" ? (
        <MessagingTab data={data} onConnect={() => void connectWithMeta()} onChanged={() => void load()} />
      ) : tab === "conversiones" ? (
        <ConversionsTab />
      ) : (
        <>
          {/* Pasos del circuito */}
          <div className="grid gap-3 md:grid-cols-4">
            {[
              ["1 · Conexión", connected, data.connection?.businessName ?? "Token de la app CRM"],
              ["2 · Página y formularios", data.pages.length > 0, data.pages.length ? `${data.pages.length} página(s) · ${data.forms.length} formulario(s)` : "Conecta tu página"],
              ["3 · Mapeo de campos", data.mappingActive, data.mappingActive ? "Activo" : "Configúralo abajo"],
              ["4 · Dataset (reportes a Meta)", data.datasetReady, data.datasetReady ? "Reglas activas" : "Configura las reglas por etapa"],
            ].map(([label, ok, detail]) => (
              <div key={label as string} className={cn("rounded-card border p-3", ok ? "border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20" : "border-line bg-panel")}>
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 size={14} className={ok ? "text-emerald-600" : "text-ink-subtle"} />
                  <p className="text-xs font-medium">{label as string}</p>
                </div>
                <p className="mt-1 text-[11px] text-ink-muted">{detail as string}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-4">
              {/* Conexión */}
              <div className="rounded-card border border-line bg-panel p-5 shadow-card">
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="font-semibold">Conexión</h2>
                  {connected && <StatusBadge kind="connected" label={data.connection!.businessName ?? "Conectada"} />}
                </div>
                {connected ? (
                  <p className="text-[13px] text-ink-muted">
                    Conexión activa ({data.connection!.mode === "OAUTH" ? "autorizada con Meta" : "token manual"}) con{" "}
                    {data.connection!.scopes.length} permisos. Para renovarla, vuelve a conectar.
                  </p>
                ) : (
                  <p className="text-[13px] text-ink-muted">
                    Autoriza tu cuenta de Meta con un clic — sin copiar tokens. Acepta todos los permisos del diálogo
                    (páginas, leads y mensajería).
                  </p>
                )}
                <Button className="mt-3" onClick={() => void connectWithMeta()}>
                  <Link2 size={14} /> {connected ? "Volver a conectar con Meta" : "Conectar con Meta"}
                </Button>
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-ink-subtle">Avanzado: conectar con token de Usuario del Sistema</summary>
                  <p className="mt-2 text-[12px] text-ink-muted">
                    Permisos mínimos: <code className="text-xs">pages_show_list</code> + <code className="text-xs">leads_retrieval</code>;
                    recomendados: <code className="text-xs">pages_manage_metadata</code>, <code className="text-xs">pages_manage_ads</code>, mensajería.
                  </p>
                  <TokenConnect onConnected={() => void load()} />
                </details>
              </div>

              {/* Páginas */}
              <div className="rounded-card border border-line bg-panel p-5 shadow-card">
                <PagesPanel enabled={connected} onConnected={() => void load()} forms={data.forms} />
              </div>
            </div>

            <div className="space-y-4">
              {/* Mapeo */}
              <div className="rounded-card border border-line bg-panel p-5 shadow-card">
                <h2 className="mb-1 font-semibold">Mapeo de campos</h2>
                <p className="mb-4 text-[13px] text-ink-muted">
                  Cómo se transforma cada campo del formulario en datos del CRM (etapa inicial, etiquetas, workflows{" "}
                  <code className="text-xs">lead_created</code>).
                </p>
                {mapping !== null && <FieldMappingEditor initial={mapping} leadStatuses={leadStatuses} onSaved={() => void load()} />}
              </div>

              {/* Prueba + accesos */}
              <div className="rounded-card border border-line bg-panel p-5 shadow-card">
                <h2 className="mb-2 font-semibold">Probar y operar</h2>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      const r = await api<{ detail: string }>("/integrations/meta/lead-test", { method: "POST" });
                      toast.push(r.detail, "ok");
                    }}
                  >
                    <Send size={14} /> Simular lead entrante
                  </Button>
                  <Link href="/crm">
                    <Button variant="secondary">
                      <KanbanSquare size={14} /> Abrir el CRM
                    </Button>
                  </Link>
                  <Button variant="ghost" onClick={() => switchTab("conversiones")}>
                    <Megaphone size={14} /> Reglas del dataset (Conversiones)
                  </Button>
                </div>
                <p className="mt-3 text-[11px] text-ink-subtle">
                  Las reglas por etapa (p. ej. «Cliente» → Purchase) están en la pestaña <b>Conversiones (dataset)</b> de
                  este mismo centro; los envíos usan automáticamente esta conexión CRM cuando existe.
                </p>
              </div>
            </div>
          </div>
        </>
      )}

      <ConfirmDialog
        open={disconnectOpen}
        title="¿Desconectar Meta CRM?"
        description="Se elimina el token del CRM. No afecta WhatsApp, anuncios ni la conexión Meta general. Los leads dejarán de leerse de Graph hasta reconectar."
        confirmLabel="Desconectar"
        onConfirm={async () => {
          setDisconnectOpen(false);
          await api("/integrations/meta-crm/disconnect", { method: "POST" });
          toast.push("Meta CRM desconectado", "ok");
          void load();
        }}
        onClose={() => setDisconnectOpen(false)}
      />
    </div>
  );
}

// ------------------------- Conexión por token -------------------------

function TokenConnect({ onConnected }: { onConnected: () => void }) {
  const toast = useToast();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; name?: string | null; scopes?: string[]; missing?: string[]; recommendedMissing?: string[]; error?: string } | null>(null);

  async function validate() {
    setBusy(true);
    setCheck(null);
    try {
      const r = await api<typeof check>("/integrations/meta-crm/token/validate", { method: "POST", body: JSON.stringify({ accessToken: token }) });
      setCheck(r);
    } catch (e: any) {
      toast.push(e.message ?? "Error al validar", "error");
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; scopes: string[]; recommendedMissing: string[] }>("/integrations/meta-crm/token/connect", {
        method: "POST",
        body: JSON.stringify({ accessToken: token }),
      });
      toast.push(`Meta CRM conectado (${r.scopes.length} permisos)`, "ok");
      if (r.recommendedMissing.length) toast.push(`Sugerencia: faltan permisos recomendados (${r.recommendedMissing.join(", ")})`, "info");
      setToken("");
      setCheck(null);
      onConnected();
    } catch (e: any) {
      toast.push(e.message ?? "Error al conectar", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Token de Usuario del Sistema (app CRM)"
          className="w-full rounded-lg border border-line bg-app px-3 py-2 text-sm outline-none focus:border-brand-500"
        />
        <Button variant="secondary" disabled={busy || token.trim().length < 20} onClick={() => void validate()}>
          <KeyRound size={14} /> Validar
        </Button>
      </div>
      {check && (
        <div className={cn("rounded-lg p-2.5 text-xs", check.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300" : "bg-amber-50 text-amber-700")}>
          {check.ok ? (
            <>✓ Token válido{check.name ? ` (${check.name})` : ""} · {check.scopes?.length ?? 0} permisos{(check.recommendedMissing?.length ?? 0) > 0 ? ` · faltan recomendados: ${check.recommendedMissing!.join(", ")}` : ""}</>
          ) : (
            <>✖ {check.error ?? `Faltan permisos: ${(check.missing ?? []).join(", ")}`}</>
          )}
        </div>
      )}
      {check?.ok && (
        <Button disabled={busy} onClick={() => void connect()}>
          Conectar Meta CRM
        </Button>
      )}
    </div>
  );
}

// ------------------------- Pestaña Mensajería -------------------------

interface MessagingChannel {
  id: string;
  type: string;
  name: string;
  status: string;
  defaultAgentName: string | null;
}

/**
 * Configuración de mensajería (Instagram Direct + Messenger) SEPARADA del CRM:
 * estado por red, diagnóstico de la página y accesos de operación. La conexión
 * subyacente es la misma (token Meta CRM), pero cada capacidad tiene su menú.
 */
function MessagingTab({ data, onConnect, onChanged }: { data: CrmStatus; onConnect: () => void; onChanged: () => void }) {
  const [channels, setChannels] = useState<MessagingChannel[] | null>(null);
  const connected = data.connection?.status === "CONNECTED";

  useEffect(() => {
    api<MessagingChannel[]>("/channels")
      .then((all) => setChannels(all.filter((c) => c.type === "INSTAGRAM" || c.type === "MESSENGER")))
      .catch(() => setChannels([]));
  }, []);

  const nets: Array<{ type: "INSTAGRAM" | "MESSENGER"; label: string; icon: ReactNode; chipClass: string }> = [
    {
      type: "INSTAGRAM",
      label: "Instagram Direct",
      icon: <InstagramIcon size={20} />,
      chipClass: "bg-gradient-to-tr from-[#F58529] via-[#DD2A7B] to-[#8134AF] text-white",
    },
    {
      type: "MESSENGER",
      label: "Facebook Messenger",
      icon: <MessengerIcon size={20} />,
      chipClass: "bg-gradient-to-tr from-[#00B2FF] to-[#006AFF] text-white",
    },
  ];

  return (
    <div className="space-y-4">
      {!connected && (
        <div className="rounded-card border border-amber-200 bg-amber-50/50 p-5 dark:border-amber-500/30 dark:bg-amber-500/10">
          <p className="text-sm font-medium">Primero conecta tu cuenta de Meta</p>
          <p className="mt-1 text-[13px] text-ink-muted">
            La mensajería usa la misma autorización que Lead Ads. Un clic, sin copiar tokens.
          </p>
          <Button className="mt-3" onClick={onConnect}>
            <Link2 size={14} /> Conectar con Meta
          </Button>
        </div>
      )}

      {/* Estado por red */}
      <div className="grid gap-4 md:grid-cols-2">
        {nets.map((n) => {
          const mine = (channels ?? []).filter((c) => c.type === n.type);
          const active = mine.some((c) => c.status === "active");
          return (
            <div key={n.type} className="rounded-card border border-line bg-panel p-5 shadow-card">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className={cn("flex h-11 w-11 items-center justify-center rounded-xl", n.chipClass)}>{n.icon}</div>
                  <div>
                    <p className="font-semibold">{n.label}</p>
                    <p className="text-xs text-ink-subtle">
                      {mine.length ? mine.map((c) => c.name).join(" · ") : "Se crea al conectar tu página (abajo)"}
                    </p>
                  </div>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium",
                    active
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
                      : "border-red-200 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400",
                  )}
                >
                  {active ? "● Conectado" : "● No conectado"}
                </span>
              </div>
              {mine.length > 0 && (
                <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-xs text-ink-muted">
                  <span>Agente: {mine[0].defaultAgentName ?? "sin agente por defecto"}</span>
                  <Link href="/channels" className="inline-flex items-center gap-1 font-medium text-brand-600 hover:underline">
                    <Settings2 size={12} /> Gestionar en Canales
                  </Link>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Diagnóstico y suscripción de la página (compartido con la conexión) */}
      {connected && (
        <div className="rounded-card border border-line bg-panel p-5 shadow-card">
          <PagesPanel enabled={connected} onConnected={onChanged} messaging />
        </div>
      )}

      <p className="rounded-card border border-line bg-app p-4 text-xs leading-relaxed text-ink-muted">
        <b>Importante mientras la revisión de Meta está pendiente:</b> con acceso estándar, Meta solo entrega los DMs de
        cuentas con rol en la app. Los mensajes del público llegan cuando la App Review de mensajería quede aprobada —
        no hay que cambiar nada más aquí.
      </p>
    </div>
  );
}

// ------------------------- Páginas conectadas -------------------------

function PagesPanel({
  enabled,
  onConnected,
  messaging,
  forms = [],
}: {
  enabled: boolean;
  onConnected: () => void;
  messaging?: boolean;
  /** formularios registrados (con la página a la que pertenecen) para listarlos bajo cada página */
  forms?: Array<{ externalId: string; name: string; pageId?: string | null }>;
}) {
  const toast = useToast();
  const [pages, setPages] = useState<GraphPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [diag, setDiag] = useState<{ pageId: string; checks: Array<{ key: string; label: string; ok: boolean; detail: string; fix?: string }> } | null>(null);
  const [diagBusy, setDiagBusy] = useState<string | null>(null);

  async function diagnose(page: GraphPage) {
    setDiagBusy(page.id);
    setDiag(null);
    try {
      const r = await api<{ checks: any[] }>(`/integrations/meta-crm/pages/${encodeURIComponent(page.id)}/diagnose`);
      setDiag({ pageId: page.id, checks: r.checks });
    } catch (e: any) {
      toast.push(e.message ?? "No se pudo diagnosticar", "error");
    } finally {
      setDiagBusy(null);
    }
  }

  const load = useCallback(async () => {
    if (!enabled) return;
    setError(null);
    setPages(null);
    try {
      const r = await api<{ pages: GraphPage[] }>("/integrations/meta-crm/pages");
      setPages(r.pages);
    } catch (e: any) {
      setError(e.message ?? "No se pudieron listar las páginas");
      setPages([]);
    }
  }, [enabled]);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect(page: GraphPage) {
    setBusy(page.id);
    try {
      const r = await api<{ forms: Array<{ id: string }> }>(`/integrations/meta-crm/pages/${encodeURIComponent(page.id)}/connect`, { method: "POST" });
      toast.push(`Página «${page.name}» conectada: ${r.forms.length} formulario(s)`, "ok");
      await load();
      onConnected();
    } catch (e: any) {
      toast.push(e.message ?? "No se pudo conectar la página", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-semibold">{messaging ? "Página y diagnóstico de mensajería" : "Páginas conectadas"}</h2>
        {enabled && (
          <button onClick={() => void load()} className="rounded p-1 text-ink-subtle hover:bg-app" title="Actualizar">
            <RefreshCw size={14} />
          </button>
        )}
      </div>
      <p className="mb-3 text-[13px] text-ink-muted">
        {messaging ? (
          <>
            La página de Facebook es la puerta de entrada de Messenger y de su cuenta de Instagram vinculada.{" "}
            <b>Re-conectar</b> re-suscribe los webhooks de mensajes y registra la cuenta IG; <b>Diagnosticar</b> revisa
            los 12 puntos del circuito.
          </>
        ) : (
          <>
            Conecta la página de tus campañas: registramos sus formularios y suscribimos la app CRM al evento{" "}
            <code className="text-xs">leadgen</code> — cada lead entra al CRM al instante.
          </>
        )}
      </p>
      {!enabled ? (
        <p className="rounded-lg bg-app p-3 text-xs text-ink-muted">Conecta primero el token (arriba).</p>
      ) : !pages ? (
        <p className="py-3 text-center text-sm text-ink-subtle">Cargando páginas…</p>
      ) : error ? (
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-700">{error}</p>
      ) : pages.length === 0 ? (
        <p className="rounded-lg bg-app p-3 text-xs text-ink-muted">
          El token no lista páginas. Asigna la página al Usuario del Sistema en Business Manager y reintenta.
        </p>
      ) : (
        <div className="space-y-2">
          {pages.map((p) => {
            // Formularios de ESTA página (los antiguos sin pageId se muestran si hay una sola página)
            const pageForms = forms.filter((f) => f.pageId === p.id || (!f.pageId && pages.length === 1));
            return (
            <div key={p.id} className="rounded-xl border border-line p-3">
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 items-center gap-2.5">
                {p.pictureUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.pictureUrl} alt={p.name} className="h-9 w-9 shrink-0 rounded-full border border-line object-cover" />
                ) : (
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-app text-xs font-semibold text-ink-muted">
                    {p.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.name}</p>
                  <p className="font-mono text-[10px] text-ink-subtle">{p.id}</p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {p.connected && (
                  <Button variant="ghost" disabled={diagBusy === p.id} onClick={() => void diagnose(p)}>
                    {diagBusy === p.id ? "Revisando…" : "🩺 Diagnosticar"}
                  </Button>
                )}
                {p.connected ? (
                  <Button variant="secondary" disabled={busy === p.id} onClick={() => void connect(p)}>
                    <RefreshCw size={14} /> {busy === p.id ? "Conectando…" : "Re-conectar"}
                  </Button>
                ) : (
                  <Button variant="secondary" disabled={busy === p.id} onClick={() => void connect(p)}>
                    <Link2 size={14} /> {busy === p.id ? "Conectando…" : "Conectar"}
                  </Button>
                )}
              </div>
            </div>
            {/* Formularios de la página — visibles para operar (y para el screencast de App Review) */}
            {!messaging && p.connected && pageForms.length > 0 && (
              <details className="mt-2 rounded-lg bg-app px-3 py-2">
                <summary className="cursor-pointer select-none text-xs font-medium text-ink-muted">
                  📋 {pageForms.length} formulario(s) de clientes potenciales de esta página
                </summary>
                <ul className="mt-2 space-y-1">
                  {pageForms.map((f) => (
                    <li key={f.externalId} className="flex items-center justify-between gap-2 rounded border border-line bg-panel px-2.5 py-1.5 text-xs">
                      <span className="truncate font-medium text-ink">{f.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-ink-subtle">{f.externalId}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            </div>
          );})}
          {diag && (
            <div className="rounded-xl border border-line bg-app p-3">
              <p className="mb-2 text-xs font-medium text-ink-muted">Diagnóstico de mensajería (página {diag.pageId})</p>
              <ul className="space-y-1.5">
                {diag.checks.map((c) => (
                  <li key={c.key} className="text-xs">
                    <span className={c.ok ? "text-emerald-600" : "text-red-500"}>{c.ok ? "✓" : "✖"}</span>{" "}
                    <span className="font-medium">{c.label}:</span> <span className="text-ink-muted">{c.detail}</span>
                    {!c.ok && c.fix && <span className="block pl-4 text-amber-600">→ {c.fix}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Pestaña «Conversiones (dataset)»: TODA la operación del dataset de Meta en el
 * mismo centro — reglas por etapa del funnel, evento de prueba y registro de
 * envíos. Reusa el editor y los endpoints del Centro Meta general (misma
 * configuración, un solo lugar visible para el usuario).
 */
function ConversionsTab() {
  const toast = useToast();
  const [mapping, setMapping] = useState<{ datasetId: string | null; testEventCode: string | null; rules: any[]; active: boolean } | null>(null);
  const [activity, setActivity] = useState<any[] | null>(null);

  const loadAll = useCallback(() => {
    void api<any>("/integrations/meta/event-mapping").then(setMapping).catch(() => setMapping(null));
    void api<any[]>("/integrations/activity?provider=capi&take=12").then(setActivity).catch(() => setActivity([]));
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="rounded-card border border-line bg-panel p-5 shadow-card">
        <h2 className="mb-1 font-semibold">Reglas del embudo (etapa → evento de Meta)</h2>
        <p className="mb-4 text-[13px] text-ink-muted">
          Cada cambio de etapa del CRM envía un evento al conjunto de datos con el <code className="text-xs">lead_id</code>{" "}
          del formulario — es lo que alimenta la optimización de «clientes potenciales de conversión» en tus campañas.
        </p>
        {mapping === null ? <Skeleton className="h-48" /> : <EventMappingEditor initial={mapping} onSaved={loadAll} />}
      </div>
      <div className="space-y-4">
        <div className="rounded-card border border-line bg-panel p-5 shadow-card">
          <h2 className="mb-2 font-semibold">Evento de prueba</h2>
          <p className="mb-3 text-[13px] text-ink-muted">
            Verifica la conexión con el dataset. Ojo: la pestaña «Probar eventos» del Events Manager no muestra eventos de
            CRM — el resultado fiable es el «aceptados: 1» del registro de abajo (y el Resumen del dataset, con ≤30 min de retardo).
          </p>
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                const r = await api<{ detail: string }>("/integrations/meta/capi-test", { method: "POST", body: JSON.stringify({}) });
                toast.push(r.detail, "ok");
              } catch (e: any) {
                toast.push(e.message ?? "Error al enviar el evento", "error");
              }
              setTimeout(loadAll, 1500);
            }}
          >
            <Send size={14} /> Enviar evento de prueba
          </Button>
        </div>
        <div className="rounded-card border border-line bg-panel p-5 shadow-card">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">Registro de envíos</h2>
            <button onClick={loadAll} className="rounded p-1 text-ink-subtle hover:bg-app" title="Actualizar">
              <RefreshCw size={14} />
            </button>
          </div>
          {activity === null ? (
            <Skeleton className="h-24" />
          ) : activity.length === 0 ? (
            <p className="text-sm text-ink-subtle">Sin envíos todavía.</p>
          ) : (
            <ul className="space-y-1.5">
              {activity.map((a) => (
                <li key={a.id} className="flex items-start justify-between gap-2 rounded-lg border border-line px-3 py-2 text-xs">
                  <span className={a.status === "error" ? "text-red-600 dark:text-red-400" : "text-ink-muted"}>{a.message ?? a.type}</span>
                  <span className="shrink-0 text-ink-subtle">{new Date(a.createdAt).toLocaleString("es-CL")}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
