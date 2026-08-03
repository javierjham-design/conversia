"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Ban, ExternalLink, Megaphone, MessageSquare, Save, ShieldCheck, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Button, ConfirmDialog, Skeleton, Tabs, cn, useToast } from "@/components/ui";

// --------------------------------- Tipos ---------------------------------

interface CustomField {
  id: string;
  key: string;
  label: string;
  type: string;
  options: string[] | { value: string; label: string }[];
  required: boolean;
  value: any;
}
interface Detail {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  documentId: string | null;
  birthDate: string | null;
  locale: string | null;
  timezone: string | null;
  country: string | null;
  consent: boolean;
  doNotContact: boolean;
  blocked: boolean;
  profileName: string | null;
  origin: {
    source: string | null;
    createdVia: string | null;
    acquisitionSource: string | null;
    adId: string | null;
    ctwaClid: string | null;
    campaignId: string | null;
    referral: Record<string, any> | null;
    firstContactAt: string | null;
    lastContactAt: string | null;
    createdAt: string;
  };
  identities: { channelType: string; externalId: string }[];
  conversations: { id: string; status: string; lastMessageAt: string | null; lastMessagePreview: string | null; unreadCount: number }[];
  leads: { id: string; createdAt: string; status: { code: string; name: string; color: string | null; category: string } }[];
  tags: { id: string; name: string; color: string | null }[];
  customFields: CustomField[];
  notes: { id: string; text: string; authorName: string | null; createdAt: string }[];
  activity: { id: string; action: string; actor: string | null; actorType: string; createdAt: string }[];
}

const ACTION_LABEL: Record<string, string> = {
  "contact.create": "Contacto creado",
  "contact.update": "Datos actualizados",
  "contact.block": "Contacto bloqueado",
  "contact.unblock": "Contacto desbloqueado",
  "contact.delete": "Contacto eliminado",
  "contact.merge": "Contactos fusionados",
};
const inputCls = "w-full rounded-lg border border-line-strong bg-panel px-3 py-2 text-sm outline-none focus:border-brand-500";

function fmt(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString("es-CL", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ================================ Drawer ================================

export function ContactDrawer({ id, onClose, onChanged }: { id: string | null; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState("datos");
  const [form, setForm] = useState<Record<string, any>>({});
  const [cf, setCf] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    if (!id) return;
    setD(null);
    setTab("datos");
    api<Detail>(`/contacts/${id}`)
      .then((r) => {
        setD(r);
        setForm({
          firstName: r.firstName ?? "",
          lastName: r.lastName ?? "",
          email: r.email ?? "",
          phone: r.phone ?? "",
          documentId: r.documentId ?? "",
          birthDate: r.birthDate ? r.birthDate.slice(0, 10) : "",
          country: r.country ?? "",
          locale: r.locale ?? "es",
          timezone: r.timezone ?? "",
          consent: r.consent,
          doNotContact: r.doNotContact,
        });
        setCf(Object.fromEntries(r.customFields.map((f) => [f.id, f.value ?? (f.type === "boolean" ? false : "")])));
      })
      .catch((e) => toast.push(e.message ?? "Error al cargar la ficha", "error"));
  }, [id, toast]);

  const name = useMemo(() => (d ? [d.firstName, d.lastName].filter(Boolean).join(" ") || d.profileName || d.phone || "Sin nombre" : ""), [d]);

  async function save() {
    if (!id) return;
    setSaving(true);
    try {
      const customFields: Record<string, any> = {};
      for (const f of d?.customFields ?? []) {
        let v = cf[f.id];
        if (f.type === "number") v = v === "" || v === null ? null : Number(v);
        customFields[f.id] = v;
      }
      await api(`/contacts/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...form, customFields }),
      });
      toast.push("Cambios guardados", "ok");
      onChanged();
      const fresh = await api<Detail>(`/contacts/${id}`);
      setD(fresh);
    } catch (e: any) {
      toast.push(e.message ?? "No se pudo guardar", "error");
    } finally {
      setSaving(false);
    }
  }

  async function toggleBlock() {
    if (!id || !d) return;
    try {
      await api(`/contacts/${id}/${d.blocked ? "unblock" : "block"}`, { method: "POST" });
      toast.push(d.blocked ? "Contacto desbloqueado" : "Contacto bloqueado", "ok");
      setD({ ...d, blocked: !d.blocked });
      onChanged();
    } catch (e: any) {
      toast.push(e.message ?? "Error", "error");
    }
  }

  async function submitNote() {
    if (!id || !note.trim()) return;
    try {
      const created = await api<Detail["notes"][number]>(`/contacts/${id}/notes`, { method: "POST", body: JSON.stringify({ text: note.trim() }) });
      setD((prev) => (prev ? { ...prev, notes: [created, ...prev.notes] } : prev));
      setNote("");
    } catch (e: any) {
      toast.push(e.message ?? "Error", "error");
    }
  }

  async function del() {
    if (!id) return;
    try {
      await api(`/contacts/${id}`, { method: "DELETE" });
      toast.push("Contacto eliminado", "ok");
      onChanged();
      onClose();
    } catch (e: any) {
      toast.push(e.message ?? "Error", "error");
    }
  }

  if (!id) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-navy-950/50 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-full max-w-xl flex-col overflow-hidden bg-panel shadow-pop">
        {/* Cabecera */}
        <div className="border-b border-line px-5 py-4">
          {!d ? (
            <Skeleton className="h-10 w-48" />
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-700">
                  {(name.trim()[0] ?? "?").toUpperCase()}
                </span>
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 truncate text-lg font-semibold">
                    {name}
                    {d.blocked && <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600"><Ban size={12} /> Bloqueado</span>}
                  </h2>
                  <p className="truncate font-mono text-xs text-ink-muted">{d.phone ?? "sin teléfono"}</p>
                </div>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button variant={d.blocked ? "secondary" : "danger"} className="px-2.5 py-1.5" onClick={toggleBlock} title={d.blocked ? "Desbloquear" : "Bloquear"}>
                  {d.blocked ? <ShieldCheck size={15} /> : <Ban size={15} />}
                </Button>
                <Button variant="danger" className="px-2.5 py-1.5" onClick={() => setConfirmDel(true)} title="Eliminar">
                  <Trash2 size={15} />
                </Button>
                <button onClick={onClose} className="rounded-lg px-2 text-ink-subtle hover:bg-app hover:text-ink-muted" aria-label="Cerrar">✕</button>
              </div>
            </div>
          )}
          {d && d.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {d.tags.map((t) => (
                <span key={t.id} className="rounded px-1.5 py-0.5 text-[11px] font-medium" style={{ background: (t.color ?? "#64748b") + "22", color: t.color ?? "#475569" }}>{t.name}</span>
              ))}
            </div>
          )}
        </div>

        {d && (
          <div className="px-5 pt-2">
            <Tabs
              active={tab}
              onChange={setTab}
              tabs={[
                { id: "datos", label: "Datos" },
                { id: "origen", label: "Origen" },
                { id: "conversaciones", label: "Conversaciones", badge: d.conversations.length ? String(d.conversations.length) : undefined },
                { id: "actividad", label: "Actividad" },
              ]}
            />
          </div>
        )}

        {/* Cuerpo */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!d ? (
            <div className="space-y-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
            </div>
          ) : tab === "datos" ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <F label="Nombre"><input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className={inputCls} /></F>
                <F label="Apellido"><input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className={inputCls} /></F>
              </div>
              <F label="Teléfono"><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={inputCls} /></F>
              <F label="Email"><input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className={inputCls} /></F>
              <div className="grid grid-cols-2 gap-3">
                <F label="Documento"><input value={form.documentId} onChange={(e) => setForm({ ...form, documentId: e.target.value })} className={inputCls} /></F>
                <F label="Nacimiento"><input type="date" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} className={inputCls} /></F>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <F label="País"><input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase().slice(0, 2) })} className={inputCls} /></F>
                <F label="Idioma"><input value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })} className={inputCls} /></F>
                <F label="Zona horaria"><input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} className={inputCls} /></F>
              </div>
              <div className="flex gap-5 pt-1">
                <label className="flex items-center gap-2 text-sm text-ink-muted"><input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} /> Consiente contacto</label>
                <label className="flex items-center gap-2 text-sm text-ink-muted"><input type="checkbox" checked={form.doNotContact} onChange={(e) => setForm({ ...form, doNotContact: e.target.checked })} /> No contactar</label>
              </div>

              {d.customFields.length > 0 && (
                <div className="border-t border-line pt-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Campos personalizados</p>
                  <div className="space-y-3">
                    {d.customFields.map((f) => (
                      <F key={f.id} label={f.label}>
                        <CustomInput field={f} value={cf[f.id]} onChange={(v) => setCf({ ...cf, [f.id]: v })} />
                      </F>
                    ))}
                  </div>
                </div>
              )}

              <div className="sticky bottom-0 -mx-5 mt-2 border-t border-line bg-panel px-5 py-3">
                <Button onClick={save} disabled={saving} className="w-full"><Save size={15} /> {saving ? "Guardando…" : "Guardar cambios"}</Button>
              </div>
            </div>
          ) : tab === "origen" ? (
            <div className="space-y-4 text-sm">
              <Block title="Perfil de WhatsApp">
                <Row k="Nombre de perfil" v={d.profileName ?? "—"} />
                {d.identities.map((i) => (
                  <Row key={i.externalId} k={i.channelType === "MOCK" ? "ID simulado" : "wa_id"} v={<span className="font-mono text-xs">{i.externalId}</span>} />
                ))}
              </Block>
              <Block title="Atribución">
                <Row k="Cómo llegó" v={d.origin.acquisitionSource === "ad" ? "Anuncio Click-to-WhatsApp" : d.origin.acquisitionSource === "organic" ? "Orgánico" : d.origin.createdVia ?? "—"} />
                <Row k="Fuente" v={d.origin.source ?? "—"} />
                {d.origin.adId && <Row k="ID de anuncio" v={<span className="font-mono text-xs">{d.origin.adId}</span>} />}
                {d.origin.ctwaClid && <Row k="CTWA click id" v={<span className="font-mono text-xs">{d.origin.ctwaClid}</span>} />}
                {d.origin.campaignId && <Row k="Campaña" v={d.origin.campaignId} />}
                {d.origin.referral?.headline && (
                  <div className="mt-2 rounded-lg border border-line bg-app p-2.5">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-ink-muted"><Megaphone size={13} /> Anuncio de origen</p>
                    <p className="mt-1 font-medium text-ink">{d.origin.referral.headline}</p>
                    {d.origin.referral.body && <p className="text-ink-muted">{d.origin.referral.body}</p>}
                    {d.origin.referral.source_url && (
                      <a href={d.origin.referral.source_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">
                        Ver anuncio <ExternalLink size={11} />
                      </a>
                    )}
                  </div>
                )}
              </Block>
              <Block title="Cronología">
                <Row k="Primer contacto" v={fmt(d.origin.firstContactAt)} />
                <Row k="Último contacto" v={fmt(d.origin.lastContactAt)} />
                <Row k="Creado" v={fmt(d.origin.createdAt)} />
              </Block>
            </div>
          ) : tab === "conversaciones" ? (
            <div className="space-y-2">
              {d.conversations.length === 0 && <p className="py-6 text-center text-sm text-ink-subtle">Sin conversaciones.</p>}
              {d.conversations.map((c) => (
                <Link key={c.id} href={`/inbox?c=${c.id}`} className="flex items-center gap-3 rounded-lg border border-line p-3 hover:bg-app">
                  <MessageSquare size={16} className="shrink-0 text-ink-subtle" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{c.lastMessagePreview ?? "Sin mensajes"}</p>
                    <p className="text-xs text-ink-subtle">{fmt(c.lastMessageAt)}</p>
                  </div>
                  {c.unreadCount > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] text-white">{c.unreadCount}</span>}
                  <ExternalLink size={13} className="shrink-0 text-ink-subtle" />
                </Link>
              ))}
              {d.leads.length > 0 && (
                <div className="border-t border-line pt-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Ciclo de vida</p>
                  {d.leads.map((l) => (
                    <div key={l.id} className="flex items-center gap-2 py-1 text-sm">
                      <span className="h-2 w-2 rounded-full" style={{ background: l.status.color ?? "#94a3b8" }} />
                      <span className="text-ink">{l.status.name}</span>
                      <span className="ml-auto text-xs text-ink-subtle">{fmt(l.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {/* Notas */}
              <div>
                <div className="flex gap-2">
                  <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitNote()} placeholder="Añadir nota interna…" className={inputCls} />
                  <Button onClick={submitNote} disabled={!note.trim()}>Añadir</Button>
                </div>
                <div className="mt-3 space-y-2">
                  {d.notes.map((n) => (
                    <div key={n.id} className="rounded-lg border border-amber-200 bg-amber-50/60 p-2.5 text-sm">
                      <p className="text-ink">{n.text}</p>
                      <p className="mt-1 text-xs text-ink-subtle">{n.authorName ?? "—"} · {fmt(n.createdAt)}</p>
                    </div>
                  ))}
                </div>
              </div>
              {/* Historial */}
              <div className="border-t border-line pt-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Historial</p>
                <ul className="space-y-2">
                  {d.activity.map((a) => (
                    <li key={a.id} className="flex items-start gap-2 text-sm">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                      <div>
                        <p className="text-ink">{ACTION_LABEL[a.action] ?? a.action}</p>
                        <p className="text-xs text-ink-subtle">{a.actor ?? a.actorType} · {fmt(a.createdAt)}</p>
                      </div>
                    </li>
                  ))}
                  {d.activity.length === 0 && <li className="text-sm text-ink-subtle">Sin actividad registrada.</li>}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog open={confirmDel} onClose={() => setConfirmDel(false)} onConfirm={del} title="Eliminar contacto" description="El contacto se dará de baja (borrado lógico). Sus conversaciones se conservan." confirmLabel="Eliminar" danger />
    </div>
  );
}

// ----------------------------- Subcomponentes -----------------------------

function F({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
    </label>
  );
}
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-subtle">{title}</p>
      <div className="divide-y divide-slate-100 rounded-lg border border-line">{children}</div>
    </div>
  );
}
function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <span className="text-ink-muted">{k}</span>
      <span className="text-right text-ink">{v}</span>
    </div>
  );
}

function CustomInput({ field, value, onChange }: { field: CustomField; value: any; onChange: (v: any) => void }) {
  const opts = (field.options as any[]).map((o) => (typeof o === "string" ? { value: o, label: o } : o));
  if (field.type === "boolean") return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
  if (field.type === "number") return <input type="number" value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={inputCls} />;
  if (field.type === "date") return <input type="date" value={value ? String(value).slice(0, 10) : ""} onChange={(e) => onChange(e.target.value)} className={inputCls} />;
  if (field.type === "select")
    return (
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={inputCls}>
        <option value="">—</option>
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  return <input value={value ?? ""} onChange={(e) => onChange(e.target.value)} className={inputCls} />;
}
