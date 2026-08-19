"use client";

/** Conexión de un catálogo de e-commerce (WooCommerce). Guarda credenciales cifradas,
 * prueba la conexión (muestra cuántos productos ve) y dispara la sincronización. */
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Drawer, useToast } from "@/components/ui";

interface CatalogStatus {
  connections: Array<{ source: string; status: string; baseUrl: string | null; lastSyncAt: string | null; lastError: string | null }>;
  lastRuns: Array<{ source: string; status: string; created: number; updated: number; deactivated: number; failed: number; startedAt: string; finishedAt: string | null }>;
  totalItems: number;
}

const HELP: Record<string, { title: string; steps: string[] }> = {
  woocommerce: {
    title: "WooCommerce",
    steps: [
      "En tu WordPress: WooCommerce → Ajustes → Avanzado → REST API.",
      "«Crear una clave de API», permisos de LECTURA. Copia la Clave y el Secreto.",
      "Pega aquí la URL de tu tienda + la clave y el secreto.",
    ],
  },
};

export function CatalogDrawer({ open, onClose, source, onChanged }: { open: boolean; onClose: () => void; source: string; onChanged: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; count?: number | null; error?: string } | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await api<CatalogStatus>("/integrations/catalog/status")); } catch { setStatus(null); }
  }, []);
  useEffect(() => { if (open) { void load(); setTestResult(null); } }, [open, load]);

  const conn = status?.connections.find((c) => c.source === source);
  const help = HELP[source] ?? { title: source, steps: [] };
  const input = "mt-1 w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm";

  async function test() {
    setTesting(true); setTestResult(null);
    try {
      setTestResult(await api("/integrations/catalog/test", { method: "POST", body: JSON.stringify({ source, baseUrl, consumerKey, consumerSecret }) }));
    } catch (e) { setTestResult({ ok: false, error: (e as Error).message }); } finally { setTesting(false); }
  }
  async function connect() {
    setSaving(true);
    try {
      await api("/integrations/catalog/connect", { method: "POST", body: JSON.stringify({ source, baseUrl, consumerKey, consumerSecret }) });
      toast.push("Conectado ✔ — sincronizando tu catálogo…", "ok");
      setConsumerKey(""); setConsumerSecret("");
      onChanged(); await load();
    } catch (e) { toast.push((e as Error).message, "error"); } finally { setSaving(false); }
  }
  async function syncNow() {
    try { await api("/integrations/catalog/sync", { method: "POST", body: JSON.stringify({ source }) }); toast.push("Sincronizando…", "ok"); setTimeout(() => void load(), 1500); }
    catch (e) { toast.push((e as Error).message, "error"); }
  }

  return (
    <Drawer open={open} onClose={onClose} title={`Conectar ${help.title}`}>
      {conn && (
        <div className="mb-4 rounded-lg border border-line bg-app p-3 text-xs">
          <p className="font-medium">Estado: <span className={conn.status === "active" ? "text-emerald-600" : "text-red-600"}>{conn.status === "active" ? "conectado" : "con error"}</span></p>
          <p className="mt-0.5 text-ink-muted">{conn.baseUrl}</p>
          <p className="mt-0.5 text-ink-subtle">{status?.totalItems ?? 0} productos en el catálogo · última sync {conn.lastSyncAt ? new Date(conn.lastSyncAt).toLocaleString("es-CL") : "—"}</p>
          {conn.lastError && <p className="mt-1 text-red-600">{conn.lastError}</p>}
          {status?.lastRuns[0] && <p className="mt-1 text-ink-subtle">Última corrida: {status.lastRuns[0].created} nuevos, {status.lastRuns[0].updated} actualizados, {status.lastRuns[0].deactivated} sin stock{status.lastRuns[0].failed ? `, ${status.lastRuns[0].failed} con error` : ""}.</p>}
          <Button className="mt-2" variant="secondary" onClick={() => void syncNow()}>Sincronizar ahora</Button>
        </div>
      )}

      <div className="rounded-lg border border-line bg-app p-3 text-xs text-ink-muted">
        <p className="font-medium text-ink">Cómo obtener tus credenciales</p>
        <ol className="mt-1 list-decimal space-y-0.5 pl-4">{help.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      </div>

      <label className="mt-4 block text-sm">URL de tu tienda
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://mitienda.cl" className={input} />
      </label>
      <label className="mt-3 block text-sm">Consumer Key
        <input value={consumerKey} onChange={(e) => setConsumerKey(e.target.value)} placeholder="ck_…" className={input} autoComplete="off" />
      </label>
      <label className="mt-3 block text-sm">Consumer Secret
        <input type="password" value={consumerSecret} onChange={(e) => setConsumerSecret(e.target.value)} placeholder="cs_…" className={input} autoComplete="off" />
      </label>

      {testResult && (
        <p className={`mt-3 text-sm ${testResult.ok ? "text-emerald-600" : "text-red-600"}`}>
          {testResult.ok ? `✔ Conexión OK — veo ${testResult.count ?? "varios"} productos.` : `✖ ${testResult.error ?? "No se pudo conectar"}`}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button variant="secondary" disabled={testing || !baseUrl || !consumerKey || !consumerSecret} onClick={() => void test()}>{testing ? "Probando…" : "Probar conexión"}</Button>
        <Button disabled={saving || !baseUrl || !consumerKey || !consumerSecret} onClick={() => void connect()}>{saving ? "Conectando…" : "Conectar y sincronizar"}</Button>
      </div>
      <p className="mt-2 text-[11px] text-ink-subtle">Guardamos las credenciales cifradas. Solo LEEMOS tu catálogo; nunca modificamos tu tienda.</p>
    </Drawer>
  );
}
