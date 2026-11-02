"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CalendarClock, MessageSquare, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/components/ui";

type Row = {
  contactId: string;
  name: string;
  phone: string | null;
  conversationId: string;
  requestedAt: string;
  canceledSlot: { startsAt: string; professionalName: string | null } | null;
};
type Resp = { total: number; rows: Row[] };

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("es-CL", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

function hace(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "hace menos de 1 h";
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} día${d === 1 ? "" : "s"}`;
}

/**
 * "Pacientes por reagendar": pidieron reagendar (su hora se liberó al toque) y no
 * volvieron a tener hora. Lista aparte del CRM de leads. Solo lectura: se deriva de las
 * señales que ya deja el bot; el paciente sale solo apenas reagenda.
 */
export default function ReagendarPage() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api<Resp>("/agenda/pending-reschedule")
      .then((r) => {
        setData(r);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "No se pudo cargar"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = data?.rows ?? [];

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <CalendarClock size={20} className="text-brand-600" /> Pacientes por reagendar
            </h1>
            <p className="mt-1 text-sm text-ink-muted">
              Pidieron reagendar y su hora quedó liberada, pero todavía no tienen una hora nueva. Salen solos de esta lista apenas reagendan.
            </p>
          </div>
          <button
            onClick={load}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-control border border-line bg-panel px-3 py-1.5 text-sm text-ink-muted hover:text-ink"
            title="Actualizar"
          >
            <RefreshCw size={15} className={cn(loading && "animate-spin")} /> Actualizar
          </button>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50/60 p-3 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/5 dark:text-rose-300">
            {error}
          </div>
        )}

        {loading && !data ? (
          <p className="mt-6 text-sm text-ink-subtle">Cargando…</p>
        ) : rows.length === 0 ? (
          <div className="mt-6 rounded-xl border border-line bg-panel p-8 text-center">
            <p className="text-sm font-medium text-ink">No hay pacientes en el aire ✔</p>
            <p className="mt-1 text-xs text-ink-muted">
              Cuando alguien pida reagendar y no complete la hora nueva, aparecerá aquí para que lo contacten.
            </p>
          </div>
        ) : (
          <div className="mt-4 overflow-hidden rounded-xl border border-line bg-panel">
            <div className="border-b border-line px-4 py-2 text-xs text-ink-muted">
              {rows.length} paciente{rows.length === 1 ? "" : "s"} pendiente{rows.length === 1 ? "" : "s"} de reagendar
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-[11px] uppercase tracking-wide text-ink-subtle">
                  <tr className="border-b border-line">
                    <th className="px-4 py-2 font-medium">Paciente</th>
                    <th className="px-4 py-2 font-medium">Hora que se liberó</th>
                    <th className="px-4 py-2 font-medium">Pidió reagendar</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.contactId} className="border-b border-line/60 last:border-0">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-ink">{r.name}</div>
                        {r.phone && <div className="text-xs text-ink-subtle">{r.phone}</div>}
                      </td>
                      <td className="px-4 py-2.5 text-ink-muted">
                        {r.canceledSlot ? (
                          <>
                            <div>{fmtDateTime(r.canceledSlot.startsAt)}</div>
                            {r.canceledSlot.professionalName && <div className="text-xs text-ink-subtle">{r.canceledSlot.professionalName}</div>}
                          </>
                        ) : (
                          <span className="text-ink-subtle">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-ink-muted">{hace(r.requestedAt)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          href={`/inbox?c=${r.conversationId}`}
                          className="inline-flex items-center gap-1.5 rounded-control border border-line px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-brand-soft dark:text-brand-300"
                        >
                          <MessageSquare size={13} /> Abrir chat
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
