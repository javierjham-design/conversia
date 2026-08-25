"use client";

/**
 * Montaje asistido de TuBot — página PROPIA en Configuración → Datos, tal como
 * lo instruye el bot de implementación («Configuración → Datos → Montaje
 * asistido de TuBot»). Antes vivía escondido dentro de Retención y privacidad.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Select, Skeleton, useToast } from "@/components/ui";

interface AssistedStatus {
  authorized: boolean;
  status: string | null;
  expiresAt: string | null;
  scopes: string[];
}

interface AssistedChannel {
  id: string;
  name: string;
  type: string;
}

interface AssistedCode {
  code: string;
  codeExpiresAt: string;
  channelName: string | null;
}

export default function AssistedSetupPage() {
  const toast = useToast();
  const [assisted, setAssisted] = useState<AssistedStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [channels, setChannels] = useState<AssistedChannel[]>([]);
  const [channelId, setChannelId] = useState<string>("");
  const [code, setCode] = useState<AssistedCode | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<AssistedStatus>("/assisted-setup/status")
      .then(setAssisted)
      .catch(() => setAssisted(null))
      .finally(() => setLoaded(true));
    void api<AssistedChannel[]>("/assisted-setup/channels").then(setChannels).catch(() => setChannels([]));
  }, []);

  async function authorize() {
    if (!confirm("Autorizas a TuBot a configurar tu cuenta (agentes, flujos, servicios y base de conocimiento) durante la implementación. NUNCA accede a tus conversaciones ni contactos, ni envía mensajes por ti. Puedes revocarlo cuando quieras. La autorización dura 14 días.")) return;
    setBusy(true);
    try {
      const r = await api<{ expiresAt: string; code: string; codeExpiresAt: string; channelName: string | null }>(
        "/assisted-setup/authorize",
        { method: "POST", body: JSON.stringify(channelId ? { channelId } : {}) },
      );
      setAssisted({ authorized: true, status: "active", expiresAt: r.expiresAt, scopes: ["agents", "flows", "services", "knowledge"] });
      setCode({ code: r.code, codeExpiresAt: r.codeExpiresAt, channelName: r.channelName });
      toast.push("Montaje asistido autorizado ✔ — dale el código al asistente", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await api("/assisted-setup/revoke", { method: "POST" });
      setAssisted({ authorized: false, status: "revoked", expiresAt: null, scopes: [] });
      setCode(null);
      toast.push("Montaje asistido revocado", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-64" /></div>;

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Montaje asistido de TuBot</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Permite que TuBot configure tu cuenta por ti durante la implementación —agentes, flujos, servicios y base de
        conocimiento—. <b>Nunca</b> accede a tus conversaciones ni contactos, ni envía mensajes por ti. Todo queda en
        Auditoría y puedes revocarlo cuando quieras. La autorización dura 14 días.
      </p>

      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        {channels.length > 0 && (
          <label className="block text-sm">
            <span className="font-medium">Canal a configurar</span>
            <Select className="mt-1 w-full" value={channelId} disabled={busy} onChange={(e) => setChannelId(e.target.value)}>
              <option value="">Todos mis canales</option>
              {channels.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
            </Select>
            <span className="mt-1 block text-[11px] text-ink-subtle">Elige el canal que quieres que TuBot configure. El asistente solo podrá tocar ese canal.</span>
          </label>
        )}

        {assisted?.authorized ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
              ● Autorizado{assisted.expiresAt ? ` · hasta ${new Date(assisted.expiresAt).toLocaleDateString("es-CL")}` : ""}
            </span>
            <Button disabled={busy} onClick={() => void authorize()}>Generar código nuevo</Button>
            <button
              disabled={busy}
              onClick={() => void revoke()}
              className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              Revocar
            </button>
          </div>
        ) : (
          <div className="mt-3">
            <Button disabled={busy} onClick={() => void authorize()}>Autorizar y generar código</Button>
          </div>
        )}

        {code && (
          <div className="mt-4 rounded-card border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-500/40 dark:bg-emerald-500/10">
            <p className="text-xs text-ink-muted">
              Dicta este código al asistente de TuBot en el chat para vincular tu cuenta
              {code.channelName ? <> (canal <b>{code.channelName}</b>)</> : null}:
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <code className="select-all rounded-lg bg-panel px-3 py-2 text-lg font-bold tracking-widest">{code.code}</code>
              <button
                onClick={() => { void navigator.clipboard?.writeText(code.code); toast.push("Código copiado", "ok"); }}
                className="rounded-lg border border-line-strong px-3 py-1.5 text-sm hover:bg-panel-muted"
              >
                Copiar
              </button>
            </div>
            <p className="mt-2 text-[11px] text-ink-subtle">
              Vence a las {new Date(code.codeExpiresAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}. Es de un solo uso.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
