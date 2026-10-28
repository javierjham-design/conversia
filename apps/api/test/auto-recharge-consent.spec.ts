import { describe, expect, it } from "vitest";
import { resolveConsent } from "../src/billing/auto-recharge-consent";

/**
 * CRE 2 (§6) — el consentimiento es lo que hace legítimo un cobro automático futuro. El
 * worker no cobra sin él, así que esta regla decide si la plata sale o no sale.
 */

const AYER = "2026-10-27T12:00:00.000Z";
const AHORA = new Date("2026-10-28T10:00:00.000Z");

describe("§6 — consentimiento de la recarga automática", () => {
  it("activar con la casilla marcada registra la fecha", () => {
    expect(resolveConsent({ enabled: true, previo: null, consent: true, now: AHORA })).toBe(AHORA.toISOString());
  });

  it("activar SIN marcar la casilla no da consentimiento (el endpoint responde 400)", () => {
    expect(resolveConsent({ enabled: true, previo: null, consent: false, now: AHORA })).toBeNull();
    expect(resolveConsent({ enabled: true, previo: null, now: AHORA })).toBeNull();
  });

  it("a quien ya aceptó no se le vuelve a pedir (puede ajustar el umbral sin re-aceptar)", () => {
    expect(resolveConsent({ enabled: true, previo: AYER, consent: false, now: AHORA })).toBe(AYER);
  });

  it("y la fecha original se CONSERVA (es el registro de cuándo autorizó)", () => {
    expect(resolveConsent({ enabled: true, previo: AYER, consent: true, now: AHORA })).toBe(AYER);
  });

  it("al desactivar se BORRA: volver a encenderla exige aceptar de nuevo", () => {
    // Si se conservara, un "activar" accidental meses después cobraría con un permiso
    // viejo que el cliente ya había retirado.
    expect(resolveConsent({ enabled: false, previo: AYER, consent: true, now: AHORA })).toBeNull();
  });

  it("un valor guardado basura no vale como consentimiento", () => {
    for (const previo of ["", "   ", 1, true, {}, null, undefined]) {
      expect(resolveConsent({ enabled: true, previo, consent: false, now: AHORA })).toBeNull();
    }
  });
});
