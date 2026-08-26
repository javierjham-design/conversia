"use client";

/** Horario de atención del negocio: default del nodo «Fecha y hora» de workflows. */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Checkbox, DateInput, Skeleton, useToast } from "@/components/ui";

type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
interface Interval { from: string; to: string }
interface Hours {
  timezone: string;
  hours: Partial<Record<DayKey, Interval[]>>;
  holidays: string[];
}

const DAYS: [DayKey, string][] = [
  ["mon", "Lunes"],
  ["tue", "Martes"],
  ["wed", "Miércoles"],
  ["thu", "Jueves"],
  ["fri", "Viernes"],
  ["sat", "Sábado"],
  ["sun", "Domingo"],
];

/** Feriados irrenunciables + comunes de Chile (precarga opcional). */
const FERIADOS_CHILE_2026 = [
  "2026-01-01", "2026-04-03", "2026-04-04", "2026-05-01", "2026-05-21", "2026-06-21", "2026-06-29",
  "2026-07-16", "2026-08-15", "2026-09-18", "2026-09-19", "2026-10-12", "2026-10-31", "2026-11-01",
  "2026-12-08", "2026-12-25",
];

export default function HoursSettingsPage() {
  const toast = useToast();
  const [data, setData] = useState<Hours | null>(null);
  const [newHoliday, setNewHoliday] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api<Hours>("/settings/hours").then(setData).catch(() => setData(null));
  }, []);

  async function save() {
    if (!data) return;
    setBusy(true);
    try {
      await api("/settings/hours", { method: "PUT", body: JSON.stringify({ hours: data.hours ?? {}, holidays: data.holidays ?? [] }) });
      toast.push("Horario guardado ✔", "ok");
    } catch (err) {
      toast.push((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="mx-auto max-w-4xl p-6"><Skeleton className="h-72" /></div>;

  const setDay = (day: DayKey, intervals: Interval[]) => setData({ ...data, hours: { ...(data.hours ?? {}), [day]: intervals } });

  return (
    <div className="mx-auto max-w-4xl p-6">
      <h2 className="text-lg font-semibold">Horario de atención</h2>
      <p className="mt-1 text-xs text-ink-muted">
        Horario del negocio en <code>{data.timezone}</code> (cámbiala en Información general). Lo usa el nodo «Fecha y
        hora» de los flujos como valor por defecto — cada nodo puede definir un horario propio que lo sobreescribe (p.
        ej. una campaña con horario especial). También está disponible para los agentes IA.
      </p>

      <div className="mt-4 space-y-2 rounded-card border border-line bg-panel p-5 shadow-card">
        {DAYS.map(([key, label]) => {
          const intervals = (data.hours ?? {})[key] ?? [];
          const open = intervals.length > 0;
          return (
            <div key={key} className="flex flex-wrap items-center gap-2 border-b border-line py-1.5 last:border-0">
              <label className="flex w-28 items-center gap-2 text-sm">
                <Checkbox
                  checked={open}
                  onChange={(e) => setDay(key, e.target.checked ? [{ from: "09:00", to: "19:00" }] : [])}
                />
                {label}
              </label>
              {open ? (
                intervals.map((iv, idx) => (
                  <span key={idx} className="flex items-center gap-1 text-sm">
                    <input type="time" value={iv.from} onChange={(e) => setDay(key, intervals.map((x, i) => (i === idx ? { ...x, from: e.target.value } : x)))} className="rounded-lg border border-line-strong px-2 py-1 text-xs" />
                    –
                    <input type="time" value={iv.to} onChange={(e) => setDay(key, intervals.map((x, i) => (i === idx ? { ...x, to: e.target.value } : x)))} className="rounded-lg border border-line-strong px-2 py-1 text-xs" />
                    {intervals.length > 1 && (
                      <button onClick={() => setDay(key, intervals.filter((_, i) => i !== idx))} className="text-ink-subtle hover:text-red-500">✕</button>
                    )}
                  </span>
                ))
              ) : (
                <span className="text-xs text-ink-subtle">Cerrado</span>
              )}
              {open && intervals.length < 3 && (
                <button onClick={() => setDay(key, [...intervals, { from: "15:00", to: "19:00" }])} className="text-[11px] text-brand-700 underline dark:text-brand-300">
                  + tramo
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Feriados (el negocio no atiende)</p>
          <Button
            variant="secondary"
            className="!py-1 text-xs"
            onClick={() => setData({ ...data, holidays: [...new Set([...data.holidays, ...FERIADOS_CHILE_2026])].sort() })}
          >
            Precargar feriados de Chile 2026
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(data.holidays ?? []).map((h) => (
            <span key={h} className="flex items-center gap-1 rounded-full bg-app px-2 py-0.5 text-xs text-ink-muted">
              {h}
              <button onClick={() => setData({ ...data, holidays: (data.holidays ?? []).filter((x) => x !== h) })} className="text-ink-subtle hover:text-red-500">✕</button>
            </span>
          ))}
          {data.holidays.length === 0 && <span className="text-xs text-ink-subtle">Sin feriados cargados.</span>}
        </div>
        <div className="mt-2 flex gap-2">
          <DateInput value={newHoliday} onChange={(e) => setNewHoliday(e.target.value)} className="text-xs" />
          <Button
            variant="ghost"
            onClick={() => {
              if (newHoliday && !data.holidays.includes(newHoliday)) setData({ ...data, holidays: [...data.holidays, newHoliday].sort() });
              setNewHoliday("");
            }}
          >
            Agregar feriado
          </Button>
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <Button onClick={() => void save()} disabled={busy}>Guardar cambios</Button>
      </div>
    </div>
  );
}
