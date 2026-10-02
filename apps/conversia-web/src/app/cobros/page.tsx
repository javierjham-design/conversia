"use client";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

type Summary = { balance: number; included: number; consumed: number; byCategory: Record<string, number>; projected: number; pctUsed: number; over80: boolean };
type Me = {
  organization: { currency: string };
  plan: { code: string; name: string; interval: string } | null;
  subscription: { status: string; periodEnd: string | null; interval: string } | null;
};
type Pkg = { code: string; name: string; credits: number; priceClp: number; priceUsd: number };
type Plan = { code: string; name: string; priceClp: number; priceUsd: number; priceClpYearly: number | null; priceUsdYearly: number | null; custom: boolean };

const CAT_LABEL: Record<string, string> = { utility: "Utilidad", authentication: "Autenticación", marketing: "Marketing", service: "Servicio", otro: "Otro" };

function barColor(pct: number): string {
  if (pct >= 100) return "var(--danger)";
  if (pct >= 80) return "var(--warn)";
  return "var(--ok)";
}

export default function Cobros() {
  const [me, setMe] = useState<Me | null>(null);
  const [s, setS] = useState<Summary | null>(null);
  const [pkgs, setPkgs] = useState<Pkg[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [interval, setIntervalSel] = useState<"monthly" | "yearly">("monthly");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Me>("/billing/me").then(setMe).catch((e) => setError((e as Error).message));
    api<Summary>("/billing/wallet/summary").then(setS).catch(() => {});
    api<{ packages: Pkg[] }>("/billing/wallet").then((r) => setPkgs(r.packages)).catch(() => {});
    api<Plan[]>("/billing/plans").then(setPlans).catch(() => {});
  }, []);

  const currency = me?.organization.currency ?? "CLP";
  const money = (clpV: number, usdV: number) =>
    currency === "CLP" ? "$" + Math.round(clpV).toLocaleString("es-CL") : "US$" + Math.round(usdV).toLocaleString("en-US");

  async function buyPackage(code: string) {
    setBusy("pkg:" + code);
    setError(null);
    try {
      const r = await api<{ url?: string }>("/billing/buy-package", { method: "POST", body: JSON.stringify({ code }) });
      if (r.url) window.location.href = r.url;
      else setError("No se pudo iniciar el pago.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function changePlan(code: string) {
    setBusy("plan:" + code);
    setError(null);
    try {
      const r = await api<{ url?: string }>("/billing/checkout", { method: "POST", body: JSON.stringify({ planCode: code, billingInterval: interval }) });
      if (r.url) window.location.href = r.url;
      else setError("No se pudo iniciar el pago.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function planPrice(p: Plan): number | null {
    if (p.custom) return null;
    if (interval === "yearly") return currency === "CLP" ? p.priceClpYearly : p.priceUsdYearly;
    return currency === "CLP" ? p.priceClp : p.priceUsd;
  }

  return (
    <AppShell>
      <main style={{ maxWidth: 860, margin: "0 auto", padding: "28px 20px 40px" }}>
        <h1 className="display" style={{ fontSize: 28, margin: "0 0 4px" }}>Cobros</h1>
        <p className="text-dim" style={{ fontSize: 14, margin: "0 0 20px" }}>Tus créditos, tu plan y tus pagos.</p>
        {error ? <p style={{ color: "var(--danger)" }}>{error}</p> : null}

        {/* Créditos */}
        {s ? (
          <div className="card" style={{ padding: 22, marginBottom: 16 }}>
            <p className="text-dim" style={{ margin: 0, fontSize: 13 }}>Créditos disponibles</p>
            <p className="display" style={{ margin: "4px 0 14px", fontSize: 40 }}>{s.balance.toLocaleString("es-CL")}</p>
            {s.included > 0 ? (
              <>
                <div style={{ height: 10, borderRadius: 999, background: "var(--acc-dim)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.min(100, s.pctUsed)}%`, background: barColor(s.pctUsed) }} />
                </div>
                <p className="text-dim" style={{ fontSize: 13, margin: "8px 0 0" }}>
                  Consumidos {s.consumed.toLocaleString("es-CL")} de {s.included.toLocaleString("es-CL")} este mes ({s.pctUsed}%) · proyección {s.projected.toLocaleString("es-CL")}
                </p>
              </>
            ) : (
              <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Consumidos este mes: {s.consumed.toLocaleString("es-CL")}</p>
            )}
            {Object.keys(s.byCategory).length ? (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
                {Object.entries(s.byCategory).map(([cat, n]) => (
                  <span key={cat} className="text-dim" style={{ fontSize: 12, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--line)" }}>{CAT_LABEL[cat] ?? cat}: {n.toLocaleString("es-CL")}</span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Comprar créditos */}
        {pkgs.length ? (
          <>
            <h2 className="display" style={{ fontSize: 18, margin: "22px 0 12px" }}>Comprar créditos</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
              {pkgs.map((p) => (
                <div key={p.code} className="card" style={{ padding: 18, display: "flex", flexDirection: "column" }}>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>{p.name}</p>
                  <p className="display" style={{ margin: "6px 0 0", fontSize: 24 }}>{p.credits.toLocaleString("es-CL")}</p>
                  <p className="text-dim" style={{ fontSize: 12, margin: "0 0 12px" }}>créditos · {money(p.priceClp, p.priceUsd)}</p>
                  <button className="btn-accent" onClick={() => buyPackage(p.code)} disabled={busy === "pkg:" + p.code} style={{ marginTop: "auto", opacity: busy === "pkg:" + p.code ? 0.6 : 1 }}>
                    {busy === "pkg:" + p.code ? "Abriendo pago…" : "Comprar"}
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {/* Plan */}
        {plans.length ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "28px 0 12px" }}>
              <h2 className="display" style={{ fontSize: 18, margin: 0 }}>Plan</h2>
              <div style={{ marginLeft: "auto", display: "flex", gap: 4, background: "var(--acc-dim)", borderRadius: 999, padding: 3 }}>
                {(["monthly", "yearly"] as const).map((iv) => (
                  <button key={iv} onClick={() => setIntervalSel(iv)} style={{ padding: "5px 12px", borderRadius: 999, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: interval === iv ? "var(--acc)" : "transparent", color: interval === iv ? "var(--acc-ink)" : "var(--ink-dim)" }}>
                    {iv === "monthly" ? "Mensual" : "Anual"}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
              {plans.map((p) => {
                const current = me?.plan?.code === p.code;
                const price = planPrice(p);
                const unavailable = !p.custom && (price == null || price <= 0);
                return (
                  <div key={p.code} className="card" style={{ padding: 18, border: current ? "none" : undefined, boxShadow: current ? "inset 0 0 0 2px var(--acc)" : undefined }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <p style={{ margin: 0, fontWeight: 700, fontSize: 16 }}>{p.name}</p>
                      {current ? <span style={{ fontSize: 11, fontWeight: 700, color: "var(--acc-deep)", background: "var(--acc-dim)", borderRadius: 999, padding: "2px 8px" }}>Actual</span> : null}
                    </div>
                    <p className="display" style={{ margin: "8px 0 0", fontSize: 24 }}>{p.custom ? "A medida" : price != null && price > 0 ? money(p.priceClp === 0 ? 0 : price, price) : "—"}</p>
                    <p className="text-dim" style={{ fontSize: 12, margin: "2px 0 14px" }}>{p.custom ? "según tu caso" : interval === "yearly" ? "al año" : "al mes"}</p>
                    {current ? (
                      <button disabled className="btn-accent" style={{ width: "100%", opacity: 0.5, cursor: "default" }}>Tu plan</button>
                    ) : p.custom ? (
                      <a href="/conversaciones" className="btn-accent" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>Hablar con nosotros</a>
                    ) : (
                      <button className="btn-accent" onClick={() => changePlan(p.code)} disabled={unavailable || busy === "plan:" + p.code} style={{ width: "100%", opacity: unavailable || busy === "plan:" + p.code ? 0.5 : 1 }}>
                        {unavailable ? "Sin precio " + (interval === "yearly" ? "anual" : "mensual") : busy === "plan:" + p.code ? "Abriendo pago…" : "Contratar"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {me?.subscription ? (
              <p className="text-dim" style={{ fontSize: 12, margin: "12px 0 0" }}>
                Suscripción: {me.subscription.status}{me.subscription.periodEnd ? ` · próximo período ${new Date(me.subscription.periodEnd).toLocaleDateString("es-CL")}` : ""}
              </p>
            ) : null}
            <p className="text-dim" style={{ fontSize: 12, margin: "6px 0 0" }}>Pagas con {currency === "CLP" ? "Flow (tarjetas chilenas)" : "tarjeta internacional"}. Al confirmar te llevamos a la pasarela.</p>
          </>
        ) : null}
      </main>
    </AppShell>
  );
}
