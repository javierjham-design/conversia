"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

type Wallet = { balance: number; included: number; consumed: number; byCategory: Record<string, number>; projected: number; pctUsed: number; over80: boolean };
type Plan = { code: string; name: string; priceClp: number; priceUsd: number; custom: boolean };

const CAT_LABEL: Record<string, string> = { utility: "Utilidad", authentication: "Autenticación", marketing: "Marketing", service: "Servicio", otro: "Otro" };
const clp = (n: number) => "$" + Math.round(n).toLocaleString("es-CL");

function barColor(pct: number): string {
  if (pct >= 100) return "var(--danger)";
  if (pct >= 80) return "var(--warn)";
  return "var(--ok)";
}

export default function Cobros() {
  const [w, setW] = useState<Wallet | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Wallet>("/billing/wallet/summary").then(setW).catch((e) => setError((e as Error).message));
    api<Plan[]>("/billing/plans").then(setPlans).catch(() => {});
  }, []);

  return (
    <AppShell>
      <main style={{ maxWidth: 820, margin: "0 auto", padding: "28px 20px 40px" }}>
        <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Cobros</h1>
        <p className="text-dim" style={{ fontSize: 14, margin: "0 0 20px" }}>Tus créditos de mensajería y tu plan.</p>
        {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}

        {w ? (
          <div className="card" style={{ padding: 22, marginBottom: 16 }}>
            <p className="text-dim" style={{ margin: 0, fontSize: 13 }}>Créditos disponibles</p>
            <p className="display" style={{ margin: "4px 0 14px", fontSize: 40 }}>{w.balance.toLocaleString("es-CL")}</p>

            {w.included > 0 ? (
              <>
                <div style={{ height: 10, borderRadius: 999, background: "var(--acc-dim)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, w.pctUsed)}%`, background: barColor(w.pctUsed) }} />
                </div>
                <p className="text-dim" style={{ fontSize: 13, margin: "8px 0 0" }}>
                  Consumidos {w.consumed.toLocaleString("es-CL")} de {w.included.toLocaleString("es-CL")} este mes ({w.pctUsed}%) · proyección {w.projected.toLocaleString("es-CL")}
                </p>
              </>
            ) : (
              <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Consumidos este mes: {w.consumed.toLocaleString("es-CL")}</p>
            )}

            {Object.keys(w.byCategory).length ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                {Object.entries(w.byCategory).map(([cat, n]) => (
                  <span key={cat} className="text-dim" style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--line)" }}>
                    {CAT_LABEL[cat] ?? cat}: {n.toLocaleString("es-CL")}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : !error ? (
          <p className="text-dim">Cargando…</p>
        ) : null}

        {plans.length ? (
          <>
            <h2 className="display" style={{ fontSize: 18, margin: "22px 0 12px" }}>Planes</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {plans.map((p) => (
                <div key={p.code} className="card" style={{ padding: 18 }}>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: 16 }}>{p.name}</p>
                  <p className="display" style={{ margin: "8px 0 0", fontSize: 24 }}>{p.custom ? "A medida" : clp(p.priceClp)}</p>
                  {!p.custom ? <p className="text-dim" style={{ fontSize: 12, margin: "2px 0 0" }}>al mes</p> : null}
                </div>
              ))}
            </div>
            <p className="text-dim" style={{ fontSize: 12, margin: "12px 0 0" }}>Para cambiar de plan o comprar créditos, escríbenos — pronto podrás hacerlo desde aquí.</p>
          </>
        ) : null}
      </main>
    </AppShell>
  );
}
