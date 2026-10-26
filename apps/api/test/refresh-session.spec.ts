import { describe, it, expect } from "vitest";
import { parseDurationSeconds } from "../src/auth/refresh-session.service";

/**
 * Parser de duración del refresh token (Bloque 3). Pura: sin Redis. El FLUJO completo (crear /
 * resolver / rotar / revocar contra Redis) lo cubre la jornada F de Playwright contra el sim.
 */
describe("parseDurationSeconds", () => {
  it("interpreta días/horas/minutos/segundos", () => {
    expect(parseDurationSeconds("30d")).toBe(30 * 86400);
    expect(parseDurationSeconds("12h")).toBe(12 * 3600);
    expect(parseDurationSeconds("45m")).toBe(45 * 60);
    expect(parseDurationSeconds("90s")).toBe(90);
  });
  it("acepta segundos a secas y tolera espacios/mayúsculas", () => {
    expect(parseDurationSeconds("3600")).toBe(3600);
    expect(parseDurationSeconds(" 2 D ")).toBe(2 * 86400);
  });
  it("cae al fallback ante valores vacíos, 0 o ilegibles", () => {
    const fallback = 30 * 24 * 3600;
    expect(parseDurationSeconds(undefined)).toBe(fallback);
    expect(parseDurationSeconds("")).toBe(fallback);
    expect(parseDurationSeconds("0d")).toBe(fallback);
    expect(parseDurationSeconds("abc")).toBe(fallback);
    expect(parseDurationSeconds("12x")).toBe(fallback);
    expect(parseDurationSeconds("7w", 99)).toBe(99);
  });
});
