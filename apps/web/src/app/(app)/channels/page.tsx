"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";

interface Channel {
  id: string;
  type: "WHATSAPP_CLOUD" | "MOCK";
  name: string;
  status: string;
  defaultAgentId: string | null;
  defaultAgentName: string | null;
  phoneNumberId: string | null;
  displayPhone: string | null;
}
interface WebhookInfo {
  webhookUrl: string;
  verifyToken: string;
  graphVersion: string;
}
interface AgentOpt {
  id: string;
  name: string;
}

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [info, setInfo] = useState<WebhookInfo | null>(null);
  const [agents, setAgents] = useState<AgentOpt[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [esConfig, setEsConfig] = useState<{ appId: string; configId: string; graphVersion: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [fbReady, setFbReady] = useState(false);
  const sessionRef = useRef<{ wabaId?: string; phoneNumberId?: string }>({});

  const [form, setForm] = useState({
    type: "WHATSAPP_CLOUD" as "WHATSAPP_CLOUD" | "MOCK",
    name: "",
    phoneNumberId: "",
    wabaId: "",
    displayPhone: "",
    accessToken: "",
    defaultAgentId: "",
  });

  const load = useCallback(async () => {
    const [ch, wi, ag] = await Promise.all([
      api<Channel[]>("/channels"),
      api<WebhookInfo>("/channels/meta/webhook-info"),
      api<{ id: string; name: string }[]>("/organizations/me/agents"),
    ]);
    setChannels(ch);
    setInfo(wi);
    setAgents(ag.map((a: any) => ({ id: a.id, name: a.name })));
  }, []);

  useEffect(() => {
    void load().catch((e) => setMsg((e as Error).message));
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api("/channels", {
        method: "POST",
        body: JSON.stringify({
          type: form.type,
          name: form.name,
          defaultAgentId: form.defaultAgentId || null,
          ...(form.type === "WHATSAPP_CLOUD"
            ? {
                phoneNumberId: form.phoneNumberId,
                wabaId: form.wabaId,
                displayPhone: form.displayPhone || undefined,
                accessToken: form.accessToken,
              }
            : {}),
        }),
      });
      setShowNew(false);
      setForm({ ...form, name: "", phoneNumberId: "", wabaId: "", displayPhone: "", accessToken: "" });
      await load();
      setMsg("Canal creado ✔");
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  async function test(id: string) {
    setTestResult((p) => ({ ...p, [id]: "probando…" }));
    try {
      const r = await api<{ ok: boolean; detail: string }>(`/channels/${id}/test`, { method: "POST" });
      setTestResult((p) => ({ ...p, [id]: `${r.ok ? "✔" : "✖"} ${r.detail}` }));
    } catch (err) {
      setTestResult((p) => ({ ...p, [id]: `✖ ${(err as Error).message}` }));
    }
  }

  async function setDefaultAgent(id: string, agentId: string) {
    await api(`/channels/${id}`, { method: "PATCH", body: JSON.stringify({ defaultAgentId: agentId || null }) });
    await load();
  }

  async function copy(text: string) {
    await navigator.clipboard.writeText(text);
    setMsg("Copiado al portapapeles ✔");
  }

  // -------- Embedded Signup (conexión self-service tipo Respond) --------
  useEffect(() => {
    api<{ appId: string; configId: string; graphVersion: string }>("/channels/meta/embedded-config")
      .then(setEsConfig)
      .catch(() => undefined);
    function onMsg(event: MessageEvent) {
      if (typeof event.origin !== "string" || !event.origin.endsWith("facebook.com")) return;
      try {
        const d = JSON.parse(event.data);
        if (d?.type === "WA_EMBEDDED_SIGNUP" && d.data) {
          if (d.data.waba_id) sessionRef.current.wabaId = d.data.waba_id;
          if (d.data.phone_number_id) sessionRef.current.phoneNumberId = d.data.phone_number_id;
        }
      } catch {
        /* no-op */
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  // Carga + inicializa el SDK de Facebook APENAS tengamos la config, para que
  // FB.login se llame SÍNCRONO en el click (si va tras un await, el navegador
  // bloquea el popup y "no hace nada").
  useEffect(() => {
    if (!esConfig?.configId || !esConfig.appId) return;
    const w = window as any;
    if (w.FB) {
      setFbReady(true);
      return;
    }
    w.fbAsyncInit = () => {
      w.FB.init({ appId: esConfig.appId, autoLogAppEvents: true, xfbml: true, version: esConfig.graphVersion });
      setFbReady(true);
    };
    const s = document.createElement("script");
    s.async = true;
    s.defer = true;
    s.crossOrigin = "anonymous";
    s.src = "https://connect.facebook.net/en_US/sdk.js";
    document.body.appendChild(s);
  }, [esConfig]);

  async function finishEmbedded(code: string) {
    if (!sessionRef.current.wabaId || !sessionRef.current.phoneNumberId) {
      setMsg(
        'Meta no devolvió la cuenta/número. Reintenta "Conectar con Meta" y elige "Editar configuración" para seleccionar tu WhatsApp Business (no "Reconectar").',
      );
      return;
    }
    setConnecting(true);
    try {
      const r = await api<{ displayPhone: string }>("/channels/embedded-signup", {
        method: "POST",
        body: JSON.stringify({
          code,
          wabaId: sessionRef.current.wabaId,
          phoneNumberId: sessionRef.current.phoneNumberId,
          defaultAgentId: form.defaultAgentId || null,
        }),
      });
      await load();
      setMsg(`WhatsApp conectado con Meta: ${r.displayPhone} ✔`);
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  function connectWithMeta() {
    if (!esConfig?.configId) {
      setMsg("El Embedded Signup aún no está configurado (falta META_CONFIG_ID en el servidor).");
      return;
    }
    const w = window as any;
    if (!fbReady || !w.FB) {
      setMsg("No se pudo cargar el SDK de Facebook (¿un bloqueador de anuncios/tracking?) o el dominio aún no está autorizado en Meta.");
      return;
    }
    setMsg(null);
    sessionRef.current = {};
    w.FB.login(
      (response: any) => {
        const code = response?.authResponse?.code;
        if (!code) {
          setMsg("Conexión cancelada.");
          return;
        }
        void finishEmbedded(code);
      },
      {
        config_id: esConfig.configId,
        response_type: "code",
        override_default_response_type: true,
        // sessionInfoVersion:'3' hace que Meta emita el evento WA_EMBEDDED_SIGNUP
        // con waba_id + phone_number_id durante el flujo de WhatsApp.
        extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
      },
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Canales</h1>
          <p className="text-sm text-slate-500">Números de WhatsApp (Meta Cloud API) y canales de prueba.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void connectWithMeta()}
            disabled={connecting}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {connecting ? "Conectando…" : "Conectar con Meta"}
          </button>
          <button
            onClick={() => setShowNew(!showNew)}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Manual
          </button>
        </div>
      </div>

      {msg && <p className="mb-4 rounded-lg bg-slate-100 px-3 py-2 text-sm">{msg}</p>}

      {info && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 font-medium">Configuración del webhook en Meta</h2>
          <p className="mb-3 text-xs text-slate-500">
            En Meta for Developers → tu App → WhatsApp → Configuration, registra este webhook y suscríbete al campo <b>messages</b>.
          </p>
          <div className="grid gap-2 text-sm md:grid-cols-2">
            <button onClick={() => void copy(info.webhookUrl)} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left font-mono text-xs hover:bg-slate-100">
              URL: {info.webhookUrl} 📋
            </button>
            <button onClick={() => void copy(info.verifyToken)} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left font-mono text-xs hover:bg-slate-100">
              Verify token: {info.verifyToken} 📋
            </button>
          </div>
        </div>
      )}

      {showNew && (
        <form onSubmit={create} className="mb-6 rounded-xl border border-cyan-200 bg-cyan-50/40 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              Tipo
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as any })} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2">
                <option value="WHATSAPP_CLOUD">WhatsApp Cloud API (Meta)</option>
                <option value="MOCK">Canal de prueba (mock)</option>
              </select>
            </label>
            <label className="text-sm">
              Nombre
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" placeholder="p.ej. WhatsApp Clínica Temuco" />
            </label>
            {form.type === "WHATSAPP_CLOUD" && (
              <>
                <label className="text-sm">
                  Phone Number ID (Meta)
                  <input value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} required className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono" />
                </label>
                <label className="text-sm">
                  WABA ID
                  <input value={form.wabaId} onChange={(e) => setForm({ ...form, wabaId: e.target.value })} required className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono" />
                </label>
                <label className="text-sm">
                  Teléfono visible (opcional)
                  <input value={form.displayPhone} onChange={(e) => setForm({ ...form, displayPhone: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2" placeholder="+56 9 …" />
                </label>
                <label className="text-sm">
                  Access token permanente
                  <input value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} required type="password" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono" />
                  <span className="text-[10px] text-slate-400">Se guarda cifrado (AES-256). Usa un token de usuario de sistema.</span>
                </label>
              </>
            )}
            <label className="text-sm">
              Agente por defecto
              <select value={form.defaultAgentId} onChange={(e) => setForm({ ...form, defaultAgentId: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2">
                <option value="">— sin agente (solo humanos) —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </label>
          </div>
          <button type="submit" className="mt-3 rounded-lg bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800">
            Conectar
          </button>
        </form>
      )}

      <div className="space-y-3">
        {channels.map((c) => (
          <div key={c.id} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-medium">
                  {c.type === "WHATSAPP_CLOUD" ? "📱" : "🧪"} {c.name}{" "}
                  <span className={`text-[10px] ${c.status === "active" ? "text-emerald-600" : "text-slate-400"}`}>
                    {c.status === "active" ? "● activo" : "○ inactivo"}
                  </span>
                </h3>
                <p className="text-xs text-slate-400">
                  {c.type === "WHATSAPP_CLOUD"
                    ? `phone_number_id: ${c.phoneNumberId ?? "—"} · ${c.displayPhone ?? ""}`
                    : "Canal de prueba: usa el simulador para enviar mensajes"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={c.defaultAgentId ?? ""}
                  onChange={(e) => void setDefaultAgent(c.id, e.target.value)}
                  className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs"
                >
                  <option value="">sin agente por defecto</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>🤖 {a.name}</option>
                  ))}
                </select>
                <button onClick={() => void test(c.id)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-50">
                  Probar conexión
                </button>
              </div>
            </div>
            {testResult[c.id] && <p className="mt-2 text-xs text-slate-600">{testResult[c.id]}</p>}
          </div>
        ))}
        {channels.length === 0 && <p className="text-sm text-slate-400">Sin canales aún.</p>}
      </div>
    </div>
  );
}
