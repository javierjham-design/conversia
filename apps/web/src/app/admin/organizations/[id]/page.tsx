"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, StatusBadge, useToast, type StatusKind } from "@/components/ui";

const LIMIT_FIELDS: { key: string; label: string }[] = [
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
  const [adminEmail, setAdminEmail] = useState("");
  const [resetInfo, setResetInfo] = useState<{ email: string; tempPassword?: string | null; sent?: boolean } | null>(null);

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
      window.open("/", "_blank");
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
        <PageHeader title={d.organization.name} description={`${d.organization.slug} · ${d.organization.country ?? "—"} · creada ${new Date(d.organization.createdAt).toLocaleDateString("es-CL")}`} />
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
        </section>

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
          <p className="mb-3 text-xs text-slate-500">Aplica a toda la plataforma del cliente (todos sus agentes y el probador). El cliente no puede cambiarlo.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-xs text-slate-600">
              Modelo
              <select value={aiModel} onChange={(e) => setAiModel(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm">
                {(cost ? Object.keys(cost.models) : [aiModel]).map((m) => (<option key={m} value={m}>{m}</option>))}
              </select>
            </label>
            <label className="text-xs text-slate-600">
              Máx. tokens/respuesta
              <input type="number" min={50} max={4000} value={aiMaxTokens} onChange={(e) => setAiMaxTokens(Number(e.target.value))} className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
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
