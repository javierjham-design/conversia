"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { LifeBuoy, Send, X } from "lucide-react";
import { api } from "@/lib/api";

/**
 * Botón flotante de soporte (abajo a la derecha). El cliente describe un problema
 * y se crea un ticket que el Super Admin ve en su bandeja (y recibe por correo).
 */
export function SupportWidget() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api("/support", {
        method: "POST",
        body: JSON.stringify({ subject: subject || undefined, message, url: pathname }),
      });
      setSent(true);
      setMessage("");
      setSubject("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setOpen(false);
    setTimeout(() => {
      setSent(false);
      setError(null);
    }, 200);
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Soporte"
        className="fixed bottom-4 right-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-brand-600 text-white shadow-lg transition hover:bg-brand-700"
        title="¿Necesitas ayuda?"
      >
        {open ? <X size={20} /> : <LifeBuoy size={22} />}
      </button>

      {open && (
        <div className="fixed bottom-20 right-4 z-50 w-[92vw] max-w-sm rounded-2xl border border-line bg-panel p-4 shadow-2xl">
          <div className="mb-2 flex items-center gap-2">
            <LifeBuoy size={18} className="text-brand-600 dark:text-accent-400" />
            <h3 className="font-semibold text-ink">Soporte</h3>
          </div>

          {sent ? (
            <div className="py-3 text-center">
              <p className="text-sm text-ink">¡Recibido! Te responderemos a tu correo. 🙌</p>
              <button onClick={close} className="mt-3 text-sm font-medium text-brand-600 hover:underline dark:text-accent-400">
                Cerrar
              </button>
            </div>
          ) : (
            <>
              <p className="mb-3 text-xs text-ink-muted">
                Cuéntanos qué está pasando y lo revisamos. Incluimos la página en la que estás.
              </p>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Asunto (opcional)"
                maxLength={120}
                className="mb-2 w-full rounded-lg border border-line-strong bg-app px-3 py-2 text-sm text-ink"
              />
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Describe el problema…"
                rows={4}
                maxLength={4000}
                className="mb-2 w-full resize-none rounded-lg border border-line-strong bg-app px-3 py-2 text-sm text-ink"
              />
              {error && <p className="mb-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
              <button
                onClick={() => void submit()}
                disabled={busy || message.trim().length < 5}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
              >
                <Send size={15} /> {busy ? "Enviando…" : "Enviar"}
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
