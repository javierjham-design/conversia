// Inferencia de país + zona horaria a partir del prefijo telefónico.
// Cobertura para LatAm + comunes; se amplía fácil agregando filas.
// [prefijo sin +, país ISO, zona horaria representativa]
const CALLING_CODES: [string, string, string][] = [
  ["569", "CL", "America/Santiago"],
  ["56", "CL", "America/Santiago"],
  ["521", "MX", "America/Mexico_City"],
  ["52", "MX", "America/Mexico_City"],
  ["51", "PE", "America/Lima"],
  ["54", "AR", "America/Argentina/Buenos_Aires"],
  ["57", "CO", "America/Bogota"],
  ["58", "VE", "America/Caracas"],
  ["593", "EC", "America/Guayaquil"],
  ["591", "BO", "America/La_Paz"],
  ["595", "PY", "America/Asuncion"],
  ["598", "UY", "America/Montevideo"],
  ["55", "BR", "America/Sao_Paulo"],
  ["502", "GT", "America/Guatemala"],
  ["503", "SV", "America/El_Salvador"],
  ["504", "HN", "America/Tegucigalpa"],
  ["505", "NI", "America/Managua"],
  ["506", "CR", "America/Costa_Rica"],
  ["507", "PA", "America/Panama"],
  ["34", "ES", "Europe/Madrid"],
  ["1", "US", "America/New_York"],
];
// Prefijos más largos primero (569 antes que 56, 521 antes que 52…).
const SORTED = [...CALLING_CODES].sort((a, b) => b[0].length - a[0].length);

/** Normaliza un wa_id (solo dígitos) o teléfono a E.164 (+dígitos). */
export function toE164(raw: string): string {
  const digits = String(raw ?? "").replace(/[^\d]/g, "");
  return digits ? `+${digits}` : "";
}

/** Infiere país ISO + zona horaria estimada desde el teléfono (por prefijo). */
export function geoFromPhone(raw: string): { phone: string; country: string | null; timezone: string | null } {
  const phone = toE164(raw);
  const digits = phone.replace(/^\+/, "");
  for (const [prefix, country, tz] of SORTED) {
    if (digits.startsWith(prefix)) return { phone, country, timezone: tz };
  }
  return { phone, country: null, timezone: null };
}
