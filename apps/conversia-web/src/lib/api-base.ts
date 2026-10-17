/**
 * Base de la API con RED DE SEGURIDAD de runtime (hallazgo prod 17-oct-2026): el bundle
 * de producción se construyó sin NEXT_PUBLIC_API_URL y quedó apuntando a localhost —
 * para cualquier visitante la página moría en "Cargando…". Regla: la variable de build
 * manda; si falta y el sitio corre en un dominio conversia.cl, se usa la API pública
 * conocida; localhost queda SOLO para desarrollo local real.
 */
export const PROD_API_FALLBACK = "https://api-production-cf8e.up.railway.app";

export function apiBase(): string {
  const fromEnv = process.env.NEXT_PUBLIC_API_URL;
  if (fromEnv && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(fromEnv)) return fromEnv;
  // Red de seguridad endurecida (QA prod): si el sitio corre en CUALQUIER host real
  // (no localhost) y falta/está mal NEXT_PUBLIC_API_URL, usamos la API pública en vez de
  // localhost. Antes solo cubría *.conversia.cl → un preview/custom host sin la var caía a
  // localhost. localhost queda SOLO para desarrollo local real.
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host !== "localhost" && host !== "127.0.0.1") return PROD_API_FALLBACK;
  }
  return fromEnv ?? "http://localhost:4000";
}
