"use client";

/**
 * Página del ENLACE DE UN CLIC del montaje asistido: el bot de implementación de
 * TuBot le manda este link al cliente en la conversación; el cliente (logueado en
 * su cuenta) autoriza acá que TuBot le configure su plataforma durante la
 * implementación. Acotado (solo configuración), auditado y revocable.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { Button, useToast } from "@/components/ui";

export default function MontajeAsistidoPage() {
  const params = useSearchParams();
  const token = params.get("t") ?? "";
  const toast = useToast();
  const [state, setState] = useState<"idle" | "authorizing" | "done" | "error">("idle");
  const [expiresAt, setExpiresAt] = useState<string | null>(null);

  async function authorize() {
    if (!token) return;
    setState("authorizing");
    try {
      const r = await api<{ expiresAt: string }>("/assisted-setup/authorize-linked", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      setExpiresAt(r.expiresAt);
      setState("done");
      toast.push("Montaje asistido autorizado ✔", "ok");
    } catch (e) {
      setState("error");
      toast.push((e as Error).message, "error");
    }
  }

  return (
    <div className="mx-auto max-w-lg p-6">
      <div className="rounded-card border border-line bg-panel p-6 shadow-card">
        <h1 className="text-lg font-semibold text-ink">Montaje asistido de TuBot</h1>

        {state === "done" ? (
          <div className="mt-4 space-y-3">
            <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
              ✔ Listo. Autorizaste el montaje asistido{expiresAt ? ` hasta el ${new Date(expiresAt).toLocaleDateString("es-CL")}` : ""}. Vuelve a
              la conversación con tu asistente para seguir armando tu plataforma.
            </p>
            <p className="text-xs text-ink-muted">
              Puedes quitar este permiso cuando quieras en <Link href="/settings/data" className="underline">Configuración → Datos</Link>.
            </p>
          </div>
        ) : (
          <>
            <p className="mt-2 text-sm text-ink-muted">
              Tu asistente de TuBot quiere ayudarte a <b>dejar tu cuenta configurada</b> durante la implementación: crear tu agente, cargar tus
              servicios, precios y base de conocimiento, y publicar tus flujos.
            </p>
            <ul className="mt-3 space-y-1.5 text-sm text-ink">
              <li>✅ Solo toca tu <b>configuración</b> (agentes, flujos, servicios, base de conocimiento).</li>
              <li>🚫 <b>Nunca</b> ve tus conversaciones ni tus contactos, ni envía mensajes por ti.</li>
              <li>🕑 Dura <b>14 días</b> y lo <b>revocas cuando quieras</b>. Todo queda en tu Auditoría.</li>
            </ul>
            {!token && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                Este enlace no trae la información necesaria. Pídele a tu asistente uno nuevo en la conversación.
              </p>
            )}
            <div className="mt-5 flex items-center gap-3">
              <Button disabled={!token || state === "authorizing"} onClick={() => void authorize()}>
                {state === "authorizing" ? "Autorizando…" : "Autorizar montaje asistido"}
              </Button>
              <Link href="/" className="text-sm text-ink-muted hover:text-ink">Ahora no</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
