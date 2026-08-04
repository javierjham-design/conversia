/**
 * Helpers puros y resistentes a datos ausentes.
 * Extraídos de las páginas para poder testearlos con fixtures deliberadamente
 * incompletas (tenant nuevo / registros con null). Ver safe.test.ts.
 */

/** Formatea un importe; los planes "a medida" (Enterprise) traen importe nulo. */
export function money(amount: number | null | undefined, currency: string): string {
  if (amount == null) return "A medida";
  return currency === "CLP"
    ? `$${amount.toLocaleString("es-CL")} CLP`
    : `US$ ${amount.toLocaleString("en-US")}`;
}

export interface PermModule {
  module: string;
  actions: { key: string }[];
}

/**
 * Expande una lista de permisos (con comodines `*` y `modulo:*`) a claves
 * concretas. Tolera `perms`/`catalog`/`actions` ausentes (rol recién creado).
 */
export function expandPerms(
  perms: string[] | null | undefined,
  catalog: PermModule[] | null | undefined,
): string[] {
  const out = new Set<string>();
  const mods = catalog ?? [];
  for (const p of perms ?? []) {
    if (p === "*") mods.forEach((m) => (m.actions ?? []).forEach((a) => out.add(a.key)));
    else if (p.endsWith(":*")) mods.find((m) => m.module === p.slice(0, -2))?.actions?.forEach((a) => out.add(a.key));
    else out.add(p);
  }
  return Array.from(out);
}

/**
 * Rellena con "" los campos string ausentes/nulos de un objeto de ajustes,
 * para no romper inputs controlados ni `.trim()` cuando el tenant aún no los
 * configuró.
 */
export function withStringDefaults<T extends object>(
  defaults: T,
  data: Partial<Record<keyof T, unknown>> | null | undefined,
): T {
  const clean = Object.fromEntries(
    Object.entries(data ?? {}).filter(([, v]) => v != null),
  );
  return { ...defaults, ...clean } as T;
}
