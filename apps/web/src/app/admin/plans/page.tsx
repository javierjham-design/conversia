"use client";

import { useCallback, useEffect, useState } from "react";
import { padmin } from "@/lib/platform-api";
import { Button, PageHeader, Skeleton, StatusBadge, useToast } from "@/components/ui";

interface Plan {
  id: string;
  code: string;
  name: string;
  priceClp: string;
  priceUsd: string;
  interval: string;
  isPublic: boolean;
  active: boolean;
  order: number;
  limits: Record<string, number>;
}

export default function PlansPage() {
  const toast = useToast();
  const [plans, setPlans] = useState<Plan[] | null>(null);

  const load = useCallback(async () => {
    setPlans(await padmin<Plan[]>("/platform/plans"));
  }, []);
  useEffect(() => {
    void load().catch((e) => toast.push((e as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function updatePrice(id: string, field: "priceClp" | "priceUsd", value: number) {
    await padmin(`/platform/plans/${id}`, { method: "PATCH", body: JSON.stringify({ [field]: value }) });
    toast.push("Precio actualizado", "ok");
    await load();
  }
  async function toggleActive(p: Plan) {
    await padmin(`/platform/plans/${p.id}`, { method: "PATCH", body: JSON.stringify({ active: !p.active }) });
    await load();
  }

  return (
    <div className="mx-auto max-w-[1300px] px-6 py-6 lg:px-8">
      <PageHeader title="Planes" description="Catálogo de planes de la plataforma. Precios en CLP y USD, límites por plan." />
      {!plans ? (
        <Skeleton className="h-56" />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {plans.map((p) => (
            <div key={p.id} className="rounded-card border border-slate-200 bg-white p-4 shadow-card">
              <div className="mb-2 flex items-center justify-between">
                <div>
                  <p className="font-semibold">{p.name}</p>
                  <p className="text-xs text-slate-400">{p.code} · {p.interval}{p.isPublic ? "" : " · privado"}</p>
                </div>
                <StatusBadge kind={p.active ? "connected" : "disconnected"} label={p.active ? "activo" : "inactivo"} />
              </div>
              <label className="mt-2 block text-xs text-slate-500">
                Precio CLP
                <input type="number" defaultValue={Number(p.priceClp)} onBlur={(e) => void updatePrice(p.id, "priceClp", Number(e.target.value))} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
              </label>
              <label className="mt-2 block text-xs text-slate-500">
                Precio USD
                <input type="number" defaultValue={Number(p.priceUsd)} onBlur={(e) => void updatePrice(p.id, "priceUsd", Number(e.target.value))} className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
              </label>
              <div className="mt-3 rounded-lg bg-slate-50 p-2 text-[11px] text-slate-500">
                {Object.entries(p.limits).map(([k, v]) => (
                  <div key={k} className="flex justify-between">
                    <span>{k}</span>
                    <span className="font-medium">{v === 0 ? "∞" : v.toLocaleString("es-CL")}</span>
                  </div>
                ))}
              </div>
              <Button variant="secondary" className="mt-3 w-full" onClick={() => void toggleActive(p)}>
                {p.active ? "Desactivar" : "Activar"}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
