/**
 * Etiquetas en español para claves internas (B3 de la armonización): las claves
 * NO se renombran — se traducen en la capa de presentación.
 */

export const ROLE_LABELS: Record<string, string> = {
  owner: "Propietario",
  admin: "Administrador",
  operator: "Operador",
  agent: "Agente",
  supervisor: "Supervisor",
  viewer: "Solo lectura",
};

export function roleLabel(code: string | null | undefined): string {
  if (!code) return "—";
  return ROLE_LABELS[code] ?? code;
}
