"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, PlayCircle, XCircle } from "lucide-react";
import { padmin } from "@/lib/platform-api";
import { Button, useToast } from "@/components/ui";
import { MessagingCapCard } from "./messaging-cap-card";

// Panel ÚNICO de mensajería por tenant: las seis condiciones que controlan el
// envío de plantillas, en orden, con semáforo y edición en línea donde aplica.
// Es lo primero que se mira cuando un cliente dice "no me está enviando".

interface Cond {
  plan: { pass: boolean; planCode: string | null; planName: string | null; allows: boolean };
  switch: { pass: boolean; on: boolean };
  account: { pass: boolean; status: string; subStatus: string | null };
  daily: { pass: boolean; effective: number; override: number | null; today: number };
  wallet: { pass: boolean; balance: number; included: number; usedThisPeriod: number };
  fuse: { pass: boolean; tripped: boolean; todayGlobal: number; globalCap: number };
}
interface PanelData {
  summary: { canSend: boolean; blockedBy: string | null; reason: string | null; line: string };
  conditions: Cond;
}
interface Rejected {
  createdAt: string;
  reason: string;
  reasonLabel: string;
  message: string | null;
  conversationId: string | null;
}

const ROWS: { key: keyof Cond; label: string }[] = [
  { key: "plan", label: "1. Plan lo incluye" },
  { key: "switch", label: "2. Interruptor del tenant" },
  { key: "account", label: "3. Estado de la cuenta" },
  { key: "daily", label: "4. Tope diario" },
  { key: "wallet", label: "5. Bolsa prepagada" },
  { key: "fuse", label: "6. Fusible global" },
];

export function MessagingPanel({ orgId, onChanged }: { orgId: string; onChanged?: () => void }) {
  const toast = useToast();
  const [p, setP] = useState<PanelData | null>(null);
  const [rejected, setRejected] = useState<Rejected[] | null>(null);
  const [live, setLive] = useState<{ canSend: boolean; line: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [panel, rej] = await Promise.all([
      padmin<PanelData>(`/platform/organizations/${orgId}/messaging-panel`),
      padmin<Rejected[]>(`/platform/organizations/${orgId}/rejected-sends`),
    ]);
    setP(panel);
    setRejected(rej);
  }, [orgId]);

  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  async function toggleSwitch(on: boolean) {
    setBusy(true);
    try {
      await padmin(`/platform/organizations/${orgId}/config`, { method: "POST", body: JSON.stringify({ templatesEnabled: on }) });
      toast.push(on ? "Plantillas activadas ✔" : "Plantillas desactivadas ✔", "ok");
      setLive(null);
      await load();
      onChanged?.();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function checkNow() {
    setBusy(true);
    try {
      const r = await padmin<{ canSend: boolean; line: string }>(`/platform/organizations/${orgId}/can-send`);
      setLive(r);
      await load();
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!p) return null;
  const c = p.conditions;
  const canSend = live?.canSend ?? p.summary.canSend;
  const line = live?.line ?? p.summary.line;

  const detailFor = (key: keyof Cond): string => {
    switch (key) {
      case "plan":
        return c.plan.planName ? `${c.plan.planName}${c.plan.allows ? "" : " — no incluye plantillas"}` : "Sin plan";
      case "switch":
        return c.switch.on ? "Encendido" : "Apagado";
      case "account":
        return c.account.status + (c.account.subStatus ? ` · ${c.account.subStatus}` : "");
      case "daily":
        return `${c.daily.today.toLocaleString("es-CL")} / ${c.daily.effective.toLocaleString("es-CL")}`;
      case "wallet":
        return `Saldo ${c.wallet.balance.toLocaleString("es-CL")}`;
      case "fuse":
        return c.fuse.tripped ? "CORTADO" : `${c.fuse.todayGlobal.toLocaleString("es-CL")} / ${c.fuse.globalCap.toLocaleString("es-CL")}`;
    }
  };

  return (
    <section className="rounded-card border border-slate-200 bg-white p-4 shadow-card lg:col-span-2">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold text-navy-900">Mensajería — envío de plantillas</h2>
          <p className="text-xs text-slate-500">Las seis condiciones que deben cumplirse para enviar, en orden.</p>
        </div>
        <Button disabled={busy} onClick={() => void checkNow()}>
          <PlayCircle size={15} className="mr-1" /> ¿Puede enviar ahora?
        </Button>
      </div>

      <div className={`mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${canSend ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
        {canSend ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
        <b>{line}</b>
      </div>

      {/* Semáforo de las seis condiciones */}
      <div className="divide-y divide-slate-100 rounded-lg border border-slate-100">
        {ROWS.map((r) => {
          const cond = c[r.key];
          return (
            <div key={r.key} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${cond.pass ? "bg-emerald-500" : "bg-red-500"}`} />
                <span className="text-navy-900">{r.label}</span>
              </span>
              <span className="flex items-center gap-3 text-slate-600">
                <span className={cond.pass ? "" : "font-medium text-red-600"}>{detailFor(r.key)}</span>
                {r.key === "switch" && (
                  <input
                    type="checkbox"
                    checked={c.switch.on}
                    disabled={busy || !c.plan.allows}
                    title={c.plan.allows ? "Encender/apagar" : "El plan no incluye plantillas"}
                    onChange={(e) => void toggleSwitch(e.target.checked)}
                  />
                )}
                {r.key === "plan" && <a href="/admin/plans" className="text-xs text-brand-600 underline">cambiar plan</a>}
                {r.key === "account" && <a href="/admin/billing" className="text-xs text-brand-600 underline">facturación</a>}
                {r.key === "fuse" && <a href="/admin/messaging-limits" className="text-xs text-brand-600 underline">límites</a>}
              </span>
            </div>
          );
        })}
      </div>

      {/* Edición en línea de tope diario (4) + bolsa prepagada (5) */}
      <div className="mt-4">
        <MessagingCapCard orgId={orgId} />
      </div>

      {/* Últimos envíos rechazados */}
      <div className="mt-4">
        <p className="mb-1 text-sm font-medium text-navy-900">Últimos envíos rechazados</p>
        {!rejected || rejected.length === 0 ? (
          <p className="text-xs text-slate-400">Sin rechazos registrados.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-[10px] uppercase text-slate-400">
                  <th className="py-1 pr-3">Fecha</th>
                  <th className="py-1 pr-3">Condición que bloqueó</th>
                  <th className="py-1 pr-3">Conversación</th>
                </tr>
              </thead>
              <tbody>
                {rejected.map((x, i) => (
                  <tr key={i} className="border-t border-slate-100 align-top">
                    <td className="py-1.5 pr-3 text-slate-500">{new Date(x.createdAt).toLocaleString("es-CL")}</td>
                    <td className="py-1.5 pr-3 text-navy-900">{x.reasonLabel}</td>
                    <td className="py-1.5 pr-3 font-mono text-slate-500">{x.conversationId ? x.conversationId.slice(0, 8) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
