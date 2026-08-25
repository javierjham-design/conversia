"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Checkbox } from "@/components/ui";

// Herramientas de desarrollador del tenant: webhooks ENTRANTES (Make/Zapier/
// landings → Conversia, disparan el trigger "Webhook entrante" de workflows) y
// API keys de la API pública. Los secretos se muestran UNA sola vez.

interface InboundWebhook {
  id: string;
  name: string;
  url: string;
  hasSecret: boolean;
  active: boolean;
  lastReceivedAt: string | null;
}
interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
}

function fmt(d: string | null): string {
  return d ? new Date(d).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" }) : "—";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded border border-line-strong px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-app"
    >
      {copied ? "✔ copiado" : "Copiar"}
    </button>
  );
}

export default function DevelopersPage() {
  const [hooks, setHooks] = useState<InboundWebhook[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [newHookName, setNewHookName] = useState("");
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>(["contacts:read"]);
  const [createdSecret, setCreatedSecret] = useState<{ kind: "hook" | "key"; label: string; secret: string; url?: string } | null>(null);

  const load = useCallback(async () => {
    const [h, k] = await Promise.all([
      api<InboundWebhook[]>("/integrations/developers/inbound-webhooks"),
      api<ApiKey[]>("/integrations/developers/api-keys"),
    ]);
    setHooks(h);
    setKeys(k);
  }, []);

  useEffect(() => {
    void load().catch((e) => setMsg((e as Error).message));
  }, [load]);

  async function createHook(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api<{ name: string; url: string; secret: string | null }>("/integrations/developers/inbound-webhooks", {
        method: "POST",
        body: JSON.stringify({ name: newHookName.trim() }),
      });
      setCreatedSecret(r.secret ? { kind: "hook", label: r.name, secret: r.secret, url: r.url } : null);
      setNewHookName("");
      await load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  async function toggleHook(h: InboundWebhook) {
    await api(`/integrations/developers/inbound-webhooks/${h.id}`, { method: "PATCH", body: JSON.stringify({ active: !h.active }) });
    await load();
  }

  async function deleteHook(id: string) {
    if (!window.confirm("¿Eliminar este webhook? Los sistemas que lo usan dejarán de poder disparar flujos.")) return;
    await api(`/integrations/developers/inbound-webhooks/${id}`, { method: "DELETE" });
    await load();
  }

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const r = await api<{ name: string; secret: string }>("/integrations/developers/api-keys", {
        method: "POST",
        body: JSON.stringify({ name: newKeyName.trim(), scopes: newKeyScopes }),
      });
      setCreatedSecret({ kind: "key", label: r.name, secret: r.secret });
      setNewKeyName("");
      await load();
    } catch (err) {
      setMsg((err as Error).message);
    }
  }

  async function revokeKey(id: string) {
    if (!window.confirm("¿Revocar esta API key? Las integraciones que la usan dejarán de funcionar de inmediato.")) return;
    await api(`/integrations/developers/api-keys/${id}/revoke`, { method: "POST" });
    await load();
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Desarrolladores</h1>
          <p className="text-sm text-ink-muted">Webhooks entrantes y API de Conversia — conecta tus sistemas externos.</p>
        </div>
        <a href="/integrations" className="rounded-lg border border-line-strong px-3 py-1.5 text-sm text-ink-muted hover:bg-app">← Integraciones</a>
      </div>

      {msg && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{msg}</p>}

      {createdSecret && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:bg-amber-500/10 dark:border-amber-500/30">
          <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
            {createdSecret.kind === "hook" ? "Webhook creado" : "API key creada"}: {createdSecret.label} — el secreto se muestra <b>una sola vez</b>
          </p>
          {createdSecret.url && (
            <p className="mt-1 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
              URL: <code className="rounded bg-panel px-1.5 py-0.5">{createdSecret.url}</code> <CopyButton text={createdSecret.url} />
            </p>
          )}
          <p className="mt-1 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
            Secreto: <code className="rounded bg-panel px-1.5 py-0.5">{createdSecret.secret}</code> <CopyButton text={createdSecret.secret} />
          </p>
          <button onClick={() => setCreatedSecret(null)} className="mt-2 text-xs text-amber-700 underline dark:text-amber-300">Entendido, lo guardé</button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---------------- Webhooks entrantes ---------------- */}
        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="font-medium">Webhooks entrantes</h2>
          <p className="mb-3 text-xs text-ink-muted">
            URL única que dispara tus flujos con el trigger <b>«Webhook entrante»</b>. El cuerpo JSON queda disponible como
            variables (<code>{"{{webhook.campo}}"}</code>). Ideal para Make, Zapier o formularios de tu sitio.
          </p>
          <form onSubmit={createHook} className="mb-3 flex gap-2">
            <input value={newHookName} onChange={(e) => setNewHookName(e.target.value)} required minLength={2} placeholder="Nombre (p. ej. Landing implantes)" className="flex-1 rounded-lg border border-line-strong px-3 py-1.5 text-sm" />
            <button type="submit" className="rounded-lg bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800">Crear</button>
          </form>
          <ul className="space-y-2">
            {hooks.map((h) => (
              <li key={h.id} className="rounded-lg border border-line p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{h.name}{" "}
                    <span className={`text-[10px] ${h.active ? "text-emerald-600" : "text-ink-subtle"} dark:text-emerald-400`}>{h.active ? "● activo" : "○ pausado"}</span>
                  </p>
                  <div className="flex gap-2 text-xs">
                    <button onClick={() => void toggleHook(h)} className="text-ink-muted hover:underline">{h.active ? "Pausar" : "Activar"}</button>
                    <button onClick={() => void deleteHook(h.id)} className="text-red-400 hover:underline">Eliminar</button>
                  </div>
                </div>
                <p className="mt-1 flex items-center gap-2 text-[11px] text-ink-muted">
                  <code className="max-w-[260px] truncate rounded bg-app px-1.5 py-0.5">{h.url}</code>
                  <CopyButton text={h.url} />
                </p>
                <p className="mt-0.5 text-[10px] text-ink-subtle">
                  {h.hasSecret ? "Firmado (X-Conversia-Signature)" : "Sin firma"} · último recibido: {fmt(h.lastReceivedAt)}
                </p>
              </li>
            ))}
            {hooks.length === 0 && <p className="text-xs text-ink-subtle">Sin webhooks entrantes aún.</p>}
          </ul>
        </section>

        {/* ---------------- API keys ---------------- */}
        <section className="rounded-xl border border-line bg-panel p-4">
          <h2 className="font-medium">API keys</h2>
          <p className="mb-3 text-xs text-ink-muted">
            Para que tus sistemas consulten o creen contactos vía la API pública. El secreto se muestra una sola vez.
          </p>
          <form onSubmit={createKey} className="mb-3 space-y-2">
            <div className="flex gap-2">
              <input value={newKeyName} onChange={(e) => setNewKeyName(e.target.value)} required minLength={2} placeholder="Nombre (p. ej. CRM interno)" className="flex-1 rounded-lg border border-line-strong px-3 py-1.5 text-sm" />
              <button type="submit" className="rounded-lg bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800">Crear</button>
            </div>
            <div className="flex gap-4 text-xs text-ink-muted">
              {["contacts:read", "contacts:write"].map((s) => (
                <label key={s} className="flex items-center gap-1.5">
                  <Checkbox
                    checked={newKeyScopes.includes(s)}
                    onChange={() => setNewKeyScopes((p) => (p.includes(s) ? p.filter((x) => x !== s) : [...p, s]))}
                  />
                  <code>{s}</code>
                </label>
              ))}
            </div>
          </form>
          <ul className="space-y-2">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between rounded-lg border border-line p-2.5">
                <div>
                  <p className="text-sm font-medium">
                    {k.name}{" "}
                    {k.revokedAt && <span className="text-[10px] text-red-500">revocada</span>}
                  </p>
                  <p className="text-[10px] text-ink-subtle">
                    <code>{k.prefix}…</code> · {(k.scopes ?? []).join(", ")} · último uso: {fmt(k.lastUsedAt)}
                  </p>
                </div>
                {!k.revokedAt && (
                  <button onClick={() => void revokeKey(k.id)} className="text-xs text-red-400 hover:underline">Revocar</button>
                )}
              </li>
            ))}
            {keys.length === 0 && <p className="text-xs text-ink-subtle">Sin API keys aún.</p>}
          </ul>
        </section>
      </div>

      {/* ---------------- Documentación ---------------- */}
      <section className="mt-6 rounded-xl border border-line bg-panel p-4">
        <h2 className="font-medium">Documentación rápida</h2>
        <div className="mt-2 grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium text-ink">Webhook entrante → disparar un flujo</h3>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">{`POST {tu URL de webhook}
Content-Type: application/json
X-Conversia-Signature: sha256=HMAC_SHA256(secreto, cuerpo)

{ "nombre": "María", "interes": "implantes" }

→ dispara los flujos con trigger «Webhook entrante»;
  en el flujo: {{webhook.nombre}}, {{webhook.interes}}`}</pre>
          </div>
          <div>
            <h3 className="text-sm font-medium text-ink">API pública v1 (Authorization: Bearer cnvk_…)</h3>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">{`GET  /public/v1/contacts?q=maria&page=1   (contacts:read)
POST /public/v1/contacts                   (contacts:write)
     { "phone": "+56 9 1234 5678",
       "firstName": "María", "tags": ["landing"] }

→ dedupe por teléfono E.164; rellena solo campos vacíos.`}</pre>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-ink-subtle">
          Base de la API: la misma URL del panel (vía «/backend») o la URL directa de la API. Los workflows que hacen
          peticiones HACIA afuera usan el paso «Petición HTTP» — esto es la dirección contraria.
        </p>
      </section>

      {/* ---------------- Contrato estándar de agenda ---------------- */}
      <section id="agenda" className="mt-6 rounded-xl border border-line bg-panel p-4">
        <h2 className="font-medium">Contrato estándar de agenda (Agenda personalizada)</h2>
        <p className="mt-1 text-xs text-ink-muted">
          Implementa estos endpoints en tu sistema y conéctalo en Integraciones → <b>Agenda personalizada</b>: los agentes
          IA y los workflows agendarán contra tu software sin código adicional. Todas las peticiones van firmadas; verifica
          la firma antes de responder. Timeout: 8 segundos.
        </p>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="text-sm font-medium text-ink">Endpoints requeridos</h3>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">{`GET    /professionals                → [{id, name, specialty?}]
GET    /services                     → [{id, name, durationMin, price?}]
GET    /availability?professionalId=&serviceId=&from=YYYY-MM-DD&to=
       → [{start, end, professionalId, clinicId}]  (ISO 8601 con zona)
POST   /appointments                 {clinicId, professionalId, serviceId?,
       patient:{firstName, phone}, start, end, notes?} → {id, status, ...}
PATCH  /appointments/:id             {start?, end?} → cita reprogramada
POST   /appointments/:id/cancel      {reason?}
POST   /appointments/:id/confirm
GET    /appointments/:id
GET    /patients/:phone/appointments → citas del paciente
PUT    /patients                     {firstName, phone, ...} → alta/actualización
POST   /appointments/:id/attendance  {attended: true|false}

Opcional: GET /clinics → [{id, name, timezone}] (si tienes varias sedes)`}</pre>
          </div>
          <div>
            <h3 className="text-sm font-medium text-ink">Firma HMAC (verifícala en cada petición)</h3>
            <pre className="mt-1 overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">{`Headers que enviamos:
  X-Conversia-Timestamp: 1785600000        (unix, rechaza si |ahora-ts| > 300s)
  X-Conversia-Signature: sha256=HEX

Cálculo:
  base = timestamp + "." + METODO + "." + ruta_con_query + "." + cuerpo_json
  firma = HMAC_SHA256(secreto_compartido, base) en hexadecimal

Ejemplo (verificación en Node):
  const base = ts + "." + req.method + "." + req.originalUrl + "." + rawBody;
  const esperado = "sha256=" + crypto.createHmac("sha256", SECRETO)
      .update(base).digest("hex");
  if (esperado !== req.headers["x-conversia-signature"]) return res.status(401).end();

Prueba con curl (GET, cuerpo vacío):
  TS=$(date +%s)
  SIG=$(printf "%s.GET./professionals." "$TS" | openssl dgst -sha256 -hmac "TU_SECRETO" -hex | sed "s/^.*= /sha256=/")
  curl -H "X-Conversia-Timestamp: $TS" -H "X-Conversia-Signature: $SIG" https://agenda.tuclinica.cl/conversia/professionals`}</pre>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-ink-subtle">
          «Probar conexión» valida profesionales + disponibilidad de ejemplo. Los estados de cita esperados:
          pending · confirmed · cancelled · rescheduled · completed · no_show.
        </p>
      </section>
    </div>
  );
}
