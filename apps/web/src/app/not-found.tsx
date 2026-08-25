/**
 * Página 404 propia (en español, con la marca del panel) en vez de la pantalla
 * por defecto de Next. Cubre cualquier ruta inexistente.
 */
import Link from "next/link";
import { Compass } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-app p-8 text-center text-ink">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
        <Compass size={22} />
      </div>
      <div>
        <p className="text-3xl font-semibold tnum text-ink">404</p>
        <h1 className="mt-1 text-lg font-semibold text-ink">No encontramos esta página</h1>
        <p className="mt-1 max-w-md text-sm text-ink-muted">
          El enlace puede estar roto o la página ya no existe. Vuelve a la bandeja para seguir trabajando.
        </p>
      </div>
      <Link
        href="/inbox"
        className="inline-flex items-center gap-1.5 rounded-control bg-brand-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-700"
      >
        Ir a la bandeja
      </Link>
    </div>
  );
}
