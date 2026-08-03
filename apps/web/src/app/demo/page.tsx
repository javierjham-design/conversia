import Link from "next/link";
import type { Metadata } from "next";
import { DemoForm } from "@/components/DemoForm";

export const metadata: Metadata = {
  title: "Solicita tu demo — TuBot.cl",
  description: "Deja tus datos y te contactamos para activar tu demo de TuBot: atención y ventas por WhatsApp con IA, 24/7.",
};

export default async function DemoPage({ searchParams }: { searchParams: Promise<{ plan?: string }> }) {
  const { plan } = await searchParams;
  return (
    <div className="min-h-screen bg-app">
      <header className="border-b border-line bg-panel">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/"><img src="/brand/tubot-horizontal.png" alt="TuBot.cl" className="h-8 w-auto" /></Link>
          <Link href="/login" className="text-sm font-medium text-navy-900 hover:text-brand-600">Entrar</Link>
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl gap-10 px-6 py-12 md:grid-cols-2 md:py-16">
        <div>
          <span className="inline-block rounded-full border border-brand-200 bg-panel px-3 py-1 text-xs font-semibold uppercase tracking-widest text-brand-700">
            Empieza hoy
          </span>
          <h1 className="mt-5 text-3xl font-bold leading-tight tracking-tight text-navy-900 md:text-4xl">
            Solicita tu demo de <span className="bg-gradient-to-r from-brand-600 to-accent-400 bg-clip-text text-transparent">TuBot</span>
          </h1>
          <p className="mt-4 text-ink-muted">
            Déjanos tus datos y te contactamos para activar tu acceso. Verás tu propio bot de WhatsApp atendiendo, agendando y vendiendo con IA.
          </p>
          <ul className="mt-6 space-y-2 text-sm text-ink-muted">
            <li className="flex items-center gap-2"><span className="text-accent-500">✓</span> Conexión con WhatsApp oficial</li>
            <li className="flex items-center gap-2"><span className="text-accent-500">✓</span> Agentes de IA con la información de tu negocio</li>
            <li className="flex items-center gap-2"><span className="text-accent-500">✓</span> Sin permanencia · acompañamiento en la puesta en marcha</li>
          </ul>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-6 shadow-sm md:p-8">
          <DemoForm planCode={plan} />
        </div>
      </main>
    </div>
  );
}
