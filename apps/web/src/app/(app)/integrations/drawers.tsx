"use client";

/** Drawers de administración: Cláriva y Webhooks salientes. */
import { useCallback, useEffect, useState } from "react";
import { Activity, CalendarCheck, Plus, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import {
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  SecretField,
  Skeleton,
  StatusBadge,
  useToast,
} from "@/components/ui";

// ------------------------------ Cláriva ------------------------------

export interface ClarivaState {
  status: string;
  baseUrl: string | null;
  apiKeyMasked: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export function ClarivaDrawer({
  open,
  onClose,
  state,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  state: ClarivaState | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const connected = state?.status === "active";
  const [form, setForm] = useState({ baseUrl: "", apiKey: "" });
  const [busy, setBusy] = useState(false);
  const [testDetail, setTestDetail] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [activity, setActivity] = useState<any[] | null>(null);

  useEffect(() => {
    if (open && connected) {
      void api<any[]>("/integrations/activity?provider=clariva&take=15").then(setActivity).catch(() => setActivity([]));
    }
  }, [open, connected]);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/integrations/clariva", { method: "POST", body: JSON.stringify(form) });
      setForm({ baseUrl: "", apiKey: "" });
      toast.push("Cláriva conectado — prueba la conexión", "ok");
      onChanged();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setTestDetail("Probando conexión…");
    try {
      const r = await api<{ ok: boolean; detail: string }>("/integrations/clariva/test", { method: "POST" });
      setTestDetail(`${r.ok ? "✔" : "✖"} ${r.detail}`);
      toast.push(r.ok ? "Conexión y sincronización OK" : "La conexión falló", r.ok ? "ok" : "error");
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await api("/integrations/clariva", { method: "DELETE" });
    toast.push("Cláriva desconectado", "info");
    onChanged();
    onClose();
  }

  return (
    <Drawer open={open} onClose={onClose} title="Cláriva — agenda clínica">
      {!connected ? (
        <div>
          <p className="mb-4 text-sm text-slate-600">
            Conecta la agenda de tus sedes: disponibilidad y citas reales para los agentes IA. Las credenciales se
            envían al backend y se guardan <b>cifradas</b>; no vuelven a mostrarse completas.
          </p>
          <form onSubmit={connect} className="space-y-3">
            <label className="block text-sm font-medium">
              URL del API de Cláriva
              <input
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                required
                placeholder="https://api.clariva.cl"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm font-medium">
              API key
              <input
                value={form.apiKey}
                onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                required
                type="password"
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <Button type="submit" disabled={busy}>Conectar y continuar</Button>
          </form>
          <ol className="mt-6 space-y-1.5 border-t border-slate-100 pt-4 text-xs text-slate-400">
            <li>1. Credenciales ✦ este paso</li>
            <li>2. Probar conexión y sedes visibles</li>
            <li>3. Mapeo de profesionales y prestaciones — próximamente</li>
            <li>4. Activación</li>
          </ol>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-center justify-between rounded-xl border border-slate-200 p-4">
            <div>
              <div className="mb-1 flex items-center gap-2">
                <StatusBadge kind={state?.lastError ? "attention" : "connected"} />
              </div>
              <p className="font-mono text-xs text-slate-500">{state?.baseUrl}</p>
              <p className="text-xs text-slate-400">
                API key: <span className="font-mono">{state?.apiKeyMasked ?? "—"}</span> · Última sincronización:{" "}
                {state?.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString("es-CL") : "nunca"}
              </p>
              {state?.lastError && <p className="mt-1 text-xs text-red-600">Último error: {state.lastError}</p>}
            </div>
            <CalendarCheck className="text-emerald-500" />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void test()} disabled={busy}>
              <RefreshCw size={14} /> Probar / sincronizar ahora
            </Button>
            <Button variant="danger" onClick={() => setConfirmDisconnect(true)}>Desconectar</Button>
          </div>
          {testDetail && <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{testDetail}</p>}

          <div>
            <p className="mb-2 flex items-center gap-1.5 text-sm font-medium"><Activity size={14} /> Actividad reciente</p>
            {activity === null ? (
              <Skeleton className="h-20" />
            ) : activity.length === 0 ? (
              <EmptyState title="Sin actividad todavía" description="Las sincronizaciones y errores aparecerán aquí." />
            ) : (
              <ul className="space-y-1.5">
                {activity.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2 text-xs">
                    <span className={a.status === "error" ? "text-red-600" : "text-slate-600"}>{a.message ?? a.type}</span>
                    <span className="shrink-0 text-slate-400">{new Date(a.createdAt).toLocaleString("es-CL")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-xs text-slate-400">
            Rotar credenciales: vuelve a conectar con una API key nueva (la anterior queda revocada para esta conexión).
            Mapeo de profesionales/prestaciones y verificación de cita de prueba: <b>próximamente</b>.
          </p>

          <form onSubmit={connect} className="space-y-2 border-t border-slate-100 pt-4">
            <p className="text-sm font-medium">Reconectar / rotar credenciales</p>
            <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} required placeholder="https://api.clariva.cl" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <input value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} required type="password" placeholder="Nueva API key" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <Button type="submit" variant="secondary" disabled={busy}>Guardar credenciales nuevas</Button>
          </form>
        </div>
      )}
      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
        title="¿Desconectar Cláriva?"
        description="Los agentes dejarán de ver la agenda real y volverán a la agenda interna de prueba."
        confirmLabel="Desconectar"
        danger
      />
    </Drawer>
  );
}

// ------------------------------ Webhooks ------------------------------

export interface WebhookRow {
  id: string;
  name: string;
  description: string | null;
  url: string;
  events: string[];
  active: boolean;
  timeoutMs: number;
  maxRetries: number;
  secretMasked: string;
  deliveries7d: number;
  successRate: number | null;
  lastDeliveryAt: string | null;
}

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.pathname.length > 18 ? u.pathname.slice(0, 15) + "…" : u.pathname}`;
  } catch {
    return url;
  }
}

export function WebhooksDrawer({
  open,
  onClose,
  webhooks,
  availableEvents,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  webhooks: WebhookRow[];
  availableEvents: string[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<"list" | "new" | "detail">("list");
  const [selected, setSelected] = useState<WebhookRow | null>(null);
  const [form, setForm] = useState({ name: "", url: "", description: "", events: [] as string[], timeoutMs: 10000, maxRetries: 4 });
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<any[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) {
      setMode("list");
      setNewSecret(null);
    }
  }, [open]);

  const loadDeliveries = useCallback(async (id: string) => {
    setDeliveries(null);
    setDeliveries(await api<any[]>(`/integrations/webhooks/${id}/deliveries`));
  }, []);

  function openDetail(w: WebhookRow) {
    setSelected(w);
    setMode("detail");
    void loadDeliveries(w.id);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (form.events.length === 0) {
      toast.push("Selecciona al menos un evento", "error");
      return;
    }
    try {
      const r = await api<{ id: string; secret: string }>("/integrations/webhooks", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setNewSecret(r.secret);
      setForm({ name: "", url: "", description: "", events: [], timeoutMs: 10000, maxRetries: 4 });
      toast.push("Webhook creado", "ok");
      onChanged();
      setMode("list");
    } catch (err) {
      toast.push((err as Error).message, "error");
    }
  }

  async function testWebhook(id: string) {
    await api(`/integrations/webhooks/${id}/test`, { method: "POST" });
    toast.push("Entrega de prueba encolada — revisa las entregas en unos segundos", "ok");
    setTimeout(() => void loadDeliveries(id), 2500);
  }

  async function rotate(id: string) {
    const r = await api<{ secret: string }>(`/integrations/webhooks/${id}/rotate-secret`, { method: "POST" });
    setNewSecret(r.secret);
    toast.push("Secreto rotado — actualiza tu sistema receptor", "ok");
    onChanged();
  }

  async function toggleActive(w: WebhookRow) {
    await api(`/integrations/webhooks/${w.id}`, { method: "PATCH", body: JSON.stringify({ active: !w.active }) });
    onChanged();
  }

  async function remove(id: string) {
    await api(`/integrations/webhooks/${id}`, { method: "DELETE" });
    toast.push("Webhook eliminado", "info");
    onChanged();
    setMode("list");
  }

  async function retryDelivery(webhookId: string, deliveryId: string) {
    await api(`/integrations/webhooks/${webhookId}/deliveries/${deliveryId}/retry`, { method: "POST" });
    toast.push("Reintento encolado", "ok");
    setTimeout(() => void loadDeliveries(webhookId), 2500);
  }

  return (
    <Drawer open={open} onClose={onClose} title="Webhooks salientes">
      {newSecret && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p className="mb-2 text-xs font-medium text-amber-800">
            Secreto de firma — se muestra UNA sola vez. Verifica la cabecera <code>X-Conversia-Signature</code> (HMAC SHA-256).
          </p>
          <SecretField value={newSecret} />
        </div>
      )}

      {mode === "list" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-slate-500">Recibe eventos de TuBot en tus sistemas, firmados y con reintentos.</p>
            <Button onClick={() => setMode("new")}><Plus size={14} /> Nuevo</Button>
          </div>
          {webhooks.length === 0 && (
            <EmptyState
              title="Sin webhooks configurados"
              description="Crea el primero para recibir eventos como lead.created o appointment.created en tu sistema."
              action={<Button onClick={() => setMode("new")}>Crear webhook</Button>}
            />
          )}
          {webhooks.map((w) => (
            <button key={w.id} onClick={() => openDetail(w)} className="block w-full rounded-xl border border-slate-200 p-3 text-left hover:border-brand-300">
              <div className="flex items-center justify-between">
                <p className="font-medium">{w.name}</p>
                <StatusBadge kind={w.active ? (w.successRate !== null && w.successRate < 80 ? "attention" : "connected") : "disconnected"} label={w.active ? undefined : "Pausado"} />
              </div>
              <p className="font-mono text-xs text-slate-400">{maskUrl(w.url)}</p>
              <p className="mt-1 text-xs text-slate-500">
                {w.events.length} evento(s) · {w.deliveries7d} entregas 7d
                {w.successRate !== null ? ` · ${w.successRate}% éxito` : ""}
                {w.lastDeliveryAt ? ` · última ${new Date(w.lastDeliveryAt).toLocaleString("es-CL")}` : ""}
              </p>
            </button>
          ))}
        </div>
      )}

      {mode === "new" && (
        <form onSubmit={create} className="space-y-3">
          <button type="button" onClick={() => setMode("list")} className="text-xs text-slate-400 hover:text-slate-600">← Volver</button>
          <label className="block text-sm font-medium">
            Nombre
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm font-medium">
            URL de destino (https)
            <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required placeholder="https://tusistema.cl/conversia" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm font-medium">
            Descripción (opcional)
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium">
              Timeout (ms)
              <input type="number" min={1000} max={30000} value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="block text-sm font-medium">
              Reintentos máx.
              <input type="number" min={0} max={8} value={form.maxRetries} onChange={(e) => setForm({ ...form, maxRetries: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            </label>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">Eventos suscritos</p>
            <div className="flex flex-wrap gap-1.5">
              {availableEvents.map((ev) => (
                <label key={ev} className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs ${form.events.includes(ev) ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 text-slate-500 hover:border-slate-300"}`}>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={form.events.includes(ev)}
                    onChange={() =>
                      setForm((f) => ({
                        ...f,
                        events: f.events.includes(ev) ? f.events.filter((x) => x !== ev) : [...f.events, ev],
                      }))
                    }
                  />
                  {ev}
                </label>
              ))}
            </div>
          </div>
          <Button type="submit">Crear webhook</Button>
        </form>
      )}

      {mode === "detail" && selected && (
        <div className="space-y-4">
          <button type="button" onClick={() => setMode("list")} className="text-xs text-slate-400 hover:text-slate-600">← Volver</button>
          <div className="rounded-xl border border-slate-200 p-4">
            <div className="flex items-center justify-between">
              <p className="font-medium">{selected.name}</p>
              <StatusBadge kind={selected.active ? "connected" : "disconnected"} label={selected.active ? "Activo" : "Pausado"} />
            </div>
            <p className="font-mono text-xs text-slate-500">{selected.url}</p>
            <p className="mt-1 text-xs text-slate-400">
              Secreto: <span className="font-mono">{selected.secretMasked}</span> · timeout {selected.timeoutMs}ms · {selected.maxRetries} reintentos
            </p>
            <p className="mt-1 text-xs text-slate-400">{selected.events.join(", ")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void testWebhook(selected.id)}>Enviar prueba</Button>
            <Button variant="secondary" onClick={() => void rotate(selected.id)}>Rotar secreto</Button>
            <Button variant="secondary" onClick={() => void toggleActive(selected)}>{selected.active ? "Pausar" : "Activar"}</Button>
            <Button variant="danger" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Eliminar</Button>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium">Entregas recientes</p>
            {deliveries === null ? (
              <Skeleton className="h-24" />
            ) : deliveries.length === 0 ? (
              <EmptyState title="Sin entregas todavía" description="Envía una prueba o espera el próximo evento suscrito." />
            ) : (
              <div className="overflow-hidden rounded-xl border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Evento</th>
                      <th className="px-3 py-2">Estado</th>
                      <th className="px-3 py-2">HTTP</th>
                      <th className="px-3 py-2">Intentos</th>
                      <th className="px-3 py-2">Fecha</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.map((d) => (
                      <tr key={d.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-mono">{d.event}</td>
                        <td className="px-3 py-2">
                          <span className={d.status === "DELIVERED" ? "text-emerald-600" : d.status === "PENDING" ? "text-slate-500" : "text-red-600"}>
                            {d.status.toLowerCase()}
                          </span>
                        </td>
                        <td className="px-3 py-2">{d.responseCode ?? "—"}</td>
                        <td className="px-3 py-2">{d.attempts}</td>
                        <td className="px-3 py-2 text-slate-400">{new Date(d.createdAt).toLocaleString("es-CL")}</td>
                        <td className="px-3 py-2">
                          {(d.status === "FAILED" || d.status === "DEAD") && (
                            <button onClick={() => void retryDelivery(selected.id, d.id)} className="text-brand-600 hover:underline">
                              Reintentar
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {deliveries?.some((d) => d.lastError) && (
              <p className="mt-2 text-xs text-red-600">Último error: {deliveries.find((d) => d.lastError)?.lastError}</p>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => selected && void remove(selected.id)}
        title="¿Eliminar este webhook?"
        description="Se eliminarán también sus entregas registradas. Esta acción no se puede deshacer."
        confirmLabel="Eliminar"
        danger
      />
    </Drawer>
  );
}

// --------------------------- Correo electrónico ---------------------------

export interface EmailState {
  status: string;
  mode?: "platform" | "smtp";
  from?: string | null;
  smtp?: { host: string; port: number; secure: boolean; user: string; hasPass?: boolean } | null;
  escalation?: { enabled: boolean; minutes: number; recipients: string[] };
  dailySummary?: { enabled: boolean; hour: number; recipients: string[] };
  alerts?: { enabled: boolean; recipients: string[] };
  lastError?: string | null;
}

function RecipientsInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  return (
    <input
      value={value.join(", ")}
      onChange={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
      placeholder={placeholder ?? "correo@equipo.cl, otro@equipo.cl"}
      className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
    />
  );
}

export function EmailDrawer({
  open,
  onClose,
  state,
  platformReady,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  state: EmailState | null;
  platformReady: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const connected = Boolean(state);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testDetail, setTestDetail] = useState<string | null>(null);
  const [form, setForm] = useState({
    mode: "platform" as "platform" | "smtp",
    from: "",
    smtpHost: "",
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: "",
    smtpPass: "",
    escalationEnabled: false,
    escalationMinutes: 10,
    escalationRecipients: [] as string[],
    dailyEnabled: false,
    dailyHour: 8,
    dailyRecipients: [] as string[],
    alertsEnabled: true,
    alertsRecipients: [] as string[],
  });

  useEffect(() => {
    if (!open) return;
    setTestDetail(null);
    if (state) {
      setForm((f) => ({
        ...f,
        mode: state.mode ?? "platform",
        from: state.from ?? "",
        smtpHost: state.smtp?.host ?? "",
        smtpPort: state.smtp?.port ?? 587,
        smtpSecure: Boolean(state.smtp?.secure),
        smtpUser: state.smtp?.user ?? "",
        smtpPass: "",
        escalationEnabled: Boolean(state.escalation?.enabled),
        escalationMinutes: state.escalation?.minutes ?? 10,
        escalationRecipients: state.escalation?.recipients ?? [],
        dailyEnabled: Boolean(state.dailySummary?.enabled),
        dailyHour: state.dailySummary?.hour ?? 8,
        dailyRecipients: state.dailySummary?.recipients ?? [],
        alertsEnabled: state.alerts?.enabled ?? true,
        alertsRecipients: state.alerts?.recipients ?? [],
      }));
    }
  }, [open, state]);

  async function save() {
    setBusy(true);
    try {
      await api("/integrations/email", {
        method: "POST",
        body: JSON.stringify({
          mode: form.mode,
          from: form.from || undefined,
          smtp:
            form.mode === "smtp"
              ? { host: form.smtpHost, port: form.smtpPort, secure: form.smtpSecure, user: form.smtpUser, ...(form.smtpPass ? { pass: form.smtpPass } : {}) }
              : undefined,
          escalation: { enabled: form.escalationEnabled, minutes: form.escalationMinutes, recipients: form.escalationRecipients },
          dailySummary: { enabled: form.dailyEnabled, hour: form.dailyHour, recipients: form.dailyRecipients },
          alerts: { enabled: form.alertsEnabled, recipients: form.alertsRecipients },
        }),
      });
      toast.push("Correo configurado ✔", "ok");
      onChanged();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!testTo) return;
    setBusy(true);
    setTestDetail("Enviando correo de prueba…");
    try {
      const r = await api<{ ok: boolean; detail: string }>("/integrations/email/test", {
        method: "POST",
        body: JSON.stringify({ to: testTo }),
      });
      setTestDetail(`${r.ok ? "✔" : "✖"} ${r.detail}`);
      onChanged();
    } catch (err) {
      setTestDetail(`✖ ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await api("/integrations/email", { method: "DELETE" });
    toast.push("Correo desconectado — escalamientos, resúmenes y alertas dejarán de enviarse", "info");
    onChanged();
    onClose();
  }

  return (
    <Drawer open={open} onClose={onClose} title="Correo electrónico — avisos al equipo">
      <p className="mb-3 text-xs text-slate-500">
        Correo <b>interno para tu equipo</b> (escalamientos, resúmenes, alertas y el paso de workflow «Enviar correo
        interno»). No es correo masivo a pacientes.
      </p>

      {/* Modo */}
      <div className="mb-3 flex gap-2">
        {(["platform", "smtp"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setForm({ ...form, mode: m })}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${form.mode === m ? "bg-cyan-700 text-white" : "border border-slate-300 text-slate-600"}`}
          >
            {m === "platform" ? "Remitente de plataforma" : "SMTP propio"}
          </button>
        ))}
      </div>
      {form.mode === "platform" && !platformReady && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          El remitente de plataforma aún no está configurado a nivel de sistema — usa SMTP propio o avísanos.
        </p>
      )}
      {form.mode === "smtp" && (
        <div className="mb-3 grid gap-2 md:grid-cols-2">
          <label className="text-sm md:col-span-2">
            <span className="text-xs text-slate-500">Remitente (From)</span>
            <input value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder="Clínica <avisos@tuclinica.cl>" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-slate-500">Servidor (host)</span>
            <input value={form.smtpHost} onChange={(e) => setForm({ ...form, smtpHost: e.target.value })} placeholder="smtp.tuclinica.cl" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-slate-500">Puerto</span>
            <input type="number" value={form.smtpPort} onChange={(e) => setForm({ ...form, smtpPort: Number(e.target.value) || 587 })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-slate-500">Usuario</span>
            <input value={form.smtpUser} onChange={(e) => setForm({ ...form, smtpUser: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-slate-500">Contraseña {state?.smtp?.hasPass ? "(dejar vacío para conservar)" : ""}</span>
            <input type="password" value={form.smtpPass} onChange={(e) => setForm({ ...form, smtpPass: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={form.smtpSecure} onChange={(e) => setForm({ ...form, smtpSecure: e.target.checked })} />
            Conexión segura (TLS/465)
          </label>
        </div>
      )}

      {/* Usos */}
      <div className="mb-3 space-y-3 rounded-xl border border-slate-200 p-3">
        <div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={form.escalationEnabled} onChange={(e) => setForm({ ...form, escalationEnabled: e.target.checked })} />
            Escalamiento sin atender
          </label>
          <p className="text-[11px] text-slate-400">Si un agente deriva a humano y nadie toma la conversación en X minutos.</p>
          {form.escalationEnabled && (
            <div className="mt-1 flex flex-wrap items-end gap-2">
              <label className="text-xs text-slate-500">
                Minutos
                <input type="number" min={2} max={240} value={form.escalationMinutes} onChange={(e) => setForm({ ...form, escalationMinutes: Number(e.target.value) || 10 })} className="mt-1 block w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
              </label>
              <div className="min-w-64 flex-1">
                <span className="text-xs text-slate-500">Destinatarios</span>
                <RecipientsInput value={form.escalationRecipients} onChange={(v) => setForm({ ...form, escalationRecipients: v })} />
              </div>
            </div>
          )}
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={form.dailyEnabled} onChange={(e) => setForm({ ...form, dailyEnabled: e.target.checked })} />
            Resumen diario
          </label>
          <p className="text-[11px] text-slate-400">Conversaciones, contactos, leads y citas de las últimas 24 h.</p>
          {form.dailyEnabled && (
            <div className="mt-1 flex flex-wrap items-end gap-2">
              <label className="text-xs text-slate-500">
                Hora
                <input type="number" min={0} max={23} value={form.dailyHour} onChange={(e) => setForm({ ...form, dailyHour: Number(e.target.value) || 8 })} className="mt-1 block w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
              </label>
              <div className="min-w-64 flex-1">
                <span className="text-xs text-slate-500">Destinatarios</span>
                <RecipientsInput value={form.dailyRecipients} onChange={(v) => setForm({ ...form, dailyRecipients: v })} />
              </div>
            </div>
          )}
        </div>
        <div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={form.alertsEnabled} onChange={(e) => setForm({ ...form, alertsEnabled: e.target.checked })} />
            Alertas de integraciones
          </label>
          <p className="text-[11px] text-slate-400">P. ej. el token de WhatsApp venció y hay que reautorizar.</p>
          {form.alertsEnabled && (
            <div className="mt-1">
              <span className="text-xs text-slate-500">Destinatarios</span>
              <RecipientsInput value={form.alertsRecipients} onChange={(v) => setForm({ ...form, alertsRecipients: v })} />
            </div>
          )}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Button onClick={() => void save()} disabled={busy}>
          {connected ? "Guardar cambios" : "Conectar"}
        </Button>
        <div className="flex items-end gap-1">
          <label className="text-xs text-slate-500">
            Probar con
            <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="tu@correo.cl" className="mt-1 block w-48 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
          </label>
          <Button variant="secondary" onClick={() => void test()} disabled={busy || !testTo}>
            Probar conexión
          </Button>
        </div>
        {connected && (
          <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>
            Desconectar
          </Button>
        )}
      </div>
      {testDetail && <p className="mb-2 text-xs text-slate-600">{testDetail}</p>}
      {state?.lastError && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">Último error: {state.lastError}</p>}

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
        title="¿Desconectar el correo?"
        description="Dejarán de enviarse los escalamientos, resúmenes diarios, alertas y el paso de workflow «Enviar correo interno»."
        confirmLabel="Desconectar"
        danger
      />
    </Drawer>
  );
}

// --------------------------- API personalizada ---------------------------

interface ApiPreset {
  id: string;
  name: string;
  baseUrl: string;
  authType: "none" | "bearer" | "header";
  headerName: string | null;
  hasSecret: boolean;
  usedBy: string[];
}

export function ApiPresetsDrawer({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [presets, setPresets] = useState<ApiPreset[] | null>(null);
  const [editing, setEditing] = useState<(Partial<ApiPreset> & { secret?: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [testDetail, setTestDetail] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const r = await api<{ presets: ApiPreset[] }>("/integrations/api-presets");
      setPresets(r.presets);
    } catch {
      setPresets([]);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function save() {
    if (!editing?.name || !editing.baseUrl) return;
    setBusy(true);
    try {
      await api("/integrations/api-presets", {
        method: "POST",
        body: JSON.stringify({
          id: editing.id,
          name: editing.name,
          baseUrl: editing.baseUrl,
          authType: editing.authType ?? "none",
          headerName: editing.headerName || undefined,
          secret: editing.secret || undefined,
        }),
      });
      toast.push("Preset guardado ✔", "ok");
      setEditing(null);
      await load();
      onChanged();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function test(id: string) {
    setTestDetail((p) => ({ ...p, [id]: "probando…" }));
    try {
      const r = await api<{ ok: boolean; detail: string }>(`/integrations/api-presets/${id}/test`, { method: "POST" });
      setTestDetail((p) => ({ ...p, [id]: `${r.ok ? "✔" : "✖"} ${r.detail}` }));
    } catch (err) {
      setTestDetail((p) => ({ ...p, [id]: `✖ ${(err as Error).message}` }));
    }
  }

  async function remove(preset: ApiPreset) {
    if (preset.usedBy.length && !window.confirm(`Este preset lo usan: ${preset.usedBy.join(", ")}. ¿Eliminar igual? Esos pasos fallarán.`)) return;
    if (!preset.usedBy.length && !window.confirm("¿Eliminar este preset?")) return;
    await api(`/integrations/api-presets/${preset.id}`, { method: "DELETE" });
    await load();
    onChanged();
  }

  return (
    <Drawer open={open} onClose={onClose} title="API personalizada — presets del paso HTTP">
      <p className="mb-3 text-xs text-slate-500">
        Define tus APIs una vez (URL base + autenticación con secreto <b>cifrado</b>) y en el canvas el paso «Petición
        HTTP» solo elige el preset y la ruta — sin pegar tokens en cada nodo. El dominio del preset queda como allowlist.
      </p>

      {editing ? (
        <div className="mb-3 space-y-2 rounded-xl border border-slate-200 p-3">
          <label className="block text-sm">
            <span className="text-xs text-slate-500">Nombre</span>
            <input value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="CRM interno" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-slate-500">URL base</span>
            <input value={editing.baseUrl ?? ""} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="https://api.miempresa.cl/v1" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <div className="flex flex-wrap gap-2">
            <label className="text-sm">
              <span className="text-xs text-slate-500">Autenticación</span>
              <select value={editing.authType ?? "none"} onChange={(e) => setEditing({ ...editing, authType: e.target.value as ApiPreset["authType"] })} className="mt-1 block rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm">
                <option value="none">Sin auth</option>
                <option value="bearer">Bearer token</option>
                <option value="header">Header personalizado</option>
              </select>
            </label>
            {editing.authType === "header" && (
              <label className="flex-1 text-sm">
                <span className="text-xs text-slate-500">Nombre del header</span>
                <input value={editing.headerName ?? ""} onChange={(e) => setEditing({ ...editing, headerName: e.target.value })} placeholder="X-Api-Key" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </label>
            )}
            {editing.authType !== "none" && (
              <label className="flex-1 text-sm">
                <span className="text-xs text-slate-500">Secreto {editing.id && editing.hasSecret ? "(vacío = conservar)" : ""}</span>
                <input type="password" value={editing.secret ?? ""} onChange={(e) => setEditing({ ...editing, secret: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
              </label>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={busy || !editing.name || !editing.baseUrl}>Guardar preset</Button>
            <Button variant="secondary" onClick={() => setEditing(null)}>Cancelar</Button>
          </div>
        </div>
      ) : (
        <div className="mb-3">
          <Button onClick={() => setEditing({ authType: "none" })}>
            <Plus size={14} /> Nuevo preset
          </Button>
        </div>
      )}

      {presets === null ? (
        <Skeleton className="h-24" />
      ) : presets.length === 0 ? (
        <EmptyState icon={<Activity size={28} />} title="Sin presets aún" description="Crea el primero para usarlo en el paso «Petición HTTP» de tus flujos." />
      ) : (
        <ul className="space-y-2">
          {presets.map((p) => (
            <li key={p.id} className="rounded-lg border border-slate-100 p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-[11px] text-slate-400">
                    <code>{p.baseUrl}</code> · {p.authType === "none" ? "sin auth" : p.authType === "bearer" ? "Bearer" : `header ${p.headerName}`}
                  </p>
                  {p.usedBy.length > 0 && <p className="text-[10px] text-cyan-700">Usado por: {p.usedBy.join(", ")}</p>}
                </div>
                <div className="flex shrink-0 gap-2 text-xs">
                  <button onClick={() => void test(p.id)} className="text-slate-500 hover:underline">Probar</button>
                  <button onClick={() => setEditing({ ...p, secret: "" })} className="text-cyan-700 hover:underline">Editar</button>
                  <button onClick={() => void remove(p)} className="text-red-400 hover:underline">Eliminar</button>
                </div>
              </div>
              {testDetail[p.id] && <p className="mt-1 text-[11px] text-slate-600">{testDetail[p.id]}</p>}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}

// --------------------------- Google Analytics (GA4) ---------------------------

export interface Ga4State {
  status: string;
  measurementId: string | null;
  mirrorCapi: boolean;
  lastError: string | null;
}

export function Ga4Drawer({ open, onClose, state, onChanged }: { open: boolean; onClose: () => void; state: Ga4State | null; onChanged: () => void }) {
  const toast = useToast();
  const connected = Boolean(state);
  const [busy, setBusy] = useState(false);
  const [testDetail, setTestDetail] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [form, setForm] = useState({ measurementId: "", apiSecret: "", mirrorCapi: false });

  useEffect(() => {
    if (open) {
      setTestDetail(null);
      setForm({ measurementId: state?.measurementId ?? "", apiSecret: "", mirrorCapi: Boolean(state?.mirrorCapi) });
    }
  }, [open, state]);

  async function save() {
    setBusy(true);
    try {
      await api("/integrations/ga4", {
        method: "POST",
        body: JSON.stringify({
          measurementId: form.measurementId.trim(),
          apiSecret: form.apiSecret || undefined,
          mirrorCapi: form.mirrorCapi,
        }),
      });
      toast.push("GA4 conectado — prueba la conexión", "ok");
      onChanged();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setTestDetail("Validando con Google…");
    try {
      const r = await api<{ ok: boolean; detail: string }>("/integrations/ga4/test", { method: "POST" });
      setTestDetail(`${r.ok ? "✔" : "✖"} ${r.detail}`);
      onChanged();
    } catch (err) {
      setTestDetail(`✖ ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await api("/integrations/ga4", { method: "DELETE" });
    toast.push("GA4 desconectado — el paso de workflow y el espejo CAPI dejarán de enviar", "info");
    onChanged();
    onClose();
  }

  return (
    <Drawer open={open} onClose={onClose} title="Google Analytics (GA4)">
      <p className="mb-3 text-xs text-slate-500">
        Measurement Protocol — sin OAuth. En Analytics: <b>Administrar → Flujos de datos → tu flujo → Secretos de la API
        de Measurement Protocol</b> para crear el <code>api_secret</code>; el <code>measurement_id</code> (G-XXXX) está en
        los detalles del flujo.
      </p>
      <div className="space-y-2">
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Measurement ID</span>
          <input value={form.measurementId} onChange={(e) => setForm({ ...form, measurementId: e.target.value.toUpperCase() })} placeholder="G-ABC123XYZ" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm" />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-slate-500">API secret {connected ? "(vacío = conservar)" : ""}</span>
          <input type="password" value={form.apiSecret} onChange={(e) => setForm({ ...form, apiSecret: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.mirrorCapi} onChange={(e) => setForm({ ...form, mirrorCapi: e.target.checked })} />
          Enviar también a Analytics los eventos CAPI (lead, agenda, compra)
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <Button onClick={() => void save()} disabled={busy || !form.measurementId}>{connected ? "Guardar" : "Conectar"}</Button>
        {connected && (
          <Button variant="secondary" onClick={() => void test()} disabled={busy}>Probar conexión</Button>
        )}
        {connected && <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>Desconectar</Button>}
      </div>
      {testDetail && <p className="mt-2 text-xs text-slate-600">{testDetail}</p>}
      {state?.lastError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">Último error: {state.lastError}</p>}
      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
        title="¿Desconectar Google Analytics?"
        description="El paso «Enviar evento GA4» de los flujos y el espejo de eventos CAPI dejarán de funcionar."
        confirmLabel="Desconectar"
        danger
      />
    </Drawer>
  );
}

// --------------------------- Meta Events Manager ---------------------------

interface EmStats {
  configured: boolean;
  datasetId?: string;
  eventsManagerUrl?: string;
  totals?: { total: number; ok: number; error: number; successRate: number | null };
  byDay?: { day: string; ok: number; error: number }[];
  byEvent?: { event: string; ok: number; error: number }[];
  recentErrors?: { message: string; at: string }[];
}

export function EventsManagerDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [stats, setStats] = useState<EmStats | null>(null);

  useEffect(() => {
    if (open) {
      setStats(null);
      void api<EmStats>("/integrations/events-manager/stats").then(setStats).catch(() => setStats({ configured: false }));
    }
  }, [open]);

  const maxDay = Math.max(1, ...(stats?.byDay ?? []).map((d) => d.ok + d.error));

  return (
    <Drawer open={open} onClose={onClose} title="Meta Events Manager — métricas CAPI">
      {stats === null ? (
        <Skeleton className="h-40" />
      ) : !stats.configured ? (
        <EmptyState
          icon={<Activity size={28} />}
          title="Conecta Meta CAPI primero"
          description="Este panel muestra las métricas de los eventos de conversión que tu cuenta envía a Meta. Configura el dataset en Integraciones → Centro Meta → Conversions API."
          action={<Button onClick={() => (window.location.href = "/integrations/meta")}>Ir al Centro Meta</Button>}
        />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg border border-slate-200 p-2">
              <p className="text-lg font-semibold">{stats.totals?.total ?? 0}</p>
              <p className="text-[10px] text-slate-400">eventos (30 d)</p>
            </div>
            <div className="rounded-lg border border-slate-200 p-2">
              <p className="text-lg font-semibold text-emerald-600">{stats.totals?.successRate ?? "—"}%</p>
              <p className="text-[10px] text-slate-400">tasa de éxito</p>
            </div>
            <div className="rounded-lg border border-slate-200 p-2">
              <p className="text-lg font-semibold text-red-500">{stats.totals?.error ?? 0}</p>
              <p className="text-[10px] text-slate-400">errores</p>
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-slate-600">Últimos 14 días</p>
            <div className="flex items-end gap-1" style={{ height: 60 }}>
              {(stats.byDay ?? []).map((d) => (
                <div key={d.day} className="flex-1" title={`${d.day}: ${d.ok} ok · ${d.error} error`}>
                  <div className="w-full rounded-t bg-red-300" style={{ height: (d.error / maxDay) * 56 }} />
                  <div className="w-full rounded-b bg-emerald-400" style={{ height: (d.ok / maxDay) * 56 }} />
                </div>
              ))}
              {(stats.byDay ?? []).length === 0 && <p className="text-xs text-slate-400">Sin eventos aún.</p>}
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-slate-600">Por tipo de evento</p>
            <ul className="space-y-1">
              {(stats.byEvent ?? []).map((e) => (
                <li key={e.event} className="flex items-center justify-between text-xs">
                  <span className="font-mono">{e.event}</span>
                  <span>
                    <span className="text-emerald-600">{e.ok} ok</span>
                    {e.error > 0 && <span className="ml-2 text-red-500">{e.error} error</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {(stats.recentErrors ?? []).length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-red-600">Últimos rechazos de Meta</p>
              <ul className="space-y-1">
                {stats.recentErrors!.map((e, i) => (
                  <li key={i} className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
                    {e.message} <span className="text-red-400">· {new Date(e.at).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <a href={stats.eventsManagerUrl} target="_blank" rel="noreferrer" className="block text-xs text-cyan-700 underline">
            Abrir el Events Manager de Meta (dataset {stats.datasetId}) →
          </a>
        </div>
      )}
    </Drawer>
  );
}

// --------------------------- Agenda personalizada ---------------------------

export interface CustomSchedState {
  status: string;
  baseUrl: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export function CustomSchedulingDrawer({ open, onClose, state, onChanged }: { open: boolean; onClose: () => void; state: CustomSchedState | null; onChanged: () => void }) {
  const toast = useToast();
  const connected = state?.status === "active" || state?.status === "error";
  const [busy, setBusy] = useState(false);
  const [testDetail, setTestDetail] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [form, setForm] = useState({ baseUrl: "", secret: "" });

  useEffect(() => {
    if (open) {
      setTestDetail(null);
      setForm({ baseUrl: state?.baseUrl ?? "", secret: "" });
    }
  }, [open, state]);

  async function save() {
    setBusy(true);
    try {
      await api("/integrations/custom-scheduling", {
        method: "POST",
        body: JSON.stringify({ baseUrl: form.baseUrl.trim(), secret: form.secret || undefined }),
      });
      toast.push("Agenda conectada — prueba la conexión", "ok");
      onChanged();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setTestDetail("Probando contra tu sistema…");
    try {
      const r = await api<{ ok: boolean; detail: string }>("/integrations/custom-scheduling/test", { method: "POST" });
      setTestDetail(`${r.ok ? "" : "✖ "}${r.detail}`);
      onChanged();
    } catch (err) {
      setTestDetail(`✖ ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await api("/integrations/custom-scheduling", { method: "DELETE" });
    toast.push("Agenda personalizada desconectada — los agentes vuelven a la agenda interna", "info");
    onChanged();
    onClose();
  }

  return (
    <Drawer open={open} onClose={onClose} title="Agenda personalizada — contrato estándar">
      <p className="mb-3 text-xs text-slate-500">
        Tu software clínico implementa el <b>contrato estándar de agenda</b> (disponibilidad, citas, profesionales,
        servicios) con firma HMAC, y los agentes IA y workflows lo usan igual que cualquier proveedor. La documentación
        completa con ejemplos curl está en{" "}
        <a href="/integrations/developers#agenda" className="underline">Desarrolladores → Contrato de agenda</a>.
      </p>
      <div className="space-y-2">
        <label className="block text-sm">
          <span className="text-xs text-slate-500">URL base de tu API de agenda</span>
          <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://agenda.tuclinica.cl/conversia" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-slate-500">Secreto HMAC compartido {connected ? "(vacío = conservar)" : "(mínimo 12 caracteres)"}</span>
          <input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <Button onClick={() => void save()} disabled={busy || !form.baseUrl}>{connected ? "Guardar" : "Conectar"}</Button>
        {connected && <Button variant="secondary" onClick={() => void test()} disabled={busy}>Probar conexión</Button>}
        {connected && <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>Desconectar</Button>}
      </div>
      {testDetail && <p className="mt-2 text-xs text-slate-600">{testDetail}</p>}
      {state?.lastError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">Último error: {state.lastError}</p>}
      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
        title="¿Desconectar la agenda personalizada?"
        description="Los agentes IA dejarán de consultar tu sistema y volverán a la agenda interna de Conversia."
        confirmLabel="Desconectar"
        danger
      />
    </Drawer>
  );
}
