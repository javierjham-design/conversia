"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, useToast } from "@/components/ui";

interface Charging {
  enabled: boolean;
  sandbox: boolean;
  notifyTeam: boolean;
  instructions: string;
  hasCredentials: boolean;
  apiKeyMasked: string;
}

export default function CobrosPage() {
  const toast = useToast();
  const [data, setData] = useState<Charging | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
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
      await api("/charging", {
        method: "PUT",
        body: JSON.stringify({
          enabled: data.enabled,
          sandbox: data.sandbox,
          notifyTeam: data.notifyTeam,
          instructions: data.instructions,
          ...(apiKey.trim() && secretKey.trim() ? { apiKey: apiKey.trim(), secretKey: secretKey.trim() } : {}),
        }),
      });
      setApiKey("");
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

  if (!data) return <div className="p-6 text-ink-subtle">Cargando…</div>;

  const input = "w-full rounded-control border border-line-strong bg-panel px-3 py-2 text-sm text-ink placeholder:text-ink-subtle";

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Cobros con Flow</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Conecta tu cuenta de <b>Flow</b> para que tus agentes de IA envíen links de pago con el monto exacto del pedido.
          Los pagos recibidos quedan registrados en <b>Reportes</b>. Esta configuración aplica a toda tu cuenta; el interruptor
          por agente (“Cobrar con link de pago”) está en la configuración de cada agente.
        </p>
      </div>

      <section className="space-y-4 rounded-xl border border-line bg-panel p-4">
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-ink">Cobros activados</span>
          <input type="checkbox" checked={data.enabled} onChange={(e) => setData({ ...data, enabled: e.target.checked })} className="h-4 w-4" />
        </label>

        <div>
          <p className="mb-1 text-xs font-medium text-ink-muted">API Key de Flow {data.hasCredentials && <span className="text-emerald-600 dark:text-emerald-400">· cargada ({data.apiKeyMasked})</span>}</p>
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={data.hasCredentials ? "•••••• (dejar en blanco para no cambiar)" : "Pega tu API Key de Flow"} className={input} />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-ink-muted">Secret Key de Flow</p>
          <input value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder={data.hasCredentials ? "•••••• (dejar en blanco para no cambiar)" : "Pega tu Secret Key de Flow"} className={input} />
          <p className="mt-1 text-[11px] text-ink-subtle">Las llaves se guardan cifradas y nunca se muestran de vuelta. Las obtienes en tu panel de Flow → Integración → API.</p>
        </div>

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm text-ink">Ambiente de prueba (sandbox de Flow)</span>
          <input type="checkbox" checked={data.sandbox} onChange={(e) => setData({ ...data, sandbox: e.target.checked })} className="h-4 w-4" />
        </label>

        <label className="flex items-center justify-between gap-3">
          <span className="text-sm text-ink">Avisar al equipo cuando se reciba un pago</span>
          <input type="checkbox" checked={data.notifyTeam} onChange={(e) => setData({ ...data, notifyTeam: e.target.checked })} className="h-4 w-4" />
        </label>

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

        <div className="flex items-center gap-2 pt-1">
          <Button disabled={saving} onClick={() => void save()}>{saving ? "Guardando…" : "Guardar"}</Button>
          <Button variant="secondary" disabled={testing || !data.hasCredentials} onClick={() => void test()}>{testing ? "Probando…" : "Probar credenciales"}</Button>
        </div>
      </section>
    </div>
  );
}
