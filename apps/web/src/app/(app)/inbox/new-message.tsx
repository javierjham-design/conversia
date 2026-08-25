"use client";

/**
 * Modal "Nuevo mensaje": inicia una conversación de WhatsApp con un contacto
 * que nunca escribió (p. ej. lead del formulario de Meta que no tocó el botón
 * de WhatsApp) enviándole una plantilla aprobada. Fuera de la ventana de 24 h
 * la plantilla es la única forma de abrir la conversación.
 */
import { useEffect, useMemo, useState } from "react";
import { FileText, Search } from "lucide-react";
import { api } from "@/lib/api";
import { Modal, Select, cn, useToast } from "@/components/ui";
import type { ChannelInfo } from "./types";

interface ContactHit {
  id: string;
  firstName: string | null;
  lastName: string | null;
  profileName: string | null;
  phone: string | null;
  stage: { name: string; color: string | null } | null;
}

interface Template {
  id: string;
  name: string;
  language: string;
  bodyText: string;
}

function contactName(c: ContactHit): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.profileName || c.phone || "Sin nombre";
}

export function NewMessageModal({
  open,
  onClose,
  channels,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  channels: ChannelInfo[];
  onStarted: (conversationId: string) => void;
}) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [contact, setContact] = useState<ContactHit | null>(null);
  /** número nuevo (no existe como contacto): se crea al vuelo al enviar */
  const [newPhone, setNewPhone] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [channelId, setChannelId] = useState("");
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [templateId, setTemplateId] = useState("");
  const [sending, setSending] = useState(false);

  const waChannels = useMemo(() => channels.filter((c) => c.type === "WHATSAPP_CLOUD"), [channels]);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 350);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (!open) return;
    setSearching(true);
    const params = new URLSearchParams({ pageSize: "25" });
    if (qDebounced.trim()) params.set("q", qDebounced.trim());
    api<{ items: ContactHit[] }>(`/contacts?${params.toString()}`)
      .then((r) => setHits(r.items))
      .catch(() => setHits([]))
      .finally(() => setSearching(false));
  }, [open, qDebounced]);

  useEffect(() => {
    if (!open) return;
    if (templates === null) {
      void api<{ templates: Template[] }>("/channels/templates/approved")
        .then((r) => setTemplates(r.templates))
        .catch(() => setTemplates([]));
    }
    if (!channelId && waChannels.length > 0) setChannelId(waChannels[0].id);
  }, [open, templates, channelId, waChannels]);

  function reset() {
    setQ("");
    setContact(null);
    setNewPhone(null);
    setNewName("");
    setTemplateId("");
  }

  async function send() {
    if ((!contact && !newPhone) || !templateId || sending) return;
    setSending(true);
    try {
      const r = await api<{ conversationId: string }>("/conversations/start", {
        method: "POST",
        body: JSON.stringify({
          ...(contact ? { contactId: contact.id } : { phone: newPhone, ...(newName.trim() ? { name: newName.trim() } : {}) }),
          templateId,
          ...(channelId ? { channelId } : {}),
        }),
      });
      toast.push("Plantilla enviada — conversación iniciada", "ok");
      reset();
      onStarted(r.conversationId);
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setSending(false);
    }
  }

  const selectable = hits.filter((h) => h.phone);
  const noPhone = hits.length > 0 && selectable.length === 0;
  // La búsqueda parece un teléfono → ofrecer crear el contacto al vuelo
  const phoneQuery = q.replace(/[^\d+]/g, "").replace(/^\+/, "");
  const looksLikePhone = phoneQuery.length >= 8 && /^[\d\s()+-]+$/.test(q.trim());

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Nuevo mensaje"
    >
      {waChannels.length === 0 ? (
        <p className="rounded-control bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          Necesitas un canal de WhatsApp conectado. <a href="/channels" className="underline">Ir a Canales</a>
        </p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-ink-muted">
            Envía una plantilla aprobada a un contacto que aún no te escribe (p. ej. un lead del formulario) y sigue la conversación en la bandeja.
          </p>

          {/* Paso 1 — contacto */}
          {!contact && !newPhone ? (
            <div>
              <div className="relative">
                <Search size={13} className="pointer-events-none absolute left-2.5 top-2.5 text-ink-subtle" />
                <input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Buscar contacto por nombre, teléfono o email…"
                  className="w-full rounded-control border border-line-strong bg-panel py-1.5 pl-8 pr-3 text-sm text-ink placeholder:text-ink-subtle"
                />
              </div>
              <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                {searching && <p className="px-1 py-2 text-xs text-ink-subtle">Buscando…</p>}
                {!searching && hits.length === 0 && !looksLikePhone && <p className="px-1 py-2 text-xs text-ink-subtle">Sin resultados.</p>}
                {!searching && looksLikePhone && (
                  <button
                    onClick={() => setNewPhone(phoneQuery)}
                    className="flex w-full items-center gap-2 rounded-control border border-dashed border-brand-400 px-2.5 py-2 text-left text-sm text-brand-700 hover:bg-brand-soft dark:text-brand-400"
                  >
                    <span className="text-base leading-none">＋</span>
                    <span>
                      Enviar a número nuevo: <b>+{phoneQuery}</b>
                      <span className="block text-xs text-ink-subtle">Se crea el contacto y se le envía la plantilla</span>
                    </span>
                  </button>
                )}
                {noPhone && <p className="px-1 py-2 text-xs text-amber-700 dark:text-amber-300">Los contactos encontrados no tienen teléfono (necesario para WhatsApp).</p>}
                {selectable.map((h) => (
                  <button
                    key={h.id}
                    onClick={() => setContact(h)}
                    className="flex w-full items-center justify-between gap-2 rounded-control border border-line px-2.5 py-2 text-left text-sm hover:border-brand-400 hover:bg-brand-soft"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink">{contactName(h)}</span>
                      <span className="block text-xs text-ink-subtle">{h.phone}</span>
                    </span>
                    {h.stage && (
                      <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${h.stage.color ?? "#94a3b8"}1f`, color: h.stage.color ?? "#64748b" }}>
                        {h.stage.name}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ) : contact ? (
            <div className="flex items-center justify-between rounded-control border border-line bg-app px-2.5 py-2 text-sm">
              <span>
                <span className="font-medium text-ink">{contactName(contact)}</span>
                <span className="ml-2 text-xs text-ink-subtle">{contact.phone}</span>
              </span>
              <button onClick={() => setContact(null)} className="text-xs text-brand-700 hover:underline dark:text-brand-400">
                Cambiar
              </button>
            </div>
          ) : (
            <div className="space-y-2 rounded-control border border-line bg-app px-2.5 py-2 text-sm">
              <div className="flex items-center justify-between">
                <span>
                  <span className="font-medium text-ink">Contacto nuevo</span>
                  <span className="ml-2 text-xs text-ink-subtle">+{newPhone}</span>
                </span>
                <button onClick={() => setNewPhone(null)} className="text-xs text-brand-700 hover:underline dark:text-brand-400">
                  Cambiar
                </button>
              </div>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Nombre (opcional)"
                className="w-full rounded-control border border-line-strong bg-panel px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-subtle"
              />
            </div>
          )}

          {/* Paso 2 — canal (solo si hay más de uno) */}
          {(contact || newPhone) && waChannels.length > 1 && (
            <Select value={channelId} onChange={(e) => setChannelId(e.target.value)} className="w-full">
              {waChannels.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </Select>
          )}

          {/* Paso 3 — plantilla */}
          {(contact || newPhone) &&
            (templates !== null && templates.length === 0 ? (
              <p className="rounded-control bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                No hay plantillas aprobadas. Créalas o sincronízalas en <a href="/channels" className="underline">Canales → Plantillas</a>.
              </p>
            ) : (
              <div className="max-h-48 space-y-1.5 overflow-y-auto">
                {(templates ?? []).map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTemplateId(t.id)}
                    className={cn(
                      "block w-full rounded-control border px-2.5 py-2 text-left",
                      templateId === t.id ? "border-brand-500 bg-brand-soft" : "border-line hover:border-brand-300",
                    )}
                  >
                    <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                      <FileText size={13} className="text-brand-600" /> {t.name}
                      <span className="text-2xs text-ink-subtle">({t.language})</span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-ink-subtle">{t.bodyText}</span>
                  </button>
                ))}
              </div>
            ))}

          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <button
              onClick={() => {
                reset();
                onClose();
              }}
              className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-ink hover:bg-app"
            >
              Cancelar
            </button>
            <button
              onClick={() => void send()}
              disabled={(!contact && !newPhone) || !templateId || sending}
              className="rounded-control bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
            >
              {sending ? "Enviando…" : "Enviar plantilla"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
