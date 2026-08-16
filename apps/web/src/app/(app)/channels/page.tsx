"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { TemplatesPanel } from "./templates-panel";

interface Channel {
  id: string;
  type: "WHATSAPP_CLOUD" | "MOCK";
  name: string;
  status: string;
  defaultAgentId: string | null;
  defaultAgentName: string | null;
  defaultProactive?: boolean;
  phoneNumberId: string | null;
  displayPhone: string | null;
  wabaId: string | null;
}
interface AgentOpt {
  id: string;
  name: string;
}

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [agents, setAgents] = useState<AgentOpt[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [templatesOpen, setTemplatesOpen] = useState<Record<string, boolean>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: "", displayPhone: "", wabaId: "", phoneNumberId: "", accessToken: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [health, setHealth] = useState<{ id: string; type: string; status: string; message: string | null; createdAt: string }[]>([]);
  const [transcription, setTranscription] = useState<boolean | null>(null);
  const [esConfig, setEsConfig] = useState<{ appId: string; configId: string; graphVersion: string; featureType?: string } | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [fbReady, setFbReady] = useState(false);
  const sessionRef = useRef<{ wabaId?: string; phoneNumberId?: string; businessId?: string }>({});

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
    const [ch, ag] = await Promise.all([
      api<Channel[]>("/channels"),
      api<{ id: string; name: string }[]>("/organizations/me/agents"),
    ]);
    setChannels(ch);
    setAgents(ag.map((a: any) => ({ id: a.id, name: a.name })));
    // Salud (best-effort, no bloquea la carga principal)
    api<{ events: { id: string; type: string; status: string; message: string | null; createdAt: string }[] }>("/channels/health/events")
      .then((r) => setHealth(r.events))
      .catch(() => undefined);
    api<{ enabled: boolean }>("/organizations/me/transcription")
      .then((r) => setTranscription(r.enabled))
      .catch(() => undefined);
  }, []);


  useEffect(() => {
    void load().catch((e) => setMsg((e as Error).message));
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api<{ warnings?: string[] }>("/channels", {
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
      // La conexión ya suscribe la app al WABA (entrantes) y registra el número
      // (salientes). Si algo falló, se avisa en vez de dar un "creado" engañoso.
      setMsg(
        r?.warnings && r.warnings.length
          ? `Canal creado, pero revisa: ${r.warnings.join(" · ")}`
          : "Canal creado ✔ (número enganchado: recibe y envía)",
      );
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  async function test(id: string) {
    setTestResult((p) => ({ ...p, [id]: "probando…" }));
    try {
      const r = await api<{ ok: boolean; detail: string }>(`/channels/${id}/test`, { method: "POST" });
      setTestResult((p) => ({ ...p, [id]: `${r.ok ? "✔" : "✖"} ${r.detail}` }));
      await load(); // la prueba puede cambiar el estado del canal (error ↔ activo)
    } catch (err) {
      setTestResult((p) => ({ ...p, [id]: `✖ ${(err as Error).message}` }));
    }
  }

  async function setDefaultAgent(id: string, agentId: string) {
    await api(`/channels/${id}`, { method: "PATCH", body: JSON.stringify({ defaultAgentId: agentId || null }) });
    await load();
  }

  async function setDefaultProactive(id: string, on: boolean) {
    await api(`/channels/default-proactive`, { method: "PATCH", body: JSON.stringify({ channelId: on ? id : null }) });
    await load();
  }

  function openEdit(c: Channel) {
    setEditingId(c.id);
    setMsg(null);
    setEditForm({
      name: c.name,
      displayPhone: c.displayPhone ?? "",
      wabaId: c.wabaId ?? "",
      phoneNumberId: c.phoneNumberId ?? "",
      accessToken: "", // vacío = no se toca el token; pega uno nuevo para rotarlo
    });
  }

  async function saveEdit(c: Channel) {
    setSavingEdit(true);
    setMsg(null);
    try {
      const payload: Record<string, unknown> = {};
      if (editForm.name && editForm.name !== c.name) payload.name = editForm.name;
      if (c.type === "WHATSAPP_CLOUD") {
        if (editForm.displayPhone !== (c.displayPhone ?? "")) payload.displayPhone = editForm.displayPhone;
        if (editForm.wabaId && editForm.wabaId !== (c.wabaId ?? "")) payload.wabaId = editForm.wabaId;
        if (editForm.phoneNumberId && editForm.phoneNumberId !== (c.phoneNumberId ?? "")) payload.phoneNumberId = editForm.phoneNumberId;
        if (editForm.accessToken) payload.accessToken = editForm.accessToken;
      }
      if (Object.keys(payload).length === 0) {
        setEditingId(null);
        return;
      }
      const r = await api<{ warnings?: string[] }>(`/channels/${c.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      setEditingId(null);
      await load();
      setMsg(
        r?.warnings && r.warnings.length
          ? `Canal actualizado, pero revisa: ${r.warnings.join(" · ")}`
          : payload.accessToken
            ? "Canal actualizado ✔ (token repegado y número re-registrado: vuelve a enviar)"
            : "Canal actualizado ✔",
      );
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setSavingEdit(false);
    }
  }

  async function removeChannel(id: string, name: string) {
    if (!confirm(`¿Eliminar el canal "${name}"? Se borra el número y su token. Las conversaciones históricas se conservan. Esta acción no se puede deshacer.`)) return;
    try {
      await api(`/channels/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      alert((err as Error).message);
    }
  }

  // -------- Embedded Signup (conexión self-service tipo Respond) --------
  useEffect(() => {
    api<{ appId: string; configId: string; graphVersion: string }>("/channels/meta/embedded-config")
      .then(setEsConfig)
      .catch(() => undefined);
    function onMsg(event: MessageEvent) {
      if (typeof event.origin !== "string" || !event.origin.endsWith("facebook.com")) return;
      let d: any = event.data;
      if (typeof d === "string") {
        try {
          d = JSON.parse(d);
        } catch {
          return;
        }
      }
      // Solo nos interesa el evento del flujo de WhatsApp Embedded Signup.
      if (d?.type && d.type !== "WA_EMBEDDED_SIGNUP") return;
      const data = d?.data ?? d;
      if (data?.waba_id) sessionRef.current.wabaId = data.waba_id;
      if (data?.phone_number_id) sessionRef.current.phoneNumberId = data.phone_number_id;
      if (data?.business_id) sessionRef.current.businessId = data.business_id;
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
      const r = await api<{ displayPhone: string; businessName?: string | null }>("/channels/embedded-signup", {
        method: "POST",
        body: JSON.stringify({
          code,
          wabaId: sessionRef.current.wabaId,
          phoneNumberId: sessionRef.current.phoneNumberId,
          businessId: sessionRef.current.businessId,
          defaultAgentId: form.defaultAgentId || null,
        }),
      });
      await load();
      setMsg(`WhatsApp conectado con Meta: ${r.displayPhone}${r.businessName ? ` · negocio: ${r.businessName}` : ""} ✔`);
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
        // setup vacío = Meta deja ELEGIR el negocio (portfolio) y CREAR una WABA
        // nueva o usar una existente. featureType configurable por env (por
        // defecto "" = flujo completo con creación). sessionInfoVersion:'3' hace
        // que Meta emita WA_EMBEDDED_SIGNUP con waba_id + phone_number_id + business_id.
        extras: { setup: {}, featureType: esConfig.featureType ?? "", sessionInfoVersion: "3" },
      },
    );
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Canales</h1>
          <p className="text-sm text-ink-muted">Números de WhatsApp (Meta Cloud API) y canales de prueba.</p>
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
            className="rounded-lg border border-line-strong px-4 py-2 text-sm font-medium text-ink hover:bg-app"
          >
            Manual
          </button>
        </div>
      </div>

      {msg && <p className="mb-4 rounded-lg bg-app px-3 py-2 text-sm">{msg}</p>}

      <p className="mb-4 rounded-lg border border-line bg-panel px-3 py-2 text-xs text-ink-muted">
        Al pulsar <b>Conectar con Meta</b> podrás <b>elegir el negocio</b> (si administras varios) y <b>crear una cuenta de WhatsApp nueva</b> o usar una existente, con su número. Si no ves esas opciones, revisa que tu <span className="font-mono">META_CONFIG_ID</span> sea una configuración de <b>Embedded Signup de WhatsApp</b> (no un login genérico) y que la app tenga acceso avanzado a <span className="font-mono">whatsapp_business_management</span>.
      </p>

      {showNew && (
        <form onSubmit={create} className="mb-6 rounded-xl border border-cyan-200 bg-cyan-50/40 p-4 dark:border-cyan-500/30">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="text-sm">
              Tipo
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as any })} className="mt-1 w-full rounded-lg border border-line-strong bg-panel px-3 py-2">
                <option value="WHATSAPP_CLOUD">WhatsApp Cloud API (Meta)</option>
                <option value="MOCK">Canal de prueba (mock)</option>
              </select>
            </label>
            <label className="text-sm">
              Nombre
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2" placeholder="p.ej. WhatsApp Clínica Temuco" />
            </label>
            {form.type === "WHATSAPP_CLOUD" && (
              <>
                <label className="text-sm">
                  Phone Number ID (Meta)
                  <input value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })} required className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 font-mono" />
                </label>
                <label className="text-sm">
                  WABA ID
                  <input value={form.wabaId} onChange={(e) => setForm({ ...form, wabaId: e.target.value })} required className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 font-mono" />
                </label>
                <label className="text-sm">
                  Teléfono visible (opcional)
                  <input value={form.displayPhone} onChange={(e) => setForm({ ...form, displayPhone: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2" placeholder="+56 9 …" />
                </label>
                <label className="text-sm">
                  Access token permanente
                  <input value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value })} required type="password" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 font-mono" />
                  <span className="text-[10px] text-ink-subtle">Se guarda cifrado (AES-256). Usa un token de usuario de sistema.</span>
                </label>
              </>
            )}
            <label className="text-sm">
              Agente por defecto
              <select value={form.defaultAgentId} onChange={(e) => setForm({ ...form, defaultAgentId: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong bg-panel px-3 py-2">
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
          <div key={c.id} className="rounded-xl border border-line bg-panel p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-medium">
                  {c.type === "WHATSAPP_CLOUD" ? "📱" : "🧪"} {c.name}{" "}
                  <span
                    className={`text-[10px] ${
                      c.status === "active" ? "text-emerald-600" : c.status === "error" ? "text-red-600" : "text-ink-subtle"
                    } dark:text-emerald-400 dark:text-red-400`}
                  >
                    {c.status === "active" ? "● activo" : c.status === "error" ? "⚠ requiere reautorización" : "○ inactivo"}
                  </span>
                </h3>
                <p className="text-xs text-ink-subtle">
                  {c.type === "WHATSAPP_CLOUD"
                    ? `phone_number_id: ${c.phoneNumberId ?? "—"} · ${c.displayPhone ?? ""}`
                    : "Canal de prueba: usa el simulador para enviar mensajes"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={c.defaultAgentId ?? ""}
                  onChange={(e) => void setDefaultAgent(c.id, e.target.value)}
                  className="rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-xs"
                >
                  <option value="">sin agente por defecto</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>🤖 {a.name}</option>
                  ))}
                </select>
                {c.type === "WHATSAPP_CLOUD" && c.status === "active" && (
                  <label className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2 py-1.5 text-xs text-ink-muted" title="Número desde el que salen los recordatorios/plantillas a contactos SIN conversación previa (p. ej. citas nacidas en Cláriva). Si el contacto ya escribió, sale por su mismo número.">
                    <input type="checkbox" checked={c.defaultProactive ?? false} onChange={(e) => void setDefaultProactive(c.id, e.target.checked)} />
                    Por defecto para recordatorios
                  </label>
                )}
                <button onClick={() => void test(c.id)} className="rounded-lg border border-line-strong px-3 py-1.5 text-xs hover:bg-app">
                  Probar conexión
                </button>
                <button
                  onClick={() => (editingId === c.id ? setEditingId(null) : openEdit(c))}
                  className="rounded-lg border border-line-strong px-3 py-1.5 text-xs hover:bg-app"
                  title="Editar datos del canal (nombre, número, WABA, token) sin borrarlo"
                >
                  {editingId === c.id ? "Cerrar" : "Editar"}
                </button>
                {c.type === "WHATSAPP_CLOUD" && (
                  <button
                    onClick={() => setTemplatesOpen((p) => ({ ...p, [c.id]: !p[c.id] }))}
                    className="rounded-lg border border-line-strong px-3 py-1.5 text-xs hover:bg-app"
                  >
                    {templatesOpen[c.id] ? "Ocultar plantillas" : "Plantillas"}
                  </button>
                )}
                <button
                  onClick={() => void removeChannel(c.id, c.name)}
                  className="rounded-lg border border-red-300 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10"
                  title="Eliminar este canal"
                >
                  Eliminar
                </button>
              </div>
            </div>
            {c.status === "error" && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 dark:bg-red-500/10 dark:border-red-500/30">
                <p className="text-xs font-medium text-red-700 dark:text-red-300">
                  El token de este canal está vencido o fue revocado — los mensajes salientes están fallando.
                </p>
                <p className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">
                  Reautoriza con <b>Conectar con Meta</b> (renueva el token automáticamente) o carga un token nuevo con el
                  formulario <b>Manual</b>. Al pasar la prueba de conexión, el canal vuelve a activo.
                </p>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => void connectWithMeta()}
                    className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
                  >
                    Reautorizar con Meta
                  </button>
                  <button
                    onClick={() => void test(c.id)}
                    className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-700 hover:bg-red-100 dark:text-red-300 dark:border-red-500/30"
                  >
                    Volver a probar
                  </button>
                </div>
              </div>
            )}
            {editingId === c.id && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
                <p className="mb-2 text-xs font-medium text-ink">Editar canal — actualiza los datos sin borrar ni recrear.</p>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="text-xs">
                    Nombre
                    <input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2" />
                  </label>
                  {c.type === "WHATSAPP_CLOUD" && (
                    <>
                      <label className="text-xs">
                        Teléfono visible
                        <input value={editForm.displayPhone} onChange={(e) => setEditForm({ ...editForm, displayPhone: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2" placeholder="+56 9 …" />
                      </label>
                      <label className="text-xs">
                        Phone Number ID (Meta)
                        <input value={editForm.phoneNumberId} onChange={(e) => setEditForm({ ...editForm, phoneNumberId: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 font-mono" />
                      </label>
                      <label className="text-xs">
                        WABA ID
                        <input value={editForm.wabaId} onChange={(e) => setEditForm({ ...editForm, wabaId: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 font-mono" />
                      </label>
                      <label className="text-xs md:col-span-2">
                        Access token nuevo (opcional — pega el token de prueba fresco para re-registrar el número)
                        <input value={editForm.accessToken} onChange={(e) => setEditForm({ ...editForm, accessToken: e.target.value })} type="password" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 font-mono" placeholder="Déjalo vacío para no cambiar el token" />
                        <span className="text-[10px] text-ink-subtle">Se guarda cifrado (AES-256). Al pegar uno nuevo, se re-suscribe y re-registra el número en Meta.</span>
                      </label>
                    </>
                  )}
                </div>
                <div className="mt-3 flex gap-2">
                  <button onClick={() => void saveEdit(c)} disabled={savingEdit} className="rounded-lg bg-amber-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50">
                    {savingEdit ? "Guardando…" : "Guardar cambios"}
                  </button>
                  <button onClick={() => setEditingId(null)} className="rounded-lg border border-line-strong px-4 py-1.5 text-xs hover:bg-app">
                    Cancelar
                  </button>
                </div>
              </div>
            )}
            {testResult[c.id] && <p className="mt-2 text-xs text-ink-muted">{testResult[c.id]}</p>}
            {c.type === "WHATSAPP_CLOUD" && templatesOpen[c.id] && <TemplatesPanel channelId={c.id} />}
          </div>
        ))}
        {channels.length === 0 && <p className="text-sm text-ink-subtle">Sin canales aún.</p>}
      </div>

      {/* Transcripción de audios: la fuente única vive en Configuración → IA */}
      {transcription !== null && (
        <div className="mt-6 flex items-center justify-between rounded-xl border border-line bg-panel p-4">
          <div>
            <h2 className="text-sm font-medium">Transcripción de audios</h2>
            <p className="text-xs text-ink-muted">
              {transcription ? "Activada" : "Desactivada"} — las notas de voz entrantes {transcription ? "se transcriben" : "no se transcriben"} automáticamente.
            </p>
          </div>
          <a href="/settings/ia" className="rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-app">
            Configurar en Ajustes ↗
          </a>
        </div>
      )}

      {/* Salud del canal: últimos eventos de WhatsApp (auth, calidad, cuenta, plantillas) */}
      {health.length > 0 && (
        <div className="mt-6 rounded-xl border border-line bg-panel p-4">
          <h2 className="mb-2 text-sm font-medium">Salud de WhatsApp — últimos eventos</h2>
          <ul className="space-y-1">
            {health.map((e) => (
              <li key={e.id} className="flex items-start gap-2 text-xs">
                <span className={e.status === "error" ? "text-red-500" : e.status === "warning" ? "text-amber-500" : "text-emerald-500"}>●</span>
                <span className="text-ink-muted">{e.message ?? e.type}</span>
                <span className="ml-auto shrink-0 text-ink-subtle">{new Date(e.createdAt).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
