import { describe, expect, it, vi } from "vitest";

/**
 * Las preferencias de notificación son POR USUARIO (org.settings.notifPrefs[userId]):
 * cambiar las de Ana no afecta a Pedro, y los correos externos pasan siempre.
 * Se testea la lógica de filtrado con los mismos defaults del sistema.
 */
function applyPrefFilter(
  recipients: string[],
  userIdByEmail: Map<string, string>,
  allPrefs: Record<string, Record<string, boolean>>,
  pref: "aiEscalation" | "dailySummary" | "dataJobs",
): string[] {
  const defaults: Record<string, boolean> = { aiEscalation: true, dailySummary: false, dataJobs: true };
  return recipients.filter((email) => {
    const userId = userIdByEmail.get(email.toLowerCase());
    if (!userId) return true;
    const p = allPrefs[userId] ?? {};
    const value = p[pref] ?? defaults[pref];
    return pref === "dailySummary" ? value === true : value !== false;
  });
}

describe("preferencias de notificación por usuario", () => {
  const users = new Map([
    ["ana@clinica.cl", "user-ana"],
    ["pedro@clinica.cl", "user-pedro"],
  ]);

  it("apagar la preferencia de un usuario NO afecta a otro", () => {
    const prefs = { "user-ana": { aiEscalation: false } };
    const out = applyPrefFilter(["ana@clinica.cl", "pedro@clinica.cl"], users, prefs, "aiEscalation");
    expect(out).toEqual(["pedro@clinica.cl"]);
  });

  it("correos externos (sin cuenta) pasan siempre", () => {
    const out = applyPrefFilter(["externo@gmail.com", "ana@clinica.cl"], users, { "user-ana": { aiEscalation: false } }, "aiEscalation");
    expect(out).toEqual(["externo@gmail.com"]);
  });

  it("resumen diario: default APAGADO para usuarios del panel (opt-in)", () => {
    const out = applyPrefFilter(["ana@clinica.cl", "pedro@clinica.cl", "externo@gmail.com"], users, { "user-pedro": { dailySummary: true } }, "dailySummary");
    expect(out).toEqual(["pedro@clinica.cl", "externo@gmail.com"]);
  });
});
