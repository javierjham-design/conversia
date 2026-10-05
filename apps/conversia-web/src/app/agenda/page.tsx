"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, Clock, List, Plus, Settings2, X } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

type Appt = {
  id: string;
  professionalId: string | null;
  professionalName: string | null;
  serviceName: string | null;
  status: string;
  startsAt: string;
  endsAt: string;
  notes: string | null;
  contact: { name: string; phone: string | null };
};
type Pro = { id: string; name: string; workingHours?: { day: number; start: string; end: string }[] };
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

// B4 — rejilla de calendario (día/semana)
const HOUR_PX = 52;
function startOfDay(d: Date): Date { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function startOfWeek(d: Date): Date { const x = startOfDay(d); const dow = (x.getDay() + 6) % 7; x.setDate(x.getDate() - dow); return x; } // lunes
function addDays(d: Date, n: number): Date { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function sameDay(a: Date, b: Date): boolean { return a.toDateString() === b.toDateString(); }
function toLocalInput(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function minsOf(iso: string): number { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); }
const DOW = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];

type Prefill = { date?: string; time?: string; professionalId?: string };

export default function Agenda() {
  const [appts, setAppts] = useState<Appt[]>([]);
  const [pros, setPros] = useState<Pro[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"day" | "week" | "list">("day");
  const [cursor, setCursor] = useState<Date>(() => startOfDay(new Date()));
  const [showNew, setShowNew] = useState(false);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  const [actionAppt, setActionAppt] = useState<Appt | null>(null);
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 700px)");
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    api<Pro[]>("/agenda/professionals").then(setPros).catch(() => {});
  }, []);

  const range = useMemo(() => {
    if (view === "list") return { from: cursor, to: addDays(cursor, 30) };
    if (view === "day") return { from: cursor, to: addDays(cursor, 1) };
    const from = startOfWeek(cursor);
    return { from, to: addDays(from, 7) };
  }, [view, cursor]);

  const load = useCallback(() => {
    setLoading(true);
    api<{ appointments: Appt[] }>(`/agenda/appointments?from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}`)
      .then((r) => setAppts(r.appointments))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [range]);
  useEffect(() => { load(); }, [load]);

  // Rango horario visible: derivado de los horarios laborales (fallback 8–20, clamp 6–23).
  const [startH, endH] = useMemo(() => {
    let min = 8, max = 20;
    for (const p of pros) for (const w of p.workingHours ?? []) {
      const sh = parseInt(w.start.slice(0, 2), 10);
      const [eh, em] = w.end.split(":").map((n) => parseInt(n, 10));
      const ehCeil = eh + (em > 0 ? 1 : 0);
      if (!isNaN(sh) && sh < min) min = sh;
      if (!isNaN(ehCeil) && ehCeil > max) max = ehCeil;
    }
    return [Math.max(6, min), Math.min(23, Math.max(max, min + 4))];
  }, [pros]);

  const cols: Pro[] = pros.length ? pros : [{ id: "", name: "Agenda" }];
  const today = startOfDay(new Date());
  const openNew = (p: Prefill) => { setPrefill(p); setShowNew(true); };

  const label =
    view === "week"
      ? `${startOfWeek(cursor).toLocaleDateString("es-CL", { day: "2-digit", month: "short" })} – ${addDays(startOfWeek(cursor), 6).toLocaleDateString("es-CL", { day: "2-digit", month: "short" })}`
      : cursor.toLocaleDateString("es-CL", { weekday: "long", day: "2-digit", month: "long" });
  const step = view === "week" ? 7 : 1;

  const tabBtn = (key: typeof view, text: string, icon: React.ReactNode) => (
    <button onClick={() => setView(key)} className={view === key ? "btn-accent" : ""} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 12px", fontSize: 13, borderRadius: 999, cursor: "pointer", border: view === key ? "none" : "1px solid var(--line)", background: view === key ? undefined : "transparent", color: view === key ? undefined : "var(--ink-dim)" }}>
      {icon} {text}
    </button>
  );

  return (
    <AppShell>
      <main style={{ maxWidth: view === "list" ? 760 : 1180, margin: "0 auto", padding: "24px 18px 40px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <h1 className="display" style={{ fontSize: 26, margin: 0 }}>Agenda</h1>
          <a href="/agenda/configurar" className="nav-item" style={{ marginLeft: "auto", width: "auto", height: 36, padding: "0 12px", gap: 6, border: "1px solid var(--line)", fontSize: 13, textDecoration: "none" }}>
            <Settings2 size={15} /> Configurar
          </a>
          <button className="btn-accent" onClick={() => openNew({})} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Plus size={16} /> Nueva cita
          </button>
        </div>

        {/* Selector de vista + navegación */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", gap: 6 }}>
            {tabBtn("day", "Día", <CalendarDays size={14} />)}
            {tabBtn("week", "Semana", <CalendarDays size={14} />)}
            {tabBtn("list", "Próximas", <List size={14} />)}
          </div>
          {view !== "list" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
              <button onClick={() => setCursor((c) => addDays(c, -step))} aria-label="Anterior" style={navBtn}><ChevronLeft size={16} /></button>
              <button onClick={() => setCursor(startOfDay(new Date()))} style={{ ...navBtn, width: "auto", padding: "0 12px", fontSize: 13 }}>Hoy</button>
              <button onClick={() => setCursor((c) => addDays(c, step))} aria-label="Siguiente" style={navBtn}><ChevronRight size={16} /></button>
              <span className="text-dim" style={{ fontSize: 13, textTransform: "capitalize", marginLeft: 4, minWidth: 0 }}>{label}</span>
            </div>
          ) : (
            <span className="text-dim" style={{ fontSize: 14, marginLeft: "auto" }}>Próximas citas (30 días).</span>
          )}
        </div>

        {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}

        {loading ? (
          <p className="text-dim">Cargando…</p>
        ) : view === "list" ? (
          <ListView appts={appts} onAppt={setActionAppt} />
        ) : view === "day" ? (
          <CalendarGrid
            columns={cols.map((p) => ({ key: p.id, label: p.name }))}
            dayForColumn={() => cursor}
            eventsForColumn={(colKey) => appts.filter((a) => sameDay(new Date(a.startsAt), cursor) && (colKey === "" ? true : a.professionalId === colKey))}
            startH={startH}
            endH={endH}
            showNow={sameDay(cursor, today)}
            onSlot={(colKey, hour) => openNew({ date: toLocalInput(cursor), time: `${String(hour).padStart(2, "0")}:00`, professionalId: colKey || undefined })}
            onAppt={setActionAppt}
            narrow={narrow}
          />
        ) : (
          <CalendarGrid
            columns={Array.from({ length: 7 }, (_, i) => { const d = addDays(startOfWeek(cursor), i); return { key: String(i), label: DOW[i], sublabel: String(d.getDate()), isToday: sameDay(d, today) }; })}
            dayForColumn={(colKey) => addDays(startOfWeek(cursor), Number(colKey))}
            eventsForColumn={(colKey) => { const d = addDays(startOfWeek(cursor), Number(colKey)); return appts.filter((a) => sameDay(new Date(a.startsAt), d)); }}
            startH={startH}
            endH={endH}
            showNow={true}
            nowColumnKey={String((new Date().getDay() + 6) % 7)}
            onSlot={(colKey, hour) => { const d = addDays(startOfWeek(cursor), Number(colKey)); openNew({ date: toLocalInput(d), time: `${String(hour).padStart(2, "0")}:00` }); }}
            onAppt={setActionAppt}
            narrow={narrow}
          />
        )}
      </main>
      {showNew ? <NewAppointment prefill={prefill} onClose={() => { setShowNew(false); setPrefill(null); }} onCreated={() => { setShowNew(false); setPrefill(null); load(); }} /> : null}
      {actionAppt ? <ApptActions appt={actionAppt} onClose={() => setActionAppt(null)} onDone={() => { setActionAppt(null); load(); }} /> : null}
    </AppShell>
  );
}

const navBtn: React.CSSProperties = { width: 34, height: 34, display: "grid", placeItems: "center", borderRadius: 10, border: "1px solid var(--line)", background: "transparent", color: "var(--ink)", cursor: "pointer" };

// ------------------------- B4: lista "Próximas" (vista alterna) -------------------------
function ListView({ appts, onAppt }: { appts: Appt[]; onAppt: (a: Appt) => void }) {
  const groups: { day: string; items: Appt[] }[] = [];
  for (const a of appts) {
    const k = dayKey(a.startsAt);
    const g = groups.find((x) => x.day === k);
    if (g) g.items.push(a);
    else groups.push({ day: k, items: [a] });
  }
  if (appts.length === 0)
    return (
      <div className="card" style={{ padding: 24 }}>
        <p style={{ margin: 0 }}>No hay citas próximas.</p>
        <p className="text-dim" style={{ fontSize: 13, margin: "6px 0 0" }}>Crea una con “Nueva cita” o deja que tu asistente agende.</p>
      </div>
    );
  return (
    <>
      {groups.map((g) => (
        <div key={g.day} style={{ marginBottom: 22 }}>
          <p className="display" style={{ fontSize: 15, margin: "0 0 10px", textTransform: "capitalize" }}>{g.day}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {g.items.map((a) => {
              const cancelled = a.status === "CANCELLED";
              return (
                <button key={a.id} onClick={() => onAppt(a)} className="card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 14, textAlign: "left", cursor: "pointer", border: "1px solid var(--hairline)", width: "100%", opacity: cancelled ? 0.55 : 1 }}>
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
      ))}
    </>
  );
}

// ------------------------- B4: rejilla día/semana -------------------------
type GridColumn = { key: string; label: string; sublabel?: string; isToday?: boolean };
function CalendarGrid({
  columns, eventsForColumn, startH, endH, showNow, nowColumnKey, onSlot, onAppt, narrow,
}: {
  columns: GridColumn[];
  dayForColumn: (key: string) => Date;
  eventsForColumn: (key: string) => Appt[];
  startH: number;
  endH: number;
  showNow: boolean;
  nowColumnKey?: string;
  onSlot: (colKey: string, hour: number) => void;
  onAppt: (a: Appt) => void;
  narrow: boolean;
}) {
  const hours = Array.from({ length: endH - startH }, (_, i) => startH + i);
  const gridH = (endH - startH) * HOUR_PX;
  const now = new Date();
  const nowTop = (now.getHours() * 60 + now.getMinutes() - startH * 60) / 60 * HOUR_PX;
  const nowVisible = showNow && nowTop >= 0 && nowTop <= gridH;
  const colMinWidth = narrow ? 128 : 0;

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", overflowX: "auto" }}>
        {/* Eje de horas */}
        <div style={{ flexShrink: 0, width: 48, borderRight: "1px solid var(--hairline)", paddingTop: 34 }}>
          {hours.map((h) => (
            <div key={h} style={{ height: HOUR_PX, position: "relative" }}>
              <span className="text-dim" style={{ position: "absolute", top: -7, right: 6, fontSize: 10.5, fontVariantNumeric: "tabular-nums" }}>{String(h).padStart(2, "0")}:00</span>
            </div>
          ))}
        </div>
        {/* Columnas */}
        <div style={{ display: "flex", flex: 1, minWidth: 0 }}>
          {columns.map((col) => {
            const events = eventsForColumn(col.key).slice().sort((a, b) => a.startsAt.localeCompare(b.startsAt));
            const colIsNow = nowVisible && (nowColumnKey === undefined || nowColumnKey === col.key);
            return (
              <div key={col.key} style={{ flex: 1, minWidth: colMinWidth, borderRight: "1px solid var(--hairline)", position: "relative" }}>
                {/* Encabezado de columna */}
                <div style={{ height: 34, display: "flex", alignItems: "center", justifyContent: "center", gap: 5, borderBottom: "1px solid var(--hairline)", fontSize: 12.5, fontWeight: 600, position: "sticky", top: 0, background: "var(--surface-solid)", textTransform: "capitalize" }}>
                  {col.label}
                  {col.sublabel ? <span style={{ fontSize: 12, fontWeight: 700, color: col.isToday ? "var(--acc-deep)" : "var(--ink-dim)", background: col.isToday ? "var(--acc-dim)" : "transparent", borderRadius: 999, padding: col.isToday ? "0 6px" : 0 }}>{col.sublabel}</span> : null}
                </div>
                {/* Rejilla horaria (clic = crear) */}
                <div style={{ position: "relative", height: gridH }}>
                  {hours.map((h) => (
                    <button key={h} onClick={() => onSlot(col.key, h)} title={`Agendar ${String(h).padStart(2, "0")}:00`} style={{ display: "block", width: "100%", height: HOUR_PX, border: "none", borderBottom: "1px solid var(--hairline)", background: "transparent", cursor: "pointer", padding: 0 }} />
                  ))}
                  {/* Línea AHORA */}
                  {colIsNow ? (
                    <div style={{ position: "absolute", top: nowTop, left: 0, right: 0, height: 2, background: "var(--acc)", zIndex: 3, pointerEvents: "none" }}>
                      <span style={{ position: "absolute", left: 0, top: -4, width: 7, height: 7, borderRadius: "50%", background: "var(--acc)" }} />
                    </div>
                  ) : null}
                  {/* Citas */}
                  {events.map((a) => {
                    const top = (minsOf(a.startsAt) - startH * 60) / 60 * HOUR_PX;
                    const dur = Math.max(18, (minsOf(a.endsAt) - minsOf(a.startsAt)) / 60 * HOUR_PX - 2);
                    const cancelled = a.status === "CANCELLED";
                    const color = STATUS_COLOR[a.status] ?? "var(--acc-deep)";
                    return (
                      <button
                        key={a.id}
                        onClick={(e) => { e.stopPropagation(); onAppt(a); }}
                        title={`${hhmm(a.startsAt)} · ${a.contact.name}`}
                        style={{
                          position: "absolute", top, left: 3, right: 3, height: dur, overflow: "hidden", textAlign: "left", cursor: "pointer",
                          borderRadius: 8, border: "none", borderLeft: `3px solid ${color}`, padding: "3px 6px", zIndex: 2,
                          background: cancelled ? "color-mix(in srgb, var(--ink) 8%, transparent)" : "color-mix(in srgb, var(--acc) 15%, var(--surface-solid))",
                          opacity: cancelled ? 0.55 : 1,
                        }}
                      >
                        <span style={{ display: "block", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: cancelled ? "line-through" : "none" }}>{hhmm(a.startsAt)} {a.contact.name}</span>
                        {dur > 30 ? <span className="text-dim" style={{ display: "block", fontSize: 10.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{[a.serviceName, a.professionalName].filter(Boolean).join(" · ") || "Cita"}</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
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

function NewAppointment({ onClose, onCreated, prefill }: { onClose: () => void; onCreated: () => void; prefill?: Prefill | null }) {
  const [pros, setPros] = useState<Pro[]>([]);
  const [svcs, setSvcs] = useState<Svc[]>([]);
  const [cq, setCq] = useState("");
  const [cResults, setCResults] = useState<ContactLite[]>([]);
  const [contact, setContact] = useState<ContactLite | null>(null);
  const [proId, setProId] = useState(prefill?.professionalId ?? "");
  const [svcId, setSvcId] = useState("");
  const [date, setDate] = useState(prefill?.date ?? "");
  const [time, setTime] = useState(prefill?.time ?? "");
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
