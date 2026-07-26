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
            <p className="text-sm text-slate-500">Recibe eventos de Conversia en tus sistemas, firmados y con reintentos.</p>
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
