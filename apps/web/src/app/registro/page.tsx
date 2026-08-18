"use client";

/**
 * Registro self-service público: crea cuenta + organización vía POST /auth/register
 * (backend existente) y aterriza según el plan elegido:
 *   - ?plan=starter|pro → /billing?plan=X (checkout inmediato con la pasarela)
 *   - ?plan=free o sin plan → /onboarding (checklist de puesta en marcha)
 * Es el destino de los CTA "Empezar" de la landing y del link que envía el bot
 * de ventas de TuBot para cerrar la venta sin intervención manual.
 */
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { api, setToken } from "@/lib/api";

const PLAN_LABELS: Record<string, string> = {
  free: "Cuenta gratis",
  starter: "Plan Starter",
  pro: "Plan Pro",
};

function RegistroForm() {
  const router = useRouter();
  const params = useSearchParams();
  const planParam = (params.get("plan") ?? "").toLowerCase();
  const plan = planParam in PLAN_LABELS ? planParam : null;

  const [name, setName] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api<{ token: string }>("/auth/register", {
        method: "POST",
        body: JSON.stringify({ name, organizationName, email, password }),
      });
      setToken(res.token);
      // Con plan pagado se va directo al checkout; si no, al checklist inicial.
      if (plan === "starter" || plan === "pro") router.push(`/billing?plan=${plan}`);
      else router.push("/onboarding");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const card = "w-full max-w-sm space-y-4 rounded-2xl border border-line bg-panel p-8 shadow-sm";
  const input = "mt-1 w-full rounded-lg border border-line-strong px-3 py-2";
  const btn = "w-full rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50";

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className={card}>
        <div className="text-center">
          <img src="/brand/tubot-horizontal.png" alt="TuBot.cl" className="mx-auto h-9 w-auto" />
          <p className="mt-2 text-sm text-ink-muted">Crea tu cuenta en minutos</p>
          {plan && (
            <span className="mt-2 inline-block rounded-full border border-brand-200 bg-brand-50 px-3 py-1 text-xs font-semibold text-brand-700 dark:border-brand-500/30 dark:bg-brand-500/10 dark:text-brand-300">
              {PLAN_LABELS[plan]}
            </span>
          )}
        </div>
        <label className="block text-sm">
          Tu nombre
          <input value={name} onChange={(e) => setName(e.target.value)} className={input} required minLength={2} maxLength={80} autoComplete="name" />
        </label>
        <label className="block text-sm">
          Nombre de tu empresa
          <input value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} className={input} required minLength={2} maxLength={120} autoComplete="organization" />
        </label>
        <label className="block text-sm">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={input} required maxLength={200} autoComplete="email" />
        </label>
        <label className="block text-sm">
          Contraseña
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} required minLength={10} maxLength={200} autoComplete="new-password" />
          <span className="mt-1 block text-[11px] text-ink-subtle">Mínimo 10 caracteres.</span>
        </label>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <button type="submit" disabled={loading} className={btn}>
          {loading ? "Creando cuenta…" : plan === "starter" || plan === "pro" ? "Crear cuenta y continuar al pago" : "Crear cuenta gratis"}
        </button>
        <p className="text-center text-[11px] text-ink-subtle">
          Al crear tu cuenta aceptas los <Link href="/legal/terminos" className="underline hover:text-brand-600">Términos</Link> y la{" "}
          <Link href="/legal/privacidad" className="underline hover:text-brand-600">Política de privacidad</Link>.
        </p>
        <p className="text-center text-sm text-ink-muted">
          ¿Ya tienes cuenta?{" "}
          <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">Entrar</Link>
        </p>
      </form>
    </main>
  );
}

export default function RegistroPage() {
  return (
    <Suspense fallback={null}>
      <RegistroForm />
    </Suspense>
  );
}
