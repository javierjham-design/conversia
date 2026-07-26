"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Overview {
  clariva: {
    status: string;
    baseUrl: string | null;
    apiKeyMasked: string | null;
    lastSyncAt: string | null;
    lastError: string | null;
  } | null;
  webhooks: { id: string; name: string; url: string; events: string[]; active: boolean; secretMasked: string }[];
  availableEvents: string[];
  catalog: { key: string; name: string; status: string; route?: string }[];
}

export default function IntegrationsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [clarivaForm, setClarivaForm] = useState({ baseUrl: "", apiKey: "" });
  const [whForm, setWhForm] = useState<{ name: string; url: string; events: string[] }>({ name: "", url: "", events: [] });
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [testDetail, setTestDetail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(await api<Overview>("/integrations"));
  }, []);

  useEffect(() => {
    void load().catch((e) => setMsg((e as Error).message));
  }, [load]);

  async function connectClariva(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api("/integrations/clariva", { method: "POST", body: JSON.stringify(clarivaForm) });
      setClarivaForm({ baseUrl: "", apiKey: "" });
      await load();
      setMsg("Cláriva conectado ✔ — prueba la conexión");
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  async function testClariva() {
    setTestDetail("probando…");
    try {
      const r = await api<{ ok: boolean; detail: string }>("/integrations/clariva/test", { method: "POST" });
      setTestDetail(`${r.ok ? "✔" : "✖"} ${r.detail}`);
    } catch (err) {
      setTestDetail(`✖ ${(err as Error).message}`);
    }
  }

  async function createWebhook(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    setNewSecret(null);
    try {
      const r = await api<{ secret: string }>("/integrations/webhooks", { method: "POST", body: JSON.stringify(whForm) });
      setNewSecret(r.secret);
      setWhForm({ name: "", url: "", events: [] });
      await load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  function toggleEvent(ev: string) {
    setWhForm((f) => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter((x) => x !== ev) : [...f.events, ev],
    }));
  }

  if (!data) return <div className="p-6 text-slate-400">Cargando…</div>;

  return (
    <div className="h-full overflow-y-auto p-6">
      <h1 className="text-xl font-semibold">Integraciones</h1>
      <p className="mb-6 text-sm text-slate-500">Conecta la plataforma con tus otros sistemas.</p>
      {msg && <p className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-sm">{msg}</p>}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-medium">🗓 Cláriva — agenda clínica</h2>
          <p className="mb-3 text-xs text-slate-500">
            Proveedor de agenda: disponibilidad y citas reales desde Cláriva. Sin conexión se usa la agenda interna de prueba.
          </p>
          {data.clariva && data.clariva.status === "active" ? (
            <div className="rounded-lg bg-emerald-50 p-3 text-sm">
              <p className="text-emerald-800">● Conectado a <span className="font-mono text-xs">{data.clariva.baseUrl}</span></p>
              <p className="text-xs text-emerald-700">API key: {data.clariva.apiKeyMasked}</p>
              {data.clariva.lastError && <p className="mt-1 text-xs text-red-600">Último error: {data.clariva.lastError}</p>}
              <div className="mt-2 flex gap-2">
                <button onClick={() => void testClariva()} className="rounded-lg border border-emerald-300 px-3 py-1.5 text-xs hover:bg-emerald-100">Probar conexión</button>
                <button onClick={async () => { await api("/integrations/clariva", { method: "DELETE" }); await load(); }} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50">Desconectar</button>
              </div>
              {testDetail && <p className="mt-2 text-xs">{testDetail}</p>}
            </div>
          ) : (
            <form onSubmit={connectClariva} className="space-y-2">
              <input value={clarivaForm.baseUrl} onChange={(e) => setClarivaForm({ ...clarivaForm, baseUrl: e.target.value })} required placeholder="https://api.clariva.cl" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              <input value={clarivaForm.apiKey} onChange={(e) => setClarivaForm({ ...clarivaForm, apiKey: e.target.value })} required type="password" placeholder="API key (se guarda cifrada)" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              <button type="submit" className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800">Conectar Cláriva</button>
            </form>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="font-medium">🔔 Webhooks salientes</h2>
          <p className="mb-3 text-xs text-slate-500">
            Recibe eventos de Conversia en tus sistemas (firmados HMAC). <b>Beta:</b> la emisión de entregas se activa en la próxima fase.
          </p>
          {newSecret && (
            <p className="mb-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">
              Secreto (solo se muestra una vez): <b className="font-mono">{newSecret}</b>
            </p>
          )}
          {data.webhooks.map((w) => (
            <div key={w.id} className="mb-2 flex items-center justify-between rounded-lg border border-slate-100 p-2 text-sm">
              <div>
                <p className="font-medium">{w.name} <span className="text-[10px] text-slate-400">{w.active ? "● activo" : "○ pausado"}</span></p>
                <p className="font-mono text-[10px] text-slate-400">{w.url}</p>
                <p className="text-[10px] text-slate-400">{w.events.join(", ")}</p>
              </div>
              <div className="flex gap-1">
                <button onClick={async () => { await api(`/integrations/webhooks/${w.id}`, { method: "PATCH", body: JSON.stringify({ active: !w.active }) }); await load(); }} className="rounded border border-slate-200 px-2 py-1 text-xs">
                  {w.active ? "Pausar" : "Activar"}
                </button>
                <button onClick={async () => { await api(`/integrations/webhooks/${w.id}`, { method: "DELETE" }); await load(); }} className="rounded border border-red-200 px-2 py-1 text-xs text-red-600">✕</button>
              </div>
            </div>
          ))}
          <form onSubmit={createWebhook} className="mt-3 space-y-2 border-t border-slate-100 pt-3">
            <div className="flex gap-2">
              <input value={whForm.name} onChange={(e) => setWhForm({ ...whForm, name: e.target.value })} required placeholder="Nombre" className="w-40 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              <input value={whForm.url} onChange={(e) => setWhForm({ ...whForm, url: e.target.value })} required placeholder="https://tusistema.cl/webhook" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </div>
            <div className="flex flex-wrap gap-2">
              {data.availableEvents.map((ev) => (
                <label key={ev} className={`cursor-pointer rounded-full border px-2 py-1 text-[11px] ${whForm.events.includes(ev) ? "border-cyan-300 bg-cyan-50 text-cyan-800" : "border-slate-200 text-slate-500"}`}>
                  <input type="checkbox" className="hidden" checked={whForm.events.includes(ev)} onChange={() => toggleEvent(ev)} />
                  {ev}
                </label>
              ))}
            </div>
            <button type="submit" className="rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800">Crear webhook</button>
          </form>
        </section>
      </div>

      <h2 className="mb-2 mt-8 font-medium">Catálogo</h2>
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-4">
        {data.catalog.map((c) => (
          <div key={c.key} className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
            <p className="font-medium">{c.name}</p>
            <p className={`text-xs ${c.status === "disponible" ? "text-emerald-600" : "text-slate-400"}`}>
              {c.status === "disponible" ? "● disponible" : "○ próximamente"}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
