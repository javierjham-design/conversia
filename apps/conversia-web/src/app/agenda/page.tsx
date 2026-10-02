"use client";
import { useCallback, useEffect, useState } from "react";
import { Ban, CheckCircle2, Clock, Plus, Settings2, X } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

type Appt = {
  id: string;
  professionalName: string | null;
  serviceName: string | null;
  status: string;
  startsAt: string;
  endsAt: string;
  notes: string | null;
  contact: { name: string; phone: string | null };
};
type Pro = { id: string; name: string };
type Svc = { id: string; name: string; durationMin: number };
type ContactLite = { id: string; firstName: string | null; lastName: string | null; profileName: string | null; phone: string | null };

const STATUS_COLOR: Record<string, string> = { CONFIRMED: "var(--ok)", BOOKED: "var(--acc-deep)", PENDING: "var(--warn)", CANCELLED: "var(--danger)", COMPLETED: "var(--ink-dim)" };

function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("es-CL", { weekday: "long", day: "2-digit", month: "long" });
}
function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
}
function contactName(c: ContactLite): string {
  return [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.profileName || c.phone || "Sin nombre";
}

const FIELD: React.CSSProperties = { width: "100%", padding: "10px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };
const LBL: React.CSSProperties = { fontSize: 12, color: "var(--ink-dim)", display: "block", marginTop: 12 };

export default function Agenda() {
  const [appts, setAppts] = useState<Appt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [actionAppt, setActionAppt] = useState<Appt | null>(null);

  const load = useCallback(() => {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    setLoading(true);
    api<{ appointments: Appt[] }>(`/agenda/appointments?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then((r) => setAppts(r.appointments))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const groups: { day: string; items: Appt[] }[] = [];
  for (const a of appts) {
    const k = dayKey(a.startsAt);
    const g = groups.find((x) => x.day === k);
    if (g) g.items.push(a);
    else groups.push({ day: k, items: [a] });
  }

  return (
    <AppShell>
      <main style={{ maxWidth: 760, margin: "0 auto", padding: "28px 20px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
          <h1 className="display" style={{ fontSize: 28, margin: 0 }}>Agenda</h1>
          <a href="/agenda/configurar" className="nav-item" style={{ marginLeft: "auto", width: "auto", height: 38, padding: "0 12px", gap: 6, border: "1px solid var(--line)", fontSize: 13, textDecoration: "none" }}>
            <Settings2 size={15} /> Configurar
          </a>
          <button className="btn-accent" onClick={() => setShowNew(true)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Plus size={16} /> Nueva cita
          </button>
        </div>
        <p className="text-dim" style={{ fontSize: 14, margin: "0 0 20px" }}>Tus próximas citas (30 días).</p>
        {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}

        {loading ? (
          <p className="text-dim">Cargando…</p>
        ) : appts.length === 0 ? (
          <div className="card" style={{ padding: 24 }}>
            <p style={{ margin: 0 }}>No hay citas próximas.</p>
            <p className="text-dim" style={{ fontSize: 13, margin: "6px 0 0" }}>Crea una con “Nueva cita” o deja que tu asistente agende.</p>
          </div>
        ) : (
          groups.map((g) => (
            <div key={g.day} style={{ marginBottom: 22 }}>
              <p className="display" style={{ fontSize: 15, margin: "0 0 10px", textTransform: "capitalize" }}>{g.day}</p>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {g.items.map((a) => {
                  const cancelled = a.status === "CANCELLED";
                  return (
                    <button key={a.id} onClick={() => setActionAppt(a)} className="card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 14, textAlign: "left", cursor: "pointer", border: "1px solid var(--hairline)", width: "100%", opacity: cancelled ? 0.55 : 1 }}>
                      <div style={{ textAlign: "center", minWidth: 58 }}>
                        <p className="display" style={{ margin: 0, fontSize: 17, textDecoration: cancelled ? "line-through" : "none" }}>{hhmm(a.startsAt)}</p>
                        <p className="text-dim" style={{ margin: 0, fontSize: 11 }}>{hhmm(a.endsAt)}</p>
                      </div>
                      <div style={{ width: 3, alignSelf: "stretch", borderRadius: 3, background: STATUS_COLOR[a.status] ?? "var(--acc)" }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ margin: 0, fontWeight: 600, fontSize: 15 }}>{a.contact.name}</p>
                        <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12 }}>
                          {[a.serviceName, a.professionalName].filter(Boolean).join(" · ") || "Cita"}{cancelled ? " · cancelada" : ""}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </main>
      {showNew ? <NewAppointment onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} /> : null}
      {actionAppt ? <ApptActions appt={actionAppt} onClose={() => setActionAppt(null)} onDone={() => { setActionAppt(null); load(); }} /> : null}
    </AppShell>
  );
}

function ApptActions({ appt, onClose, onDone }: { appt: Appt; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"menu" | "reschedule">("menu");
  const [date, setDate] = useState(appt.startsAt.slice(0, 10));
  const [time, setTime] = useState(hhmm(appt.startsAt));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const durationMin = Math.max(5, Math.round((new Date(appt.endsAt).getTime() - new Date(appt.startsAt).getTime()) / 60000));

  async function patch(data: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/agenda/appointments/${appt.id}`, { method: "PATCH", body: JSON.stringify(data) });
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  async function reschedule(e: React.FormEvent) {
    e.preventDefault();
    const startsAt = new Date(`${date}T${time}`);
    const endsAt = new Date(startsAt.getTime() + durationMin * 60000);
    await patch({ startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), status: "RESCHEDULED" });
  }

  const field: React.CSSProperties = { width: "100%", padding: "10px 12px", marginTop: 5, borderRadius: 10, border: "1px solid var(--line)", background: "var(--surface-solid)", color: "var(--ink)", fontSize: 14 };
  const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid var(--line)", background: "transparent", color: "var(--ink)", cursor: "pointer", fontSize: 14, marginTop: 8 };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: "100%", maxWidth: 400, padding: 22 }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
          <h2 className="display" style={{ fontSize: 19, margin: 0 }}>{appt.contact.name}</h2>
          <button type="button" onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }} aria-label="Cerrar"><X size={20} /></button>
        </div>
        <p className="text-dim" style={{ fontSize: 13, margin: "0 0 6px" }}>
          {new Date(appt.startsAt).toLocaleString("es-CL", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · {[appt.serviceName, appt.professionalName].filter(Boolean).join(" · ") || "Cita"}
        </p>
        {err ? <p style={{ color: "var(--danger)", fontSize: 13 }}>{err}</p> : null}

        {mode === "menu" ? (
          <>
            <button style={row} onClick={() => setMode("reschedule")} disabled={busy}><Clock size={17} /> Reagendar</button>
            <button style={row} onClick={() => patch({ status: "COMPLETED" })} disabled={busy}><CheckCircle2 size={17} color="var(--ok)" /> Marcar como completada</button>
            <button style={{ ...row, color: "var(--danger)" }} onClick={() => patch({ status: "CANCELLED" })} disabled={busy}><Ban size={17} /> Cancelar cita</button>
          </>
        ) : (
          <form onSubmit={reschedule}>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Fecha</label>
                <input style={field} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: "var(--ink-dim)" }}>Hora</label>
                <input style={field} type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
              </div>
            </div>
            <p className="text-dim" style={{ fontSize: 12, margin: "8px 0 0" }}>Duración: {durationMin} min.</p>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setMode("menu")} style={{ ...row, marginTop: 0, justifyContent: "center", flex: 1 }}>Volver</button>
              <button className="btn-accent" type="submit" disabled={busy} style={{ flex: 1, opacity: busy ? 0.6 : 1 }}>{busy ? "Guardando…" : "Reagendar"}</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function NewAppointment({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [pros, setPros] = useState<Pro[]>([]);
  const [svcs, setSvcs] = useState<Svc[]>([]);
  const [cq, setCq] = useState("");
  const [cResults, setCResults] = useState<ContactLite[]>([]);
  const [contact, setContact] = useState<ContactLite | null>(null);
  const [proId, setProId] = useState("");
  const [svcId, setSvcId] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Pro[]>("/agenda/professionals").then(setPros).catch(() => {});
    api<Svc[]>("/agenda/services").then(setSvcs).catch(() => {});
  }, []);

  useEffect(() => {
    if (contact || !cq.trim()) {
      setCResults([]);
      return;
    }
    const t = setTimeout(() => {
      api<{ items: ContactLite[] }>(`/contacts?page=1&pageSize=25&q=${encodeURIComponent(cq.trim())}`)
        .then((r) => setCResults(r.items))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [cq, contact]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!contact || !date || !time) {
      setErr("Elige cliente, fecha y hora.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const startsAt = new Date(`${date}T${time}`);
      const dur = svcs.find((s) => s.id === svcId)?.durationMin ?? 30;
      const endsAt = new Date(startsAt.getTime() + dur * 60000);
      await api("/agenda/appointments", {
        method: "POST",
        body: JSON.stringify({
          contactId: contact.id,
          professionalId: proId || undefined,
          serviceId: svcId || undefined,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          notes: notes.trim() || undefined,
        }),
      });
      onCreated();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", padding: 16, zIndex: 50 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} className="card" style={{ width: "100%", maxWidth: 440, padding: 24, maxHeight: "90dvh", overflowY: "auto" }}>
        <div style={{ display: "flex", alignItems: "center", marginBottom: 6 }}>
          <h2 className="display" style={{ fontSize: 20, margin: 0 }}>Nueva cita</h2>
          <button type="button" onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-dim)" }} aria-label="Cerrar"><X size={20} /></button>
        </div>

        <label style={LBL}>Cliente</label>
        {contact ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
            <span className="card" style={{ padding: "8px 12px", flex: 1, fontSize: 14 }}>{contactName(contact)}</span>
            <button type="button" onClick={() => { setContact(null); setCq(""); }} className="text-accent" style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13 }}>Cambiar</button>
          </div>
        ) : (
          <>
            <input style={FIELD} value={cq} onChange={(e) => setCq(e.target.value)} placeholder="Buscar por nombre o teléfono…" />
            {cResults.length ? (
              <div className="card" style={{ marginTop: 6, maxHeight: 180, overflowY: "auto", padding: 4 }}>
                {cResults.map((c) => (
                  <button key={c.id} type="button" onClick={() => { setContact(c); setCResults([]); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 10px", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink)", fontSize: 14, borderRadius: 8 }}>
                    {contactName(c)} <span className="text-dim" style={{ fontSize: 12 }}>{c.phone ?? ""}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}

        <label style={LBL}>Servicio (opcional)</label>
        <select style={FIELD} value={svcId} onChange={(e) => setSvcId(e.target.value)}>
          <option value="">— sin servicio —</option>
          {svcs.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.durationMin} min)</option>)}
        </select>

        <label style={LBL}>Profesional / recurso (opcional)</label>
        <select style={FIELD} value={proId} onChange={(e) => setProId(e.target.value)}>
          <option value="">— sin asignar —</option>
          {pros.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>

        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <label style={LBL}>Fecha</label>
            <input style={FIELD} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div style={{ flex: 1 }}>
            <label style={LBL}>Hora</label>
            <input style={FIELD} type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
        </div>

        <label style={LBL}>Notas (opcional)</label>
        <input style={FIELD} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej: primera consulta" />

        {err ? <p style={{ color: "var(--danger)", fontSize: 13, marginTop: 12 }}>{err}</p> : null}
        <button className="btn-accent" type="submit" disabled={saving} style={{ width: "100%", marginTop: 18, opacity: saving ? 0.6 : 1 }}>
          {saving ? "Guardando…" : "Crear cita"}
        </button>
      </form>
    </div>
  );
}
