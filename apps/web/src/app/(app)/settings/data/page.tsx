"use client";

/** Retención y privacidad: cuánto se conservan los datos + derechos del titular. */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Skeleton, useToast } from "@/components/ui";

interface DataPolicy {
  conversationsMonths: number;
  transcriptionsMonths: number;
  lastPurgeAt: string | null;
}

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

const OPTIONS = [
  { v: 0, label: "Indefinido (no se borran)" },
  { v: 6, label: "6 meses" },
  { v: 12, label: "1 año" },
  { v: 24, label: "2 años" },
];

export default function DataSettingsPage() {
  const toast = useToast();
  const [policy, setPolicy] = useState<DataPolicy | null>(null);
  const [assisted, setAssisted] = useState<AssistedStatus | null>(null);
  const [channels, setChannels] = useState<AssistedChannel[]>([]);
  const [channelId, setChannelId] = useState<string>("");
  const [code, setCode] = useState<AssistedCode | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<DataPolicy>("/settings/data").then(setPolicy).catch((e) => toast.push((e as Error).message, "error"));
    void api<AssistedStatus>("/assisted-setup/status").then(setAssisted).catch(() => setAssisted(null));
    void api<AssistedChannel[]>("/assisted-setup/channels").then(setChannels).catch(() => setChannels([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function authorizeAssisted() {
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
  async function revokeAssisted() {
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

  async function save(patch: Partial<DataPolicy>) {
    if (!policy) return;
    // Advertencia clara al REDUCIR la retención (implica borrar datos).
    const reducing =
      (patch.conversationsMonths !== undefined && policy.conversationsMonths === 0 && patch.conversationsMonths > 0) ||
      (patch.conversationsMonths !== undefined && policy.conversationsMonths > 0 && patch.conversationsMonths < policy.conversationsMonths) ||
      (patch.transcriptionsMonths !== undefined && policy.transcriptionsMonths === 0 && patch.transcriptionsMonths > 0) ||
      (patch.transcriptionsMonths !== undefined && policy.transcriptionsMonths > 0 && patch.transcriptionsMonths < policy.transcriptionsMonths);
    if (reducing && !confirm("Reducir la retención BORRA de forma permanente los datos más antiguos que el nuevo plazo, en la próxima purga (diaria). Esta acción no se puede deshacer. ¿Continuar?")) {
      return;
    }
    setBusy(true);
    try {
      await api("/settings/data", { method: "PUT", body: JSON.stringify(patch) });
      setPolicy({ ...policy, ...patch });
      toast.push("Política de retención guardada ✔", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!policy) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-64" /></div>;
  const sel = "mt-1 w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm";

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h2 className="text-lg font-semibold">Retención y privacidad</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Define cuánto tiempo conservas los datos. El default es <b>indefinido</b> (no se borra nada). Reducir el plazo
        borra de forma permanente lo más antiguo en la purga diaria.
      </p>

      <div className="mt-4 space-y-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <label className="block text-sm">
          <span className="font-medium">Conservar conversaciones y mensajes</span>
          <select className={sel} value={policy.conversationsMonths} disabled={busy} onChange={(e) => void save({ conversationsMonths: Number(e.target.value) })}>
            {OPTIONS.map((o) => (<option key={o.v} value={o.v}>{o.label}</option>))}
          </select>
          <span className="mt-1 block text-[11px] text-ink-subtle">Las conversaciones más antiguas se eliminan por completo (con sus mensajes y adjuntos). El contacto se conserva.</span>
        </label>

        <label className="block text-sm">
          <span className="font-medium">Conservar transcripciones de audio</span>
          <select className={sel} value={policy.transcriptionsMonths} disabled={busy} onChange={(e) => void save({ transcriptionsMonths: Number(e.target.value) })}>
            {OPTIONS.map((o) => (<option key={o.v} value={o.v}>{o.label}</option>))}
          </select>
          <span className="mt-1 block text-[11px] text-ink-subtle">Se borra solo el texto transcrito de los audios antiguos; el mensaje se conserva.</span>
        </label>

        {policy.lastPurgeAt && (
          <p className="text-[11px] text-ink-subtle">Última purga aplicada: {new Date(policy.lastPurgeAt).toLocaleString("es-CL")}.</p>
        )}
      </div>

      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <p className="text-sm font-medium">Derechos del titular</p>
        <p className="mt-1 text-xs text-ink-muted">
          Para responder solicitudes de acceso o borrado de una persona, ve a <b>Contactos</b>, abre su ficha y usa
          <b> «Exportar datos»</b> o <b>«Eliminar datos del titular»</b>. El borrado anonimiza la ficha (no rompe reportes
          ni facturación) y queda registrado en Auditoría.
        </p>
      </div>

      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <p className="text-sm font-medium">Montaje asistido de TuBot</p>
        <p className="mt-1 text-xs text-ink-muted">
          Permite que TuBot configure tu cuenta por ti durante la implementación —agentes, flujos, servicios y base de
          conocimiento—. <b>Nunca</b> accede a tus conversaciones ni contactos, ni envía mensajes por ti. Todo queda en
          Auditoría y puedes revocarlo cuando quieras. La autorización dura 14 días.
        </p>

        {channels.length > 0 && (
          <label className="mt-3 block text-sm">
            <span className="font-medium">Canal a configurar</span>
            <select className={sel} value={channelId} disabled={busy} onChange={(e) => setChannelId(e.target.value)}>
              <option value="">Todos mis canales</option>
              {channels.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
            </select>
            <span className="mt-1 block text-[11px] text-ink-subtle">Elige el canal que quieres que TuBot configure. El asistente solo podrá tocar ese canal.</span>
          </label>
        )}

        {assisted?.authorized ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
              ● Autorizado{assisted.expiresAt ? ` · hasta ${new Date(assisted.expiresAt).toLocaleDateString("es-CL")}` : ""}
            </span>
            <Button disabled={busy} onClick={() => void authorizeAssisted()}>Generar código nuevo</Button>
            <button
              disabled={busy}
              onClick={() => void revokeAssisted()}
              className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              Revocar
            </button>
          </div>
        ) : (
          <div className="mt-3">
            <Button disabled={busy} onClick={() => void authorizeAssisted()}>Autorizar y generar código</Button>
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
