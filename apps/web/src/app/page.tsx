import Link from "next/link";
import type { Metadata } from "next";

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

type PlanCard = { name: string; price: string; note: string; features: string[]; highlight?: boolean };

const FALLBACK_PLANS: PlanCard[] = [
  { name: "Free", price: "$0", note: "Para probar", features: ["1 canal", "2 agentes IA", "3 flujos"] },
  { name: "Starter", price: "$29.990", note: "/mes", features: ["1 canal", "5 agentes IA", "10 flujos", "5 usuarios"], highlight: true },
  { name: "Pro", price: "$79.990", note: "/mes", features: ["3 canales", "20 agentes IA", "50 flujos", "20 usuarios"] },
  { name: "Enterprise", price: "A medida", note: "", features: ["Ilimitado", "White-label", "SSO", "Soporte dedicado"] },
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
    <div className="min-h-screen bg-white text-slate-700">
      {/* Nav */}
      <header className="sticky top-0 z-10 border-b border-slate-100 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <img src="/brand/tubot-horizontal.png" alt="TuBot.cl" className="h-8 w-auto" />
          <nav className="hidden gap-8 text-sm text-slate-600 md:flex">
            <a href="#caracteristicas" className="hover:text-brand-600">Características</a>
            <a href="#como-funciona" className="hover:text-brand-600">Cómo funciona</a>
            <a href="#precios" className="hover:text-brand-600">Precios</a>
          </nav>
          <div className="flex items-center gap-3">
            <Link href="/login" className="text-sm font-medium text-navy-900 hover:text-brand-600">
              Entrar
            </Link>
            <a
              href="#contacto"
              className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700"
            >
              Solicitar demo
            </a>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-brand-50 to-white" />
        <div className="relative mx-auto max-w-6xl px-6 py-20 text-center">
          <span className="inline-block rounded-full border border-brand-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-widest text-brand-700">
            Conversa. Automatiza. Crece.
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-bold leading-tight tracking-tight text-navy-900 md:text-5xl">
            Tu propio bot de WhatsApp que atiende, agenda y vende{" "}
            <span className="bg-gradient-to-r from-brand-600 to-accent-400 bg-clip-text text-transparent">24/7</span>
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-slate-600">
            Plataforma de IA conversacional para WhatsApp y otros canales. Configura agentes con la información real
            de tu negocio y deja que tu equipo se enfoque en lo importante. Sin código.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <a href="#contacto" className="rounded-lg bg-brand-600 px-6 py-3 font-medium text-white shadow-sm hover:bg-brand-700">
              Solicitar una demo
            </a>
            <Link href="/login" className="rounded-lg border border-slate-300 px-6 py-3 font-medium text-navy-900 hover:border-brand-600 hover:text-brand-600">
              Entrar al panel
            </Link>
          </div>
          <p className="mt-4 text-xs text-slate-400">Sin permanencia · Empieza gratis</p>
        </div>
      </section>

      {/* Features */}
      <section id="caracteristicas" className="border-t border-slate-100 bg-slate-50 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight text-navy-900">
            Todo lo que necesitas para atender por WhatsApp
          </h2>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <div key={f.title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h3 className="text-lg font-semibold text-navy-900">{f.title}</h3>
                <p className="mt-2 text-sm text-slate-600">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Cómo funciona */}
      <section id="como-funciona" className="py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight text-navy-900">En 3 pasos</h2>
          <div className="mt-12 grid gap-8 md:grid-cols-3">
            {steps.map((s) => (
              <div key={s.n} className="text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-600 text-lg font-bold text-white">
                  {s.n}
                </div>
                <h3 className="mt-4 text-lg font-semibold text-navy-900">{s.title}</h3>
                <p className="mt-2 text-sm text-slate-600">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Precios */}
      <section id="precios" className="border-t border-slate-100 bg-slate-50 py-20">
        <div className="mx-auto max-w-6xl px-6">
          <h2 className="text-center text-3xl font-bold tracking-tight text-navy-900">Planes simples</h2>
          <p className="mt-3 text-center text-sm text-slate-500">Precios en CLP. Cambia o cancela cuando quieras.</p>
          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {plans.map((p) => (
              <div
                key={p.name}
                className={`rounded-2xl border bg-white p-6 shadow-sm ${p.highlight ? "border-brand-600 ring-1 ring-brand-600" : "border-slate-200"}`}
              >
                <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{p.name}</h3>
                <p className="mt-3">
                  <span className="text-3xl font-bold text-navy-900">{p.price}</span>
                  <span className="text-sm text-slate-500"> {p.note}</span>
                </p>
                <ul className="mt-4 space-y-2 text-sm text-slate-600">
                  {p.features.map((feat) => (
                    <li key={feat} className="flex items-center gap-2">
                      <span className="text-accent-500">✓</span> {feat}
                    </li>
                  ))}
                </ul>
                <a
                  href="#contacto"
                  className={`mt-6 block rounded-lg px-4 py-2 text-center text-sm font-medium ${p.highlight ? "bg-brand-600 text-white hover:bg-brand-700" : "border border-slate-300 text-navy-900 hover:border-brand-600 hover:text-brand-600"}`}
                >
                  Empezar
                </a>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Contacto / CTA */}
      <section id="contacto" className="py-20">
        <div className="mx-auto max-w-3xl px-6 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-navy-900">¿Listo para automatizar tu WhatsApp?</h2>
          <p className="mt-4 text-slate-600">
            Escríbenos y te mostramos TuBot funcionando con un caso real de tu negocio.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <a
              href="mailto:hola@tubot.cl"
              className="rounded-lg bg-brand-600 px-6 py-3 font-medium text-white hover:bg-brand-700"
            >
              hola@tubot.cl
            </a>
            <Link href="/login" className="rounded-lg border border-slate-300 px-6 py-3 font-medium text-navy-900 hover:border-brand-600 hover:text-brand-600">
              Ya tengo cuenta
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100 bg-navy-900 py-10 text-slate-300">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-sm md:flex-row">
          <img src="/brand/tubot-mono.png" alt="TuBot.cl" className="h-7 w-auto brightness-0 invert" />
          <nav className="flex flex-wrap gap-6">
            <Link href="/legal/privacidad" className="hover:text-white">Privacidad</Link>
            <Link href="/legal/terminos" className="hover:text-white">Términos</Link>
            <Link href="/legal/eliminacion-datos" className="hover:text-white">Eliminación de datos</Link>
            <a href="mailto:hola@tubot.cl" className="hover:text-white">Contacto</a>
          </nav>
          <span className="text-xs text-slate-400">© {new Date().getFullYear()} Servicios DigitalDent SpA</span>
        </div>
      </footer>
    </div>
  );
}
