"use client";

import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { api } from "@/lib/api";

interface WalletData {
  balance: number;
  included: number;
  remainingPct: number | null;
  packages: { code: string; name: string; credits: number; priceClp: number; priceUsd: number }[];
}

/** Bolsa de mensajes de plantilla del tenant: saldo, barra y paquetes. */
export function WalletCard() {
  const [d, setD] = useState<WalletData | null>(null);

  useEffect(() => {
    void api<WalletData>("/billing/wallet").then(setD).catch(() => undefined);
  }, []);

  if (!d) return null;
  const pct = d.remainingPct ?? 100;
  const low = pct <= 20;

  return (
    <div className="mt-4 rounded-card border border-line bg-panel p-5 shadow-card">
      <div className="mb-1 flex items-center gap-2">
        <Wallet size={18} className="text-brand-600 dark:text-accent-400" />
        <h3 className="font-semibold text-ink">Bolsa de mensajes de plantilla</h3>
      </div>
      <p className="mb-3 text-xs text-ink-muted">
        Los mensajes de plantilla (recordatorios, confirmaciones, campañas) descuentan de tu bolsa. Responder dentro de las 24 h no cuesta.
      </p>

      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium text-ink">{d.balance.toLocaleString("es-CL")} disponibles</span>
        {d.included > 0 && <span className="text-ink-muted">de {d.included.toLocaleString("es-CL")} del plan</span>}
      </div>
      {d.included > 0 && (
        <div className="h-2.5 overflow-hidden rounded-full bg-app">
          <div className={`h-full rounded-full ${low ? "bg-red-500" : "bg-gradient-to-r from-brand-500 to-accent-500"}`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
      {low && <p className="mt-2 text-xs font-medium text-red-600 dark:text-red-400">Te queda poca bolsa. Compra un paquete o sube de plan para no quedarte sin poder avisar a tus clientes.</p>}

      {d.packages.length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-medium text-ink">Paquetes adicionales</p>
          <div className="flex flex-wrap gap-2">
            {d.packages.map((p) => (
              <div key={p.code} className="rounded-lg border border-line bg-app px-3 py-2 text-sm">
                <span className="font-medium text-ink">{p.credits.toLocaleString("es-CL")}</span>
                <span className="text-ink-muted"> · ${p.priceClp.toLocaleString("es-CL")} CLP</span>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-ink-subtle">La compra en 2 clics se habilita junto con la pasarela. Por ahora, escríbenos por Soporte para cargar un paquete.</p>
        </div>
      )}
    </div>
  );
}
