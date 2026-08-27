"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, StatusBadge, useToast, type StatusKind } from "@/components/ui";
import { MessagingPanel } from "./messaging-panel";

const LIMIT_FIELDS: { key: string; label: string }[] = [
  { key: "contactsMonthly", label: "Contactos / mes" },
  { key: "aiTokensDaily", label: "Tokens IA / día" },
  { key: "agents", label: "Agentes" },
  { key: "channels", label: "Canales" },
  { key: "workflows", label: "Flujos" },
  { key: "users", label: "Usuarios" },
  { key: "clinics", label: "Sedes" },
];
const STATUS_KIND: Record<string, StatusKind> = { ACTIVE: "connected", TRIAL: "beta", SUSPENDED: "attention", CANCELLED: "disconnected" };

export default function OrgDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [d, setD] = useState<any | null>(null);
  const [cost, setCost] = useState<any | null>(null);
  const [validUntil, setValidUntil] = useState("");
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [model, setModel] = useState("gpt-4o-mini");
  // Modelo de IA REAL de todo el tenant (lo fija el Super Admin).
  const [aiModel, setAiModel] = useState("gpt-4o-mini");
  const [aiMaxTokens, setAiMaxTokens] = useState(400);
  const [aiMaxToolRounds, setAiMaxToolRounds] = useState(5);
  const [saving, setSaving] = useState(false);
  const [billables, setBillables] = useState<Array<{ concept: string; amount: number }>>([]);
  const [adminEmail, setAdminEmail] = useState("");
  const [resetInfo, setResetInfo] = useState<{ email: string; tempPassword?: string | null; sent?: boolean } | null>(null);
  // Renombrar la organización en sitio (ordena cuentas multi-org sin entrar a cada tenant)
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  const load = useCallback(async () => {
    const [detail, cm] = await Promise.all([padmin<any>(`/platform/organizations/${id}`), padmin<any>("/platform/cost-model")]);
    setD(detail);
    setCost(cm);
    setValidUntil(detail.validUntil ? String(detail.validUntil).slice(0, 10) : "");
    setLimits({ ...detail.effectiveLimits });
    setAdminEmail(detail.adminEmail ?? "");
    setAiModel(detail.ai?.model ?? "gpt-4o-mini");
    setAiMaxTokens(detail.ai?.maxTokens ?? 400);
    setAiMaxToolRounds(detail.ai?.maxToolRounds ?? 5);
    setBillables(Array.isArray(detail.billables) ? detail.billables : []);
  }, [id]);
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function saveConfig(partial: Record<string, unknown>) {
    setSaving(true);
    try {
      await padmin(`/platform/organizations/${id}/config`, { method: "POST", body: JSON.stringify(partial) });
      toast.push("Guardado ✔", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function billingAction(action: string, hours?: number) {
    setSaving(true);
    try {
      await padmin(`/platform/organizations/${id}/billing-action`, { method: "POST", body: JSON.stringify({ action, hours }) });
      toast.push("Hecho ✔", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }
  async function setAgentModel(agentId: string, model: string | null) {
    try {
      await padmin(`/platform/organizations/${id}/agents/${agentId}/model`, { method: "POST", body: JSON.stringify({ model }) });
      toast.push("Modelo del agente actualizado ✔", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }
  async function setStatus(status: string) {
    await padmin(`/platform/organizations/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
    toast.push(`Estado: ${status}`, "ok");
    await load();
  }
  async function assignPlan(planCode: string) {
    if (!planCode) return;
    await padmin(`/platform/organizations/${id}/subscription`, { method: "POST", body: JSON.stringify({ planCode, status: "ACTIVE" }) });
    toast.push(`Plan ${planCode} asignado`, "ok");
    await load();
  }
  async function impersonate() {
    if (!window.confirm("Entrarás como el usuario de este tenant (soporte, 30 min, auditado). ¿Continuar?")) return;
    try {
      const res = await padmin<{ token: string; user: { email: string } }>(`/platform/organizations/${id}/impersonate`, { method: "POST" });
      window.localStorage.setItem("conversia_token", res.token);
      // Abre el PANEL del tenant (/inbox), no la raíz "/" (que es la landing de tubot.cl).
      window.open("/inbox", "_blank");
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }

  async function saveEmail() {
    setSaving(true);
    try {
      await padmin(`/platform/organizations/${id}/admin/email`, { method: "POST", body: JSON.stringify({ email: adminEmail }) });
      toast.push("Correo actualizado ✔", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }
  async function resetPassword() {
    if (!window.confirm("¿Restablecer la contraseña del administrador? Se generará una nueva y la actual dejará de servir.")) return;
    try {
      const res = await padmin<{ email: string; tempPassword: string }>(`/platform/organizations/${id}/admin/reset-password`, { method: "POST" });
      setResetInfo({ email: res.email, tempPassword: res.tempPassword });
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }
  async function sendReset() {
    if (!window.confirm("¿Enviar un restablecimiento de contraseña al correo del administrador?")) return;
    try {
      const res = await padmin<{ email: string; sent: boolean; tempPassword: string | null }>(`/platform/organizations/${id}/admin/send-reset`, { method: "POST" });
      setResetInfo({ email: res.email, sent: res.sent, tempPassword: res.tempPassword });
      if (res.sent) toast.push(`Correo enviado a ${res.email}`, "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    }
  }

  function estCostMonthly(dailyTokens: number): number | null {
    const pr = cost?.models?.[model];
    if (!dailyTokens || !pr) return null;
    const blended = pr.inputPerMTok * 0.75 + pr.outputPerMTok * 0.25;
    return (dailyTokens * 30 * blended) / 1_000_000;
  }

  if (!d) return <div className="mx-auto max-w-[1100px] px-6 py-6"><Skeleton className="h-96" /></div>;

  const tokensToday = d.metrics?.aiTokensToday ?? 0;
  const dailyLimit = Number(limits.aiTokensDaily ?? 0);
  const usagePct = dailyLimit > 0 ? Math.min(100, Math.round((tokensToday / dailyLimit) * 100)) : 0;
  const aiCostMonthly = estCostMonthly(dailyLimit);
  const aiCost30d = Number(d.usage?.find((u: any) => u.type === "ai_tokens")?._sum?.costUsd ?? 0);
  const metaCost30d = Number(d.usage?.find((u: any) => u.type === "whatsapp_message")?._sum?.costUsd ?? 0);
  const expired = d.validUntil && new Date(d.validUntil).getTime() < Date.now();

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-6 lg:px-8">
      <Link href="/admin/organizations" className="text-xs text-slate-400 hover:text-brand-600">← Organizaciones</Link>
      <div className="mt-1 flex items-start justify-between">
        {editingName ? (
          <div className="mb-6 flex items-center gap-2">
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditingName(false);
              }}
              autoFocus
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-xl font-semibold outline-none focus:border-brand-500"
            />
            <Button
              disabled={saving || nameDraft.trim().length < 2}
              onClick={async () => {
                await saveConfig({ name: nameDraft.trim() });
                setEditingName(false);
              }}
            >
              Guardar
            </Button>
            <Button variant="ghost" onClick={() => setEditingName(false)}>Cancelar</Button>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <PageHeader title={d.organization.name} description={`${d.organization.slug} · ${d.organization.country ?? "—"} · creada ${new Date(d.organization.createdAt).toLocaleDateString("es-CL")}`} />
            <button
              onClick={() => {
                setNameDraft(d.organization.name);
                setEditingName(true);
              }}
              title="Renombrar organización"
              className="mt-1.5 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-brand-600"
            >
              ✏️
            </button>
          </div>
        )}
        <div className="flex items-center gap-2 pt-1">
          <StatusBadge kind={STATUS_KIND[d.organization.status] ?? "disconnected"} label={d.organization.status.toLowerCase()} />
          {expired && <span className="rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">vencido</span>}
        </div>
      </div>

      {/* Acciones rápidas */}
      <div className="mb-5 flex flex-wrap gap-2">
        {d.organization.status === "SUSPENDED" ? (
          <Button variant="secondary" onClick={() => void setStatus("ACTIVE")}>Reactivar</Button>
        ) : (
          <Button variant="danger" onClick={() => void setStatus("SUSPENDED")}>Suspender</Button>
        )}
        <Button variant="secondary" onClick={() => void impersonate()}>Entrar como tenant (soporte)</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Panel ÚNICO de mensajería: seis condiciones + ¿puede enviar? + rechazados */}
        <MessagingPanel orgId={id} onChanged={() => void load()} />

        {/* Vigencia */}
        <section className="rounded-card border border-slate-200 bg-white p-4 shadow-card">
          <h2 className="mb-1 font-semibold text-navy-900">Vigencia del servicio</h2>
          <p className="mb-3 text-xs text-slate-500">Al vencer, la IA se detiene y se bloquea la creación de recursos.</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              Válido hasta
              <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} className="mt-1 block rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <Button disabled={saving} onClick={() => void saveConfig({ validUntil: validUntil || null })}>Guardar vigencia</Button>
            {validUntil && (
              <button onClick={() => { setValidUntil(""); void saveConfig({ validUntil: null }); }} className="text-xs text-slate-400 hover:text-red-500">
                Sin vencimiento
              </button>
            )}
          </div>
        </section>

        {/* Plan */}
        <section className="rounded-card border border-slate-200 bg-white p-4 shadow-card">
          <h2 className="mb-1 font-semibold text-navy-900">Plan y suscripción</h2>
          <p className="mb-3 text-xs text-slate-500">
            Actual: <b>{d.subscription?.planName ?? "sin plan"}</b> ({d.subscription?.status ?? "—"})
            {d.subscription?.periodEnd ? ` · renueva ${new Date(d.subscription.periodEnd).toLocaleDateString("es-CL")}` : ""}
          </p>
          <select defaultValue={d.plan?.code ?? ""} onChange={(e) => void assignPlan(e.target.value)} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">— asignar plan —</option>
            {d.availablePlans.map((p: any) => (
              <option key={p.code} value={p.code}>{p.name}</option>
            ))}
          </select>
          <label className="mt-3 block text-xs text-slate-500">
            Proveedor de pago del tenant
            <select
              value={d.paymentProvider ?? ""}
              onChange={(e) => void saveConfig({ paymentProvider: e.target.value || null })}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
            >
              <option value="">Automático (por moneda)</option>
              <option value="flow">Flow (CLP)</option>
              <option value="lemonsqueezy">Lemon Squeezy (USD)</option>
            </select>
          </label>

          {/* Facturables a medida: se suman a la base del plan "Desde" al cobrar */}
          <div className="mt-4 border-t border-slate-100 pt-3">
            <p className="text-xs font-medium text-slate-600">Facturables a medida ({d.currency ?? "CLP"})</p>
            <p className="mt-0.5 text-[11px] text-slate-400">Se suman a la base del plan en cada cobro y factura. Úsalos para adaptar un plan «Desde» a los requerimientos del cliente.</p>
            <div className="mt-2 space-y-2">
              {billables.map((b, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    value={b.concept}
                    onChange={(e) => setBillables((prev) => prev.map((x, j) => (j === i ? { ...x, concept: e.target.value } : x)))}
                    placeholder="Concepto (p. ej. Integración a medida)"
                    className="flex-1 rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                  />
                  <input
                    type="number"
                    value={b.amount}
                    onChange={(e) => setBillables((prev) => prev.map((x, j) => (j === i ? { ...x, amount: Number(e.target.value) } : x)))}
                    placeholder="Monto"
                    className="w-32 rounded-lg border border-slate-300 px-2 py-1.5 text-right text-sm"
                  />
                  <button onClick={() => setBillables((prev) => prev.filter((_, j) => j !== i))} className="px-2 text-slate-400 hover:text-red-500" title="Quitar">✕</button>
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-3">
              <button onClick={() => setBillables((prev) => [...prev, { concept: "", amount: 0 }])} className="text-xs font-medium text-brand-600 hover:text-brand-700">+ Agregar facturable</button>
              <Button disabled={saving} onClick={() => void saveConfig({ billables: billables.filter((b) => b.concept.trim() && b.amount > 0) })}>Guardar facturables</Button>
              {billables.length > 0 && (
                <span className="text-[11px] text-slate-400">Total add-ons: {billables.reduce((a, b) => a + (Number(b.amount) || 0), 0).toLocaleString("es-CL")}</span>
              )}
            </div>
          </div>
        </section>

        {/* Cobro recurrente del tenant */}
        {d.recurring && (
          <section className="rounded-card border border-slate-200 bg-white p-4 shadow-card">
            <p className="text-sm font-semibold">Cobro recurrente</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
              <span>Estado: <b className={d.recurring.status === "ACTIVE" ? "text-emerald-600" : d.recurring.status === "SUSPENDED" ? "text-red-600" : d.recurring.status === "PAST_DUE" ? "text-amber-600" : ""}>{d.recurring.status}</b></span>
              <span>Cadencia: {d.recurring.interval === "yearly" ? "anual" : "mensual"}</span>
              <span>Tarjeta: {d.recurring.hasCard ? "registrada" : "sin registrar"}</span>
              {d.recurring.nextChargeAt && <span>Próximo cobro: {new Date(d.recurring.nextChargeAt).toLocaleDateString("es-CL")}</span>}
              {d.recurring.cancelAtPeriodEnd && <span className="text-amber-600">Cancelada al fin del período</span>}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button disabled={saving} onClick={() => void billingAction("reactivate")}>Reactivar</Button>
              <button disabled={saving} onClick={() => void billingAction("extend_window", 24)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50">Extender ventana 48 h (+24 h)</button>
              <button disabled={saving} onClick={() => { if (confirm("¿Registrar un pago recibido POR FUERA (transferencia, etc.)? Renueva el período y reactiva la cuenta.")) void billingAction("register_payment"); }} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50">Registrar pago externo</button>
            </div>
            {Array.isArray(d.paymentAttempts) && d.paymentAttempts.length > 0 && (
              <div className="mt-3 overflow-hidden rounded-lg border border-slate-100 text-xs">
                {d.paymentAttempts.slice(0, 6).map((a: any) => (
                  <div key={a.id} className="flex items-center justify-between border-b border-slate-100 px-3 py-1.5 last:border-0">
                    <span className="text-slate-500">{new Date(a.createdAt).toLocaleDateString("es-CL")} · {a.kind}</span>
                    <span className={a.status === "succeeded" ? "text-emerald-600" : a.status === "failed" ? "text-red-600" : "text-amber-600"}>{a.status}{a.reason ? ` · ${a.reason}` : ""}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Límites (token limiter + caps) */}
        <section className="rounded-card border border-slate-200 bg-white p-4 shadow-card lg:col-span-2">
          <div className="mb-1 flex items-center justify-between">
            <h2 className="font-semibold text-navy-900">Límites del cliente (override por-tenant)</h2>
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={d.aiKillSwitch} onChange={(e) => void saveConfig({ aiKillSwitch: e.target.checked })} />
              Pausar IA (kill switch)
            </label>
          </div>
          <p className="mb-3 text-xs text-slate-500">Sobrescriben el plan para este cliente. 0 = ilimitado. Incluye el limitador de tokens.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            {LIMIT_FIELDS.map((f) => (
              <label key={f.key} className="text-xs text-slate-600">
                {f.label}
                {d.plan?.limits?.[f.key] !== undefined && <span className="text-slate-400"> · plan: {d.plan.limits[f.key]}</span>}
                <input
                  type="number"
                  min={0}
                  value={limits[f.key] ?? 0}
                  onChange={(e) => setLimits({ ...limits, [f.key]: Number(e.target.value) })}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
                />
              </label>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button disabled={saving} onClick={() => void saveConfig({ limits })}>Guardar límites</Button>
            <span className="text-xs text-slate-400">Los cambios aplican de inmediato (API y worker).</span>
          </div>
        </section>

        {/* Modelo de IA del cliente — aplica a TODA su plataforma */}
        <section className="rounded-card border border-slate-200 bg-white p-4 shadow-card lg:col-span-2">
          <h2 className="mb-1 font-semibold text-navy-900">Modelo de IA del cliente</h2>
          <p className="mb-3 text-xs text-slate-500">Modelo por DEFECTO del cliente (todos sus agentes y el probador), salvo los agentes con override abajo. El cliente no puede cambiarlo.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-slate-600">
              Modelo
              <select value={aiModel} onChange={(e) => setAiModel(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
                {(cost ? Object.keys(cost.models) : [aiModel]).map((m) => (<option key={m} value={m}>{m}</option>))}
              </select>
            </label>
            <label className="text-xs text-slate-600">
              Máx. tokens/respuesta
              <input type="number" min={50} max={8000} step={100} value={aiMaxTokens} onChange={(e) => setAiMaxTokens(Number(e.target.value))} className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
              <span className="mt-1 block text-[11px] leading-tight text-slate-400">
                Largo máximo de cada respuesta. Corto (≤400) puede cortar mensajes largos (listas de planes, detalles). Recomendado 1200–2000; 3000+ para agentes muy detallistas. Si se corta, el sistema la reanuda solo, pero subirlo evita el «por partes».
              </span>
            </label>
            <label className="text-xs text-slate-600">
              Máx. rondas de tools
              <input type="number" min={0} max={10} value={aiMaxToolRounds} onChange={(e) => setAiMaxToolRounds(Number(e.target.value))} className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
            </label>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Button disabled={saving} onClick={() => void saveConfig({ ai: { model: aiModel, maxTokens: aiMaxTokens, maxToolRounds: aiMaxToolRounds } })}>Guardar modelo</Button>
            <span className="text-xs text-slate-400">Aplica de inmediato a los agentes del cliente.</span>
          </div>
        </section>

        {/* Modelo POR AGENTE — override para optimizar costos (p. ej. ventas barato, implementación Opus) */}
        {Array.isArray(d?.agents) && d.agents.length > 0 && (
          <section className="rounded-card border border-slate-200 bg-white p-4 shadow-card lg:col-span-2">
            <h2 className="mb-1 font-semibold text-navy-900">Modelo por agente</h2>
            <p className="mb-3 text-xs text-slate-500">
              Override por agente. «Heredar» usa el modelo del cliente de arriba. Optimiza costos: ventas/soporte en un modelo
              económico y el de implementación en Opus. Por defecto de plataforma: <span className="font-mono">{d?.ai?.platformDefaultModel ?? "gpt-4o-mini"}</span>.
            </p>
            <div className="space-y-2">
              {d.agents.map((a: any) => (
                <div key={a.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-navy-900">{a.name}{!a.active && <span className="ml-1 text-xs text-slate-400">(inactivo)</span>}</p>
                    <p className="text-xs text-slate-400">{a.kind} · efectivo: <span className="font-mono">{a.effectiveModel}</span></p>
                  </div>
                  <select
                    value={a.model ?? ""}
                    onChange={(e) => void setAgentModel(a.id, e.target.value || null)}
                    className="shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm"
                  >
                    <option value="">Heredar del cliente</option>
                    {(d.availableModels ?? []).map((m: string) => (<option key={m} value={m}>{m}</option>))}
                  </select>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Costo de los máximos */}
        <section className="rounded-card border border-slate-200 bg-white p-4 shadow-card">
          <h2 className="mb-1 font-semibold text-navy-900">Costo de los máximos</h2>
          <p className="mb-3 text-xs text-slate-500">Costo de IA si el cliente consume todo su tope diario, 30 días.</p>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs text-slate-500">Modelo:</span>
            <select value={model} onChange={(e) => setModel(e.target.value)} className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs">
              {cost ? Object.keys(cost.models).map((m) => <option key={m} value={m}>{m}</option>) : <option>{model}</option>}
            </select>
          </div>
          {aiCostMonthly == null ? (
            <p className="text-sm text-slate-400">Tope de tokens en 0 (ilimitado) — sin estimación.</p>
          ) : (
            <p className="text-2xl font-bold text-navy-900">US${aiCostMonthly.toFixed(2)}<span className="text-sm font-normal text-slate-400"> /mes máx.</span></p>
          )}
          <p className="mt-1 text-[11px] text-slate-400">Solo costo de tokens de IA (no incluye conversaciones de WhatsApp).</p>
        </section>

        {/* Indicador de uso */}
        <section className="rounded-card border border-slate-200 bg-white p-4 shadow-card">
          <h2 className="mb-3 font-semibold text-navy-900">Uso</h2>
          <div className="mb-2">
            <div className="flex justify-between text-xs text-slate-500">
              <span>Tokens IA hoy</span>
              <span>{tokensToday.toLocaleString("es-CL")}{dailyLimit > 0 ? ` / ${dailyLimit.toLocaleString("es-CL")}` : " (ilimitado)"}</span>
            </div>
            {dailyLimit > 0 && (
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div className={`h-full ${usagePct >= 90 ? "bg-red-500" : usagePct >= 70 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${usagePct}%` }} />
              </div>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            {[
              { label: "Costo IA 30d", value: `US$${aiCost30d.toFixed(2)}` },
              { label: "Costo Meta 30d", value: `US$${metaCost30d.toFixed(2)}` },
              { label: "Conversaciones", value: d.metrics.conversationsInitiated },
              { label: "Clientes activos", value: d.metrics.activeClients },
            ].map((s) => (
              <div key={s.label} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                <div className="text-base font-semibold text-navy-900">{s.value}</div>
                <div className="text-[10px] text-slate-500">{s.label}</div>
              </div>
            ))}
          </div>
          {d.templates && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-medium text-navy-900">Mensajes de plantilla (WhatsApp) — período actual</span>
                <span className="text-slate-500">
                  {d.templates.used.toLocaleString("es-CL")}{d.templates.included < 0 ? " (ilimitado)" : ` / ${d.templates.included.toLocaleString("es-CL")} incluidos`}
                </span>
              </div>
              <p className="mt-1 text-slate-400">Costo que cobra Meta este período: US${(d.templates.metaCostUsd ?? 0).toFixed(2)}.</p>
            </div>
          )}
        </section>

        {/* Facturas */}
        <section className="rounded-card border border-slate-200 bg-white p-4 shadow-card">
          <h2 className="mb-2 font-semibold text-navy-900">Facturas</h2>
          {d.invoices.length === 0 ? (
            <p className="text-xs text-slate-400">Sin facturas.</p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {d.invoices.slice(0, 8).map((inv: any) => (
                  <tr key={inv.id} className="border-t border-slate-100">
                    <td className="py-1 font-mono">{inv.number}</td>
                    <td className="py-1">{inv.currency} {Number(inv.amountDue).toLocaleString("es-CL")}</td>
                    <td className="py-1">{inv.status}</td>
                    <td className="py-1 text-slate-400">{new Date(inv.createdAt).toLocaleDateString("es-CL")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* Cuenta del administrador */}
        <section className="rounded-card border border-slate-200 bg-white p-4 shadow-card lg:col-span-2">
          <h2 className="mb-1 font-semibold text-navy-900">Cuenta del administrador</h2>
          <p className="mb-3 text-xs text-slate-500">Correo y contraseña del usuario dueño de este tenant.</p>
          <div className="mb-3 grid gap-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3 text-sm sm:grid-cols-2">
            <div><span className="text-xs text-slate-500">Nombre (registro)</span><div className="font-medium text-navy-900">{d.adminName ?? "—"}</div></div>
            <div><span className="text-xs text-slate-500">Negocio (registro)</span><div className="font-medium text-navy-900">{d.organization.name}</div></div>
            <div><span className="text-xs text-slate-500">Correo</span><div className="font-medium text-navy-900">{d.adminEmail ?? "—"}</div></div>
            <div><span className="text-xs text-slate-500">Creada</span><div className="font-medium text-navy-900">{new Date(d.organization.createdAt).toLocaleDateString("es-CL")}</div></div>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-sm">
              Correo del administrador
              <input type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className="mt-1 block w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <Button variant="secondary" disabled={saving || !adminEmail} onClick={() => void saveEmail()}>Guardar correo</Button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => void resetPassword()}>Restablecer contraseña</Button>
            <Button variant="secondary" onClick={() => void sendReset()}>Enviar restablecimiento al correo</Button>
          </div>
          {resetInfo && (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
              {resetInfo.tempPassword ? (
                <>
                  <p className="text-amber-900">Contraseña temporal para <b>{resetInfo.email}</b> (se muestra una vez):</p>
                  <p className="mt-1 font-mono text-base text-navy-900">{resetInfo.tempPassword}</p>
                  {resetInfo.sent === false && <p className="mt-1 text-[11px] text-amber-700">No se pudo enviar por correo (falta configurar Resend): compártela manualmente.</p>}
                </>
              ) : (
                <p className="text-emerald-800">✓ Restablecimiento enviado a {resetInfo.email}.</p>
              )}
              <button onClick={() => setResetInfo(null)} className="mt-2 text-xs text-slate-400 hover:text-slate-600">Cerrar</button>
            </div>
          )}
        </section>

        {/* Miembros */}
        <section className="rounded-card border border-slate-200 bg-white p-4 shadow-card lg:col-span-2">
          <h2 className="mb-2 font-semibold text-navy-900">Miembros ({d.members.length})</h2>
          <ul className="grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
            {d.members.map((m: any) => (
              <li key={m.email}>{m.name} · {m.email} {m.active ? "" : "(inactivo)"}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
