"use client";
import { useEffect, useState } from "react";
import { api, getToken } from "@/lib/api";
import { AppShell } from "@/components/AppShell";

/** Hora actual en la zona horaria del NEGOCIO (A14), no la del navegador. */
function hourIn(tz?: string): number {
  try {
    if (tz) return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date()));
  } catch {
    /* zona inválida → hora local */
  }
  return new Date().getHours();
}
function greeting(tz?: string): string {
  const h = hourIn(tz);
  if (h < 12) return "Buenos días";
  if (h < 20) return "Buenas tardes";
  return "Buenas noches";
}

interface WalletSummary {
  balance: number;
  included: number;
  consumed: number;
  pctUsed: number;
  projected: number;
  over80: boolean;
}

export default function Home() {
  const [name, setName] = useState("");
  const [tz, setTz] = useState<string | undefined>(undefined);
  const [summary, setSummary] = useState<WalletSummary | null>(null);

  useEffect(() => {
    if (!getToken()) return; // el AppShell redirige al login
    api<{ user?: { name?: string }; organization?: { timezone?: string } }>("/auth/me")
      .then((me) => {
        setName(me.user?.name?.split(" ")[0] ?? "");
        setTz(me.organization?.timezone);
      })
      .catch(() => undefined);
    api<WalletSummary>("/billing/wallet/summary").then(setSummary).catch(() => undefined);
  }, []);

  const pct = summary?.pctUsed ?? 0;
  const creditColor = pct > 85 ? "var(--danger)" : pct >= 60 ? "var(--warn)" : "var(--ok)";

  function toggleTheme() {
    const r = document.documentElement;
    const next = r.getAttribute("data-theme") === "dark" ? "light" : "dark";
    r.setAttribute("data-theme", next);
    try {
      localStorage.setItem("conversia_theme", next);
    } catch {
      /* ignore */
    }
  }

  return (
    <AppShell>
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px 40px" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Conversia</p>
            <h1 className="display" style={{ fontSize: 30, margin: "2px 0 0" }}>
              {greeting(tz)}
              {name ? <span className="display-italic">, {name}</span> : null}
            </h1>
          </div>
          <button className="card" onClick={toggleTheme} style={{ padding: "8px 14px", cursor: "pointer" }} aria-label="Cambiar modo claro/oscuro">
            ◐ Modo
          </button>
        </header>

        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
          <article className="card" style={{ padding: 20 }}>
            <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>El día de tu negocio</h2>
            <p className="text-dim" style={{ fontSize: 14, margin: 0 }}>Tu agenda del día y lo que necesita tu atención, en un solo lugar.</p>
          </article>

          <article className="card" style={{ padding: 20 }}>
            <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Conversaciones</h2>
            <p className="text-dim" style={{ fontSize: 14, margin: 0 }}>Tu asistente está atendiendo. Las que necesiten a una persona aparecerán aquí.</p>
          </article>

          <article className="card" style={{ padding: 20 }}>
            <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Créditos</h2>
            {summary ? (
              <>
                <p style={{ fontSize: 28, fontWeight: 700, margin: "0 0 4px", color: creditColor }}>{summary.balance.toLocaleString("es-CL")}</p>
                <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>
                  {summary.consumed.toLocaleString("es-CL")} usados este mes
                  {summary.included > 0 ? ` · ${pct}% del plan` : ""}
                </p>
                {summary.included > 0 ? (
                  <p className="text-dim" style={{ fontSize: 12, margin: "6px 0 0", color: summary.projected > summary.included ? "var(--warn)" : undefined }}>
                    Proyección fin de mes: {summary.projected.toLocaleString("es-CL")}
                    {summary.projected > summary.included ? " ⚠️ superarás el plan" : ""}
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-dim" style={{ fontSize: 14, margin: 0 }}>Cargando saldo…</p>
            )}
          </article>
        </section>
      </main>
    </AppShell>
  );
}
