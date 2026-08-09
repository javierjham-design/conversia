"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, LifeBuoy, RotateCcw } from "lucide-react";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, useToast } from "@/components/ui";

interface Ticket {
  id: string;
  org: string;
  user: string | null;
  email: string | null;
  subject: string | null;
  message: string;
  url: string | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
}

type Filter = "open" | "resolved" | "all";

export default function AdminSupportPage() {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("open");
  const [data, setData] = useState<{ tickets: Ticket[]; openCount: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (f: Filter) => {
    setData(await padmin<{ tickets: Ticket[]; openCount: number }>(`/platform/support?status=${f}`));
  }, []);

  useEffect(() => {
    void load(filter).catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function setStatus(id: string, status: "open" | "resolved") {
    setBusy(id);
    try {
      await padmin(`/platform/support/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await load(filter);
      toast.push(status === "resolved" ? "Marcado como resuelto" : "Reabierto", "ok");
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-6 lg:px-8">
      <PageHeader
        title="Soporte"
        description="Reportes que envían los clientes desde su panel."
      />

      <div className="mb-4 flex gap-2">
        {(["open", "resolved", "all"] as Filter[]).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              filter === f ? "bg-brand-600 text-white" : "bg-white text-slate-600 hover:bg-slate-100"
            }`}
          >
            {f === "open" ? "Abiertos" : f === "resolved" ? "Resueltos" : "Todos"}
            {f === "open" && data && data.openCount > 0 && (
              <span className="ml-1.5 rounded-full bg-red-500 px-1.5 text-[11px] text-white">{data.openCount}</span>
            )}
          </button>
        ))}
      </div>

      {!data ? (
        <Skeleton className="h-64" />
      ) : data.tickets.length === 0 ? (
        <div className="rounded-card border border-slate-200 bg-white p-10 text-center text-slate-500">
          <LifeBuoy size={28} className="mx-auto mb-2 text-slate-300" />
          Sin tickets {filter === "open" ? "abiertos" : filter === "resolved" ? "resueltos" : ""}.
        </div>
      ) : (
        <ul className="space-y-3">
          {data.tickets.map((t) => (
            <li key={t.id} className="rounded-card border border-slate-200 bg-white p-4 shadow-card">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-semibold text-navy-900">{t.org}</span>
                {t.subject && <span className="text-sm text-slate-700">· {t.subject}</span>}
                {t.status === "resolved" ? (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">resuelto</span>
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700">abierto</span>
                )}
                <span className="ml-auto text-xs text-slate-400">
                  {new Date(t.createdAt).toLocaleString("es-CL", { dateStyle: "short", timeStyle: "short" })}
                </span>
              </div>
              <p className="whitespace-pre-wrap text-sm text-slate-700">{t.message}</p>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                {t.user && <span>👤 {t.user}</span>}
                {t.email && (
                  <a href={`mailto:${t.email}`} className="text-brand-600 hover:underline">
                    {t.email}
                  </a>
                )}
                {t.url && <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">{t.url}</span>}
                <span className="ml-auto">
                  {t.status === "open" ? (
                    <Button variant="secondary" disabled={busy === t.id} onClick={() => void setStatus(t.id, "resolved")}>
                      <Check size={14} className="mr-1" /> Resolver
                    </Button>
                  ) : (
                    <Button variant="secondary" disabled={busy === t.id} onClick={() => void setStatus(t.id, "open")}>
                      <RotateCcw size={14} className="mr-1" /> Reabrir
                    </Button>
                  )}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
