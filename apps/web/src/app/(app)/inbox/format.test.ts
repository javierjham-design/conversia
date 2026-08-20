import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatListTime } from "./types";

// La lista de la Bandeja mostraba SIEMPRE la hora → un mensaje de días previos parecía de hoy.
// Ahora: hora si es hoy, "Ayer" si es ayer, y la fecha si es más atrás.
describe("formatListTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Referencia: 2026-08-20 10:00 hora local.
    vi.setSystemTime(new Date(2026, 7, 20, 10, 0, 0));
  });
  afterEach(() => vi.useRealTimers());

  it("hoy → muestra la hora (no la fecha)", () => {
    const r = formatListTime(new Date(2026, 7, 20, 7, 11, 0).toISOString());
    expect(r).toMatch(/\d{1,2}:\d{2}/);
    expect(r).not.toBe("Ayer");
  });

  it("ayer → 'Ayer'", () => {
    expect(formatListTime(new Date(2026, 7, 19, 23, 30, 0).toISOString())).toBe("Ayer");
  });

  it("hace varios días (mismo año) → día + mes, sin hora", () => {
    const r = formatListTime(new Date(2026, 7, 10, 9, 5, 0).toISOString());
    expect(r).not.toBe("Ayer");
    expect(r).not.toMatch(/\d{1,2}:\d{2}/); // no debe contener hora
    expect(r.toLowerCase()).toContain("ago"); // "10 ago"
  });

  it("año anterior → incluye el año", () => {
    expect(formatListTime(new Date(2025, 11, 31, 12, 0, 0).toISOString())).toMatch(/25|2025/);
  });

  it("vacío/ inválido → cadena vacía", () => {
    expect(formatListTime(null)).toBe("");
    expect(formatListTime("no-date")).toBe("");
  });
});
