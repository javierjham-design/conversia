"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Clock, Copy, FileText, XCircle } from "lucide-react";
import { api } from "@/lib/api";
import { PageHeader, Skeleton, useToast } from "@/components/ui";

interface Suggestion {
  name: string;
  title: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  language: string;
  body: string;
  why: string;
  syncStatus: string;
}

const CATEGORY_LABEL: Record<string, string> = {
  MARKETING: "Marketing",
  UTILITY: "Utilidad",
  AUTHENTICATION: "Autenticación",
};

function SyncBadge({ status }: { status: string }) {
  if (status === "APPROVED")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300">
        <Check size={12} /> Aprobada
      </span>
    );
  if (status === "PENDING" || status === "IN_APPEAL" || status === "PENDING_DELETION")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/50 dark:text-amber-300">
        <Clock size={12} /> En revisión
      </span>
    );
  if (status === "REJECTED")
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:bg-red-950/50 dark:text-red-300">
        <XCircle size={12} /> Rechazada
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-app px-2 py-0.5 text-[11px] font-medium text-ink-muted">
      Sin crear
    </span>
  );
}

export default function TemplateGuidePage() {
  const toast = useToast();
  const [data, setData] = useState<{ suggestions: Suggestion[]; whatsappConnected: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ suggestions: Suggestion[]; whatsappConnected: boolean }>("/onboarding/plantillas")
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, []);

  function copy(text: string, what: string) {
    void navigator.clipboard.writeText(text);
    toast.push(`${what} copiado`, "ok");
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <PageHeader
          title="Plantillas de tu rubro"
          description="Estas son las plantillas de WhatsApp que tu negocio necesita. Copia el texto y créalas en Meta; aquí verás el estado de cada una."
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
            {!data.whatsappConnected && (
              <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
                Aún no conectas WhatsApp. Primero{" "}
                <Link href="/channels" className="font-medium underline">
                  vincula tu número
                </Link>{" "}
                para poder crear y sincronizar plantillas.
              </div>
            )}

            <div className="mb-4 rounded-lg border border-line bg-panel px-4 py-3 text-[13px] text-ink-muted">
              <b className="text-ink">Cómo crearlas:</b> en Meta Business Manager → WhatsApp Manager →
              Plantillas de mensajes → Crear plantilla. Pega el nombre y el cuerpo. Los{" "}
              <code className="rounded bg-app px-1">{"{{1}}"}</code> son variables que se rellenan al enviar.
              Cuando Meta las apruebe, se sincronizan solas y el estado cambia aquí.
            </div>

            <div className="space-y-3">
              {data.suggestions.map((t) => (
                <div key={t.name} className="rounded-card border border-line bg-panel p-4">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2">
                    <FileText size={16} className="text-brand-600 dark:text-accent-400" />
                    <span className="font-medium text-ink">{t.title}</span>
                    <span className="rounded bg-app px-1.5 py-0.5 text-[11px] text-ink-muted">{CATEGORY_LABEL[t.category]}</span>
                    <span className="ml-auto">
                      <SyncBadge status={t.syncStatus} />
                    </span>
                  </div>
                  <p className="mb-2 text-xs text-ink-subtle">{t.why}</p>

                  <div className="mb-2 flex items-center gap-2">
                    <code className="rounded bg-app px-2 py-1 text-[12px] text-ink">{t.name}</code>
                    <button onClick={() => copy(t.name, "Nombre")} className="text-ink-subtle hover:text-ink" title="Copiar nombre">
                      <Copy size={13} />
                    </button>
                    <span className="text-[11px] text-ink-subtle">idioma: {t.language}</span>
                  </div>

                  <div className="relative rounded-lg border border-line bg-app p-3">
                    <p className="whitespace-pre-wrap pr-8 text-[13px] text-ink">{t.body}</p>
                    <button
                      onClick={() => copy(t.body, "Texto")}
                      className="absolute right-2 top-2 rounded-md border border-line bg-panel p-1.5 text-ink-muted hover:text-ink"
                      title="Copiar texto"
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <p className="mt-6 text-center text-xs text-ink-subtle">
              El estado se actualiza automáticamente al sincronizar con Meta.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
