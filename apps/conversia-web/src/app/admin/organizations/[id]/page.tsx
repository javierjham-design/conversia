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
  const [editAgent, setEditAgent] = useState<string | null>(null);

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

  useEffect(() => {
    load().catch((e) => setError((e as Error).message));
    padmin<Wallet>(`/platform/organizations/${id}/wallet`).then(setWallet).catch(() => {});
    padmin<VerticalCat[]>("/platform/verticals").then(setCatalog).catch(() => {});
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

  async function impersonate() {
    setError(null);
    if (!confirm("Entrarás al panel de este cliente como soporte (reemplaza tu sesión de cliente en este navegador). ¿Continuar?")) return;
    try {
      const r = await padmin<{ token: string }>(`/platform/organizations/${id}/impersonate`, { method: "POST" });
      // El token de impersonación es un JWT de TENANT → se guarda bajo la clave de cliente;
      // el token de super admin vive en otra clave, así tu sesión de consola se mantiene.
      setToken(r.token);
      window.open("/", "_blank");
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
        <button className="btn-accent" onClick={impersonate} style={{ marginLeft: "auto" }}>Entrar como soporte</button>
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

        {d.agents.length ? (
          <Card title="Agentes de IA">
            {d.agents.map((a) => (
              <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: "1px solid var(--hairline)", fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {a.name} <span className="text-dim">· {a.kind}</span>
                  {!a.active ? <span style={{ color: "var(--warn)", fontSize: 11 }}> · inactivo</span> : null}
                  <br /><span className="text-dim" style={{ fontSize: 11 }}>{a.effectiveModel}</span>
                </span>
                <button onClick={() => setEditAgent(a.id)} className="text-accent" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13 }}>Editar</button>
              </div>
            ))}
          </Card>
        ) : null}
      </div>

      <button className="btn-accent" onClick={saveConfig} style={{ marginTop: 20, padding: "12px 28px", fontSize: 15 }}>Guardar configuración</button>

      {editAgent ? <AgentEditor orgId={id} agentId={editAgent} onClose={() => setEditAgent(null)} onSaved={() => { setEditAgent(null); load(); }} /> : null}
    </div>
  );
}

function AgentEditor({ orgId, agentId, onClose, onSaved }: { orgId: string; agentId: string; onClose: () => void; onSaved: () => void }) {
  const [a, setA] = useState<{ name: string; kind: string; active: boolean; systemPrompt: string } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    padmin<{ name: string; kind: string; active: boolean; systemPrompt: string }>(`/platform/organizations/${orgId}/agents/${agentId}`)
      .then((x) => { setA(x); setPrompt(x.systemPrompt); setActive(x.active); })
      .catch((e) => setErr((e as Error).message));
  }, [orgId, agentId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await padmin(`/platform/organizations/${orgId}/agents/${agentId}/prompt`, { method: "POST", body: JSON.stringify({ systemPrompt: prompt }) });
      if (a && active !== a.active) {
        await padmin(`/platform/organizations/${orgId}/agents/${agentId}/active`, { method: "POST", body: JSON.stringify({ active }) });
      }
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={save} className="card" style={{ width: "100%", maxWidth: 640, padding: 22, maxHeight: "92dvh", overflowY: "auto" }}>
        <h2 className="display" style={{ fontSize: 19, margin: "0 0 2px" }}>{a ? a.name : "Agente"}</h2>
        <p className="text-dim" style={{ fontSize: 12, margin: "0 0 12px" }}>{a ? a.kind : ""} · editar prompt y estado</p>
        {!a && !err ? <p className="text-dim">Cargando…</p> : null}
        {a ? (
          <>
            <label style={LABEL}>System prompt</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={16} style={{ ...NAPSE, fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 1.5, resize: "vertical" }} />
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12, fontSize: 14 }}>
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Agente activo
            </label>
          </>
        ) : null}
        {err ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 10 }}>{err}</p> : null}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onClose} className="nav-item" style={{ flex: 1, height: 42, justifyContent: "center", border: "1px solid var(--line)", background: "transparent", cursor: "pointer" }}>Cancelar</button>
          <button className="btn-accent" type="submit" disabled={busy || !a} style={{ flex: 1, opacity: busy || !a ? 0.6 : 1 }}>{busy ? "Guardando…" : "Guardar y publicar"}</button>
        </div>
      </form>
    </div>
  );
}
