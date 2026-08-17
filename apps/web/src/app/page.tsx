import Link from "next/link";
import type { Metadata } from "next";
import { DemoCta } from "@/components/DemoCta";

export const metadata: Metadata = {
  title: "TuBot.cl — Atención y ventas por WhatsApp con IA",
  description:
    "Plataforma de IA conversacional y automatización para WhatsApp y otros canales. Conecta tu WhatsApp, configura agentes de IA y atiende, agenda y vende 24/7. Conversa. Automatiza. Crece.",
  robots: { index: true, follow: true },
};

const features = [
  {
    title: "Agentes de IA a tu medida",
    body: "Crea asistentes con su propio contexto, tono y conocimiento. Responden solo con información real de tu negocio, nunca inventan.",
  },
  {
    title: "WhatsApp oficial (Cloud API)",
    body: "Conexión directa con la API oficial de WhatsApp Business. Sin intermediarios y con tu propio número.",
  },
  {
    title: "Flujos y seguimiento",
    body: "Automatiza respuestas, recordatorios y seguimiento de leads que no contestan, sin escribir código.",
  },
  {
    title: "Bandeja para tu equipo",
    body: "Tu equipo humano toma el control cuando hace falta, asigna conversaciones y colabora en un solo lugar.",
  },
  {
    title: "Multi-agente y derivación",
    body: "Un recepcionista deriva al especialista correcto (ventas, agenda, soporte) conservando el contexto.",
  },
  {
    title: "Reportes y costos",
    body: "Mide conversaciones, conversiones y el costo de la IA en tiempo real para decidir con datos.",
  },
];

const steps = [
  { n: "1", title: "Conecta tu WhatsApp", body: "En minutos, desde el panel, con la conexión oficial de Meta." },
  { n: "2", title: "Configura tus agentes", body: "Carga tus servicios, precios y respuestas. Publica y prueba al instante." },
  { n: "3", title: "Atiende y vende 24/7", body: "La IA responde y agenda; tu equipo entra cuando quiere. Todo medido." },
];

type PlanCard = { code: string; name: string; price: string; note: string; features: string[]; highlight?: boolean };

const FALLBACK_PLANS: PlanCard[] = [
  { code: "free", name: "Free", price: "$0", note: "Para probar", features: ["1 canal", "2 agentes IA", "3 flujos"] },
  { code: "starter", name: "Starter", price: "$29.990", note: "/mes", features: ["1 canal", "5 agentes IA", "10 flujos", "5 usuarios"], highlight: true },
  { code: "pro", name: "Pro", price: "$79.990", note: "/mes", features: ["3 canales", "20 agentes IA", "50 flujos", "20 usuarios"] },
  { code: "enterprise", name: "Enterprise", price: "A medida", note: "", features: ["Ilimitado", "White-label", "SSO", "Soporte dedicado"] },
];

/** Precios EN VIVO desde la API pública (Fase E); cae a FALLBACK si no responde. */
async function getPlans(): Promise<PlanCard[]> {
  try {
    const base = process.env.API_URL || "https://api-production-cf8e.up.railway.app";
    const res = await fetch(`${base}/public/plans`, { next: { revalidate: 300 } });
    if (!res.ok) return FALLBACK_PLANS;
    const data: any[] = await res.json();
    return Array.isArray(data) && data.length ? data.map(mapPlan) : FALLBACK_PLANS;
  } catch {
    return FALLBACK_PLANS;
  }
}

function mapPlan(p: any): PlanCard {
  const l = (p.limits ?? {}) as Record<string, number>;
  const enterprise = p.code === "enterprise";
  const feats: string[] = [];
  if (l.channels) feats.push(`${l.channels} canal${l.channels > 1 ? "es" : ""}`);
  if (l.agents) feats.push(`${l.agents} agentes IA`);
  if (l.workflows) feats.push(`${l.workflows} flujos`);
  if (l.users) feats.push(`${l.users} usuarios`);
  return {
    code: p.code,
    name: p.name,
    price: enterprise ? "A medida" : p.priceClp === 0 ? "$0" : `$${Number(p.priceClp).toLocaleString("es-CL")}`,
    note: enterprise ? "" : p.priceClp === 0 ? "Para probar" : "/mes",
    features: enterprise ? ["Ilimitado", "White-label", "SSO", "Soporte dedicado"] : feats,
    highlight: p.code === "starter",
  };
}

export default async function LandingPage() {
  const plans = await getPlans();
  return (
    <div className="min-h-screen bg-panel text-ink">
      {/* Nav */}
      <header className="sticky top-0 z-10 border-b border-line bg-panel/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <img src="/brand/tubot-horizontal.png" alt="TuBot.cl" className="h-8 w-auto" />
          <nav className="hidden gap-8 text-sm text-ink-muted md:flex">
            <a href="#caracteristicas" className="hover:text-brand-600">Características</a>
            <a href="#como-funciona" className="hover:text-brand-600">Cómo funciona</a>
            <a href="#precios" className="hover:text-brand-600">Precios</a>
          </nav>
          <div className="flex items-center gap-3">
            <Link href="/login" className="text-sm font-medium text-ink hover:text-brand-600">
              Entrar
            </Link>
            <DemoCta label="Solicitar demo" className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700" />
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-brand-50 to-white dark:from-brand-500/10 dark:to-transparent" />
        <div className="relative mx-auto max-w-6xl px-6 py-20 text-center">
          <span className="inline-block rounded-full border border-brand-200 bg-panel px-3 py-1 text-xs font-semibold uppercase tracking-widest text-brand-700 dark:text-brand-300 dark:border-brand-500/30">
            Conversa. Automatiza. Crece.
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-bold leading-tight tracking-tight text-ink md:text-5xl">
            Tu propio bot de WhatsApp que atiende, agenda y vende{" "}
            <span className="bg-gradient-to-r from-brand-600 to-accent-400 bg-clip-text text-transparent">24/7</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-ink-muted">
            <strong>TuBot</strong> es la plataforma de IA conversacional para WhatsApp y otros canales. Configura agentes
            con la información real de tu negocio y deja que tu equipo se enfoque en lo importante. Sin código.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <DemoCta label="Solicitar una demo" className="rounded-lg bg-brand-600 px-6 py-3 font-medium text-white shadow-sm hover:bg-brand-700" />
            <Link href="/login" className="rounded-lg border border-line-strong px-6 py-3 font-medium text-ink hover:border-brand-600 hover:text-brand-600">
              Entrar al panel
            </Link>
          </div>
          <p className="mt-4 text-xs text-ink-subtle">Sin permanencia · Empieza gratis</p>
        </div>
      </section>

      {/* Features */}
      <section id="caracteristicas" className="border-t border-line bg-app py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight text-ink">
            Todo lo que necesitas para atender por WhatsApp
          </h2>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div key={f.title} className="rounded-2xl border border-line bg-panel p-6 shadow-sm">
                <h3 className="text-lg font-semibold text-ink">{f.title}</h3>
                <p className="mt-2 text-sm text-ink-muted">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Cómo funciona */}
      <section id="como-funciona" className="py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight text-ink">En 3 pasos</h2>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {steps.map((s) => (
              <div key={s.n} className="text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-600 text-lg font-bold text-white">
                  {s.n}
                </div>
                <h3 className="mt-4 text-lg font-semibold text-ink">{s.title}</h3>
                <p className="mt-2 text-sm text-ink-muted">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Precios */}
      <section id="precios" className="border-t border-line bg-app py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight text-ink">Planes simples</h2>
          <p className="mt-3 text-center text-sm text-ink-muted">Precios en CLP. Cambia o cancela cuando quieras.</p>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {plans.map((p) => (
              <div
                key={p.name}
                className={`rounded-2xl border bg-panel p-6 shadow-sm ${p.highlight ? "border-brand-600 ring-1 ring-brand-600" : "border-line"}`}
              >
                <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">{p.name}</h3>
                <p className="mt-3">
                  <span className="text-3xl font-bold text-ink">{p.price}</span>
                  <span className="text-sm text-ink-muted"> {p.note}</span>
                </p>
                <ul className="mt-4 space-y-2 text-sm text-ink-muted">
                  {p.features.map((feat) => (
                    <li key={feat} className="flex items-center gap-2">
                      <span className="text-accent-500">✓</span> {feat}
                    </li>
                  ))}
                </ul>
                <DemoCta
                  label="Empezar"
                  planCode={p.code}
                  className={`mt-6 block w-full rounded-lg px-4 py-2 text-center text-sm font-medium ${p.highlight ? "bg-brand-600 text-white hover:bg-brand-700" : "border border-line-strong text-ink hover:border-brand-600 hover:text-brand-600"}`}
                />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Contacto / CTA */}
      <section id="contacto" className="py-20">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-ink">¿Listo para automatizar tu WhatsApp?</h2>
          <p className="mt-4 text-ink-muted">
            Escríbenos y te mostramos TuBot funcionando con un caso real de tu negocio.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <a
              href="mailto:hola@tubot.cl"
              className="rounded-lg bg-brand-600 px-6 py-3 font-medium text-white hover:bg-brand-700"
            >
              hola@tubot.cl
            </a>
            <Link href="/login" className="rounded-lg border border-line-strong px-6 py-3 font-medium text-ink hover:border-brand-600 hover:text-brand-600">
              Ya tengo cuenta
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-line bg-navy-900 py-10 text-ink-subtle">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-sm md:flex-row">
          <img src="/brand/tubot-mono.png" alt="TuBot.cl" className="h-7 w-auto brightness-0 invert" />
          <nav className="flex flex-wrap gap-6">
            <Link href="/legal/privacidad" className="hover:text-white">Privacidad</Link>
            <Link href="/legal/terminos" className="hover:text-white">Términos</Link>
            <Link href="/legal/eliminacion-datos" className="hover:text-white">Eliminación de datos</Link>
            <a href="mailto:hola@tubot.cl" className="hover:text-white">Contacto</a>
          </nav>
          <span className="text-xs text-ink-subtle"><strong>TuBot</strong> es un servicio de Servicios Digital-Dent SpA · © {new Date().getFullYear()}</span>
        </div>
      </footer>
    </div>
  );
}
