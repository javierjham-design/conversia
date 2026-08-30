"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button, Modal, Select, cn, useToast } from "@/components/ui";

const DAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
const DAYS_LONG = ["Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado"];
type Block = { day: number; start: string; end: string };
type Prof = { id: string; name: string; specialty: string | null; type?: "persona" | "servicio"; durationMin?: number | null; workingHours: Block[] };
type Slot = { professionalId: string; start: string; end: string };
type AvailResponse = { source: string; slots: Slot[] };
type Svc = { id: string; code: string; name: string; durationMin: number; price: number | null; currency: string };
type Appt = { id: string; status: string; startsAt: string; endsAt: string; notes: string | null; contact: { name: string; phone: string | null }; professionalId: string | null; professionalName?: string | null; serviceId?: string | null; serviceName?: string | null };
type ApptsResponse = { source: string; live: boolean; appointments: Appt[] };
type ColorRef = { id: string; name: string };
type Status = { provider: string; external: boolean };
type Config = { slotStepMin: number; bufferMin: number; minAdvanceMin: number };

const input = "rounded-control border border-line-strong bg-panel px-2 py-1 text-sm text-ink";
const TAB_LABELS: Record<string, string> = { citas: "Citas", personas: "Recursos", servicios: "Servicios", config: "Configuración" };

// Paleta por persona — clases literales para que Tailwind las incluya en el build.
const PALETTE = [
  { band: "bg-violet-500/10", block: "bg-violet-500 border-violet-600", dot: "bg-violet-500", soft: "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300" },
  { band: "bg-emerald-500/10", block: "bg-emerald-500 border-emerald-600", dot: "bg-emerald-500", soft: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" },
  { band: "bg-sky-500/10", block: "bg-sky-500 border-sky-600", dot: "bg-sky-500", soft: "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300" },
  { band: "bg-amber-500/10", block: "bg-amber-500 border-amber-600", dot: "bg-amber-500", soft: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" },
  { band: "bg-rose-500/10", block: "bg-rose-500 border-rose-600", dot: "bg-rose-500", soft: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300" },
  { band: "bg-teal-500/10", block: "bg-teal-500 border-teal-600", dot: "bg-teal-500", soft: "bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300" },
];
const palOf = (profId: string | null, refs: ColorRef[]) => {
  if (!profId) return PALETTE[0];
  const i = refs.findIndex((p) => p.id === profId);
  return PALETTE[((i < 0 ? 0 : i) % PALETTE.length + PALETTE.length) % PALETTE.length];
};

const HOUR_H = 56; // px por hora
const PX_MIN = HOUR_H / 60;
const pad = (n: number) => String(n).padStart(2, "0");
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const minsOf = (d: Date) => d.getHours() * 60 + d.getMinutes();
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export default function AgendaPage() {
  const [tab, setTab] = useState<"citas" | "personas" | "servicios" | "config">("citas");
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    void api<Status>("/agenda/status").then(setStatus).catch(() => setStatus(null));
  }, []);

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-xl font-semibold">Agenda</h1>
        {status?.external ? (
          <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50/60 p-3 text-sm text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/5 dark:text-sky-300">
            Tu agenda está conectada a <b>{status.provider}</b>. Las citas y la disponibilidad se gestionan allá; aquí verás lo que sincronice.
          </div>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">Agenda nativa de TuBot: define recursos (personas o servicios: box, sala, equipo…), sus horarios y los servicios que ofreces; el bot busca disponibilidad y agenda solo.</p>
        )}

        <div className="mt-4 flex gap-1 border-b border-line">
          {(["citas", "personas", "servicios", "config"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cn("border-b-2 px-3 py-2 text-sm font-medium", tab === t ? "border-brand-600 text-brand-700 dark:text-brand-300" : "border-transparent text-ink-subtle hover:text-ink")}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        <div className="mt-4">
          {tab === "citas" && <Citas />}
          {tab === "personas" && <Personas />}
          {tab === "servicios" && <Servicios />}
          {tab === "config" && <Configuracion />}
        </div>
      </div>
    </div>
  );
}

// ------------------------------ Citas (calendario) ------------------------------
const VIEW_LABELS: Record<string, string> = { semana: "Semana", dia: "Día", lista: "Lista" };

function Citas() {
  const [appts, setAppts] = useState<Appt[] | null>(null);
  const [meta, setMeta] = useState<{ source: string; live: boolean }>({ source: "native", live: false });
  const [pros, setPros] = useState<Prof[]>([]);
  const [svcs, setSvcs] = useState<Svc[]>([]);
  const [avail, setAvail] = useState<Slot[]>([]);
  const [view, setView] = useState<"semana" | "dia" | "lista">("semana");
  const [anchor, setAnchor] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<null | { date?: Date; appt?: Appt; profId?: string }>(null);

  const weekStart = useMemo(() => { const d = new Date(anchor); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d; }, [anchor]);
  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => { const d = new Date(weekStart); d.setDate(d.getDate() + i); return d; }), [weekStart]);

  const load = useCallback(() => {
    const base = view === "dia" ? anchor : weekStart;
    const from = new Date(base); from.setDate(from.getDate() - 1);
    const to = new Date(base); to.setDate(to.getDate() + (view === "dia" ? 2 : 8));
    const range = `from=${from.toISOString()}&to=${to.toISOString()}`;
    return Promise.all([
      api<ApptsResponse>(`/agenda/appointments?${range}`)
        .then((r) => { setAppts(r.appointments ?? []); setMeta({ source: r.source ?? "native", live: !!r.live }); })
        .catch(() => { setAppts([]); setMeta({ source: "native", live: false }); }),
      api<Prof[]>("/agenda/professionals").then(setPros).catch(() => {}),
      api<Svc[]>("/agenda/services").then(setSvcs).catch(() => {}),
      // Disponibilidad (huecos libres) para pintar la franja disponible en Semana y Día.
      view === "lista"
        ? Promise.resolve(setAvail([]))
        : api<AvailResponse>(`/agenda/availability?${range}`).then((r) => setAvail(r.slots ?? [])).catch(() => setAvail([])),
    ]);
  }, [weekStart, anchor, view]);
  useEffect(() => void load(), [load]);

  // Referencia de color/leyenda por profesional: personas nativas si las hay;
  // si la agenda viene del proveedor externo (Cláriva), se derivan de las citas.
  const colorRefs = useMemo<ColorRef[]>(() => {
    if (pros.length) return pros.map((p) => ({ id: p.id, name: p.name }));
    const seen = new Map<string, string>();
    for (const a of appts ?? []) if (a.professionalId && !seen.has(a.professionalId)) seen.set(a.professionalId, a.professionalName || "Profesional");
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [pros, appts]);

  // Filtro por profesional (chips): las citas de profesionales ocultos no se muestran.
  const visible = useMemo(() => (appts ?? []).filter((a) => !hidden.has(a.professionalId ?? "")), [appts, hidden]);
  const visibleRefs = useMemo(() => colorRefs.filter((r) => !hidden.has(r.id)), [colorRefs, hidden]);
  const visibleAvail = useMemo(() => avail.filter((s) => !hidden.has(s.professionalId)), [avail, hidden]);
  const toggle = (id: string) => setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // Rango horario visible: se ajusta a los horarios cargados + a las citas.
  const [rangeStart, rangeEnd] = useMemo(() => {
    let lo = 8 * 60, hi = 20 * 60;
    for (const p of pros) for (const b of p.workingHours ?? []) { lo = Math.min(lo, toMin(b.start)); hi = Math.max(hi, toMin(b.end)); }
    for (const a of appts ?? []) { lo = Math.min(lo, minsOf(new Date(a.startsAt))); hi = Math.max(hi, minsOf(new Date(a.endsAt))); }
    for (const s of avail) { lo = Math.min(lo, minsOf(new Date(s.start))); hi = Math.max(hi, minsOf(new Date(s.end))); }
    lo = Math.max(0, Math.floor(lo / 60) * 60);
    hi = Math.min(24 * 60, Math.ceil(hi / 60) * 60);
    if (hi - lo < 4 * 60) hi = Math.min(24 * 60, lo + 4 * 60);
    return [lo, hi];
  }, [pros, appts, avail]);
  const hours = useMemo(() => Array.from({ length: (rangeEnd - rangeStart) / 60 + 1 }, (_, i) => rangeStart / 60 + i), [rangeStart, rangeEnd]);
  const gridH = ((rangeEnd - rangeStart) / 60) * HOUR_H;

  const shift = (n: number) => setAnchor((a) => { const d = new Date(a); d.setDate(d.getDate() + n); return d; });
  const step = view === "dia" ? 1 : 7;
  const navLabel = view === "dia"
    ? anchor.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" })
    : `${week[0].toLocaleDateString("es-CL", { day: "numeric", month: "short" })} – ${week[6].toLocaleDateString("es-CL", { day: "numeric", month: "short", year: "numeric" })}`;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button onClick={() => shift(-step)} className="rounded-control border border-line px-2 py-1 text-sm text-ink-muted hover:bg-app" aria-label="Anterior">‹</button>
          <button onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setAnchor(d); }} className="rounded-control border border-line px-3 py-1 text-sm font-medium text-ink hover:bg-app">Hoy</button>
          <button onClick={() => shift(step)} className="rounded-control border border-line px-2 py-1 text-sm text-ink-muted hover:bg-app" aria-label="Siguiente">›</button>
          <span className="ml-2 text-sm font-medium capitalize text-ink">{navLabel}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex overflow-hidden rounded-control border border-line text-sm">
            {(["semana", "dia", "lista"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} className={cn("px-3 py-1", view === v ? "bg-brand-600 text-white" : "text-ink-muted hover:bg-app")}>{VIEW_LABELS[v]}</button>
            ))}
          </div>
          {!meta.live && <Button onClick={() => setModal({ date: new Date() })}>＋ Nueva cita</Button>}
        </div>
      </div>

      {meta.live && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-pill bg-emerald-50 px-2.5 py-1 text-2xs font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> En vivo desde {meta.source === "clariva" ? "Cláriva" : meta.source === "dentalink" ? "Dentalink" : meta.source}
          </span>
          <span className="text-2xs text-ink-subtle">Las citas se gestionan en {meta.source === "clariva" ? "Cláriva" : "el proveedor"} o las agenda el bot; aquí las ves en tiempo real.</span>
        </div>
      )}

      {colorRefs.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {colorRefs.map((p) => {
            const off = hidden.has(p.id);
            return (
              <button key={p.id} onClick={() => toggle(p.id)} title={off ? "Mostrar" : "Ocultar"} className={cn("inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5 text-xs transition", off ? "border-line text-ink-subtle line-through opacity-60" : "border-line-strong text-ink-muted hover:bg-app")}>
                <span className={cn("h-2.5 w-2.5 rounded-full", palOf(p.id, colorRefs).dot, off && "opacity-40")} />{p.name}
              </button>
            );
          })}
          {hidden.size > 0 && <button onClick={() => setHidden(new Set())} className="ml-1 text-2xs text-brand-700 hover:underline dark:text-brand-300">Ver todos</button>}
        </div>
      )}

      {view !== "lista" && (
        <p className="mb-2 flex items-center gap-3 text-2xs text-ink-subtle">
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-3 rounded-sm bg-emerald-500/20 ring-1 ring-inset ring-emerald-500/30" /> Disponible</span>
          <span className="inline-flex items-center gap-1"><span className="h-2.5 w-3 rounded-sm bg-violet-500" /> Cita agendada</span>
          <span className="text-ink-subtle/70">· vista Día = cada profesional por separado</span>
        </p>
      )}

      {appts === null ? (
        <p className="text-sm text-ink-subtle">Cargando…</p>
      ) : view === "lista" ? (
        <ListaCitas appts={visible} refs={colorRefs} onOpen={(a) => setModal({ appt: a })} />
      ) : view === "dia" ? (
        <DiaView date={anchor} refs={visibleRefs} readOnly={meta.live} gridH={gridH} hours={hours} rangeStart={rangeStart} appts={visible.filter((a) => sameDay(new Date(a.startsAt), anchor))} avail={visibleAvail.filter((s) => sameDay(new Date(s.start), anchor))} onSlot={(date, profId) => setModal({ date, profId })} onAppt={(a) => setModal({ appt: a })} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <div className="min-w-[720px]">
            {/* cabecera de días */}
            <div className="grid border-b border-line" style={{ gridTemplateColumns: `48px repeat(7, 1fr)` }}>
              <div />
              {week.map((d, i) => {
                const today = sameDay(d, new Date());
                return (
                  <div key={i} className={cn("border-l border-line px-1 py-1.5 text-center", today && "bg-brand-500/5")}>
                    <div className="text-2xs uppercase text-ink-subtle">{DAYS[d.getDay()]}</div>
                    <div className={cn("mx-auto mt-0.5 flex h-6 w-6 items-center justify-center rounded-full text-sm font-semibold", today ? "bg-brand-600 text-white" : "text-ink")}>{d.getDate()}</div>
                  </div>
                );
              })}
            </div>
            {/* cuerpo */}
            <div className="grid" style={{ gridTemplateColumns: `48px repeat(7, 1fr)` }}>
              {/* gutter horas */}
              <div className="relative" style={{ height: gridH }}>
                {hours.slice(0, -1).map((h, i) => (
                  <div key={h} className="absolute right-1 text-2xs tabular-nums text-ink-subtle" style={{ top: i * HOUR_H - 6 }}>{pad(h)}:00</div>
                ))}
              </div>
              {week.map((d, di) => (
                <DayColumn key={di} date={d} gridH={gridH} hours={hours} rangeStart={rangeStart} refs={colorRefs} readOnly={meta.live} appts={visible.filter((a) => sameDay(new Date(a.startsAt), d))} avail={visibleAvail.filter((s) => sameDay(new Date(s.start), d))} onSlot={(date) => setModal({ date })} onAppt={(a) => setModal({ appt: a })} />
              ))}
            </div>
          </div>
        </div>
      )}

      {modal && <ApptModal init={modal} pros={pros} svcs={svcs} readOnly={meta.live} onClose={() => setModal(null)} onSaved={() => { setModal(null); void load(); }} />}
    </div>
  );
}

// Vista "Día": una columna por profesional/recurso (des-mezclada, estilo Cláriva).
function DiaView({ date, refs, readOnly, gridH, hours, rangeStart, appts, avail, onSlot, onAppt }: { date: Date; refs: ColorRef[]; readOnly?: boolean; gridH: number; hours: number[]; rangeStart: number; appts: Appt[]; avail: Slot[]; onSlot: (d: Date, profId?: string) => void; onAppt: (a: Appt) => void }) {
  const cols = refs.length ? refs : [{ id: "", name: "Agenda" }];
  const tmpl = `48px repeat(${cols.length}, minmax(140px, 1fr))`;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-panel">
      <div style={{ minWidth: Math.max(480, 48 + cols.length * 150) }}>
        <div className="grid border-b border-line" style={{ gridTemplateColumns: tmpl }}>
          <div />
          {cols.map((c) => (
            <div key={c.id} className="flex items-center justify-center gap-1.5 border-l border-line px-2 py-2 text-center">
              <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", palOf(c.id || null, refs).dot)} />
              <span className="truncate text-xs font-medium text-ink">{c.name}</span>
            </div>
          ))}
        </div>
        <div className="grid" style={{ gridTemplateColumns: tmpl }}>
          <div className="relative" style={{ height: gridH }}>
            {hours.slice(0, -1).map((h, i) => (
              <div key={h} className="absolute right-1 text-2xs tabular-nums text-ink-subtle" style={{ top: i * HOUR_H - 6 }}>{pad(h)}:00</div>
            ))}
          </div>
          {cols.map((c) => (
            <ResourceColumn key={c.id} date={date} profId={c.id || null} refs={refs} gridH={gridH} hours={hours} rangeStart={rangeStart} readOnly={readOnly} appts={appts.filter((a) => (a.professionalId ?? "") === c.id)} avail={avail.filter((s) => s.professionalId === c.id)} onSlot={onSlot} onAppt={onAppt} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ResourceColumn({ date, profId, refs, gridH, hours, rangeStart, readOnly, appts, avail, onSlot, onAppt }: { date: Date; profId: string | null; refs: ColorRef[]; gridH: number; hours: number[]; rangeStart: number; readOnly?: boolean; appts: Appt[]; avail: Slot[]; onSlot: (d: Date, profId?: string) => void; onAppt: (a: Appt) => void }) {
  // Bandas VERDES = disponibilidad real (huecos libres de Cláriva o del motor nativo),
  // fusionando slots contiguos. Refleja el horario disponible de cada profesional/recurso.
  const bands = useMemo(() => {
    const ivs = avail.map((s) => [minsOf(new Date(s.start)), minsOf(new Date(s.end))] as [number, number]).sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const iv of ivs) { const last = merged[merged.length - 1]; if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else merged.push([...iv] as [number, number]); }
    return merged;
  }, [avail]);
  const laid = useMemo(() => {
    const sorted = [...appts].sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt));
    const laneEnds: number[] = [];
    const out = sorted.map((a) => {
      const s = +new Date(a.startsAt), e = +new Date(a.endsAt);
      let lane = laneEnds.findIndex((end) => end <= s);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(e); } else laneEnds[lane] = e;
      return { a, lane };
    });
    return { items: out, lanes: Math.max(1, laneEnds.length) };
  }, [appts]);
  const today = sameDay(date, new Date());
  const nowMin = minsOf(new Date());
  const pal = palOf(profId, refs);

  return (
    <div className={cn("relative border-l border-line", !readOnly && "cursor-pointer")} style={{ height: gridH }}
      onClick={(e) => {
        if (readOnly) return;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const y = e.clientY - rect.top;
        const min = Math.round((rangeStart + y / PX_MIN) / 15) * 15;
        const d = new Date(date); d.setHours(Math.floor(min / 60), min % 60, 0, 0);
        onSlot(d, profId ?? undefined);
      }}>
      {hours.slice(1).map((h, i) => (<div key={h} className="pointer-events-none absolute inset-x-0 border-t border-line/60" style={{ top: (i + 1) * HOUR_H }} />))}
      {bands.map(([s, e], i) => (
        <div key={i} className="pointer-events-none absolute inset-x-0.5 rounded bg-emerald-500/[0.12] ring-1 ring-inset ring-emerald-500/20" style={{ top: (s - rangeStart) * PX_MIN, height: (e - s) * PX_MIN }} title="Disponible" />
      ))}
      {today && nowMin >= rangeStart && (
        <div className="pointer-events-none absolute inset-x-0 z-10" style={{ top: (nowMin - rangeStart) * PX_MIN }}>
          <div className="relative"><span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-red-500" /><div className="border-t border-red-500" /></div>
        </div>
      )}
      {laid.items.map(({ a, lane }) => {
        const s = minsOf(new Date(a.startsAt)), e = minsOf(new Date(a.endsAt));
        const cancelled = a.status === "CANCELLED";
        const w = 100 / laid.lanes;
        return (
          <button key={a.id} onClick={(ev) => { ev.stopPropagation(); onAppt(a); }}
            className={cn("absolute overflow-hidden rounded-md border-l-4 px-1.5 py-1 text-left text-white shadow-sm transition hover:brightness-105", cancelled ? "border-line bg-app text-ink-subtle line-through" : pal.block)}
            style={{ top: (s - rangeStart) * PX_MIN + 1, height: Math.max(16, (e - s) * PX_MIN - 2), left: `calc(${lane * w}% + 2px)`, width: `calc(${w}% - 4px)` }}>
            <div className="truncate text-2xs font-semibold leading-tight tabular-nums">{pad(Math.floor(s / 60))}:{pad(s % 60)}</div>
            <div className="truncate text-xs font-medium leading-tight">{a.contact.name}</div>
          </button>
        );
      })}
    </div>
  );
}

function DayColumn({ date, gridH, hours, rangeStart, refs, readOnly, appts, avail, onSlot, onAppt }: { date: Date; gridH: number; hours: number[]; rangeStart: number; refs: ColorRef[]; readOnly?: boolean; appts: Appt[]; avail: Slot[]; onSlot: (d: Date) => void; onAppt: (a: Appt) => void }) {
  // Bandas VERDES = disponibilidad (unión de los huecos libres de todos los profesionales
  // ese día). Delimita disponible vs no disponible en la vista Semana.
  const bands = useMemo(() => {
    const ivs = avail.map((s) => [minsOf(new Date(s.start)), minsOf(new Date(s.end))] as [number, number]).sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const iv of ivs) { const last = merged[merged.length - 1]; if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]); else merged.push([...iv] as [number, number]); }
    return merged;
  }, [avail]);

  // layout de solapamientos en carriles
  const laid = useMemo(() => {
    const sorted = [...appts].sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt));
    const laneEnds: number[] = [];
    const out = sorted.map((a) => {
      const s = +new Date(a.startsAt), e = +new Date(a.endsAt);
      let lane = laneEnds.findIndex((end) => end <= s);
      if (lane === -1) { lane = laneEnds.length; laneEnds.push(e); } else laneEnds[lane] = e;
      return { a, lane };
    });
    return { items: out, lanes: Math.max(1, laneEnds.length) };
  }, [appts]);

  const today = sameDay(date, new Date());
  const nowMin = minsOf(new Date());

  return (
    <div className={cn("relative border-l border-line", today && "bg-brand-500/[0.03]", !readOnly && "cursor-pointer")} style={{ height: gridH }}
      onClick={(e) => {
        if (readOnly) return;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const y = e.clientY - rect.top;
        const min = Math.round((rangeStart + y / PX_MIN) / 15) * 15;
        const d = new Date(date); d.setHours(Math.floor(min / 60), min % 60, 0, 0);
        onSlot(d);
      }}>
      {/* líneas de hora */}
      {hours.slice(1).map((h, i) => (<div key={h} className="pointer-events-none absolute inset-x-0 border-t border-line/60" style={{ top: (i + 1) * HOUR_H }} />))}
      {/* bandas disponibles (verde) */}
      {bands.map(([s, e], i) => (
        <div key={i} className="pointer-events-none absolute inset-x-0.5 rounded bg-emerald-500/[0.12] ring-1 ring-inset ring-emerald-500/20" style={{ top: (s - rangeStart) * PX_MIN, height: (e - s) * PX_MIN }} title="Disponible" />
      ))}
      {/* línea "ahora" */}
      {today && nowMin >= rangeStart && (
        <div className="pointer-events-none absolute inset-x-0 z-10" style={{ top: (nowMin - rangeStart) * PX_MIN }}>
          <div className="relative"><span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-red-500" /><div className="border-t border-red-500" /></div>
        </div>
      )}
      {/* citas */}
      {laid.items.map(({ a, lane }) => {
        const s = minsOf(new Date(a.startsAt)), e = minsOf(new Date(a.endsAt));
        const pal = palOf(a.professionalId, refs);
        const cancelled = a.status === "CANCELLED";
        const w = 100 / laid.lanes;
        return (
          <button key={a.id} onClick={(ev) => { ev.stopPropagation(); onAppt(a); }}
            className={cn("absolute overflow-hidden rounded-md border-l-4 px-1.5 py-1 text-left text-white shadow-sm transition hover:brightness-105", cancelled ? "border-line bg-app text-ink-subtle line-through" : pal.block)}
            style={{ top: (s - rangeStart) * PX_MIN + 1, height: Math.max(16, (e - s) * PX_MIN - 2), left: `calc(${lane * w}% + 2px)`, width: `calc(${w}% - 4px)` }}>
            <div className="truncate text-2xs font-semibold leading-tight tabular-nums">{pad(Math.floor(s / 60))}:{pad(s % 60)}</div>
            <div className="truncate text-xs font-medium leading-tight">{a.contact.name}</div>
          </button>
        );
      })}
    </div>
  );
}

function ListaCitas({ appts, refs, onOpen }: { appts: Appt[] | null; refs: ColorRef[]; onOpen: (a: Appt) => void }) {
  if (!appts) return <p className="text-sm text-ink-subtle">Cargando…</p>;
  if (!appts.length) return <p className="text-sm text-ink-subtle">No hay citas en esta semana. Usa “＋ Nueva cita” o deja que el bot agende.</p>;
  const byDay = new Map<string, Appt[]>();
  for (const a of appts) {
    const d = new Date(a.startsAt).toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" });
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(a);
  }
  return (
    <div className="space-y-4">
      {[...byDay.entries()].map(([day, list]) => (
        <div key={day}>
          <p className="mb-1 text-xs font-semibold uppercase text-ink-subtle">{day}</p>
          <div className="space-y-1">
            {list.map((a) => {
              const pal = palOf(a.professionalId, refs);
              return (
                <button key={a.id} onClick={() => onOpen(a)} className="flex w-full items-center justify-between rounded-lg border border-line bg-panel px-3 py-2 text-left text-sm hover:bg-app">
                  <div className="flex items-center gap-2">
                    <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", pal.dot)} />
                    <span className="font-medium tabular-nums">{new Date(a.startsAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="text-ink">{a.contact.name}</span>
                    {a.professionalName && <span className="text-ink-subtle">· {a.professionalName}</span>}
                    {a.notes && <span className="text-ink-subtle">· {a.notes}</span>}
                  </div>
                  <span className={cn("rounded-pill px-2 py-0.5 text-2xs font-medium", a.status === "CANCELLED" ? "bg-red-50 text-red-600 dark:bg-red-500/10" : a.status === "CONFIRMED" ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10" : "bg-app text-ink-muted")}>{a.status}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------ Modal Nueva/Editar cita ------------------------------
function ApptModal({ init, pros, svcs, readOnly, onClose, onSaved }: { init: { date?: Date; appt?: Appt; profId?: string }; pros: Prof[]; svcs: Svc[]; readOnly?: boolean; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const editing = !!init.appt;

  if (readOnly && init.appt) {
    const a = init.appt;
    const start = new Date(a.startsAt), end = new Date(a.endsAt);
    const fmt = (d: Date) => d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" });
    return (
      <Modal open onClose={onClose} title="Cita">
        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-line bg-app px-3 py-2">
            <span className="font-medium">{a.contact.name}</span>
            {a.contact.phone && <span className="ml-2 text-ink-subtle">{a.contact.phone}</span>}
            <span className={cn("ml-2 rounded-pill px-2 py-0.5 text-2xs", a.status === "CANCELLED" ? "bg-red-50 text-red-600" : a.status === "CONFIRMED" ? "bg-emerald-50 text-emerald-600" : "bg-panel text-ink-muted")}>{a.status}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div><p className="text-ink-subtle">Fecha</p><p className="text-ink">{start.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" })}</p></div>
            <div><p className="text-ink-subtle">Horario</p><p className="tabular-nums text-ink">{fmt(start)} – {fmt(end)}</p></div>
            {a.professionalName && <div><p className="text-ink-subtle">Profesional</p><p className="text-ink">{a.professionalName}</p></div>}
            {a.serviceName && <div><p className="text-ink-subtle">Servicio</p><p className="text-ink">{a.serviceName}</p></div>}
          </div>
          {a.notes && <div className="text-xs"><p className="text-ink-subtle">Notas</p><p className="text-ink">{a.notes}</p></div>}
          <p className="text-2xs text-ink-subtle">Esta cita se gestiona en el proveedor conectado. Para reprogramar o cancelar, hazlo allí (o el bot lo hará en vivo).</p>
          <div className="flex justify-end"><Button variant="secondary" onClick={onClose}>Cerrar</Button></div>
        </div>
      </Modal>
    );
  }
  const base = init.appt ? new Date(init.appt.startsAt) : init.date ?? new Date();
  const [contact, setContact] = useState<{ id: string; name: string } | null>(init.appt ? { id: "", name: init.appt.contact.name } : null);
  const [profId, setProfId] = useState(init.appt?.professionalId ?? init.profId ?? "");
  const [svcId, setSvcId] = useState(init.appt?.serviceId ?? "");
  const [date, setDate] = useState(`${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`);
  const [time, setTime] = useState(`${pad(base.getHours())}:${pad(base.getMinutes())}`);
  const initialDur = init.appt ? Math.round((+new Date(init.appt.endsAt) - +new Date(init.appt.startsAt)) / 60000) : 30;
  const [dur, setDur] = useState(initialDur);
  const [notes, setNotes] = useState(init.appt?.notes ?? "");
  const [busy, setBusy] = useState(false);

  function pickService(id: string) { setSvcId(id); const s = svcs.find((x) => x.id === id); if (s) setDur(s.durationMin); }

  async function save() {
    if (!editing && !contact) { toast.push("Elige un contacto", "error"); return; }
    setBusy(true);
    try {
      const start = new Date(`${date}T${time}:00`);
      const end = new Date(start.getTime() + dur * 60000);
      if (editing && init.appt) {
        await api(`/agenda/appointments/${init.appt.id}`, { method: "PATCH", body: JSON.stringify({ startsAt: start.toISOString(), endsAt: end.toISOString(), notes }) });
      } else {
        await api("/agenda/appointments", { method: "POST", body: JSON.stringify({ contactId: contact!.id, professionalId: profId || undefined, serviceId: svcId || undefined, startsAt: start.toISOString(), endsAt: end.toISOString(), notes: notes || undefined }) });
      }
      toast.push(editing ? "Cita actualizada" : "Cita creada", "ok");
      onSaved();
    } catch (e) { toast.push((e as Error).message, "error"); } finally { setBusy(false); }
  }
  async function setStatus(status: string) {
    if (!init.appt) return;
    setBusy(true);
    try { await api(`/agenda/appointments/${init.appt.id}`, { method: "PATCH", body: JSON.stringify({ status }) }); toast.push("Listo", "ok"); onSaved(); }
    catch (e) { toast.push((e as Error).message, "error"); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={editing ? "Cita" : "Nueva cita"}>
      <div className="space-y-3">
        {editing ? (
          <div className="rounded-lg border border-line bg-app px-3 py-2 text-sm">
            <span className="font-medium">{init.appt!.contact.name}</span>
            {init.appt!.contact.phone && <span className="ml-2 text-ink-subtle">{init.appt!.contact.phone}</span>}
            <span className={cn("ml-2 rounded-pill px-2 py-0.5 text-2xs", init.appt!.status === "CANCELLED" ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-600")}>{init.appt!.status}</span>
          </div>
        ) : (
          <ContactPicker value={contact} onChange={setContact} />
        )}

        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-ink-muted">Recurso
            <Select className="mt-1 w-full" value={profId} onChange={(e) => setProfId(e.target.value)} disabled={editing}>
              <option value="">— cualquiera —</option>
              {pros.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
          <label className="text-xs text-ink-muted">Servicio
            <Select className="mt-1 w-full" value={svcId} onChange={(e) => pickService(e.target.value)} disabled={editing}>
              <option value="">— ninguno —</option>
              {svcs.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.durationMin}m</option>)}
            </Select>
          </label>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <label className="text-xs text-ink-muted">Fecha<input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={cn(input, "mt-1 w-full")} /></label>
          <label className="text-xs text-ink-muted">Hora<input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={cn(input, "mt-1 w-full")} /></label>
          <label className="text-xs text-ink-muted">Duración (min)<input type="number" min={5} step={5} value={dur} onChange={(e) => setDur(Number(e.target.value))} className={cn(input, "mt-1 w-full")} /></label>
        </div>

        <label className="block text-xs text-ink-muted">Notas<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={cn(input, "mt-1 w-full resize-none")} placeholder="Opcional" /></label>

        <div className="flex items-center justify-between gap-2 pt-1">
          {editing && init.appt!.status !== "CANCELLED" ? (
            <button onClick={() => void setStatus("CANCELLED")} disabled={busy} className="text-sm text-red-600 hover:underline disabled:opacity-50">Cancelar cita</button>
          ) : <span />}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cerrar</Button>
            <Button onClick={() => void save()} disabled={busy}>{busy ? "Guardando…" : editing ? "Guardar" : "Crear cita"}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ContactPicker({ value, onChange }: { value: { id: string; name: string } | null; onChange: (c: { id: string; name: string } | null) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ id: string; name: string; phone: string | null }>>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api<{ items: Array<{ id: string; firstName: string | null; lastName: string | null; phone: string | null }> }>(`/contacts?q=${encodeURIComponent(q)}&pageSize=8`)
        .then((r) => setResults(r.items.map((c) => ({ id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.phone || "Sin nombre", phone: c.phone }))))
        .catch(() => setResults([]));
    }, 250);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [q, open]);

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-line bg-app px-3 py-2 text-sm">
        <span className="font-medium">{value.name}</span>
        <button onClick={() => onChange(null)} className="text-2xs text-ink-subtle hover:text-red-500">cambiar</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <label className="text-xs text-ink-muted">Contacto</label>
      <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder="Buscar por nombre o teléfono…" className={cn(input, "mt-1 w-full")} />
      {open && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-line bg-raised shadow-e2">
          {results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-subtle">{q ? "Sin resultados" : "Escribe para buscar…"}</p>
          ) : results.map((c) => (
            <button key={c.id} onClick={() => { onChange({ id: c.id, name: c.name }); setOpen(false); }} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-app">
              <span>{c.name}</span>{c.phone && <span className="text-2xs text-ink-subtle">{c.phone}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------ Recursos ------------------------------
type ResourcePatch = { workingHours?: Block[]; type?: "persona" | "servicio"; durationMin?: number };
function Personas() {
  const toast = useToast();
  const [pros, setPros] = useState<Prof[] | null>(null);
  const [name, setName] = useState("");
  const [type, setType] = useState<"persona" | "servicio">("persona");
  const load = useCallback(() => api<Prof[]>("/agenda/professionals").then(setPros).catch(() => setPros([])), []);
  useEffect(() => void load(), [load]);

  async function create() {
    if (!name.trim()) return;
    try { await api("/agenda/professionals", { method: "POST", body: JSON.stringify({ name: name.trim(), type, workingHours: [], ...(type === "servicio" ? { durationMin: 30 } : {}) }) }); setName(""); await load(); }
    catch (e) { toast.push((e as Error).message, "error"); }
  }
  async function savePatch(id: string, patch: ResourcePatch) {
    try { await api(`/agenda/professionals/${id}`, { method: "PUT", body: JSON.stringify(patch) }); toast.push("Guardado", "ok"); await load(); }
    catch (e) { toast.push((e as Error).message, "error"); }
  }
  async function remove(id: string) {
    if (!confirm("¿Quitar este recurso de la agenda?")) return;
    try { await api(`/agenda/professionals/${id}`, { method: "DELETE" }); await load(); } catch (e) { toast.push((e as Error).message, "error"); }
  }

  if (!pros) return <p className="text-sm text-ink-subtle">Cargando…</p>;
  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-subtle">Un recurso agendable puede ser una <b>persona</b> (Dra. Pérez, mecánico) o un <b>servicio</b> (cambio de aceite, box, sala, equipo). Cada uno tiene su propio <b>horario disponible</b>; el bot solo ofrece y agenda dentro de esos horarios.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={type} onChange={(e) => setType(e.target.value as "persona" | "servicio")}>
          <option value="persona">Persona</option>
          <option value="servicio">Servicio</option>
        </Select>
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} placeholder={type === "servicio" ? "Nombre del servicio (ej: Cambio de aceite)" : "Nombre de la persona (ej: Dra. Pérez)"} className={cn(input, "min-w-[220px] flex-1")} />
        <Button onClick={() => void create()}>Agregar recurso</Button>
      </div>
      {pros.map((p, i) => (
        <HoursEditor key={p.id} prof={p} color={PALETTE[i % PALETTE.length]} onSave={(patch) => void savePatch(p.id, patch)} onRemove={() => void remove(p.id)} />
      ))}
      {!pros.length && <p className="text-sm text-ink-subtle">Aún no hay recursos. Agrega el primero (una persona o un servicio) para que el bot pueda agendar con él.</p>}
    </div>
  );
}

function HoursEditor({ prof, color, onSave, onRemove }: { prof: Prof; color: (typeof PALETTE)[number]; onSave: (patch: ResourcePatch) => void; onRemove: () => void }) {
  const [blocks, setBlocks] = useState<Block[]>(prof.workingHours ?? []);
  const [type, setType] = useState<"persona" | "servicio">(prof.type ?? "persona");
  const [dur, setDur] = useState<number>(prof.durationMin ?? 30);
  const [dirty, setDirty] = useState(false);
  const add = (day: number) => { setBlocks((b) => [...b, { day, start: "09:00", end: "18:00" }]); setDirty(true); };
  const upd = (i: number, patch: Partial<Block>) => { setBlocks((b) => b.map((x, j) => (j === i ? { ...x, ...patch } : x))); setDirty(true); };
  const del = (i: number) => { setBlocks((b) => b.filter((_, j) => j !== i)); setDirty(true); };
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-2 font-medium text-ink"><span className={cn("h-2.5 w-2.5 rounded-full", color.dot)} />{prof.name}<span className="rounded-pill bg-app px-1.5 py-0.5 text-2xs text-ink-muted">{type === "servicio" ? "Servicio" : "Persona"}</span></p>
        <button onClick={onRemove} className="text-2xs text-red-600 hover:underline dark:text-red-400">Quitar</button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="text-xs text-ink-muted">Tipo
          <Select className="ml-1" value={type} onChange={(e) => { setType(e.target.value as "persona" | "servicio"); setDirty(true); }}>
            <option value="persona">Persona</option>
            <option value="servicio">Servicio</option>
          </Select>
        </label>
        <label className="text-xs text-ink-muted">Duración de cada cita (min)
          <input type="number" min={5} step={5} value={dur} onChange={(e) => { setDur(Number(e.target.value)); setDirty(true); }} className={cn(input, "ml-1 w-20")} />
        </label>
      </div>
      <div className="space-y-2">
        {DAYS_LONG.map((label, day) => {
          const dayBlocks = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.day === day);
          return (
            <div key={day} className="flex flex-wrap items-center gap-2">
              <span className="w-20 text-xs font-medium text-ink-muted">{label}</span>
              {dayBlocks.length === 0 && <span className="text-2xs text-ink-subtle">Cerrado</span>}
              {dayBlocks.map(({ b, i }) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-control bg-app px-1.5 py-0.5">
                  <input type="time" value={b.start} onChange={(e) => upd(i, { start: e.target.value })} className="bg-transparent text-xs text-ink" />
                  <span className="text-2xs text-ink-subtle">a</span>
                  <input type="time" value={b.end} onChange={(e) => upd(i, { end: e.target.value })} className="bg-transparent text-xs text-ink" />
                  <button onClick={() => del(i)} className="text-ink-subtle hover:text-red-500">×</button>
                </span>
              ))}
              <button onClick={() => add(day)} className="text-2xs text-brand-700 hover:underline dark:text-brand-300">+ bloque</button>
            </div>
          );
        })}
      </div>
      <div className="mt-3"><Button variant="secondary" onClick={() => { onSave({ workingHours: blocks, type, durationMin: dur }); setDirty(false); }} disabled={!dirty}>{dirty ? "Guardar" : "Guardado"}</Button></div>
    </div>
  );
}

// ------------------------------ Servicios ------------------------------
function Servicios() {
  const toast = useToast();
  const [svcs, setSvcs] = useState<Svc[] | null>(null);
  const [name, setName] = useState("");
  const [dur, setDur] = useState(30);
  const [price, setPrice] = useState("");
  const load = useCallback(() => api<Svc[]>("/agenda/services").then(setSvcs).catch(() => setSvcs([])), []);
  useEffect(() => void load(), [load]);
  async function create() {
    if (!name.trim()) return;
    try { await api("/agenda/services", { method: "POST", body: JSON.stringify({ name: name.trim(), durationMin: dur, ...(price ? { price: Number(price) } : {}) }) }); setName(""); setPrice(""); await load(); }
    catch (e) { toast.push((e as Error).message, "error"); }
  }
  async function remove(id: string) { try { await api(`/agenda/services/${id}`, { method: "DELETE" }); await load(); } catch (e) { toast.push((e as Error).message, "error"); } }
  if (!svcs) return <p className="text-sm text-ink-subtle">Cargando…</p>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} placeholder="Servicio (ej: Consulta)" className={cn(input, "flex-1")} />
        <label className="text-xs text-ink-muted">Duración (min) <input type="number" min={5} value={dur} onChange={(e) => setDur(Number(e.target.value))} className={cn(input, "ml-1 w-20")} /></label>
        <label className="text-xs text-ink-muted">Precio <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="opcional" className={cn(input, "ml-1 w-24")} /></label>
        <Button onClick={() => void create()}>Agregar servicio</Button>
      </div>
      <div className="space-y-1">
        {svcs.map((s) => (
          <div key={s.id} className="flex items-center justify-between rounded-lg border border-line bg-panel px-3 py-2 text-sm">
            <span>{s.name} <span className="text-ink-subtle">· {s.durationMin} min{s.price ? ` · $${s.price.toLocaleString("es-CL")}` : ""}</span></span>
            <button onClick={() => void remove(s.id)} className="text-2xs text-red-600 hover:underline dark:text-red-400">Quitar</button>
          </div>
        ))}
        {!svcs.length && <p className="text-sm text-ink-subtle">Sin servicios. Agrega los que ofreces (con su duración) para que el bot cotice y agende.</p>}
      </div>
    </div>
  );
}

// ------------------------------ Configuración ------------------------------
function Configuracion() {
  const toast = useToast();
  const [cfg, setCfg] = useState<Config | null>(null);
  useEffect(() => void api<Config>("/agenda/config").then(setCfg).catch(() => setCfg(null)), []);
  async function save() {
    if (!cfg) return;
    try { await api("/agenda/config", { method: "PUT", body: JSON.stringify(cfg) }); toast.push("Guardado", "ok"); }
    catch (e) { toast.push((e as Error).message, "error"); }
  }
  if (!cfg) return <p className="text-sm text-ink-subtle">Cargando…</p>;
  return (
    <div className="max-w-md space-y-4 rounded-xl border border-line bg-panel p-4">
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="text-ink">Bloque mínimo (granularidad, min)</span>
        <input type="number" min={5} value={cfg.slotStepMin} onChange={(e) => setCfg({ ...cfg, slotStepMin: Number(e.target.value) })} className={cn(input, "w-24")} />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="text-ink">Buffer entre citas (min)</span>
        <input type="number" min={0} value={cfg.bufferMin} onChange={(e) => setCfg({ ...cfg, bufferMin: Number(e.target.value) })} className={cn(input, "w-24")} />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="text-ink">Anticipación mínima para reservar (min)</span>
        <input type="number" min={0} value={cfg.minAdvanceMin} onChange={(e) => setCfg({ ...cfg, minAdvanceMin: Number(e.target.value) })} className={cn(input, "w-24")} />
      </label>
      <Button onClick={() => void save()}>Guardar configuración</Button>
    </div>
  );
}
