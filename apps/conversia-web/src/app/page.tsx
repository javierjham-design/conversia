"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getToken } from "@/lib/api";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Buenos días";
  if (h < 20) return "Buenas tardes";
  return "Buenas noches";
}

interface WalletSummary {
  balance: number;
  included: number;
  consumed: number;
  pctUsed: number;
}

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [summary, setSummary] = useState<WalletSummary | null>(null);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    api<{ user?: { name?: string } }>("/auth/me")
      .then((me) => setName(me.user?.name?.split(" ")[0] ?? ""))
      .catch(() => router.replace("/login"));
    api<WalletSummary>("/billing/wallet/summary").then(setSummary).catch(() => undefined);
  }, [router]);

  // Color del indicador de créditos: SEMÁNTICO (no el acento). <60% ok · 60-85% warn · >85% danger.
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
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px 80px" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>Conversia</p>
          <h1 className="display" style={{ fontSize: 30, margin: "2px 0 0" }}>
            {greeting()}
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
          <p className="text-dim" style={{ fontSize: 14, margin: 0 }}>Agenda del día y conversaciones que esperan — próximamente en esta vista.</p>
        </article>

        <article className="card" style={{ padding: 20 }}>
          <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Conversaciones</h2>
          <p className="text-dim" style={{ fontSize: 14, margin: 0 }}>Tu asistente está atendiendo. Las que necesiten a una persona aparecerán aquí.</p>
        </article>

        <article className="card" style={{ padding: 20 }}>
          <h2 style={{ fontSize: 15, margin: "0 0 10px" }}>Créditos</h2>
          {summary ? (
            <>
              <p style={{ fontSize: 28, fontWeight: 700, margin: "0 0 4px", color: creditColor }}>
                {summary.balance.toLocaleString("es-CL")}
              </p>
              <p className="text-dim" style={{ fontSize: 13, margin: 0 }}>
                {summary.consumed.toLocaleString("es-CL")} usados este mes
                {summary.included > 0 ? ` · ${pct}% del plan` : ""}
              </p>
            </>
          ) : (
            <p className="text-dim" style={{ fontSize: 14, margin: 0 }}>Cargando saldo…</p>
          )}
        </article>
      </section>
    </main>
  );
}
