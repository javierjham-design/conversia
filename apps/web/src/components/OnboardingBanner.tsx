"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Rocket, X } from "lucide-react";
import { api } from "@/lib/api";

interface Onboarding {
  completed: number;
  total: number;
  percent: number;
  done: boolean;
}

/**
 * Banner delgado de progreso de activación. Aparece mientras el checklist no
 * está completo (y el usuario no lo ocultó en esta sesión). Enlaza a /onboarding.
 */
export function OnboardingBanner() {
  const pathname = usePathname();
  const [data, setData] = useState<Onboarding | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(sessionStorage.getItem("onboardingBannerDismissed") === "1");
    void api<Onboarding>("/onboarding").then(setData).catch(() => undefined);
  }, []);

  // No mostrar en la propia página de primeros pasos ni cuando ya está completo.
  if (!data || data.done || dismissed || pathname === "/onboarding") return null;

  return (
    <div className="flex items-center gap-3 border-b border-line bg-gradient-to-r from-brand-600/10 to-accent-500/10 px-4 py-2 text-[13px]">
      <Rocket size={16} className="shrink-0 text-brand-600 dark:text-accent-400" />
      <span className="text-ink">
        Termina de configurar tu asistente — <b>{data.completed}/{data.total}</b> pasos.
      </span>
      <div className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-app sm:block">
        <div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500" style={{ width: `${data.percent}%` }} />
      </div>
      <Link href="/onboarding" className="ml-auto whitespace-nowrap font-medium text-brand-600 hover:underline dark:text-accent-400">
        Continuar →
      </Link>
      <button
        onClick={() => {
          setDismissed(true);
          sessionStorage.setItem("onboardingBannerDismissed", "1");
        }}
        aria-label="Ocultar"
        className="text-ink-subtle hover:text-ink"
      >
        <X size={15} />
      </button>
    </div>
  );
}
