"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, cn, useToast } from "@/components/ui";

const DAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
type Block = { day: number; start: string; end: string };
type Prof = { id: string; name: string; specialty: string | null; workingHours: Block[] };
type Svc = { id: string; code: string; name: string; durationMin: number; price: number | null; currency: string };
type Appt = { id: string; status: string; startsAt: string; endsAt: string; notes: string | null; contact: { name: string; phone: string | null }; professionalId: string | null };
type Status = { provider: string; external: boolean };
type Config = { slotStepMin: number; bufferMin: number; minAdvanceMin: number };

const input = "rounded-control border border-line-strong bg-panel px-2 py-1 text-sm text-ink";

export default function AgendaPage() {
  const toast = useToast();
  const [tab, setTab] = useState<"citas" | "personas" | "servicios" | "config">("citas");
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    void api<Status>("/agenda/status").then(setStatus).catch(() => setStatus(null));
  }, []);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <h1 className="text-xl font-semibold">Agenda</h1>
        {status?.external ? (
          <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50/60 p-3 text-sm text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/5 dark:text-sky-300">
            Tu agenda está conectada a <b>{status.provider}</b>. Las citas y la disponibilidad se gestionan allá; aquí verás lo que sincronice.
          </div>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">Agenda nativa de TuBot: define personas, horarios y servicios; el bot busca disponibilidad y agenda solo.</p>
        )}

        <div className="mt-4 flex gap-1 border-b border-line">
          {(["citas", "personas", "servicios", "config"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={cn("border-b-2 px-3 py-2 text-sm font-medium capitalize", tab === t ? "border-brand-600 text-brand-700 dark:text-brand-300" : "border-transparent text-ink-subtle hover:text-ink")}>
              {t === "config" ? "Configuración" : t}
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

function Citas() {
  const [appts, setAppts] = useState<Appt[] | null>(null);
  const load = useCallback(() => api<Appt[]>("/agenda/appointments").then(setAppts).catch(() => setAppts([])), []);
  useEffect(() => void load(), [load]);
  if (!appts) return <p className="text-sm text-ink-subtle">Cargando…</p>;
  if (!appts.length) return <p className="text-sm text-ink-subtle">No hay citas próximas. Cuando el bot (o el equipo) agende, aparecerán aquí.</p>;
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
            {list.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-lg border border-line bg-panel px-3 py-2 text-sm">
                <div>
                  <span className="font-medium tnum">{new Date(a.startsAt).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="ml-2 text-ink">{a.contact.name}</span>
                  {a.notes && <span className="ml-2 text-ink-subtle">· {a.notes}</span>}
                </div>
                <span className={cn("rounded-pill px-2 py-0.5 text-2xs font-medium", a.status === "CANCELLED" ? "bg-red-50 text-red-600 dark:bg-red-500/10" : a.status === "CONFIRMED" ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10" : "bg-app text-ink-muted")}>{a.status}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Personas() {
  const toast = useToast();
  const [pros, setPros] = useState<Prof[] | null>(null);
  const [name, setName] = useState("");
  const load = useCallback(() => api<Prof[]>("/agenda/professionals").then(setPros).catch(() => setPros([])), []);
  useEffect(() => void load(), [load]);

  async function create() {
    if (!name.trim()) return;
    try { await api("/agenda/professionals", { method: "POST", body: JSON.stringify({ name: name.trim(), workingHours: [] }) }); setName(""); await load(); }
    catch (e) { toast.push((e as Error).message, "error"); }
  }
  async function saveHours(id: string, workingHours: Block[]) {
    try { await api(`/agenda/professionals/${id}`, { method: "PUT", body: JSON.stringify({ workingHours }) }); toast.push("Horario guardado", "ok"); await load(); }
    catch (e) { toast.push((e as Error).message, "error"); }
  }
  async function remove(id: string) {
    if (!confirm("¿Quitar esta persona de la agenda?")) return;
    try { await api(`/agenda/professionals/${id}`, { method: "DELETE" }); await load(); } catch (e) { toast.push((e as Error).message, "error"); }
  }

  if (!pros) return <p className="text-sm text-ink-subtle">Cargando…</p>;
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nombre de la persona (ej: Dra. Pérez)" className={cn(input, "flex-1")} />
        <Button onClick={() => void create()}>Agregar persona</Button>
      </div>
      {pros.map((p) => (
        <HoursEditor key={p.id} prof={p} onSave={(wh) => void saveHours(p.id, wh)} onRemove={() => void remove(p.id)} />
      ))}
      {!pros.length && <p className="text-sm text-ink-subtle">Aún no hay personas. Agrega la primera para que el bot pueda agendar con ella.</p>}
    </div>
  );
}

function HoursEditor({ prof, onSave, onRemove }: { prof: Prof; onSave: (wh: Block[]) => void; onRemove: () => void }) {
  const [blocks, setBlocks] = useState<Block[]>(prof.workingHours ?? []);
  const add = (day: number) => setBlocks((b) => [...b, { day, start: "09:00", end: "18:00" }]);
  const upd = (i: number, patch: Partial<Block>) => setBlocks((b) => b.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const del = (i: number) => setBlocks((b) => b.filter((_, j) => j !== i));
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-medium text-ink">{prof.name}{prof.specialty ? <span className="ml-1 text-xs text-ink-subtle">· {prof.specialty}</span> : null}</p>
        <button onClick={onRemove} className="text-2xs text-red-600 hover:underline dark:text-red-400">Quitar</button>
      </div>
      <div className="space-y-2">
        {DAYS.map((label, day) => {
          const dayBlocks = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.day === day);
          return (
            <div key={day} className="flex flex-wrap items-center gap-2">
              <span className="w-10 text-xs font-medium text-ink-muted">{label}</span>
              {dayBlocks.length === 0 && <span className="text-2xs text-ink-subtle">—</span>}
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
      <div className="mt-3"><Button variant="secondary" onClick={() => onSave(blocks)}>Guardar horario</Button></div>
    </div>
  );
}

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
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Servicio (ej: Consulta)" className={cn(input, "flex-1")} />
        <label className="text-xs text-ink-muted">Duración (min) <input type="number" min={5} value={dur} onChange={(e) => setDur(Number(e.target.value))} className={cn(input, "ml-1 w-20")} /></label>
        <label className="text-xs text-ink-muted">Precio <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="opcional" className={cn(input, "ml-1 w-24")} /></label>
        <Button onClick={() => void create()}>Agregar</Button>
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
