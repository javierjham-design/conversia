"use client";

import { useCallback, useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { padmin } from "@/lib/platform-api";
import { Button, useToast } from "@/components/ui";

interface OrgMessaging {
  override: number | null;
  default: number;
  effective: number;
  today: number;
  clpPerMsg: { marketing: number; utility: number };
}

const clp = (n: number) => `$${Math.round(n).toLocaleString("es-CL")}`;

/** Tope de mensajería propio del tenant (override del default de plataforma). */
export function MessagingCapCard({ orgId }: { orgId: string }) {
  const toast = useToast();
  const [d, setD] = useState<OrgMessaging | null>(null);
  const [value, setValue] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await padmin<OrgMessaging>(`/platform/organizations/${orgId}/messaging`);
    setD(r);
    setValue(r.override != null ? String(r.override) : "");
  }, [orgId]);

  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  async function save(dailyCap: number | null) {
    setBusy(true);
    try {
      await padmin(`/platform/organizations/${orgId}/messaging-cap`, { method: "PATCH", body: JSON.stringify({ dailyCap }) });
      toast.push(dailyCap === null ? "Tope propio quitado (usa el default) ✔" : "Tope del tenant actualizado ✔", "ok");
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!d) return null;
  const n = Number(value);
  const validN = Number.isFinite(n) && n > 0;

  return (
    <div className="rounded-card border border-slate-200 bg-white p-5 shadow-card">
      <div className="mb-1 flex items-center gap-2">
        <Gauge size={18} className="text-brand-600" />
        <h3 className="font-semibold text-navy-900">Límite de mensajería (plantillas/día)</h3>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Tope propio de este tenant. Vacío = usa el default de plataforma ({d.default.toLocaleString("es-CL")}). Solo afecta plantillas (las que cuestan).
      </p>

      <div className="mb-3 grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <p className="text-[11px] uppercase text-slate-400">Tope efectivo hoy</p>
          <p className="font-semibold text-navy-900">{d.effective.toLocaleString("es-CL")}{d.override == null && <span className="ml-1 text-[11px] font-normal text-slate-400">(default)</span>}</p>
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <p className="text-[11px] uppercase text-slate-400">Consumo de hoy</p>
          <p className="font-semibold text-navy-900">{d.today.toLocaleString("es-CL")} / {d.effective.toLocaleString("es-CL")}</p>
        </div>
      </div>

      <label className="block text-sm text-slate-600">Tope propio</label>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="number"
          min={1}
          placeholder={`default ${d.default}`}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-36 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <Button disabled={busy || !validN} onClick={() => void save(n)}>Guardar</Button>
        {d.override != null && (
          <Button variant="secondary" disabled={busy} onClick={() => void save(null)}>Usar default</Button>
        )}
      </div>
      {validN && (
        <p className="mt-1 text-xs text-slate-500">
          ≈ {clp(n * d.clpPerMsg.utility)}/día (utilidad) · hasta <b>{clp(n * d.clpPerMsg.marketing)}/día</b> (marketing).
        </p>
      )}
    </div>
  );
}
