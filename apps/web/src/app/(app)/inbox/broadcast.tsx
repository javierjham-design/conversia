"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Megaphone, Users } from "lucide-react";
import { api } from "@/lib/api";
import { Button, Checkbox, Modal, Select, cn, useToast } from "@/components/ui";
import { guessField, parseSpreadsheetFile } from "../contacts/contact-csv";

interface BroadcastMeta {
  entitlement: { planAllows: boolean; switchOn: boolean; enabled: boolean };
  walletBalance: number;
  channels: { id: string; name: string }[];
  groups: { id: string; name: string; color: string | null; count: number }[];
  templates: { id: string; name: string; language: string; category: string; bodyText: string }[];
}

interface BroadcastRow {
  id: string;
  name: string;
  templateName: string;
  status: string;
  total: number;
  sent: number;
  failed: number;
  createdAt: string;
}

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: "Borrador", cls: "bg-app text-ink-muted" },
  QUEUED: { label: "En cola", cls: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" },
  SENDING: { label: "Enviando", cls: "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300" },
  COMPLETED: { label: "Completada", cls: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" },
  CANCELED: { label: "Cancelada", cls: "bg-app text-ink-muted" },
  FAILED: { label: "Con errores", cls: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300" },
};

/** Parsea texto pegado: una línea por contacto, "telefono" o "telefono,nombre". */
function parsePastedContacts(text: string): { phone: string; firstName?: string }[] {
  const out: { phone: string; firstName?: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const [rawPhone, ...rest] = t.split(/[,;\t]/);
    const digits = (rawPhone ?? "").replace(/[^\d]/g, "");
    if (digits.length < 8) continue;
    out.push({ phone: `+${digits}`, firstName: rest.join(" ").trim() || undefined });
  }
  // Dedupe por teléfono.
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.phone) ? false : (seen.add(c.phone), true)));
}

export function BroadcastModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [meta, setMeta] = useState<BroadcastMeta | null>(null);
  const [history, setHistory] = useState<BroadcastRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set());
  const [pasted, setPasted] = useState("");
  const [newGroupId, setNewGroupId] = useState(""); // grupo para los contactos nuevos
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ total: number; insufficientWallet: boolean } | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      api<BroadcastMeta>("/broadcasts/meta"),
      api<BroadcastRow[]>("/broadcasts").catch(() => [] as BroadcastRow[]),
    ])
      .then(([m, h]) => { setMeta(m); setHistory(h); })
      .catch((e) => toast.push(e.message ?? "No se pudo cargar", "error"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) {
      load();
      setName(""); setTemplateId(""); setChannelId(""); setGroupIds(new Set()); setPasted(""); setNewGroupId(""); setDone(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Sondeo del historial mientras haya difusiones en curso.
  useEffect(() => {
    if (!open) return;
    const active = history.some((h) => h.status === "SENDING" || h.status === "QUEUED");
    if (!active) return;
    const t = setInterval(() => { void api<BroadcastRow[]>("/broadcasts").then(setHistory).catch(() => undefined); }, 3000);
    return () => clearInterval(t);
  }, [open, history]);

  const template = useMemo(() => meta?.templates.find((t) => t.id === templateId) ?? null, [meta, templateId]);
  const newContacts = useMemo(() => parsePastedContacts(pasted), [pasted]);
  const audienceCount = useMemo(() => {
    const fromGroups = meta ? meta.groups.filter((g) => groupIds.has(g.id)).reduce((s, g) => s + g.count, 0) : 0;
    return fromGroups + newContacts.length; // aprox (puede haber solape con grupos)
  }, [meta, groupIds, newContacts]);

  async function onFile(file: File) {
    try {
      const { headers, rows } = await parseSpreadsheetFile(file);
      let phoneIdx = headers.findIndex((h) => guessField(h) === "phone");
      let nameIdx = headers.findIndex((h) => guessField(h) === "firstName");
      if (phoneIdx < 0) phoneIdx = 0; // sin cabecera reconocida → primera columna
      const lines = rows
        .map((r) => {
          const phone = (r[phoneIdx] ?? "").trim();
          const nm = nameIdx >= 0 ? (r[nameIdx] ?? "").trim() : "";
          return phone ? (nm ? `${phone},${nm}` : phone) : "";
        })
        .filter(Boolean);
      setPasted((prev) => (prev ? prev + "\n" : "") + lines.join("\n"));
      toast.push(`${lines.length} contacto(s) leídos del archivo`, "ok");
    } catch (e: any) {
      toast.push(e?.message ?? "No pudimos leer el archivo", "error");
    }
  }

  const canSend = !!template && !!name.trim() && (groupIds.size > 0 || newContacts.length > 0) && !busy;

  async function send() {
    if (!template) return;
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; total: number; insufficientWallet: boolean }>("/broadcasts", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          templateId: template.id,
          channelId: channelId || undefined,
          audience: {
            groupIds: [...groupIds],
            contacts: newContacts.length ? newContacts : undefined,
            newContactsGroupId: newGroupId || undefined,
          },
        }),
      });
      setDone({ total: r.total, insufficientWallet: r.insufficientWallet });
      load();
    } catch (e: any) {
      toast.push(e.message ?? "No se pudo crear la difusión", "error");
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    try {
      await api(`/broadcasts/${id}/cancel`, { method: "POST" });
      void api<BroadcastRow[]>("/broadcasts").then(setHistory).catch(() => undefined);
    } catch (e: any) {
      toast.push(e.message ?? "No se pudo cancelar", "error");
    }
  }

  const blocked = meta && !meta.entitlement.enabled;

  return (
    <Modal open={open} onClose={onClose} title="Difusión — envío masivo por plantilla" wide>
      {loading ? (
        <p className="py-10 text-center text-sm text-ink-subtle">Cargando…</p>
      ) : done ? (
        <div className="space-y-4 py-4 text-center">
          <CheckCircle2 size={40} className="mx-auto text-emerald-500" />
          <p className="text-lg font-semibold text-ink">Difusión encolada</p>
          <p className="text-sm text-ink-muted">Se enviará la plantilla a <b>{done.total}</b> contacto(s). Puedes seguir el avance en la lista de difusiones.</p>
          {done.insufficientWallet && (
            <p className="mx-auto max-w-md rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-sm text-amber-700 dark:border-amber-500/30 dark:text-amber-300">
              <AlertTriangle size={14} className="mr-1 inline" />
              Tu bolsa de mensajes podría no alcanzar para todos. Los que excedan el saldo quedarán marcados como no enviados hasta recargar.
            </p>
          )}
          <div className="flex justify-center gap-2">
            <Button variant="secondary" onClick={() => setDone(null)}>Nueva difusión</Button>
            <Button onClick={onClose}>Listo</Button>
          </div>
        </div>
      ) : blocked ? (
        <div className="space-y-3 py-6 text-center">
          <AlertTriangle size={36} className="mx-auto text-amber-500" />
          <p className="text-base font-semibold text-ink">Las plantillas de WhatsApp no están habilitadas</p>
          <p className="mx-auto max-w-md text-sm text-ink-muted">
            {meta!.entitlement.planAllows
              ? "Tu cuenta tiene el plan correcto, pero el interruptor de plantillas está apagado. Escríbele a soporte para activarlo."
              : "Tu plan actual no incluye el envío de plantillas de WhatsApp. Escríbele a soporte para habilitarlas."}
          </p>
          <Button onClick={onClose}>Entendido</Button>
        </div>
      ) : (
        <div className="grid gap-5 md:grid-cols-2">
          {/* --------- Formulario --------- */}
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">Nombre de la difusión (interno)</label>
              <input className="w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm outline-none focus:border-brand-500" placeholder="Ej: Promo octubre" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">Plantilla aprobada por Meta</label>
              <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">— Elige una plantilla —</option>
                {meta!.templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({t.language} · {t.category})</option>
                ))}
              </Select>
              {meta!.templates.length === 0 && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">No hay plantillas aprobadas. Crea y aprueba una en Canales → Plantillas.</p>}
              {template && (
                <div className="mt-2 whitespace-pre-wrap rounded-lg border border-line bg-app p-3 text-sm text-ink-muted">{template.bodyText || "(sin cuerpo de texto)"}</div>
              )}
            </div>

            {meta!.channels.length > 1 && (
              <div>
                <label className="mb-1 block text-xs font-medium text-ink-muted">Canal de WhatsApp</label>
                <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                  <option value="">Automático (primer canal activo)</option>
                  {meta!.channels.map((c) => (<option key={c.id} value={c.id}>{c.name}</option>))}
                </Select>
              </div>
            )}
          </div>

          {/* --------- Audiencia --------- */}
          <div className="space-y-4">
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-muted"><Users size={13} /> Grupos destino</label>
              <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-line p-2">
                {meta!.groups.length === 0 && <p className="px-1 py-2 text-xs text-ink-subtle">Aún no tienes grupos. Créalos en Clientes → Grupos, o carga contactos nuevos abajo.</p>}
                {meta!.groups.map((g) => (
                  <label key={g.id} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-app">
                    <Checkbox
                      checked={groupIds.has(g.id)}
                      onChange={(e) => setGroupIds((prev) => { const n = new Set(prev); e.target.checked ? n.add(g.id) : n.delete(g.id); return n; })}
                    />
                    <span className="flex-1 truncate text-ink">{g.name}</span>
                    <span className="text-xs text-ink-subtle">{g.count}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-ink-muted">Cargar contactos nuevos (opcional)</label>
              <textarea
                className="h-20 w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm outline-none focus:border-brand-500"
                placeholder={"Un teléfono por línea (con código de país)\n+56912345678\n+56987654321,Juan"}
                value={pasted}
                onChange={(e) => setPasted(e.target.value)}
              />
              <div className="mt-1 flex items-center justify-between gap-2">
                <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"><FileSpreadsheet size={13} /> Subir Excel/CSV</button>
                {newContacts.length > 0 && <span className="text-xs text-ink-subtle">{newContacts.length} contacto(s) nuevos detectados</span>}
                <input ref={fileRef} type="file" accept=".csv,.xlsx,.xlsm,text/csv" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
              </div>
              {newContacts.length > 0 && meta!.groups.length > 0 && (
                <div className="mt-2">
                  <label className="mb-1 block text-[11px] text-ink-subtle">Agregar los nuevos a un grupo (opcional)</label>
                  <Select value={newGroupId} onChange={(e) => setNewGroupId(e.target.value)}>
                    <option value="">— Sin grupo —</option>
                    {meta!.groups.map((g) => (<option key={g.id} value={g.id}>{g.name}</option>))}
                  </Select>
                </div>
              )}
              <p className="mt-1 text-[11px] text-ink-subtle">Los contactos nuevos se agregan al CRM automáticamente. Para cargas grandes con más datos, usa Clientes → Importar.</p>
            </div>
          </div>

          {/* --------- Resumen + enviar (ancho completo) --------- */}
          <div className="md:col-span-2 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <div className="text-sm text-ink-muted">
              <span className="font-medium text-ink">~{audienceCount}</span> destinatario(s) · bolsa: <span className="font-medium text-ink">{meta!.walletBalance}</span> mensajes
              {audienceCount > meta!.walletBalance && <span className="ml-2 text-amber-600 dark:text-amber-400">⚠ saldo insuficiente</span>}
            </div>
            <Button onClick={send} disabled={!canSend}><Megaphone size={15} /> {busy ? "Creando…" : "Enviar difusión"}</Button>
          </div>

          {/* --------- Historial --------- */}
          {history.length > 0 && (
            <div className="md:col-span-2 border-t border-line pt-4">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-subtle">Difusiones recientes</p>
              <div className="max-h-48 space-y-1.5 overflow-y-auto">
                {history.map((b) => {
                  const st = STATUS_LABEL[b.status] ?? { label: b.status, cls: "bg-app text-ink-muted" };
                  const pct = b.total ? Math.round((b.sent / b.total) * 100) : 0;
                  return (
                    <div key={b.id} className="rounded-lg border border-line p-2.5">
                      <div className="flex items-center gap-2">
                        <span className="flex-1 truncate text-sm font-medium text-ink">{b.name}</span>
                        <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", st.cls)}>{st.label}</span>
                        {(b.status === "SENDING" || b.status === "QUEUED") && (
                          <button onClick={() => cancel(b.id)} className="text-[11px] text-red-500 hover:underline">Cancelar</button>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-ink-subtle">{b.templateName} · {b.sent}/{b.total} enviados{b.failed ? ` · ${b.failed} con error` : ""}</p>
                      {b.total > 0 && (
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-app">
                          <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
