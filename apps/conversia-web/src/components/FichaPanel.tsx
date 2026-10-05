"use client";
import { useEffect, useState } from "react";
import { CalendarClock, CreditCard, Hash, Phone, StickyNote, Tag, User, X } from "lucide-react";
import { api } from "@/lib/api";

// B3 — ficha del cliente bajo demanda ("Ver ficha"). Funde /context (identidad, etapa, tags)
// con /ficha (próxima cita + historial, pagos, campos personalizados, notas persistentes).

type Ctx = {
  contact: { id: string; firstName: string | null; lastName: string | null; profileName: string | null; phone: string | null; email: string | null; country: string | null; source: string | null; createdAt: string; isReturning: boolean };
  stage: { name: string; color: string | null } | null;
  tags: string[];
};
type Appt = { id: string; startsAt: string; endsAt: string; status: string; professionalName: string | null; serviceName: string | null };
type Payment = { id: string; amount: number; currency: string; subject: string | null; status: string; createdAt: string; paidAt: string | null };
type CustomField = { key: string; label: string; type: string; value: unknown };
type Note = { at: string; byName: string | null; text: string };
type Ficha = { next: Appt | null; recent: Appt[]; payments: Payment[]; customFields: CustomField[]; notes: Note[] };

const STATUS_ES: Record<string, string> = {
  PENDING: "Por confirmar",
  CONFIRMED: "Confirmada",
  CANCELLED: "Cancelada",
  RESCHEDULED: "Reagendada",
  COMPLETED: "Completada",
  NO_SHOW: "No asistió",
};

function fullName(c: Ctx["contact"]): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.profileName || c.phone || "Sin nombre";
}
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-CL", { weekday: "short", day: "2-digit", month: "short" });
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
}

export function FichaPanel({ conversationId, narrow, onClose }: { conversationId: string; narrow: boolean; onClose: () => void }) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [loading, setLoading] = useState(true);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api<Ctx>(`/conversations/${conversationId}/context`),
      api<Ficha>(`/conversations/${conversationId}/ficha`),
    ])
      .then(([c, f]) => {
        setCtx(c);
        setFicha(f);
      })
      .catch((e) => setErr((e as Error).message))
      .finally(() => setLoading(false));
  }, [conversationId]);

  async function addNote() {
    const text = noteText.trim();
    if (!text) return;
    setSavingNote(true);
    setErr(null);
    try {
      const r = await api<{ notes: Note[] }>(`/conversations/${conversationId}/contact-note`, { method: "POST", body: JSON.stringify({ text }) });
      setFicha((f) => (f ? { ...f, notes: r.notes } : f));
      setNoteText("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSavingNote(false);
    }
  }

  const panel: React.CSSProperties = narrow
    ? { position: "fixed", inset: 0, zIndex: 60, background: "var(--surface-solid)", display: "flex", flexDirection: "column" }
    : { width: 340, flexShrink: 0, borderLeft: "1px solid var(--hairline)", display: "flex", flexDirection: "column", height: "100%", background: "color-mix(in srgb, var(--surface-solid) 60%, transparent)" };

  return (
    <aside style={panel}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 16px", borderBottom: "1px solid var(--hairline)" }}>
        <b className="display" style={{ fontSize: 16 }}>Ficha del cliente</b>
        <button onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }} aria-label="Cerrar ficha"><X size={20} /></button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 16 }}>
        {loading ? (
          <p className="text-dim" style={{ fontSize: 14 }}>Cargando ficha…</p>
        ) : !ctx ? (
          <p className="text-dim" style={{ fontSize: 14 }}>{err ?? "No se pudo cargar la ficha."}</p>
        ) : (
          <>
            {/* Identidad */}
            <section>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--acc-dim)", color: "var(--acc-deep)", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 16, flexShrink: 0 }}>
                  {fullName(ctx.contact).slice(0, 2).toUpperCase()}
                </span>
                <div style={{ minWidth: 0 }}>
                  <b style={{ fontSize: 15, display: "block" }}>{fullName(ctx.contact)}</b>
                  {ctx.contact.isReturning ? <span className="text-dim" style={{ fontSize: 11 }}>Cliente recurrente</span> : null}
                </div>
              </div>
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                {ctx.contact.phone ? <Row icon={<Phone size={14} />} text={ctx.contact.phone} /> : null}
                {ctx.contact.email ? <Row icon={<User size={14} />} text={ctx.contact.email} /> : null}
                <Row icon={<Hash size={14} />} text={`Alta ${fmtDate(ctx.contact.createdAt)}${ctx.contact.source ? ` · ${ctx.contact.source}` : ""}`} />
              </div>
            </section>

            {/* Etapa + etiquetas */}
            {(ctx.stage || ctx.tags.length) ? (
              <section style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                {ctx.stage ? (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--line)" }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: ctx.stage.color ?? "var(--acc)" }} />
                    {ctx.stage.name}
                  </span>
                ) : null}
                {ctx.tags.map((t) => (
                  <span key={t} style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, padding: "4px 10px", borderRadius: 999, background: "var(--acc-dim)", color: "var(--acc-deep)" }}>
                    <Tag size={11} /> {t}
                  </span>
                ))}
              </section>
            ) : null}

            {/* Próxima cita */}
            <Section title="Próxima cita" icon={<CalendarClock size={14} />}>
              {ficha?.next ? (
                <div className="card" style={{ padding: "10px 12px" }}>
                  <b style={{ fontSize: 13, textTransform: "capitalize" }}>{fmtDate(ficha.next.startsAt)} · {fmtTime(ficha.next.startsAt)}</b>
                  <p className="text-dim" style={{ fontSize: 12, margin: "3px 0 0" }}>
                    {[ficha.next.serviceName, ficha.next.professionalName].filter(Boolean).join(" · ") || STATUS_ES[ficha.next.status] || ficha.next.status}
                  </p>
                </div>
              ) : (
                <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Sin próximas citas.</p>
              )}
            </Section>

            {/* Historial de citas */}
            {ficha && ficha.recent.length > 0 ? (
              <Section title="Historial de citas">
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {ficha.recent.map((a) => (
                    <div key={a.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5 }}>
                      <span style={{ textTransform: "capitalize" }}>{fmtDate(a.startsAt)} · {fmtTime(a.startsAt)}</span>
                      <span className="text-dim" style={{ flexShrink: 0 }}>{STATUS_ES[a.status] ?? a.status}</span>
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            {/* Pagos */}
            {ficha && ficha.payments.length > 0 ? (
              <Section title="Pagos" icon={<CreditCard size={14} />}>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {ficha.payments.map((p) => (
                    <div key={p.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5 }}>
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.subject ?? "Cobro"}</span>
                      <span style={{ flexShrink: 0, color: p.status === "paid" ? "var(--ok)" : "var(--ink-dim)" }}>
                        ${p.amount.toLocaleString("es-CL")} · {p.status === "paid" ? "Pagado" : "Pendiente"}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            {/* Campos personalizados */}
            {ficha && ficha.customFields.length > 0 ? (
              <Section title="Campos personalizados">
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {ficha.customFields.map((f) => (
                    <div key={f.key} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12.5 }}>
                      <span className="text-dim">{f.label}</span>
                      <span style={{ textAlign: "right" }}>{formatValue(f.value)}</span>
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            {/* Notas del contacto */}
            <Section title="Notas del contacto" icon={<StickyNote size={14} />}>
              <div style={{ display: "flex", gap: 6, marginBottom: ficha && ficha.notes.length ? 10 : 0 }}>
                <input
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addNote(); } }}
                  placeholder="Agregar una nota…"
                  style={{ flex: 1, padding: "8px 10px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 13 }}
                />
                <button className="btn-accent" onClick={addNote} disabled={savingNote || !noteText.trim()} style={{ fontSize: 12, padding: "6px 12px", opacity: savingNote || !noteText.trim() ? 0.5 : 1 }}>Guardar</button>
              </div>
              {ficha && ficha.notes.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {ficha.notes.map((n, i) => (
                    <div key={i} style={{ fontSize: 12.5, padding: "8px 10px", borderRadius: 10, background: "color-mix(in srgb, var(--warn) 10%, transparent)", border: "1px solid color-mix(in srgb, var(--warn) 30%, transparent)" }}>
                      <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{n.text}</p>
                      <p className="text-dim" style={{ margin: "4px 0 0", fontSize: 10.5 }}>{n.byName ? `${n.byName} · ` : ""}{fmtDate(n.at)} {fmtTime(n.at)}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-dim" style={{ fontSize: 12.5, margin: 0 }}>Sin notas aún.</p>
              )}
            </Section>

            {err ? <p style={{ color: "var(--danger)", fontSize: 12 }}>{err}</p> : null}
          </>
        )}
      </div>
    </aside>
  );
}

function Row({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--ink-dim)" }}>
      <span style={{ flexShrink: 0 }}>{icon}</span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{text}</span>
    </div>
  );
}

function Section({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <p style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--ink-dim)", margin: "0 0 8px" }}>
        {icon} {title}
      </p>
      {children}
    </section>
  );
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Sí" : "No";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
