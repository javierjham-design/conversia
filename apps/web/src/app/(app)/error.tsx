"use client";

/**
 * Error boundary de las páginas del panel. Convierte un fallo de render
 * (p. ej. un dato inesperadamente ausente) en un estado amable con opción de
 * reintentar o recargar, en vez de la pantalla de error de Next. El sidebar y
 * la barra superior (del layout) permanecen; esto solo cubre el contenido.
 */
import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Deja rastro en consola para diagnóstico (no expone nada al usuario).
    console.error("[panel] error de render:", error);
  }, [error]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-app p-8 text-center text-ink">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
        <AlertTriangle size={22} />
      </div>
      <div>
        <h2 className="text-lg font-semibold text-ink">No pudimos mostrar esta sección</h2>
        <p className="mt-1 max-w-md text-sm text-ink-muted">
          Ocurrió un problema al cargar el contenido. Puedes reintentar; si vuelve a pasar, recarga la página o avísanos.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => reset()}
          className="inline-flex items-center gap-1.5 rounded-control bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
        >
          <RefreshCw size={15} /> Reintentar
        </button>
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-1.5 rounded-control border border-line-strong bg-panel px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-app"
        >
          Recargar la página
        </button>
      </div>
      {error.digest && <p className="text-2xs text-ink-subtle">Referencia: {error.digest}</p>}
    </div>
  );
}
