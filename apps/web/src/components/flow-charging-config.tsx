"use client";

/**
 * Configuración de COBROS a los clientes del tenant. Se elige el PROVEEDOR (Flow o Getnet)
 * y, según el elegido, se cargan sus credenciales (Flow: API Key + Secret Key · Getnet:
 * Login + Secret Key). Es config a nivel de CUENTA; las llaves se guardan cifradas vía
 * /charging. Se reutiliza en Configuración → Cobros y en la Config. avanzada del agente.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, cn, useToast } from "@/components/ui";

interface Charging {
  enabled: boolean;
  sandbox: boolean;
  notifyTeam: boolean;
  instructions: string;
  provider: "flow" | "getnet";
  flow: { hasCredentials: boolean; apiKeyMasked: string };
  getnet: { hasCredentials: boolean; loginMasked: string };
}

const PROVIDERS = [
  { key: "flow", label: "Flow" },
  { key: "getnet", label: "Getnet" },
] as const;

export function FlowChargingConfig({ showInstructions = true }: { showInstructions?: boolean }) {
  const toast = useToast();
  const [data, setData] = useState<Charging | null>(null);
  const [apiKey, setApiKey] = useState(""); // Flow
  const [login, setLogin] = useState(""); // Getnet
  const [secretKey, setSecretKey] = useState(""); // ambos
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  async function load() {
    setData(await api<Charging>("/charging"));
  }
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!data) return;
    setSaving(true);
    try {
      const creds =
        data.provider === "getnet"
          ? login.trim() && secretKey.trim()
            ? { login: login.trim(), secretKey: secretKey.trim() }
            : {}
          : apiKey.trim() && secretKey.trim()
            ? { apiKey: apiKey.trim(), secretKey: secretKey.trim() }
            : {};
      await api("/charging", {
        method: "PUT",
        body: JSON.stringify({
          enabled: data.enabled,
          sandbox: data.sandbox,
          notifyTeam: data.notifyTeam,
          instructions: data.instructions,
          provider: data.provider,
          ...creds,
        }),
      });
      setApiKey("");
      setLogin("");
      setSecretKey("");
      toast.push("Guardado ✔", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      const r = await api<{ ok: boolean; detail: string }>("/charging/test", { method: "POST" });
      toast.push(r.detail, r.ok ? "ok" : "error");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setTesting(false);
    }
  }

  if (!data) return <div className="text-sm text-ink-subtle">Cargando cobros…</div>;

  const input = "w-full rounded-control border border-line-strong bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-subtle";
  const p = data.provider;
  const hasCreds = p === "getnet" ? data.getnet.hasCredentials : data.flow.hasCredentials;

  return (
    <section className="space-y-4 rounded-xl border border-line bg-panel p-4">
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink">Cobros activados</span>
        <input type="checkbox" checked={data.enabled} onChange={(e) => setData({ ...data, enabled: e.target.checked })} className="h-4 w-4" />
      </label>

      <div>
        <p className="mb-1 text-xs font-medium text-ink-muted">Proveedor de pago</p>
        <div className="inline-flex rounded-lg border border-line-strong p-0.5 text-xs">
          {PROVIDERS.map((pv) => (
            <button
              key={pv.key}
              onClick={() => setData({ ...data, provider: pv.key })}
              className={cn("rounded-md px-3 py-1.5 font-medium", p === pv.key ? "bg-brand-600 text-white" : "text-ink-muted hover:bg-app")}
            >
              {pv.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] text-ink-subtle">Elige con qué pasarela cobrarás a tus clientes. Se irán agregando más.</p>
      </div>

      {p === "flow" ? (
        <>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">API Key de Flow {data.flow.hasCredentials && <span className="text-emerald-600 dark:text-emerald-400">· cargada ({data.flow.apiKeyMasked})</span>}</p>
            <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={data.flow.hasCredentials ? "•••••• (dejar en blanco para no cambiar)" : "Pega tu API Key de Flow"} className={input} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Secret Key de Flow</p>
            <input value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder={data.flow.hasCredentials ? "•••••• (dejar en blanco para no cambiar)" : "Pega tu Secret Key de Flow"} className={input} />
            <p className="mt-1 text-[11px] text-ink-subtle">Las llaves se guardan cifradas y nunca se muestran de vuelta. Las obtienes en tu panel de Flow → Integración → API.</p>
          </div>
        </>
      ) : (
        <>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Login de Getnet {data.getnet.hasCredentials && <span className="text-emerald-600 dark:text-emerald-400">· cargado ({data.getnet.loginMasked})</span>}</p>
            <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder={data.getnet.hasCredentials ? "•••••• (dejar en blanco para no cambiar)" : "Pega tu Login de Getnet"} className={input} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Secret Key de Getnet</p>
            <input value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder={data.getnet.hasCredentials ? "•••••• (dejar en blanco para no cambiar)" : "Pega tu Secret Key de Getnet"} className={input} />
            <p className="mt-1 text-[11px] text-ink-subtle">Las llaves se guardan cifradas y nunca se muestran de vuelta. Las obtienes en tu panel de Getnet (Web Checkout → credenciales de integración).</p>
          </div>
        </>
      )}

      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-ink">Ambiente de prueba (sandbox)</span>
        <input type="checkbox" checked={data.sandbox} onChange={(e) => setData({ ...data, sandbox: e.target.checked })} className="h-4 w-4" />
      </label>

      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-ink">Avisar al equipo cuando se reciba un pago</span>
        <input type="checkbox" checked={data.notifyTeam} onChange={(e) => setData({ ...data, notifyTeam: e.target.checked })} className="h-4 w-4" />
      </label>

      {showInstructions && (
        <div>
          <p className="mb-1 text-xs font-medium text-ink-muted">Instrucciones para el momento del cobro</p>
          <textarea
            value={data.instructions}
            onChange={(e) => setData({ ...data, instructions: e.target.value })}
            rows={3}
            placeholder="Ej: Ofrece el link de pago solo cuando el cliente confirme el pedido y el monto. Antes de cobrar, pide la foto del flyer si corresponde al descuento."
            className={input}
          />
          <p className="mt-1 text-[11px] text-ink-subtle">Se le entregan al agente cuando el cobro está habilitado, para guiar cómo y cuándo cobrar.</p>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button disabled={saving} onClick={() => void save()}>{saving ? "Guardando…" : "Guardar"}</Button>
        <Button variant="secondary" disabled={testing || !hasCreds} onClick={() => void test()}>{testing ? "Probando…" : "Probar credenciales"}</Button>
      </div>
    </section>
  );
}
