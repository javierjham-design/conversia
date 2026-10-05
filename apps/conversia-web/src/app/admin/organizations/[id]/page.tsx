"use client";
import { use, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";
import { setToken } from "@/lib/api";

type Detail = {
  organization: { id: string; name: string; slug: string; status: string; country: string | null; createdAt: string };
  adminEmail: string | null;
  adminName: string | null;
  subscription: { status: string; planCode?: string; planName?: string; periodEnd?: string } | null;
  plan: { code: string; name: string } | null;
  validUntil: string | null;
  aiKillSwitch: boolean;
  templates_switch: { switchOn: boolean; planAllows: boolean };
  currency: string;
  ai: { model: string | null; maxTokens: number | null; maxToolRounds: number | null; platformDefaultModel: string };
  agents: { id: string; name: string; kind: string; active: boolean; model: string | null; effectiveModel: string }[];
  availableModels: string[];
  availablePlans: { code: string; name: string }[];
};
type Wallet = { balance: number; included: number; ledger: { delta: number; reason: string; balanceAfter: number; createdAt: string }[] };
type VerticalCat = { key: string; name: string; wave: number; status: string; variant: string; requiresFeature: string[] };

const ONBOARDING_STEPS: { key: string; label: string }[] = [
  { key: "cuenta", label: "Cuenta creada" },
  { key: "rubro", label: "Rubro instalado" },
  { key: "agentes", label: "Agentes configurados (prompts)" },
  { key: "agenda", label: "Agenda: horarios y servicios" },
  { key: "canal", label: "Canal conectado" },
  { key: "prueba", label: "Primera conversación de prueba" },
  { key: "entregado", label: "Entregado al cliente" },
];
const CHANNEL_TYPES: { type: string; label: string; emoji: string }[] = [
  { type: "whatsapp", label: "WhatsApp", emoji: "🟢" },
  { type: "instagram", label: "Instagram", emoji: "📸" },
  { type: "messenger", label: "Messenger", emoji: "💬" },
  { type: "tiktok", label: "TikTok", emoji: "🎵" },
];

const NAPSE: React.CSSProperties = { width: "100%", padding: "9px 12px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };
const LABEL: React.CSSProperties = { fontSize: 12, color: "var(--ink-dim)", display: "block", marginBottom: 4 };

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ padding: 18 }}>
      <h2 className="display" style={{ fontSize: 17, margin: "0 0 14px" }}>{title}</h2>
      {children}
    </div>
  );
}

export default function AdminOrgDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [d, setD] = useState<Detail | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Estado editable
  const [name, setName] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [aiKill, setAiKill] = useState(false);
  const [templatesOn, setTemplatesOn] = useState(false);
  const [model, setModel] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [maxRounds, setMaxRounds] = useState("");
  const [planCode, setPlanCode] = useState("");
  const [vertical, setVertical] = useState("");
  const [catalog, setCatalog] = useState<VerticalCat[]>([]);
  const [adjust, setAdjust] = useState("");
  const [steps, setSteps] = useState<Record<string, boolean>>({});
  const [obNotes, setObNotes] = useState("");
  const [channels, setChannels] = useState<{ connections: { id: string; type: string; name: string; status: string }[]; intents: { type: string; status: string }[] }>({ connections: [], intents: [] });
  const [cash, setCash] = useState<{ net: number; conciliado: number; declarado: number; byMethod: Record<string, number>; count: number } | null>(null);
  const [impl, setImpl] = useState<{ steps: { key: string; title: string; done: boolean }[]; percent: number; goLiveReady: boolean; lifecycle: { stage: string | null; setupPaid: boolean; deliveredAt: string | null } } | null>(null);

  const load = () =>
    padmin<Detail>(`/platform/organizations/${id}`).then((x) => {
      setD(x);
      setName(x.organization.name);
      setValidUntil(x.validUntil ? x.validUntil.slice(0, 10) : "");
      setAiKill(x.aiKillSwitch);
      setTemplatesOn(x.templates_switch.switchOn);
      setModel(x.ai.model ?? "");
      setMaxTokens(x.ai.maxTokens ? String(x.ai.maxTokens) : "");
      setMaxRounds(x.ai.maxToolRounds != null ? String(x.ai.maxToolRounds) : "");
      setPlanCode(x.subscription?.planCode ?? x.plan?.code ?? "");
    });

  const loadChannels = () => padmin<typeof channels>(`/platform/organizations/${id}/channels`).then(setChannels).catch(() => {});

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
    padmin<Wallet>(`/platform/organizations/${id}/wallet`).then(setWallet).catch(() => {});
    padmin<VerticalCat[]>("/platform/verticals").then(setCatalog).catch(() => {});
    padmin<typeof cash>(`/platform/organizations/${id}/cash-summary`).then(setCash).catch(() => {});
    padmin<typeof impl>(`/platform/organizations/${id}/implementation`).then(setImpl).catch(() => {});
    padmin<{ steps: Record<string, boolean>; notes: string }>(`/platform/organizations/${id}/onboarding`).then((o) => { setSteps(o.steps); setObNotes(o.notes); }).catch(() => {});
    loadChannels();
  }, [id]);

  async function run(fn: () => Promise<unknown>, okMsg: string) {
    setError(null);
    setMsg(null);
    try {
      await fn();
      setMsg(okMsg);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const saveConfig = () =>
    run(
      () =>
        padmin(`/platform/organizations/${id}/config`, {
          method: "POST",
          body: JSON.stringify({
            name: name || undefined,
            validUntil: validUntil || null,
            aiKillSwitch: aiKill,
            templatesEnabled: templatesOn,
            ai: {
              ...(model ? { model } : {}),
              ...(maxTokens ? { maxTokens: Number(maxTokens) } : {}),
              ...(maxRounds !== "" ? { maxToolRounds: Number(maxRounds) } : {}),
            },
          }),
        }),
      "Configuración guardada.",
    );

  const assignPlan = () =>
    run(() => padmin(`/platform/organizations/${id}/subscription`, { method: "POST", body: JSON.stringify({ planCode, status: "ACTIVE" }) }), "Plan asignado.");

  const setStatus = (status: string) =>
    run(() => padmin(`/platform/organizations/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }), `Estado → ${status}.`);

  const installVertical = () =>
    run(() => padmin(`/platform/organizations/${id}/vertical`, { method: "POST", body: JSON.stringify({ key: vertical }) }), `Rubro "${vertical}" instalado.`);

  const adjustWallet = () =>
    run(async () => {
      await padmin(`/platform/organizations/${id}/wallet-adjust`, { method: "POST", body: JSON.stringify({ delta: Number(adjust), reason: "Ajuste desde consola" }) });
      setAdjust("");
      setWallet(await padmin<Wallet>(`/platform/organizations/${id}/wallet`));
    }, "Créditos ajustados.");

  const saveOnboarding = (nextSteps: Record<string, boolean>, notes: string) =>
    run(() => padmin(`/platform/organizations/${id}/onboarding`, { method: "PATCH", body: JSON.stringify({ steps: nextSteps, notes }) }), "Ficha de implementación guardada.");

  function toggleStep(key: string) {
    const next = { ...steps, [key]: !steps[key] };
    setSteps(next);
    saveOnboarding(next, obNotes);
  }

  const addChannel = (type: string) =>
    run(async () => { await padmin(`/platform/organizations/${id}/channels`, { method: "POST", body: JSON.stringify({ type }) }); await loadChannels(); }, `Canal ${type} agregado (pendiente de conexión).`);
  const removeChannel = (type: string) =>
    run(async () => { await padmin(`/platform/organizations/${id}/channels/${type}`, { method: "DELETE" }); await loadChannels(); }, `Canal ${type} quitado.`);

  async function impersonate(path = "/") {
    setError(null);
    if (!confirm("Entrarás al panel de este cliente como soporte (reemplaza tu sesión de cliente en este navegador). ¿Continuar?")) return;
    try {
      const r = await padmin<{ token: string }>(`/platform/organizations/${id}/impersonate`, { method: "POST" });
      // El token de impersonación es un JWT de TENANT → se guarda bajo la clave de cliente;
      // el token de super admin vive en otra clave, así tu sesión de consola se mantiene.
      setToken(r.token);
      window.open(path, "_blank");
      setMsg("Sesión de soporte abierta en otra pestaña (30 min).");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error && !d) return <p style={{ color: "var(--danger)" }}>{error}</p>;
  if (!d) return <p className="text-dim">Cargando tenant…</p>;

  return (
    <div style={{ maxWidth: 900 }}>
      <a href="/admin/organizations" className="text-dim" style={{ fontSize: 13, textDecoration: "none" }}>← Tenants</a>
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", margin: "8px 0 20px" }}>
        <h1 className="display" style={{ fontSize: 26, margin: 0 }}>{d.organization.name}</h1>
        <span className="text-dim" style={{ fontSize: 13 }}>{d.organization.slug} · {d.currency} · {d.organization.status}</span>
        <a href={`/admin/organizations/${id}/conversaciones`} className="nav-item" style={{ marginLeft: "auto", width: "auto", height: 38, padding: "0 12px", gap: 6, border: "1px solid var(--line)", fontSize: 13, textDecoration: "none" }}>Ver conversaciones</a>
        <button className="btn-accent" onClick={() => impersonate("/")}>Entrar como soporte</button>
      </div>
      {msg ? <p style={{ color: "var(--ok)", fontSize: 13 }}>{msg}</p> : null}
      {error ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{error}</p> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
        <Card title="Datos y vigencia">
          <label style={LABEL}>Nombre</label>
          <input style={NAPSE} value={name} onChange={(e) => setName(e.target.value)} />
          <label style={{ ...LABEL, marginTop: 12 }}>Vigencia del servicio (vacío = sin vencimiento)</label>
          <input style={NAPSE} type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          <p className="text-dim" style={{ fontSize: 12, marginTop: 10 }}>Admin: {d.adminEmail ?? "—"}</p>
        </Card>

        <Card title="Plan y suscripción">
          <label style={LABEL}>Plan</label>
          <select style={NAPSE} value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
            <option value="">— elegir —</option>
            {d.availablePlans.map((p) => (
              <option key={p.code} value={p.code}>{p.name}</option>
            ))}
          </select>
          <button className="btn-accent" onClick={assignPlan} disabled={!planCode} style={{ marginTop: 12, width: "100%" }}>Asignar plan (activar)</button>
          <p className="text-dim" style={{ fontSize: 12, marginTop: 10 }}>
            Actual: {d.subscription?.planName ?? "—"} · {d.subscription?.status ?? "sin suscripción"}
          </p>
        </Card>

        <Card title="Inteligencia artificial">
          <label style={LABEL}>Modelo (vacío = default plataforma: {d.ai.platformDefaultModel})</label>
          <select style={NAPSE} value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">— default —</option>
            {d.availableModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={LABEL}>Máx. tokens</label>
              <input style={NAPSE} inputMode="numeric" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} placeholder="1500" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={LABEL}>Máx. rondas de tools</label>
              <input style={NAPSE} inputMode="numeric" value={maxRounds} onChange={(e) => setMaxRounds(e.target.value)} placeholder="5" />
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, fontSize: 14 }}>
            <input type="checkbox" checked={aiKill} onChange={(e) => setAiKill(e.target.checked)} />
            Pausar la IA (kill switch)
          </label>
        </Card>

        <Card title="Mensajería (WhatsApp)">
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
            <input type="checkbox" checked={templatesOn} onChange={(e) => setTemplatesOn(e.target.checked)} />
            Permitir envío de plantillas
          </label>
          <p className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>
            {d.templates_switch.planAllows ? "El plan permite plantillas." : "⚠ El plan actual no incluye plantillas."}
          </p>
        </Card>

        <Card title="Rubro (paquete vertical)">
          <label style={LABEL}>Instalar rubro (catálogo completo, incluye beta)</label>
          <select style={NAPSE} value={vertical} onChange={(e) => setVertical(e.target.value)}>
            <option value="">— elegir rubro —</option>
            {catalog.map((c) => {
              const blocked = c.requiresFeature.length > 0;
              return (
                <option key={c.key} value={c.key} disabled={blocked}>
                  {c.name} · ola {c.wave}{c.status === "beta" ? " · beta" : ""}{c.variant !== "citas" ? ` · ${c.variant}` : ""}{blocked ? " (bloqueado)" : ""}
                </option>
              );
            })}
          </select>
          <button className="btn-accent" onClick={installVertical} disabled={!vertical} style={{ marginTop: 12, width: "100%" }}>Instalar paquete</button>
          <p className="text-dim" style={{ fontSize: 12, marginTop: 8 }}>Instala plantillas/estados/config del rubro (borrador editable). Los beta solo se instalan desde aquí.</p>
        </Card>

        <Card title="Créditos (bolsa)">
          {wallet ? (
            <>
              <p style={{ margin: 0, fontSize: 22 }} className="display">{wallet.balance.toLocaleString("es-CL")}</p>
              <p className="text-dim" style={{ fontSize: 12, margin: "2px 0 12px" }}>créditos · incluidos/período: {wallet.included}</p>
            </>
          ) : (
            <p className="text-dim" style={{ fontSize: 13 }}>Sin bolsa.</p>
          )}
          <label style={LABEL}>Ajustar (+ regalar / − quitar)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input style={NAPSE} inputMode="numeric" value={adjust} onChange={(e) => setAdjust(e.target.value)} placeholder="+500" />
            <button className="btn-accent" onClick={adjustWallet} disabled={!adjust || Number(adjust) === 0}>Aplicar</button>
          </div>
        </Card>

        <Card title="Estado del tenant">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="nav-item" onClick={() => setStatus("ACTIVE")} style={{ width: "auto", height: 38, padding: "0 14px", border: "1px solid var(--line)", background: "transparent", cursor: "pointer", fontSize: 13 }}>Activar</button>
            <button className="nav-item" onClick={() => setStatus("TRIAL")} style={{ width: "auto", height: 38, padding: "0 14px", border: "1px solid var(--line)", background: "transparent", cursor: "pointer", fontSize: 13 }}>Prueba</button>
            <button className="nav-item" onClick={() => setStatus("SUSPENDED")} style={{ width: "auto", height: 38, padding: "0 14px", border: "1px solid var(--line)", background: "transparent", cursor: "pointer", fontSize: 13, color: "var(--danger)" }}>Suspender</button>
          </div>
        </Card>

        <Card title="Agentes de IA">
          {d.agents.length ? d.agents.map((a) => (
            <a key={a.id} href={`/admin/organizations/${id}/agents/${a.id}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: "1px solid var(--hairline)", fontSize: 13, textDecoration: "none", color: "var(--ink)" }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                {a.name} <span className="text-dim">· {a.kind}</span>
                {!a.active ? <span style={{ color: "var(--warn)", fontSize: 11 }}> · inactivo</span> : null}
                <br /><span className="text-dim" style={{ fontSize: 11 }}>{a.effectiveModel}</span>
              </span>
              <span className="text-accent" style={{ fontSize: 13 }}>Configurar →</span>
            </a>
          )) : <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Sin agentes aún.</p>}
          <a href={`/admin/organizations/${id}/agents`} className="btn-accent" style={{ display: "block", textAlign: "center", textDecoration: "none", marginTop: 14 }}>Abrir configurador de agentes</a>
        </Card>

        <Card title="Canales (conexión por tenant)">
          {channels.connections.length ? channels.connections.map((c) => (
            <div key={c.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderTop: "1px solid var(--hairline)", fontSize: 13 }}>
              <span>{c.name} <span className="text-dim">· {c.type}</span></span>
              <span style={{ color: c.status === "active" ? "var(--ok)" : "var(--warn)", fontSize: 12 }}>● {c.status}</span>
            </div>
          )) : null}
          {channels.intents.map((c) => (
            <div key={c.type} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: "1px solid var(--hairline)", fontSize: 13 }}>
              <span style={{ flex: 1 }}>{CHANNEL_TYPES.find((t) => t.type === c.type)?.emoji} {CHANNEL_TYPES.find((t) => t.type === c.type)?.label ?? c.type} <span style={{ color: "var(--warn)", fontSize: 11 }}>· pendiente de conexión</span></span>
              <button onClick={() => removeChannel(c.type)} className="text-dim" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 12 }}>Quitar</button>
            </div>
          ))}
          <label style={{ ...LABEL, marginTop: 12 }}>Agregar canal (se conecta a Meta/TikTok al final)</label>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {CHANNEL_TYPES.filter((t) => !channels.intents.some((i) => i.type === t.type) && !channels.connections.some((c) => c.type.toLowerCase().includes(t.type))).map((t) => (
              <button key={t.type} onClick={() => addChannel(t.type)} className="nav-item" style={{ width: "auto", height: 34, padding: "0 10px", border: "1px solid var(--line)", background: "transparent", cursor: "pointer", fontSize: 12 }}>+ {t.emoji} {t.label}</button>
            ))}
          </div>
          <p className="text-dim" style={{ fontSize: 11, marginTop: 8 }}>Cableado listo; la conexión real con Meta (WhatsApp/IG/Messenger) y TikTok se activa al final. Los canales le figuran al cliente en su panel.</p>
        </Card>

        <Card title="Implementación / onboarding">
          {ONBOARDING_STEPS.map((s) => (
            <label key={s.key} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", fontSize: 13, cursor: "pointer" }}>
              <input type="checkbox" checked={!!steps[s.key]} onChange={() => toggleStep(s.key)} /> {s.label}
            </label>
          ))}
          <label style={{ ...LABEL, marginTop: 10 }}>Notas de montaje</label>
          <textarea value={obNotes} onChange={(e) => setObNotes(e.target.value)} onBlur={() => saveOnboarding(steps, obNotes)} rows={3} style={{ ...NAPSE, resize: "vertical" }} placeholder="Notas internas del montaje…" />
        </Card>

        <Card title="Agenda y servicios">
          <p className="text-dim" style={{ fontSize: 13, margin: "0 0 12px" }}>Configura horarios, equipo y servicios del tenant (se abre su panel como soporte).</p>
          <button className="btn-accent" onClick={() => impersonate("/agenda/configurar")} style={{ width: "100%" }}>Configurar agenda</button>
        </Card>

        <Card title="Caja (resumen · solo lectura)">
          {cash ? (
            <>
              <p className="display" style={{ margin: 0, fontSize: 22 }}>${Math.round(cash.net).toLocaleString("es-CL")}</p>
              <p className="text-dim" style={{ fontSize: 12, margin: "2px 0 10px" }}>neto 30 días · {cash.count} asientos</p>
              <p className="text-dim" style={{ fontSize: 12 }}>Conciliado: ${Math.round(cash.conciliado).toLocaleString("es-CL")} · Declarado: ${Math.round(cash.declarado).toLocaleString("es-CL")}</p>
              <p className="text-dim" style={{ fontSize: 11, marginTop: 10 }}>El super admin solo ve; el tenant registra y cierra su caja.</p>
            </>
          ) : (
            <p className="text-dim" style={{ fontSize: 13 }}>Sin movimientos de caja.</p>
          )}
        </Card>

        <Card title="Implementación (F10)">
          {impl ? (
            <>
              <p className="display" style={{ margin: 0, fontSize: 22 }}>{impl.percent}%</p>
              <p className="text-dim" style={{ fontSize: 12, margin: "2px 0 10px" }}>
                {impl.lifecycle.stage === "demo" ? "Cuenta demo (sin cobro)" : impl.lifecycle.deliveredAt || impl.lifecycle.stage === "active" ? "En vivo" : impl.lifecycle.setupPaid ? "Implementando" : "Prospecto"}
                {impl.lifecycle.stage === "demo" ? "" : impl.lifecycle.setupPaid ? " · setup pagado" : " · setup sin pagar"}
              </p>
              <ul style={{ listStyle: "none", padding: 0, margin: "0 0 10px", display: "flex", flexDirection: "column", gap: 4 }}>
                {impl.steps.map((s) => <li key={s.key} style={{ fontSize: 12, color: s.done ? "var(--ok)" : "var(--ink-dim)" }}>{s.done ? "✓" : "○"} {s.title}</li>)}
              </ul>
              {impl.lifecycle.deliveredAt || impl.lifecycle.stage === "active" ? (
                <p className="text-dim" style={{ fontSize: 11 }}>Cliente entregado{impl.lifecycle.deliveredAt ? ` · ${new Date(impl.lifecycle.deliveredAt).toLocaleDateString("es-CL")}` : ""}.</p>
              ) : impl.lifecycle.stage === "demo" ? (
                <p className="text-dim" style={{ fontSize: 11 }}>Cuenta interna de prueba. No se factura.</p>
              ) : (
                <>
                  <button
                    className="btn-accent"
                    disabled={!impl.lifecycle.setupPaid}
                    title={!impl.lifecycle.setupPaid ? "Requiere setup pagado (o usa override)" : !impl.goLiveReady ? "Aún faltan pasos (puedes entregar igual)" : "Poner en vivo"}
                    onClick={() => { if (confirm("¿Marcar ENTREGADO? Pone al cliente EN VIVO y activa su ciclo de cobro.")) run(() => padmin(`/platform/organizations/${id}/lifecycle/delivered`, { method: "POST" }).then(() => padmin<typeof impl>(`/platform/organizations/${id}/implementation`).then(setImpl)), "Cliente marcado como ENTREGADO."); }}
                    style={{ width: "100%", opacity: impl.lifecycle.setupPaid ? 1 : 0.5 }}
                  >Marcar ENTREGADO</button>
                  {/* B6 — entregar sin setup pagado requiere override con motivo (auditado, solo super admin) */}
                  {!impl.lifecycle.setupPaid ? (
                    <button
                      onClick={() => { const reason = prompt("Entregar SIN setup pagado (override auditado). Motivo:"); if (reason && reason.trim()) run(() => padmin(`/platform/organizations/${id}/lifecycle/delivered`, { method: "POST", body: JSON.stringify({ override: true, reason: reason.trim() }) }).then(() => padmin<typeof impl>(`/platform/organizations/${id}/implementation`).then(setImpl)), "Entregado con override."); }}
                      style={{ width: "100%", marginTop: 8, padding: "9px 12px", fontSize: 13, borderRadius: 10, border: "1px solid var(--warn)", background: "transparent", color: "var(--ink)", cursor: "pointer" }}
                    >Entregar con override…</button>
                  ) : null}
                  {/* B6 — marcar como cuenta demo interna (operativa, sin cobro) */}
                  <button
                    onClick={() => { const reason = prompt("Marcar como cuenta DEMO interna (operativa, sin cobro). Motivo (opcional):") ?? ""; if (confirm("¿Marcar esta cuenta como DEMO? No se facturará.")) run(() => padmin(`/platform/organizations/${id}/lifecycle/demo`, { method: "POST", body: JSON.stringify({ reason: reason.trim() || undefined }) }).then(() => padmin<typeof impl>(`/platform/organizations/${id}/implementation`).then(setImpl)), "Cuenta marcada como demo."); }}
                    style={{ width: "100%", marginTop: 8, padding: "9px 12px", fontSize: 13, borderRadius: 10, border: "1px solid var(--line)", background: "transparent", color: "var(--ink-dim)", cursor: "pointer" }}
                  >Marcar como demo</button>
                </>
              )}
            </>
          ) : (
            <p className="text-dim" style={{ fontSize: 13 }}>Sin datos de implementación.</p>
          )}
        </Card>
      </div>

      <button className="btn-accent" onClick={saveConfig} style={{ marginTop: 20, padding: "12px 28px", fontSize: 15 }}>Guardar configuración</button>
    </div>
  );
}
