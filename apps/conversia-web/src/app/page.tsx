"use client";
import { useCallback, useEffect, useState } from "react";
import { Bell, CalendarPlus, ChevronRight, Moon, Sun } from "lucide-react";
import { api, getToken } from "@/lib/api";
import { AppShell } from "@/components/AppShell";

/* ---------- Helpers de hora en la zona del negocio (A14/§6) ---------- */
function hourIn(tz?: string): number {
  try {
    if (tz) return Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date()));
  } catch { /* zona inválida */ }
  return new Date().getHours();
}
function greeting(tz?: string): string {
  const h = hourIn(tz);
  if (h < 12) return "Buenos días";
  if (h < 20) return "Buenas tardes";
  return "Buenas noches";
}
function nowParts(tz?: string): { date: string; time: string } {
  const opts: Intl.DateTimeFormatOptions = tz ? { timeZone: tz } : {};
  const date = new Intl.DateTimeFormat("es-CL", { weekday: "long", day: "numeric", month: "long", ...opts }).format(new Date());
  const time = new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit", ...opts }).format(new Date());
  return { date: date.charAt(0).toUpperCase() + date.slice(1), time };
}
/** Límites del día [00:00, 24:00) en la zona del negocio, como ISO UTC. */
function dayRange(tz?: string): { from: string; to: string } {
  const now = new Date();
  const ymd = (() => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now); } catch { return now.toISOString().slice(0, 10); } })();
  // Offset de la zona respecto a UTC a esta hora (minutos).
  let offMin = 0;
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(now).find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
    const m = s.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
    if (m) offMin = Number(m[1]) * 60 + (m[1].startsWith("-") ? -1 : 1) * Number(m[2] ?? 0);
  } catch { /* 0 */ }
  const from = new Date(`${ymd}T00:00:00.000Z`).getTime() - offMin * 60000;
  return { from: new Date(from).toISOString(), to: new Date(from + 24 * 3600_000).toISOString() };
}
const clp = (n: number) => (n < 0 ? "−$" : "$") + Math.abs(Math.round(n)).toLocaleString("es-CL");
const hhmm = (iso: string, tz?: string) => { try { return new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(iso)); } catch { return ""; } };
function ago(iso: string | null): string {
  if (!iso) return "";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "ahora"; if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60); if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

/* ---------- Tipos de las respuestas ---------- */
type Me = { user?: { name?: string }; organization?: { timezone?: string; name?: string } };
type Wallet = { balance: number; included: number; consumed: number; pctUsed: number; projected: number; over80: boolean };
type Appt = { id: string; status: string; startsAt: string; endsAt: string; professionalName: string | null; serviceName: string | null; contact: { name: string } };
type ApptResp = { appointments: Appt[] };
type CashDay = { summary: { net: number } };
type Conv = { id: string; status: string; unreadCount: number; lastMessagePreview: string | null; lastMessageAt: string | null; contact: { firstName: string | null; lastName: string | null; profileName: string | null; phone: string | null } };
type ConvResp = { items: Conv[] };

const DONE_STATUSES = new Set(["CANCELLED", "COMPLETED", "NO_SHOW"]);
const WARN_STATUSES = new Set(["PENDING", "RESCHEDULED"]);
const contactName = (c: Conv["contact"]) => [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || c.profileName || c.phone || "Sin nombre";

/* ---------- Anillo semántico de créditos (C1 — gradiente ok→warn→danger, nunca el acento) ---------- */
function CreditRing({ pct }: { pct: number }) {
  const R = 46, C = 2 * Math.PI * R;
  const p = Math.max(0, Math.min(100, pct));
  const color = p > 85 ? "var(--danger)" : p >= 60 ? "var(--warn)" : "var(--ok)";
  return (
    <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden>
      <defs>
        <linearGradient id="credarc" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--ok)" />
          <stop offset="0.55" stopColor="var(--warn)" />
          <stop offset="1" stopColor="var(--danger)" />
        </linearGradient>
      </defs>
      <circle cx="60" cy="60" r={R} fill="none" stroke="var(--line)" strokeWidth="9" />
      <circle cx="60" cy="60" r={R} fill="none" stroke="url(#credarc)" strokeWidth="9" strokeLinecap="round"
        strokeDasharray={`${(p / 100) * C} ${C}`} transform="rotate(-90 60 60)" />
      <text x="60" y="60" textAnchor="middle" dominantBaseline="central" fontSize="24" fontWeight="700" fill={color} className="display">{p}%</text>
    </svg>
  );
}

/* ---------- Sparkline de caja (7 días) ---------- */
function Sparkline({ values }: { values: number[] }) {
  if (!values.length) return null;
  const max = Math.max(1, ...values.map(Math.abs));
  const w = 72, h = 22, step = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${i * step},${h - (Math.max(0, v) / max) * h}`).join(" ");
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden><polyline points={pts} fill="none" stroke="var(--acc)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function Pulse({ on }: { on: boolean }) {
  return <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: on ? "var(--ok)" : "var(--warn)", boxShadow: on ? "0 0 0 0 var(--ok)" : "none", animation: on ? "pulseDot 1.8s infinite" : "none" }} />;
}

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [appts, setAppts] = useState<Appt[] | null>(null);
  const [cashNet, setCashNet] = useState<number | null>(null);
  const [spark, setSpark] = useState<number[]>([]);
  const [pending, setPending] = useState<Conv[]>([]);
  const [assistantOn, setAssistantOn] = useState<boolean | null>(null);
  const [, setTick] = useState(0);

  const tz = me?.organization?.timezone;
  const firstName = me?.user?.name?.split(" ")[0] ?? "";

  useEffect(() => {
    if (!getToken()) return;
    api<Me>("/auth/me").then(setMe).catch(() => {});
    api<Wallet>("/billing/wallet/summary").then(setWallet).catch(() => {});
    // Asistente activo = ≥1 agente publicado && ≥1 canal conectado.
    Promise.all([
      api<{ active?: boolean; publishedVersion?: unknown }[]>("/agents").catch(() => []),
      api<{ status?: string }[]>("/channels").catch(() => []),
    ]).then(([agents, channels]) => {
      const pub = Array.isArray(agents) && agents.some((a) => a.active && a.publishedVersion);
      const ch = Array.isArray(channels) && channels.some((c) => (c.status ?? "").toLowerCase() === "active");
      setAssistantOn(pub && ch);
    }).catch(() => setAssistantOn(false));
  }, []);

  const loadDay = useCallback(() => {
    const r = dayRange(tz);
    api<ApptResp>(`/agenda/appointments?from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`)
      .then((x) => setAppts((x.appointments ?? []).slice().sort((a, b) => a.startsAt.localeCompare(b.startsAt))))
      .catch(() => setAppts([]));
    api<CashDay>("/cash/day").then((x) => setCashNet(x.summary?.net ?? 0)).catch(() => setCashNet(null));
    api<ConvResp>("/conversations?status=pending").then((x) => setPending((x.items ?? []).slice(0, 6))).catch(() => setPending([]));
  }, [tz]);
  useEffect(() => { loadDay(); }, [loadDay]);

  // Sparkline: neto de caja de los últimos 7 días.
  useEffect(() => {
    (async () => {
      const out: number[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 3600_000).toISOString().slice(0, 10);
        try { const r = await api<CashDay>(`/cash/day?date=${d}`); out.push(r.summary?.net ?? 0); } catch { out.push(0); }
      }
      setSpark(out);
    })();
  }, []);

  // Re-render cada minuto para la línea "AHORA" y el reloj.
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 60000); return () => clearInterval(t); }, []);

  function toggleTheme() {
    const r = document.documentElement;
    const next = r.getAttribute("data-theme") === "dark" ? "light" : "dark";
    r.setAttribute("data-theme", next);
    try { localStorage.setItem("conversia_theme", next); } catch { /* ignore */ }
    setTick((n) => n + 1);
  }

  const parts = nowParts(tz);
  const nowMs = Date.now();
  const upcoming = (appts ?? []).filter((a) => !DONE_STATUSES.has(a.status));
  const porConfirmar = upcoming.filter((a) => WARN_STATUSES.has(a.status)).length;
  const nowHH = hhmm(new Date().toISOString(), tz);
  // Índice donde cae la línea "AHORA" (primera cita futura).
  const nowIdx = (appts ?? []).findIndex((a) => new Date(a.startsAt).getTime() > nowMs);

  return (
    <AppShell>
      <main style={{ maxWidth: 1120, margin: "0 auto", padding: "22px 20px 48px" }}>
        {/* Topbar */}
        <header style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 20, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p className="text-dim" style={{ margin: 0, fontSize: 12.5 }}>{parts.date} · {parts.time}</p>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 3, fontSize: 12.5, color: assistantOn ? "var(--ok)" : "var(--warn)" }}>
              <Pulse on={assistantOn === true} />
              {assistantOn === null ? "Comprobando asistente…" : assistantOn ? "Asistente activo" : "Asistente en preparación"}
            </span>
          </div>
          <a href="/agenda" className="btn-accent" style={{ display: "inline-flex", alignItems: "center", gap: 7, textDecoration: "none", height: 38, padding: "0 16px" }}><CalendarPlus size={16} /> Nueva cita</a>
          <button onClick={toggleTheme} aria-label="Modo claro/oscuro" className="card" style={{ width: 38, height: 38, display: "grid", placeItems: "center", cursor: "pointer", borderRadius: 11 }}>
            {typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button aria-label="Notificaciones" className="card" style={{ width: 38, height: 38, display: "grid", placeItems: "center", cursor: "pointer", borderRadius: 11, position: "relative" }}>
            <Bell size={17} />
            {pending.length ? <span style={{ position: "absolute", top: 8, right: 8, width: 7, height: 7, borderRadius: "50%", background: "var(--warn)" }} /> : null}
          </button>
          <div className="shell-brand" style={{ width: 38, height: 38, fontSize: 15, marginBottom: 0 }}>{(firstName || "C").charAt(0).toUpperCase()}</div>
        </header>

        {/* Saludo (Fraunces cursiva en el acento) */}
        <h1 className="display" style={{ fontSize: 32, margin: "0 0 20px", fontWeight: 600 }}>
          {greeting(tz)}
          {firstName ? <span className="display-italic" style={{ color: "var(--acc-deep)" }}>, {firstName}</span> : null}
        </h1>

        {/* 4 KPIs */}
        <section style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 14, marginBottom: 18 }}>
          <Kpi label="Citas hoy" value={appts === null ? "…" : String(upcoming.length)} hint={appts === null ? "" : `${(appts ?? []).length} en total`} />
          <Kpi label="Por confirmar" value={appts === null ? "…" : String(porConfirmar)} hint="esperan confirmación" tone={porConfirmar > 0 ? "warn" : undefined} />
          <Kpi label="Caja del día" value={cashNet === null ? "—" : clp(cashNet)} extra={<Sparkline values={spark} />} />
          <Kpi label="Atendió tu asistente" value={String(pending.length ? pending.length : (appts ? 0 : "…"))} hint="conversaciones esperando" />
        </section>

        <section style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.6fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
          {/* Agenda del día */}
          <div className="card" style={{ padding: 18 }}>
            <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
              <h2 className="display" style={{ fontSize: 18, margin: 0, flex: 1 }}>Agenda de hoy</h2>
              <a href="/agenda" className="text-dim" style={{ fontSize: 13, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 2 }}>Ver semana <ChevronRight size={15} /></a>
            </div>
            {appts === null ? (
              <p className="text-dim" style={{ fontSize: 14 }}>Cargando…</p>
            ) : appts.length === 0 ? (
              <p className="text-dim" style={{ fontSize: 14, margin: "6px 0" }}>No hay citas para hoy. {upcoming.length === 0 && (appts.length === 0) ? "Agenda una desde “Nueva cita” o configura tu equipo en Agenda." : ""}</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                {appts.map((a, i) => (
                  <div key={a.id}>
                    {i === nowIdx ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0" }}>
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--acc-deep)", letterSpacing: "0.04em" }}>AHORA · {nowHH}</span>
                        <span style={{ flex: 1, height: 1, background: "var(--acc)" }} />
                      </div>
                    ) : null}
                    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 10px", borderRadius: 10, opacity: DONE_STATUSES.has(a.status) || new Date(a.endsAt).getTime() < nowMs ? 0.55 : 1 }}>
                      <span style={{ width: 3, alignSelf: "stretch", borderRadius: 2, background: "var(--acc)" }} />
                      <span style={{ fontSize: 13, fontWeight: 600, minWidth: 48, fontVariantNumeric: "tabular-nums" }}>{hhmm(a.startsAt, tz)}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 14 }}>{a.contact.name}</span>
                        <br /><span className="text-dim" style={{ fontSize: 12 }}>{[a.serviceName, a.professionalName].filter(Boolean).join(" · ") || "Cita"}</span>
                      </span>
                      <StatusPill status={a.status} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Columna derecha: Te esperan + Créditos */}
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="card" style={{ padding: 18 }}>
              <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
                <h2 className="display" style={{ fontSize: 17, margin: 0, flex: 1 }}>Te esperan</h2>
                <a href="/conversaciones" className="text-dim" style={{ fontSize: 13, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>Ver <ChevronRight size={15} /></a>
              </div>
              {pending.length === 0 ? (
                <p className="text-dim" style={{ fontSize: 13.5, margin: "4px 0" }}>Tu asistente está al día. Nada pendiente ✶</p>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {pending.map((c) => (
                    <a key={c.id} href="/conversaciones" style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px", borderRadius: 10, textDecoration: "none", color: "var(--ink)" }}>
                      <span style={{ width: 34, height: 34, borderRadius: "50%", background: "var(--acc-dim)", color: "var(--acc-deep)", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{contactName(c.contact).slice(0, 2).toUpperCase()}</span>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{contactName(c.contact)}</span>
                        <br /><span className="text-dim" style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "block" }}>{c.lastMessagePreview ?? "—"}</span>
                      </span>
                      <span className="text-dim" style={{ fontSize: 11, flexShrink: 0 }}>{ago(c.lastMessageAt)}</span>
                    </a>
                  ))}
                </div>
              )}
            </div>

            <div className="card" style={{ padding: 18 }}>
              <h2 className="display" style={{ fontSize: 17, margin: "0 0 10px" }}>Créditos</h2>
              {wallet ? (
                <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                  <CreditRing pct={wallet.included > 0 ? wallet.pctUsed : 0} />
                  <div style={{ minWidth: 0 }}>
                    <p style={{ margin: 0, fontSize: 14 }}><b style={{ fontVariantNumeric: "tabular-nums" }}>{wallet.consumed.toLocaleString("es-CL")}</b> de {wallet.included.toLocaleString("es-CL")} usados</p>
                    <p className="text-dim" style={{ margin: "2px 0 0", fontSize: 12.5 }}>Proyección fin de mes: {wallet.projected.toLocaleString("es-CL")}{wallet.projected > wallet.included ? " ⚠" : ""}</p>
                    <p className="text-dim" style={{ margin: "2px 0 10px", fontSize: 12.5 }}>Saldo: {wallet.balance.toLocaleString("es-CL")}</p>
                    <a href="/cobros" className="btn-accent" style={{ display: "inline-block", textDecoration: "none", fontSize: 13, padding: "8px 14px" }}>Comprar sobre +500 · $21.900</a>
                  </div>
                </div>
              ) : (
                <p className="text-dim" style={{ fontSize: 14 }}>Cargando saldo…</p>
              )}
            </div>
          </div>
        </section>
      </main>
    </AppShell>
  );
}

function Kpi({ label, value, hint, extra, tone }: { label: string; value: string; hint?: string; extra?: React.ReactNode; tone?: "warn" }) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <p className="text-dim" style={{ margin: 0, fontSize: 12.5 }}>{label}</p>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
        <p className="display" style={{ margin: 0, fontSize: 26, fontVariantNumeric: "tabular-nums", color: tone === "warn" ? "var(--warn)" : "var(--ink)" }}>{value}</p>
        {extra}
      </div>
      {hint ? <p className="text-dim" style={{ margin: "3px 0 0", fontSize: 12 }}>{hint}</p> : null}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { PENDING: "Por confirmar", CONFIRMED: "Confirmada", RESCHEDULED: "Reagendada", COMPLETED: "Atendida", CANCELLED: "Cancelada", NO_SHOW: "No asistió" };
function StatusPill({ status }: { status: string }) {
  const warn = WARN_STATUSES.has(status);
  const bad = status === "CANCELLED" || status === "NO_SHOW";
  const color = bad ? "var(--danger)" : warn ? "var(--warn)" : "var(--ok)";
  return <span style={{ fontSize: 11, fontWeight: 600, color, border: `1px solid ${color}`, borderRadius: 999, padding: "2px 9px", whiteSpace: "nowrap", opacity: 0.9 }}>{STATUS_LABEL[status] ?? status}</span>;
}
