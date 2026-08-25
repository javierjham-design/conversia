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
          <p className="mb-4 text-sm text-ink-muted">
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
                className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
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
                className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
              />
            </label>
            <Button type="submit" disabled={busy}>Conectar y continuar</Button>
          </form>
          <ol className="mt-6 space-y-1.5 border-t border-line pt-4 text-xs text-ink-subtle">
            <li>1. Credenciales ✦ este paso</li>
            <li>2. Probar conexión y sedes visibles</li>
            <li>3. Mapeo de profesionales y prestaciones — próximamente</li>
            <li>4. Activación</li>
          </ol>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-center justify-between rounded-xl border border-line p-4">
            <div>
              <div className="mb-1 flex items-center gap-2">
                <StatusBadge kind={state?.lastError ? "attention" : "connected"} />
              </div>
              <p className="font-mono text-xs text-ink-muted">{state?.baseUrl}</p>
              <p className="text-xs text-ink-subtle">
                API key: <span className="font-mono">{state?.apiKeyMasked ?? "—"}</span> · Última sincronización:{" "}
                {state?.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString("es-CL") : "nunca"}
              </p>
              {state?.lastError && <p className="mt-1 text-xs text-red-600 dark:text-red-400">Último error: {state.lastError}</p>}
            </div>
            <CalendarCheck className="text-emerald-500" />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void test()} disabled={busy}>
              <RefreshCw size={14} /> Probar / sincronizar ahora
            </Button>
            <Button variant="danger" onClick={() => setConfirmDisconnect(true)}>Desconectar</Button>
          </div>
          {testDetail && <p className="rounded-lg bg-app px-3 py-2 text-xs text-ink-muted">{testDetail}</p>}

          <div>
            <p className="mb-2 flex items-center gap-1.5 text-sm font-medium"><Activity size={14} /> Actividad reciente</p>
            {activity === null ? (
              <Skeleton className="h-20" />
            ) : activity.length === 0 ? (
              <EmptyState title="Sin actividad todavía" description="Las sincronizaciones y errores aparecerán aquí." />
            ) : (
              <ul className="space-y-1.5">
                {activity.map((a) => (
                  <li key={a.id} className="flex items-start justify-between gap-2 rounded-lg border border-line px-3 py-2 text-xs">
                    <span className={a.status === "error" ? "text-red-600 dark:text-red-400" : "text-ink-muted"}>{a.message ?? a.type}</span>
                    <span className="shrink-0 text-ink-subtle">{new Date(a.createdAt).toLocaleString("es-CL")}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <p className="text-xs text-ink-subtle">
            Rotar credenciales: vuelve a conectar con una API key nueva (la anterior queda revocada para esta conexión).
            Mapeo de profesionales/prestaciones y verificación de cita de prueba: <b>próximamente</b>.
          </p>

          <form onSubmit={connect} className="space-y-2 border-t border-line pt-4">
            <p className="text-sm font-medium">Reconectar / rotar credenciales</p>
            <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} required placeholder="https://api.clariva.cl" className="w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
            <input value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} required type="password" placeholder="Nueva API key" className="w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
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
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:bg-amber-500/10 dark:border-amber-500/30">
          <p className="mb-2 text-xs font-medium text-amber-800 dark:text-amber-300">
            Secreto de firma — se muestra UNA sola vez. Verifica la cabecera <code>X-Conversia-Signature</code> (HMAC SHA-256).
          </p>
          <SecretField value={newSecret} />
        </div>
      )}

      {mode === "list" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-ink-muted">Recibe eventos de TuBot en tus sistemas, firmados y con reintentos.</p>
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
            <button key={w.id} onClick={() => openDetail(w)} className="block w-full rounded-xl border border-line p-3 text-left hover:border-brand-300">
              <div className="flex items-center justify-between">
                <p className="font-medium">{w.name}</p>
                <StatusBadge kind={w.active ? (w.successRate !== null && w.successRate < 80 ? "attention" : "connected") : "disconnected"} label={w.active ? undefined : "Pausado"} />
              </div>
              <p className="font-mono text-xs text-ink-subtle">{maskUrl(w.url)}</p>
              <p className="mt-1 text-xs text-ink-muted">
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
          <button type="button" onClick={() => setMode("list")} className="text-xs text-ink-subtle hover:text-ink-muted">← Volver</button>
          <label className="block text-sm font-medium">
            Nombre
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm font-medium">
            URL de destino (https)
            <input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required placeholder="https://tusistema.cl/conversia" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm font-medium">
            Descripción (opcional)
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm font-medium">
              Timeout (ms)
              <input type="number" min={1000} max={30000} value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
            </label>
            <label className="block text-sm font-medium">
              Reintentos máx.
              <input type="number" min={0} max={8} value={form.maxRetries} onChange={(e) => setForm({ ...form, maxRetries: Number(e.target.value) })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
            </label>
          </div>
          <div>
            <p className="mb-1.5 text-sm font-medium">Eventos suscritos</p>
            <div className="flex flex-wrap gap-1.5">
              {availableEvents.map((ev) => (
                <label key={ev} className={`cursor-pointer rounded-full border px-2.5 py-1 text-xs ${form.events.includes(ev) ? "border-brand-300 bg-brand-50 text-brand-700" : "border-line text-ink-muted hover:border-line-strong"} dark:bg-brand-500/10 dark:text-brand-300 dark:border-brand-500/40`}>
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
          <button type="button" onClick={() => setMode("list")} className="text-xs text-ink-subtle hover:text-ink-muted">← Volver</button>
          <div className="rounded-xl border border-line p-4">
            <div className="flex items-center justify-between">
              <p className="font-medium">{selected.name}</p>
              <StatusBadge kind={selected.active ? "connected" : "disconnected"} label={selected.active ? "Activo" : "Pausado"} />
            </div>
            <p className="font-mono text-xs text-ink-muted">{selected.url}</p>
            <p className="mt-1 text-xs text-ink-subtle">
              Secreto: <span className="font-mono">{selected.secretMasked}</span> · timeout {selected.timeoutMs}ms · {selected.maxRetries} reintentos
            </p>
            <p className="mt-1 text-xs text-ink-subtle">{selected.events.join(", ")}</p>
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
              <div className="overflow-hidden rounded-xl border border-line">
                <table className="w-full text-xs">
                  <thead className="bg-app text-left text-ink-muted">
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
                      <tr key={d.id} className="border-t border-line">
                        <td className="px-3 py-2 font-mono">{d.event}</td>
                        <td className="px-3 py-2">
                          <span className={d.status === "DELIVERED" ? "text-emerald-600 dark:text-emerald-400" : d.status === "PENDING" ? "text-ink-muted" : "text-red-600 dark:text-red-400"}>
                            {d.status.toLowerCase()}
                          </span>
                        </td>
                        <td className="px-3 py-2">{d.responseCode ?? "—"}</td>
                        <td className="px-3 py-2">{d.attempts}</td>
                        <td className="px-3 py-2 text-ink-subtle">{new Date(d.createdAt).toLocaleString("es-CL")}</td>
                        <td className="px-3 py-2">
                          {(d.status === "FAILED" || d.status === "DEAD") && (
                            <button onClick={() => void retryDelivery(selected.id, d.id)} className="text-brand-600 hover:underline dark:text-brand-400">
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
              <p className="mt-2 text-xs text-red-600 dark:text-red-400">Último error: {deliveries.find((d) => d.lastError)?.lastError}</p>
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
      className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
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
      <p className="mb-3 text-xs text-ink-muted">
        Correo <b>interno para tu equipo</b> (escalamientos, resúmenes, alertas y el paso de workflow «Enviar correo
        interno»). No es correo masivo a pacientes.
      </p>

      {/* Modo */}
      <div className="mb-3 flex gap-2">
        {(["platform", "smtp"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setForm({ ...form, mode: m })}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${form.mode === m ? "bg-cyan-700 text-white" : "border border-line-strong text-ink-muted"}`}
          >
            {m === "platform" ? "Remitente de plataforma" : "SMTP propio"}
          </button>
        ))}
      </div>
      {form.mode === "platform" && !platformReady && (
        <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
          El remitente de plataforma aún no está configurado a nivel de sistema — usa SMTP propio o avísanos.
        </p>
      )}
      {form.mode === "smtp" && (
        <div className="mb-3 grid gap-2 md:grid-cols-2">
          <label className="text-sm md:col-span-2">
            <span className="text-xs text-ink-muted">Remitente (From)</span>
            <input value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} placeholder="Clínica <avisos@tuclinica.cl>" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-ink-muted">Servidor (host)</span>
            <input value={form.smtpHost} onChange={(e) => setForm({ ...form, smtpHost: e.target.value })} placeholder="smtp.tuclinica.cl" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-ink-muted">Puerto</span>
            <input type="number" value={form.smtpPort} onChange={(e) => setForm({ ...form, smtpPort: Number(e.target.value) || 587 })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-ink-muted">Usuario</span>
            <input value={form.smtpUser} onChange={(e) => setForm({ ...form, smtpUser: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
          </label>
          <label className="text-sm">
            <span className="text-xs text-ink-muted">Contraseña {state?.smtp?.hasPass ? "(dejar vacío para conservar)" : ""}</span>
            <input type="password" value={form.smtpPass} onChange={(e) => setForm({ ...form, smtpPass: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input type="checkbox" checked={form.smtpSecure} onChange={(e) => setForm({ ...form, smtpSecure: e.target.checked })} />
            Conexión segura (TLS/465)
          </label>
        </div>
      )}

      {/* Usos */}
      <div className="mb-3 space-y-3 rounded-xl border border-line p-3">
        <div>
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={form.escalationEnabled} onChange={(e) => setForm({ ...form, escalationEnabled: e.target.checked })} />
            Escalamiento sin atender
          </label>
          <p className="text-[11px] text-ink-subtle">Si un agente deriva a humano y nadie toma la conversación en X minutos.</p>
          {form.escalationEnabled && (
            <div className="mt-1 flex flex-wrap items-end gap-2">
              <label className="text-xs text-ink-muted">
                Minutos
                <input type="number" min={2} max={240} value={form.escalationMinutes} onChange={(e) => setForm({ ...form, escalationMinutes: Number(e.target.value) || 10 })} className="mt-1 block w-20 rounded-lg border border-line-strong px-2 py-1.5 text-sm" />
              </label>
              <div className="min-w-64 flex-1">
                <span className="text-xs text-ink-muted">Destinatarios</span>
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
          <p className="text-[11px] text-ink-subtle">Conversaciones, contactos, leads y citas de las últimas 24 h.</p>
          {form.dailyEnabled && (
            <div className="mt-1 flex flex-wrap items-end gap-2">
              <label className="text-xs text-ink-muted">
                Hora
                <input type="number" min={0} max={23} value={form.dailyHour} onChange={(e) => setForm({ ...form, dailyHour: Number(e.target.value) || 8 })} className="mt-1 block w-20 rounded-lg border border-line-strong px-2 py-1.5 text-sm" />
              </label>
              <div className="min-w-64 flex-1">
                <span className="text-xs text-ink-muted">Destinatarios</span>
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
          <p className="text-[11px] text-ink-subtle">P. ej. el token de WhatsApp venció y hay que reautorizar.</p>
          {form.alertsEnabled && (
            <div className="mt-1">
              <span className="text-xs text-ink-muted">Destinatarios</span>
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
          <label className="text-xs text-ink-muted">
            Probar con
            <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="tu@correo.cl" className="mt-1 block w-48 rounded-lg border border-line-strong px-2 py-1.5 text-sm" />
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
      {testDetail && <p className="mb-2 text-xs text-ink-muted">{testDetail}</p>}
      {state?.lastError && <p className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">Último error: {state.lastError}</p>}

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
      <p className="mb-3 text-xs text-ink-muted">
        Define tus APIs una vez (URL base + autenticación con secreto <b>cifrado</b>) y en el canvas el paso «Petición
        HTTP» solo elige el preset y la ruta — sin pegar tokens en cada nodo. El dominio del preset queda como allowlist.
      </p>

      {editing ? (
        <div className="mb-3 space-y-2 rounded-xl border border-line p-3">
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">Nombre</span>
            <input value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="CRM interno" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
          </label>
          <label className="block text-sm">
            <span className="text-xs text-ink-muted">URL base</span>
            <input value={editing.baseUrl ?? ""} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} placeholder="https://api.miempresa.cl/v1" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
          </label>
          <div className="flex flex-wrap gap-2">
            <label className="text-sm">
              <span className="text-xs text-ink-muted">Autenticación</span>
              <select value={editing.authType ?? "none"} onChange={(e) => setEditing({ ...editing, authType: e.target.value as ApiPreset["authType"] })} className="mt-1 block rounded-lg border border-line-strong bg-panel px-2 py-2 text-sm">
                <option value="none">Sin auth</option>
                <option value="bearer">Bearer token</option>
                <option value="header">Header personalizado</option>
              </select>
            </label>
            {editing.authType === "header" && (
              <label className="flex-1 text-sm">
                <span className="text-xs text-ink-muted">Nombre del header</span>
                <input value={editing.headerName ?? ""} onChange={(e) => setEditing({ ...editing, headerName: e.target.value })} placeholder="X-Api-Key" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
              </label>
            )}
            {editing.authType !== "none" && (
              <label className="flex-1 text-sm">
                <span className="text-xs text-ink-muted">Secreto {editing.id && editing.hasSecret ? "(vacío = conservar)" : ""}</span>
                <input type="password" value={editing.secret ?? ""} onChange={(e) => setEditing({ ...editing, secret: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
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
            <li key={p.id} className="rounded-lg border border-line p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{p.name}</p>
                  <p className="text-[11px] text-ink-subtle">
                    <code>{p.baseUrl}</code> · {p.authType === "none" ? "sin auth" : p.authType === "bearer" ? "Bearer" : `header ${p.headerName}`}
                  </p>
                  {p.usedBy.length > 0 && <p className="text-[10px] text-cyan-700 dark:text-cyan-300">Usado por: {p.usedBy.join(", ")}</p>}
                </div>
                <div className="flex shrink-0 gap-2 text-xs">
                  <button onClick={() => void test(p.id)} className="text-ink-muted hover:underline">Probar</button>
                  <button onClick={() => setEditing({ ...p, secret: "" })} className="text-cyan-700 hover:underline dark:text-cyan-300">Editar</button>
                  <button onClick={() => void remove(p)} className="text-red-400 hover:underline">Eliminar</button>
                </div>
              </div>
              {testDetail[p.id] && <p className="mt-1 text-[11px] text-ink-muted">{testDetail[p.id]}</p>}
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
      <p className="mb-3 text-xs text-ink-muted">
        Measurement Protocol — sin OAuth. En Analytics: <b>Administrar → Flujos de datos → tu flujo → Secretos de la API
        de Measurement Protocol</b> para crear el <code>api_secret</code>; el <code>measurement_id</code> (G-XXXX) está en
        los detalles del flujo.
      </p>
      <div className="space-y-2">
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Measurement ID</span>
          <input value={form.measurementId} onChange={(e) => setForm({ ...form, measurementId: e.target.value.toUpperCase() })} placeholder="G-ABC123XYZ" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 font-mono text-sm" />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">API secret {connected ? "(vacío = conservar)" : ""}</span>
          <input type="password" value={form.apiSecret} onChange={(e) => setForm({ ...form, apiSecret: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
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
      {testDetail && <p className="mt-2 text-xs text-ink-muted">{testDetail}</p>}
      {state?.lastError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">Último error: {state.lastError}</p>}
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
            <div className="rounded-lg border border-line p-2">
              <p className="text-lg font-semibold">{stats.totals?.total ?? 0}</p>
              <p className="text-[10px] text-ink-subtle">eventos (30 d)</p>
            </div>
            <div className="rounded-lg border border-line p-2">
              <p className="text-lg font-semibold text-emerald-600 dark:text-emerald-400">{stats.totals?.successRate ?? "—"}%</p>
              <p className="text-[10px] text-ink-subtle">tasa de éxito</p>
            </div>
            <div className="rounded-lg border border-line p-2">
              <p className="text-lg font-semibold text-red-500">{stats.totals?.error ?? 0}</p>
              <p className="text-[10px] text-ink-subtle">errores</p>
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Últimos 14 días</p>
            <div className="flex items-end gap-1" style={{ height: 60 }}>
              {(stats.byDay ?? []).map((d) => (
                <div key={d.day} className="flex-1" title={`${d.day}: ${d.ok} ok · ${d.error} error`}>
                  <div className="w-full rounded-t bg-red-300" style={{ height: (d.error / maxDay) * 56 }} />
                  <div className="w-full rounded-b bg-emerald-400" style={{ height: (d.ok / maxDay) * 56 }} />
                </div>
              ))}
              {(stats.byDay ?? []).length === 0 && <p className="text-xs text-ink-subtle">Sin eventos aún.</p>}
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Por tipo de evento</p>
            <ul className="space-y-1">
              {(stats.byEvent ?? []).map((e) => (
                <li key={e.event} className="flex items-center justify-between text-xs">
                  <span className="font-mono">{e.event}</span>
                  <span>
                    <span className="text-emerald-600 dark:text-emerald-400">{e.ok} ok</span>
                    {e.error > 0 && <span className="ml-2 text-red-500">{e.error} error</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {(stats.recentErrors ?? []).length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-red-600 dark:text-red-400">Últimos rechazos de Meta</p>
              <ul className="space-y-1">
                {stats.recentErrors!.map((e, i) => (
                  <li key={i} className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:bg-red-500/10 dark:text-red-300">
                    {e.message} <span className="text-red-400">· {new Date(e.at).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" })}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <a href={stats.eventsManagerUrl} target="_blank" rel="noreferrer" className="block text-xs text-cyan-700 underline dark:text-cyan-300">
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
      <p className="mb-3 text-xs text-ink-muted">
        Tu software clínico implementa el <b>contrato estándar de agenda</b> (disponibilidad, citas, profesionales,
        servicios) con firma HMAC, y los agentes IA y workflows lo usan igual que cualquier proveedor. La documentación
        completa con ejemplos curl está en{" "}
        <a href="/integrations/developers#agenda" className="underline">Desarrolladores → Contrato de agenda</a>.
      </p>
      <div className="space-y-2">
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">URL base de tu API de agenda</span>
          <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://agenda.tuclinica.cl/conversia" className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Secreto HMAC compartido {connected ? "(vacío = conservar)" : "(mínimo 12 caracteres)"}</span>
          <input type="password" value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
        </label>
      </div>
      <div className="mt-3 flex gap-2">
        <Button onClick={() => void save()} disabled={busy || !form.baseUrl}>{connected ? "Guardar" : "Conectar"}</Button>
        {connected && <Button variant="secondary" onClick={() => void test()} disabled={busy}>Probar conexión</Button>}
        {connected && <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>Desconectar</Button>}
      </div>
      {testDetail && <p className="mt-2 text-xs text-ink-muted">{testDetail}</p>}
      {state?.lastError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">Último error: {state.lastError}</p>}
      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
        title="¿Desconectar la agenda personalizada?"
        description="Los agentes IA dejarán de consultar tu sistema y volverán a la agenda interna de TuBot."
        confirmLabel="Desconectar"
        danger
      />
    </Drawer>
  );
}

// --------------------------- Zapier / Make ---------------------------

export interface AutomationState {
  status: string;
  webhookEndpointId: string | null;
}

const AUTOMATION_TEMPLATES: Record<"zapier" | "make", { title: string; steps: string[] }[]> = {
  make: [
    {
      title: "Nuevo lead → Google Sheets",
      steps: [
        "En Make crea un escenario con el módulo «Webhooks → Custom webhook» y pega su URL aquí al conectar.",
        "Suscribe el evento lead.created (ya viene marcado).",
        "Agrega el módulo «Google Sheets → Add a Row» y mapea data.contactId, data.source y la fecha.",
      ],
    },
    {
      title: "Cita creada → aviso (Slack/Telegram/correo)",
      steps: [
        "Mismo webhook; el evento appointment.created llega con los datos de la cita.",
        "Agrega el módulo de aviso que uses (Slack, Telegram, Email) y arma el mensaje con los campos del payload.",
      ],
    },
    {
      title: "Lead calificado → tu CRM",
      steps: [
        "El evento lead.status_changed incluye statusCode (p. ej. calificado).",
        "Filtra por statusCode y usa «HTTP → Make a request» hacia tu CRM, o consulta más datos del contacto con nuestra API (Authorization: Bearer tu API key).",
      ],
    },
  ],
  zapier: [
    {
      title: "Nuevo lead → Google Sheets",
      steps: [
        "En Zapier crea un Zap con trigger «Webhooks by Zapier → Catch Hook» y pega su URL aquí al conectar.",
        "El evento lead.created llegará con el payload del lead.",
        "Acción: «Google Sheets → Create Spreadsheet Row» mapeando los campos.",
      ],
    },
    {
      title: "Cita creada → aviso",
      steps: [
        "Mismo Catch Hook; filtra por event = appointment.created (paso Filter).",
        "Acción: Gmail/Slack/SMS con los datos de la cita.",
      ],
    },
    {
      title: "Lead calificado → CRM",
      steps: [
        "Filtra event = lead.status_changed y data.statusCode = calificado.",
        "Acción: «Webhooks by Zapier → POST» a tu CRM, o enriquece con nuestra API (GET /public/v1/contacts).",
      ],
    },
  ],
};

export function AutomationDrawer({
  open,
  onClose,
  kind,
  state,
  webhooks,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  kind: "zapier" | "make";
  state: AutomationState | null;
  webhooks: WebhookRow[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const label = kind === "zapier" ? "Zapier" : "Make";
  const connected = Boolean(state);
  const endpoint = webhooks.find((w) => w.id === state?.webhookEndpointId) ?? null;
  const [busy, setBusy] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [secrets, setSecrets] = useState<{ webhookSecret: string | null; apiKeySecret: string | null } | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    if (open) {
      setSecrets(null);
      setWebhookUrl(endpoint?.url ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function connect() {
    setBusy(true);
    try {
      const r = await api<{ webhookSecret: string | null; apiKeySecret: string | null }>("/integrations/automation", {
        method: "POST",
        body: JSON.stringify({ kind, webhookUrl: webhookUrl.trim() }),
      });
      setSecrets(r);
      toast.push(`${label} conectado ✔`, "ok");
      onChanged();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await api(`/integrations/automation/${kind}`, { method: "DELETE" });
    toast.push(`${label} desconectado — el webhook quedó pausado y la API key revocada`, "info");
    onChanged();
    onClose();
  }

  return (
    <Drawer open={open} onClose={onClose} title={`${label} — automatizaciones`}>
      <p className="mb-3 text-xs text-ink-muted">
        Sin app nativa (queda como mejora futura): el asistente conecta {label} con lo que ya tienes — un <b>webhook
        saliente</b> como trigger y una <b>API key</b> para las acciones.
      </p>

      <label className="block text-sm">
        <span className="text-xs text-ink-muted">URL del webhook de {label} ({kind === "zapier" ? "Catch Hook" : "Custom webhook"})</span>
        <input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder={kind === "zapier" ? "https://hooks.zapier.com/hooks/catch/…" : "https://hook.us1.make.com/…"} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
      </label>
      <div className="mt-2 flex gap-2">
        <Button onClick={() => void connect()} disabled={busy || !webhookUrl.trim()}>{connected ? "Actualizar" : "Conectar"}</Button>
        {connected && <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>Desconectar</Button>}
      </div>

      {secrets && (secrets.apiKeySecret || secrets.webhookSecret) && (
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30">
          <p className="font-medium">Guarda estos secretos — se muestran una sola vez:</p>
          {secrets.apiKeySecret && <p className="mt-1">API key (acciones): <code className="rounded bg-panel px-1.5 py-0.5">{secrets.apiKeySecret}</code></p>}
          {secrets.webhookSecret && <p className="mt-1">Secreto del webhook (firma sha256): <code className="rounded bg-panel px-1.5 py-0.5">{secrets.webhookSecret}</code></p>}
        </div>
      )}

      {connected && endpoint && (
        <p className="mt-3 text-xs text-ink-muted">
          Estado: {endpoint.deliveries7d} entrega(s) en 7 días
          {endpoint.successRate !== null ? ` · ${endpoint.successRate}% OK` : ""} · última:{" "}
          {endpoint.lastDeliveryAt ? new Date(endpoint.lastDeliveryAt).toLocaleString("es-CL") : "sin entregas aún"}
        </p>
      )}

      <div className="mt-4">
        <h3 className="text-sm font-medium">Plantillas de casos comunes</h3>
        <div className="mt-2 space-y-3">
          {AUTOMATION_TEMPLATES[kind].map((t) => (
            <div key={t.title} className="rounded-lg border border-line p-3">
              <p className="text-sm font-medium">{t.title}</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-ink-muted">
                {t.steps.map((s, i) => (<li key={i}>{s}</li>))}
              </ol>
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
        title={`¿Desconectar ${label}?`}
        description="El webhook saliente quedará pausado y la API key revocada: tus escenarios dejarán de recibir eventos y de poder llamar a la API."
        confirmLabel="Desconectar"
        danger
      />
    </Drawer>
  );
}

// ------------------------------ Google (Calendar + Sheets) ------------------------------

export interface GoogleState {
  status: string;
  accountEmail: string | null;
  calendarId: string | null;
  calendarSync: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

export function GoogleDrawer({
  open,
  onClose,
  state,
  platformReady,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  state: GoogleState | null;
  platformReady: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const connected = Boolean(state);
  const needsReauth = state?.status === "reauthorize";
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [calendars, setCalendars] = useState<{ id: string; name: string; primary: boolean }[] | null>(null);
  const [calendarId, setCalendarId] = useState("");
  const [calendarSync, setCalendarSync] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTestResult(null);
    setCalendarId(state?.calendarId ?? "");
    setCalendarSync(Boolean(state?.calendarSync));
    if (connected && !needsReauth) {
      setCalendars(null);
      void api<{ calendars: { id: string; name: string; primary: boolean }[] }>("/integrations/google/calendars")
        .then((r) => setCalendars(r.calendars))
        .catch(() => setCalendars([]));
    }
  }, [open, connected, needsReauth, state?.calendarId, state?.calendarSync]);

  async function startOAuth() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>("/integrations/oauth/google/authorize");
      // Ventana aparte: al terminar avisa por postMessage y se cierra sola.
      const popup = window.open(url, "tubot-oauth-google", "popup=yes,width=560,height=720");
      if (!popup) window.location.href = url; // popup bloqueado → misma pestaña
      setBusy(false);
    } catch (err) {
      toast.push((err as Error).message, "error");
      setBusy(false);
    }
  }

  async function saveConfig() {
    setBusy(true);
    try {
      await api("/integrations/google/config", {
        method: "PUT",
        body: JSON.stringify({ calendarId, calendarSync }),
      });
      toast.push("Configuración guardada ✔", "ok");
      onChanged();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setTestResult(null);
    try {
      const r = await api<{ ok: boolean; detail: string }>("/integrations/google/test", { method: "POST" });
      setTestResult(r.detail);
      if (r.ok) onChanged();
    } catch (err) {
      setTestResult((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await api("/integrations/google", { method: "DELETE" });
    toast.push("Cuenta de Google desconectada — el token fue revocado", "info");
    onChanged();
    onClose();
  }

  return (
    <Drawer open={open} onClose={onClose} title="Google Calendar y Sheets">
      {!platformReady ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30">
          <p className="font-medium">Configuración de plataforma pendiente</p>
          <p className="mt-1 text-xs">
            Falta registrar la app OAuth de Google a nivel plataforma (variables GOOGLE_OAUTH_CLIENT_ID y
            GOOGLE_OAUTH_CLIENT_SECRET). Sigue la guía <code>docs/GUIA_OAUTH_GOOGLE.md</code> del repositorio y
            vuelve aquí: no necesitas cambiar nada más.
          </p>
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-ink-muted">
            Una sola conexión habilita <b>Google Calendar</b> (espejo de tus citas de Conversia) y{" "}
            <b>Google Sheets</b> (paso «Añadir fila a Google Sheets» en los flujos). Los tokens quedan cifrados por
            organización.
          </p>

          {needsReauth && (
            <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30">
              El acceso fue revocado o expiró: vuelve a conectar la cuenta para reanudar la sincronización.
            </div>
          )}

          {!connected || needsReauth ? (
            <Button onClick={() => void startOAuth()} disabled={busy}>
              {needsReauth ? "Volver a conectar con Google" : "Conectar con Google"}
            </Button>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30">
                <span className="text-base">✅</span>
                <div>
                  <p className="font-medium">Cuenta de Google conectada</p>
                  <p className="text-xs">
                    {state?.accountEmail ?? calendars?.find((c) => c.primary)?.id ?? "cuenta autorizada"}
                  </p>
                </div>
              </div>
              <div className="rounded-xl border border-line p-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Espejo de citas en Google Calendar</p>
                  <StatusBadge kind={state?.lastError ? "attention" : "connected"} label={state?.lastError ? "Atención" : "Activa"} />
                </div>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={calendarSync} onChange={(e) => setCalendarSync(e.target.checked)} />
                  Reflejar cada cita creada, actualizada o cancelada
                </label>
                <label className="mt-2 block text-sm">
                  <span className="text-xs text-ink-muted">Calendario destino</span>
                  {calendars === null ? (
                    <Skeleton className="mt-1 h-9" />
                  ) : (
                    <select
                      value={calendarId}
                      onChange={(e) => setCalendarId(e.target.value)}
                      className="mt-1 block w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm"
                    >
                      <option value="">— elegir calendario —</option>
                      {calendars.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.primary ? " (principal)" : ""}
                        </option>
                      ))}
                    </select>
                  )}
                </label>
                {state?.lastSyncAt && (
                  <p className="mt-2 text-[11px] text-ink-subtle">
                    Última sincronización: {new Date(state.lastSyncAt).toLocaleString("es-CL")}
                  </p>
                )}
                {state?.lastError && <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{state.lastError}</p>}
              </div>

              <div className="rounded-xl border border-line p-3 text-xs text-ink-muted">
                <p className="text-sm font-medium text-ink">Google Sheets</p>
                <p className="mt-1">
                  Ya quedó habilitado: agrega el paso <b>«Añadir fila a Google Sheets»</b> en{" "}
                  <a href="/workflows" className="underline">Workflows</a> con el ID de la planilla y las columnas
                  (admiten variables del contacto).
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void saveConfig()} disabled={busy || (calendarSync && !calendarId)}>Guardar</Button>
                <Button variant="secondary" onClick={() => void test()} disabled={busy}>Probar conexión</Button>
                <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>Desconectar</Button>
              </div>
              {testResult && (
                <p className={`text-xs ${testResult.startsWith("✔") ? "text-emerald-600" : "text-red-600"} dark:text-emerald-400 dark:text-red-400`}>{testResult}</p>
              )}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
        title="¿Desconectar Google?"
        description="Se revocará el token y se detendrá el espejo de citas y el paso de Google Sheets en los flujos publicados."
        confirmLabel="Desconectar"
        danger
      />
    </Drawer>
  );
}

// ------------------------------ Dentalink (Healthatom) ------------------------------

export interface DentalinkState {
  status: string;
  workStartHour: number;
  workEndHour: number;
  slotMinutes: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

export function DentalinkDrawer({
  open,
  onClose,
  state,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  state: DentalinkState | null;
  onChanged: () => void;
}) {
  const toast = useToast();
  const connected = Boolean(state);
  const [token, setToken] = useState("");
  const [workStartHour, setWorkStartHour] = useState(9);
  const [workEndHour, setWorkEndHour] = useState(19);
  const [slotMinutes, setSlotMinutes] = useState(30);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    if (!open) return;
    setToken("");
    setTestResult(null);
    setWorkStartHour(state?.workStartHour ?? 9);
    setWorkEndHour(state?.workEndHour ?? 19);
    setSlotMinutes(state?.slotMinutes ?? 30);
  }, [open, state?.workStartHour, state?.workEndHour, state?.slotMinutes]);

  async function save() {
    setBusy(true);
    try {
      await api("/integrations/dentalink", {
        method: "POST",
        body: JSON.stringify({
          ...(token.trim() ? { token: token.trim() } : {}),
          workStartHour,
          workEndHour,
          slotMinutes,
        }),
      });
      toast.push("Dentalink guardado ✔ — prueba la conexión", "ok");
      setToken("");
      onChanged();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setTestResult(null);
    try {
      const r = await api<{ ok: boolean; detail: string }>("/integrations/dentalink/test", { method: "POST" });
      setTestResult(r.detail);
      onChanged();
    } catch (err) {
      setTestResult((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await api("/integrations/dentalink", { method: "DELETE" });
    toast.push("Dentalink desconectado", "info");
    onChanged();
    onClose();
  }

  return (
    <Drawer open={open} onClose={onClose} title="Dentalink — agenda dental">
      <p className="mb-3 text-xs text-ink-muted">
        Conecta tu Dentalink (Healthatom) con el token de <b>Configuración → API</b> de tu cuenta. Los agentes IA
        ofrecerán horas reales (tu ventana laboral menos las citas ya agendadas en Dentalink), crearán pacientes y
        agendarán directo en tu agenda. El token queda cifrado.
      </p>

      <label className="block text-sm">
        <span className="text-xs text-ink-muted">Token de la API {connected ? "(deja vacío para mantener el actual)" : ""}</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Token generado en Dentalink → Configuración API"
          className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm"
        />
      </label>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Desde (hora)</span>
          <input type="number" min={0} max={23} value={workStartHour} onChange={(e) => setWorkStartHour(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Hasta (hora)</span>
          <input type="number" min={1} max={24} value={workEndHour} onChange={(e) => setWorkEndHour(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-ink-muted">Bloques (min)</span>
          <input type="number" min={10} max={120} step={5} value={slotMinutes} onChange={(e) => setSlotMinutes(Number(e.target.value))} className="mt-1 w-full rounded-lg border border-line-strong px-3 py-2 text-sm" />
        </label>
      </div>
      <p className="mt-1 text-[10px] text-ink-subtle">
        La ventana laboral define qué huecos se ofrecen; las citas existentes en Dentalink se descuentan automáticamente.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={busy || (!connected && !token.trim())}>
          {connected ? "Guardar cambios" : "Conectar"}
        </Button>
        {connected && (
          <>
            <Button variant="secondary" onClick={() => void test()} disabled={busy}>Probar conexión</Button>
            <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>Desconectar</Button>
          </>
        )}
      </div>

      {testResult && (
        <p className={`mt-2 text-xs ${testResult.startsWith("✔") ? "text-emerald-600" : "text-red-600"} dark:text-emerald-400 dark:text-red-400`}>{testResult}</p>
      )}
      {state?.lastError && !testResult && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{state.lastError}</p>}
      {state?.lastSyncAt && (
        <p className="mt-2 text-[11px] text-ink-subtle">Última verificación: {new Date(state.lastSyncAt).toLocaleString("es-CL")}</p>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
        title="¿Desconectar Dentalink?"
        description="Los agentes dejarán de ver la disponibilidad de Dentalink y volverán a la agenda interna."
        confirmLabel="Desconectar"
        danger
      />
    </Drawer>
  );
}

// ------------------------------ HubSpot ------------------------------

export interface HubspotState {
  status: string;
  accountEmail: string | null;
  hubDomain: string | null;
  syncAuto: boolean;
  fieldMapping: Record<string, string> | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

const HUBSPOT_FIELD_OPTIONS: { value: string; label: string }[] = [
  { value: "firstName", label: "Nombre" },
  { value: "lastName", label: "Apellido" },
  { value: "email", label: "Email" },
  { value: "phone", label: "Teléfono" },
  { value: "country", label: "País" },
  { value: "source", label: "Origen (canal)" },
];

const HUBSPOT_DEFAULT_MAPPING: Record<string, string> = {
  firstname: "firstName",
  lastname: "lastName",
  email: "email",
  phone: "phone",
};

export function HubspotDrawer({
  open,
  onClose,
  state,
  platformReady,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  state: HubspotState | null;
  platformReady: boolean;
  onChanged: () => void;
}) {
  const toast = useToast();
  const connected = Boolean(state);
  const needsReauth = state?.status === "reauthorize";
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [syncAuto, setSyncAuto] = useState(true);
  const [mapping, setMapping] = useState<Record<string, string>>(HUBSPOT_DEFAULT_MAPPING);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTestResult(null);
    setSyncAuto(state?.syncAuto ?? true);
    setMapping(state?.fieldMapping && Object.keys(state.fieldMapping).length ? state.fieldMapping : HUBSPOT_DEFAULT_MAPPING);
  }, [open, state?.syncAuto, state?.fieldMapping]);

  async function startOAuth() {
    setBusy(true);
    try {
      const { url } = await api<{ url: string }>("/integrations/oauth/hubspot/authorize");
      // Ventana aparte: al terminar avisa por postMessage y se cierra sola.
      const popup = window.open(url, "tubot-oauth-hubspot", "popup=yes,width=560,height=720");
      if (!popup) window.location.href = url; // popup bloqueado → misma pestaña
      setBusy(false);
    } catch (err) {
      toast.push((err as Error).message, "error");
      setBusy(false);
    }
  }

  async function saveConfig() {
    setBusy(true);
    try {
      await api("/integrations/hubspot/config", {
        method: "PUT",
        body: JSON.stringify({ syncAuto, fieldMapping: mapping }),
      });
      toast.push("Configuración guardada ✔", "ok");
      onChanged();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setTestResult(null);
    try {
      const r = await api<{ ok: boolean; detail: string }>("/integrations/hubspot/test", { method: "POST" });
      setTestResult(r.detail);
      if (r.ok) onChanged();
    } catch (err) {
      setTestResult((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function syncAll() {
    setBusy(true);
    try {
      const r = await api<{ queued: number }>("/integrations/hubspot/sync-all", { method: "POST" });
      toast.push(`Backfill iniciado: ${r.queued} contacto(s) en cola (escalonados)`, "ok");
      onChanged();
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    await api("/integrations/hubspot", { method: "DELETE" });
    toast.push("HubSpot desconectado", "info");
    onChanged();
    onClose();
  }

  return (
    <Drawer open={open} onClose={onClose} title="HubSpot — sincronización de contactos">
      {!platformReady ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30">
          <p className="font-medium">Configuración de plataforma pendiente</p>
          <p className="mt-1 text-xs">
            Falta registrar la app OAuth de HubSpot a nivel plataforma (variables HUBSPOT_CLIENT_ID y
            HUBSPOT_CLIENT_SECRET). Sigue la guía <code>docs/GUIA_OAUTH_HUBSPOT.md</code> del repositorio y vuelve
            aquí.
          </p>
        </div>
      ) : (
        <>
          <p className="mb-3 text-xs text-ink-muted">
            Sincronización <b>unidireccional</b> Conversia → HubSpot: cada contacto nuevo o editado se refleja en tu
            CRM. Antes de crear se busca por teléfono/email — <b>sin duplicados</b>. Los tokens quedan cifrados.
          </p>

          {needsReauth && (
            <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300 dark:border-red-500/30">
              El acceso fue revocado o expiró: vuelve a conectar la cuenta para reanudar la sincronización.
            </div>
          )}

          {!connected || needsReauth ? (
            <Button onClick={() => void startOAuth()} disabled={busy}>
              {needsReauth ? "Volver a conectar con HubSpot" : "Conectar con HubSpot"}
            </Button>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-500/30">
                <span className="text-base">✅</span>
                <div>
                  <p className="font-medium">Cuenta de HubSpot conectada</p>
                  <p className="text-xs">
                    {state?.accountEmail ?? "cuenta autorizada"}
                    {state?.hubDomain ? ` · portal ${state.hubDomain}` : ""}
                  </p>
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={syncAuto} onChange={(e) => setSyncAuto(e.target.checked)} />
                Sincronizar automáticamente contactos nuevos y editados
              </label>

              <div className="rounded-xl border border-line p-3">
                <p className="text-sm font-medium">Mapeo de campos (HubSpot ← Conversia)</p>
                <div className="mt-2 space-y-1.5">
                  {Object.entries(mapping).map(([prop, field]) => (
                    <div key={prop} className="flex items-center gap-2 text-xs">
                      <code className="w-28 shrink-0 rounded bg-app px-1.5 py-1">{prop}</code>
                      <span className="text-ink-subtle">←</span>
                      <select
                        value={field}
                        onChange={(e) => setMapping({ ...mapping, [prop]: e.target.value })}
                        className="flex-1 rounded-lg border border-line-strong bg-panel px-2 py-1.5 text-xs"
                      >
                        {HUBSPOT_FIELD_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => {
                          const next = { ...mapping };
                          delete next[prop];
                          setMapping(next);
                        }}
                        className="text-ink-subtle hover:text-red-500"
                        title="Quitar"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <AddHubspotProperty existing={mapping} onAdd={(prop) => setMapping({ ...mapping, [prop]: "source" })} />
                <p className="mt-2 text-[10px] text-ink-subtle">
                  La clave es el nombre interno de la propiedad en HubSpot (p. ej. <code>firstname</code>,{" "}
                  <code>lead_source</code> si la creaste como personalizada).
                </p>
              </div>

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void saveConfig()} disabled={busy || Object.keys(mapping).length === 0}>Guardar</Button>
                <Button variant="secondary" onClick={() => void test()} disabled={busy}>Probar conexión</Button>
                <Button variant="secondary" onClick={() => void syncAll()} disabled={busy}>Sincronizar contactos existentes</Button>
                <Button variant="ghost" onClick={() => setConfirmDisconnect(true)}>Desconectar</Button>
              </div>
              {testResult && (
                <p className={`text-xs ${testResult.startsWith("✔") ? "text-emerald-600" : "text-red-600"} dark:text-emerald-400 dark:text-red-400`}>{testResult}</p>
              )}
              {state?.lastSyncAt && (
                <p className="text-[11px] text-ink-subtle">Última sincronización: {new Date(state.lastSyncAt).toLocaleString("es-CL")}</p>
              )}
              {state?.lastError && <p className="text-[11px] text-red-600 dark:text-red-400">{state.lastError}</p>}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
        title="¿Desconectar HubSpot?"
        description="Se dejará de sincronizar contactos hacia tu CRM. Los contactos ya creados en HubSpot no se tocan."
        confirmLabel="Desconectar"
        danger
      />
    </Drawer>
  );
}

function AddHubspotProperty({ existing, onAdd }: { existing: Record<string, string>; onAdd: (prop: string) => void }) {
  const [prop, setProp] = useState("");
  const normalized = prop.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return (
    <div className="mt-2 flex items-center gap-2">
      <input
        value={prop}
        onChange={(e) => setProp(e.target.value)}
        placeholder="agregar propiedad de HubSpot…"
        className="flex-1 rounded-lg border border-line-strong px-2 py-1.5 text-xs"
      />
      <Button
        variant="ghost"
        onClick={() => {
          if (normalized && !existing[normalized]) onAdd(normalized);
          setProp("");
        }}
        disabled={!normalized || Boolean(existing[normalized])}
      >
        <Plus size={13} /> Añadir
      </Button>
    </div>
  );
}
