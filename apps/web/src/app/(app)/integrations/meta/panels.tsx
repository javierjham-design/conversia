"use client";

/** Wizard de conexión Meta + editores de mapeo (Lead Ads y Conversions API). */
import { useState } from "react";
import { CheckCircle2, ChevronRight, Circle, FlaskConical, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Modal, StatusBadge, cn, useToast } from "@/components/ui";
import type { MetaOverview } from "./page";

// ------------------------------ Checklist ------------------------------

export function PermissionChecklist({ checklist }: { checklist: MetaOverview["checklist"] }) {
  const items: Array<[keyof MetaOverview["checklist"], string]> = [
    ["connected", "Cuenta de Meta conectada"],
    ["pageSelected", "Página de Facebook seleccionada"],
    ["wabaLinked", "WhatsApp Business Account vinculada"],
    ["phoneConnected", "Número de WhatsApp conectado"],
    ["webhookConfigured", "Webhook de recepción configurado"],
    ["leadFormsSubscribed", "Formularios de Lead Ads suscritos"],
    ["leadMappingReady", "Mapeo de campos de leads activo"],
    ["datasetConfigured", "Dataset de conversiones configurado"],
    ["capiReady", "Conversions API lista"],
  ];
  return (
    <ul className="space-y-2">
      {items.map(([key, label]) => {
        const ok = checklist[key];
        return (
          <li key={key} className="flex items-center gap-2 text-sm">
            {ok ? (
              <CheckCircle2 size={16} className="shrink-0 text-emerald-500" aria-hidden />
            ) : (
              <Circle size={16} className="shrink-0 text-ink-subtle" aria-hidden />
            )}
            <span className={ok ? "text-ink" : "text-ink-subtle"}>{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

// ------------------------------- Wizard -------------------------------

const WIZARD_STEPS = ["Conectar", "Activos", "Funciones", "Verificar", "Probar"];

export function MetaWizard({
  open,
  onClose,
  data,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  data: MetaOverview;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [testLog, setTestLog] = useState<string[]>([]);
  const [manualToken, setManualToken] = useState("");
  const connected = data.connection?.status === "CONNECTED";

  async function run(label: string, fn: () => Promise<{ detail?: string } | void>) {
    setBusy(true);
    try {
      const r = await fn();
      setTestLog((l) => [...l, `✔ ${label}${r && "detail" in (r as any) && (r as any).detail ? ` — ${(r as any).detail}` : ""}`]);
      toast.push(`${label}: OK`, "ok");
    } catch (err) {
      setTestLog((l) => [...l, `✖ ${label} — ${(err as Error).message}`]);
      toast.push(`${label}: ${(err as Error).message}`, "error");
    } finally {
      setBusy(false);
    }
  }

  const assetGroups: Array<[string, MetaOverview["assets"][keyof MetaOverview["assets"]]]> = [
    ["Páginas de Facebook", data.assets.pages],
    ["Cuentas publicitarias", data.assets.adAccounts],
    ["WhatsApp Business (WABA)", data.assets.wabas],
    ["Números de WhatsApp", data.assets.phoneNumbers],
    ["Formularios de Lead Ads", data.assets.leadForms],
    ["Datasets de conversiones", data.assets.datasets],
  ];

  return (
    <Modal open={open} onClose={onClose} title="Conectar Meta Business Suite" wide>
      {/* Progreso */}
      <ol className="mb-6 flex items-center gap-1 text-xs" aria-label="Progreso">
        {WIZARD_STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-1">
            {i > 0 && <ChevronRight size={12} className="text-ink-subtle" aria-hidden />}
            <button
              onClick={() => setStep(i)}
              className={cn(
                "rounded-full px-2.5 py-1 font-medium",
                i === step ? "bg-brand-600 text-white" : i < step ? "bg-brand-50 text-brand-700" : "bg-app text-ink-subtle",
              )}
            >
              {i + 1}. {s}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            Una sola conexión con Meta habilita <b>WhatsApp Cloud API</b>, la recepción de <b>leads de anuncios</b> y el
            envío de <b>conversiones</b> a tus campañas. Los tokens se almacenan cifrados en el backend y nunca vuelven
            al navegador.
          </p>
          <div className="rounded-xl border border-line bg-app p-4 text-sm">
            <p className="mb-1.5 flex items-center gap-1.5 font-medium"><ShieldCheck size={15} className="text-brand-600" /> Permisos que se solicitarán</p>
            <p className="text-xs text-ink-muted">
              whatsapp_business_management · whatsapp_business_messaging · leads_retrieval · pages_show_list ·
              pages_manage_metadata · ads_management (solo lectura de activos)
            </p>
            <p className="mt-2 text-xs text-ink-subtle">
              Usamos exclusivamente las APIs oficiales de Meta. Tus datos se procesan según la política de privacidad de la plataforma.
            </p>
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:bg-amber-500/10 dark:border-amber-500/30">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">Embedded Signup oficial: pendiente de aprobación de la app</p>
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{data.embeddedSignup.pendingReason}</p>
          </div>

          <label className="block text-sm">
            <span className="text-xs text-ink-muted">
              Token de acceso propio de la conexión (opcional — recomendado para Conversions API / Lead Ads)
            </span>
            <input
              type="password"
              value={manualToken}
              onChange={(e) => setManualToken(e.target.value)}
              placeholder="EAAG… — vacío = usar el token de la plataforma"
              className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 font-mono text-xs"
            />
            <span className="mt-1 block text-[10px] text-ink-subtle">
              Se guarda cifrado (AES-256) y solo lo usan las integraciones de esta conexión. Para enviar eventos de
              conversión el token debe incluir el permiso <span className="font-mono">whatsapp_business_manage_events</span>.
              Volver a conectar con un token nuevo lo rota.
            </span>
          </label>

          <div className="flex flex-wrap gap-2">
            <Button disabled title="Disponible cuando Meta apruebe la app (META_APP_ID + META_CONFIG_ID)">
              Continuar con Meta (oficial)
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run("Conexión manual registrada", async () => {
                  await api("/integrations/meta/manual-connect", {
                    method: "POST",
                    body: JSON.stringify(manualToken.trim() ? { accessToken: manualToken.trim() } : {}),
                  });
                  setManualToken("");
                  onChanged();
                  setStep(1);
                })
              }
            >
              Usar conexión manual (ids + token desde Canales)
            </Button>
            {data.mockAllowed && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void run("Simulación de desarrollo creada", async () => {
                    await api("/integrations/meta/mock-connect", { method: "POST" });
                    onChanged();
                    setStep(1);
                  })
                }
              >
                <FlaskConical size={14} /> Simular conexión (solo desarrollo)
              </Button>
            )}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            Activa los activos que TuBot puede usar. {data.connection?.mode === "MOCK" && (
              <span className="font-medium text-violet-700 dark:text-violet-300">Estás viendo activos DEMO de la simulación de desarrollo.</span>
            )}
          </p>
          {!connected ? (
            <p className="rounded-lg bg-app p-3 text-sm text-ink-muted">Primero completa el paso 1 (conectar).</p>
          ) : (
            assetGroups.map(([label, assets]) => (
              <div key={label}>
                <p className="mb-1.5 text-[13px] font-semibold text-ink-muted">{label}</p>
                {assets.length === 0 ? (
                  <p className="text-xs text-ink-subtle">Sin activos detectados{data.connection?.mode === "MANUAL" ? " — conecta números en Canales" : ""}.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {assets.map((a) => (
                      <label
                        key={a.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm",
                          a.enabled ? "border-brand-300 bg-brand-50" : "border-line",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={a.enabled}
                          onChange={async (e) => {
                            await api(`/integrations/meta/assets/${a.id}`, { method: "PATCH", body: JSON.stringify({ enabled: e.target.checked }) });
                            onChanged();
                          }}
                        />
                        <span>{a.name}</span>
                        <span className="font-mono text-[10px] text-ink-subtle">{a.externalId}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
          <div className="flex justify-end"><Button onClick={() => setStep(2)}>Continuar</Button></div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">Funcionalidades del ecosistema Meta en TuBot:</p>
          {[
            ["WhatsApp Cloud API", "Mensajería con agentes IA en tu número oficial", true, "Se gestiona en Canales"],
            ["Recepción de leads (Lead Ads)", "Formularios instantáneos → contactos y workflows", data.checklist.leadMappingReady, "Configura el mapeo en la pestaña Lead Ads"],
            ["Envío de conversiones (CAPI)", "Citas y ventas de vuelta a tus campañas", data.checklist.capiReady, "Configura reglas en la pestaña Conversions API"],
            ["Instagram Direct", "DM de Instagram en la bandeja", false, "Próximamente"],
            ["Messenger", "Chat de tu página de Facebook", false, "Próximamente"],
          ].map(([name, desc, on, hint]) => (
            <div key={name as string} className="flex items-center justify-between rounded-xl border border-line p-3">
              <div>
                <p className="text-sm font-medium">{name as string}</p>
                <p className="text-xs text-ink-muted">{desc as string}</p>
              </div>
              <div className="text-right">
                <StatusBadge kind={on ? "connected" : "incomplete"} label={on ? "Activa" : "Pendiente"} />
                <p className="mt-0.5 text-[10px] text-ink-subtle">{hint as string}</p>
              </div>
            </div>
          ))}
          <div className="flex justify-end"><Button onClick={() => setStep(3)}>Continuar</Button></div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <PermissionChecklist checklist={data.checklist} />
          <div className="flex justify-end"><Button onClick={() => setStep(4)}>Continuar a pruebas</Button></div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">Ejecuta pruebas reales por el pipeline completo:</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run("Lead de prueba", async () => {
                  const r = await api<{ detail: string }>("/integrations/meta/lead-test", { method: "POST" });
                  return r;
                })
              }
            >
              Simular recepción de lead
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run("Evento CAPI de prueba", async () => {
                  const r = await api<{ detail: string }>("/integrations/meta/capi-test", { method: "POST", body: JSON.stringify({}) });
                  return r;
                })
              }
            >
              Enviar evento de conversión de prueba
            </Button>
          </div>
          {testLog.length > 0 && (
            <ul className="space-y-1 rounded-xl bg-app p-3 text-xs">
              {testLog.map((l, i) => (
                <li key={i} className={l.startsWith("✖") ? "text-red-600 dark:text-red-400" : "text-ink-muted"}>{l}</li>
              ))}
            </ul>
          )}
          <div className="flex justify-between border-t border-line pt-3">
            <p className="text-xs text-ink-subtle">Los resultados quedan en la pestaña Actividad.</p>
            <Button onClick={onClose}>Finalizar</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------- Editor de mapeo de campos ----------------------

const LEAD_TARGETS = [
  ["firstName", "Nombre"],
  ["lastName", "Apellidos"],
  ["phone", "Teléfono"],
  ["email", "Correo"],
  ["custom", "Campo personalizado (atributos)"],
] as const;

export function FieldMappingEditor({
  initial,
  leadStatuses,
  onSaved,
}: {
  initial: { mappings: Array<{ source: string; target: string }>; config: Record<string, any>; active: boolean } | null;
  leadStatuses: Array<{ code: string; name: string }>;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [rows, setRows] = useState(initial?.mappings ?? [
    { source: "full_name", target: "firstName" },
    { source: "phone_number", target: "phone" },
    { source: "email", target: "email" },
  ]);
  const [statusCode, setStatusCode] = useState<string>(initial?.config?.leadStatusCode ?? "nuevo");
  const [tags, setTags] = useState<string>(((initial?.config?.tags as string[]) ?? ["meta-lead"]).join(", "));
  const [active, setActive] = useState(initial?.active ?? false);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api("/integrations/meta/lead-mapping", {
        method: "PUT",
        body: JSON.stringify({
          mappings: rows.filter((r) => r.source && r.target),
          config: {
            leadStatusCode: statusCode,
            tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
          },
          active,
        }),
      });
      toast.push("Mapeo de leads guardado", "ok");
      onSaved();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 text-sm font-medium">Campo de Meta → Campo de TuBot</p>
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                value={row.source}
                onChange={(e) => setRows((r) => r.map((x, idx) => (idx === i ? { ...x, source: e.target.value } : x)))}
                placeholder="full_name"
                className="w-48 rounded-lg border border-line-strong px-3 py-2 font-mono text-xs"
                aria-label="Campo de Meta"
              />
              <ChevronRight size={14} className="shrink-0 text-ink-subtle" aria-hidden />
              <select
                value={LEAD_TARGETS.some(([v]) => v === row.target) ? row.target : "custom"}
                onChange={(e) => setRows((r) => r.map((x, idx) => (idx === i ? { ...x, target: e.target.value === "custom" ? row.source : e.target.value } : x)))}
                className="rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm"
                aria-label="Campo de TuBot"
              >
                {LEAD_TARGETS.map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
              <button onClick={() => setRows((r) => r.filter((_, idx) => idx !== i))} aria-label="Quitar fila" className="p-1 text-ink-subtle hover:text-red-500">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
        <Button variant="ghost" className="mt-2" onClick={() => setRows((r) => [...r, { source: "", target: "custom" }])}>
          <Plus size={14} /> Agregar campo
        </Button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm font-medium">
          Estado inicial del lead
          <select value={statusCode} onChange={(e) => setStatusCode(e.target.value)} className="mt-1 w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm">
            {leadStatuses.map((s) => (
              <option key={s.code} value={s.code}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Etiquetas (separadas por coma)
          <input value={tags} onChange={(e) => setTags(e.target.value)} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Mapeo activo (procesar leads entrantes)
      </label>

      <Button onClick={() => void save()} disabled={busy}>Guardar mapeo</Button>
    </div>
  );
}

// ---------------------- Editor de eventos CAPI ----------------------

const CAPI_SOURCES = [
  "lead.created",
  "lead.status_changed:contactado",
  "lead.status_changed:calificando",
  "lead.status_changed:hot_lead",
  "lead.status_changed:agenda",
  "lead.status_changed:confirmado",
  "lead.status_changed:en_tratamiento",
  "lead.status_changed:ganado",
  "lead.status_changed:perdido",
  "appointment.created",
];
const CAPI_DESTS = ["Lead", "Contact", "Schedule", "SubmitApplication", "CompleteRegistration", "Purchase"];

export function EventMappingEditor({
  initial,
  onSaved,
}: {
  initial: { datasetId: string | null; testEventCode: string | null; rules: any[]; active: boolean } | null;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [datasetId, setDatasetId] = useState(initial?.datasetId ?? "");
  const [testEventCode, setTestEventCode] = useState(initial?.testEventCode ?? "");
  const [active, setActive] = useState(initial?.active ?? false);
  const [rules, setRules] = useState<Array<{ source: string; dest: string; value?: number | null; currency?: string | null; active: boolean }>>(
    (initial?.rules as any[]) ?? [{ source: "lead.created", dest: "Lead", active: true }],
  );
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api("/integrations/meta/event-mapping", {
        method: "PUT",
        body: JSON.stringify({ datasetId: datasetId || null, testEventCode: testEventCode || null, rules, active }),
      });
      toast.push("Reglas de conversiones guardadas", "ok");
      onSaved();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block text-sm font-medium">
          Dataset ID (Events Manager)
          <input value={datasetId} onChange={(e) => setDatasetId(e.target.value)} placeholder="123456789012345" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 font-mono text-sm" />
        </label>
        <label className="block text-sm font-medium">
          Test event code (opcional)
          <input value={testEventCode} onChange={(e) => setTestEventCode(e.target.value)} placeholder="TEST12345" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 font-mono text-sm" />
        </label>
      </div>

      <div>
        <p className="mb-2 text-sm font-medium">Evento de TuBot → Evento de Meta</p>
        <div className="space-y-2">
          {rules.map((rule, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2">
              <select
                value={rule.source}
                onChange={(e) => setRules((r) => r.map((x, idx) => (idx === i ? { ...x, source: e.target.value } : x)))}
                className="rounded-lg border border-line-strong bg-panel px-2 py-1.5 font-mono text-xs"
              >
                {[...new Set([rule.source, ...CAPI_SOURCES])].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <ChevronRight size={14} className="text-ink-subtle" aria-hidden />
              <select
                value={rule.dest}
                onChange={(e) => setRules((r) => r.map((x, idx) => (idx === i ? { ...x, dest: e.target.value } : x)))}
                className="rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-xs"
              >
                {[...new Set([rule.dest, ...CAPI_DESTS])].map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <input
                type="number"
                value={rule.value ?? ""}
                onChange={(e) => setRules((r) => r.map((x, idx) => (idx === i ? { ...x, value: e.target.value ? Number(e.target.value) : null } : x)))}
                placeholder="valor"
                className="w-24 rounded-lg border border-line-strong px-2 py-1.5 text-xs"
                aria-label="Valor"
              />
              <input
                value={rule.currency ?? ""}
                onChange={(e) => setRules((r) => r.map((x, idx) => (idx === i ? { ...x, currency: e.target.value || null } : x)))}
                placeholder="CLP"
                className="w-16 rounded-lg border border-line-strong px-2 py-1.5 text-xs uppercase"
                aria-label="Moneda"
              />
              <label className="flex items-center gap-1 text-xs text-ink-muted">
                <input type="checkbox" checked={rule.active} onChange={(e) => setRules((r) => r.map((x, idx) => (idx === i ? { ...x, active: e.target.checked } : x)))} />
                activa
              </label>
              <button onClick={() => setRules((r) => r.filter((_, idx) => idx !== i))} aria-label="Quitar regla" className="ml-auto p-1 text-ink-subtle hover:text-red-500">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
        <Button variant="ghost" className="mt-2" onClick={() => setRules((r) => [...r, { source: "lead.status_changed:agenda", dest: "Schedule", active: true }])}>
          <Plus size={14} /> Agregar regla
        </Button>
        <p className="mt-1 text-xs text-ink-subtle">
          Deduplicación por event_id automática · los teléfonos se envían normalizados y hasheados (SHA-256) según la
          documentación oficial de Meta.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
        Envío de conversiones activo
      </label>

      <Button onClick={() => void save()} disabled={busy}>Guardar reglas</Button>
    </div>
  );
}
