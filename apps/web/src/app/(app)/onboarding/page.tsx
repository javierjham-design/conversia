"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle, PartyPopper } from "lucide-react";
import { api } from "@/lib/api";
import { Button, PageHeader, Skeleton } from "@/components/ui";

interface Step {
  key: string;
  title: string;
  description: string;
  done: boolean;
  cta: { label: string; href: string };
}
interface Onboarding {
  steps: Step[];
  completed: number;
  total: number;
  percent: number;
  done: boolean;
}

export default function OnboardingPage() {
  const [data, setData] = useState<Onboarding | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<Onboarding>("/onboarding")
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <PageHeader
          title="Primeros pasos"
          description="Deja tu asistente funcionando en cinco pasos. Cada uno se marca solo cuando lo completas."
        />

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        {!data ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            {/* Progreso */}
            <div className="mb-6 rounded-card border border-line bg-panel p-5">
              <div className="mb-2 flex items-center justify-between text-sm">
                <span className="font-medium text-ink">
                  {data.completed} de {data.total} completados
                </span>
                <span className="text-ink-muted">{data.percent}%</span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-app">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-brand-500 to-accent-500 transition-all"
                  style={{ width: `${data.percent}%` }}
                />
              </div>
              {data.done && (
                <p className="mt-3 flex items-center gap-2 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                  <PartyPopper size={16} /> ¡Listo! Tu asistente está configurado y operativo.
                </p>
              )}
            </div>

            {/* Pasos */}
            <ol className="space-y-3">
              {data.steps.map((step, i) => (
                <li
                  key={step.key}
                  className={`flex items-start gap-3 rounded-card border p-4 ${
                    step.done ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/50 dark:bg-emerald-950/20" : "border-line bg-panel"
                  }`}
                >
                  <div className="mt-0.5 shrink-0">
                    {step.done ? (
                      <CheckCircle2 size={22} className="text-emerald-500" />
                    ) : (
                      <Circle size={22} className="text-ink-subtle" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`font-medium ${step.done ? "text-ink-muted line-through" : "text-ink"}`}>
                      <span className="mr-1.5 text-ink-subtle">{i + 1}.</span>
                      {step.title}
                    </p>
                    <p className="mt-0.5 text-sm text-ink-muted">{step.description}</p>
                  </div>
                  {!step.done && (
                    <Link href={step.cta.href} className="shrink-0 self-center">
                      <Button variant="secondary" className="whitespace-nowrap">
                        {step.cta.label}
                        <ArrowRight size={15} className="ml-1" />
                      </Button>
                    </Link>
                  )}
                </li>
              ))}
            </ol>

            <p className="mt-6 text-center text-xs text-ink-subtle">
              Cada paso se marca automáticamente cuando lo completas.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
