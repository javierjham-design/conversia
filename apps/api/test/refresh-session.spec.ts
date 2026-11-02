import { describe, it, expect } from "vitest";
import { parseDurationSeconds, techoDeLaSesion, ttlHastaElTecho } from "../src/auth/refresh-session.service";

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

/**
 * TECHO ABSOLUTO de la sesión deslizante. El hallazgo que lo motiva: `refresh()` rotaba el token
 * creando una sesión nueva con TTL de 30 d COMPLETOS, así que quien entraba al panel una vez al
 * mes no volvía a escribir su contraseña nunca. "La sesión dura 30 días" era falso.
 */
const DIA = 86_400_000;
const MAX = 90 * DIA;

describe("techoDeLaSesion", () => {
  it("usa el techo guardado y NO lo mueve al rotar (si no, no es un techo)", () => {
    const login = Date.UTC(2026, 0, 1);
    const techo = login + MAX;
    // La sesión se rotó hoy: `createdAt` es de hoy, pero el techo sigue siendo el del login.
    const rotadaHoy = { createdAt: login + 80 * DIA, absoluteExpiresAt: techo };
    expect(techoDeLaSesion(rotadaHoy, MAX)).toBe(techo);
  });

  it("a una sesión vieja (sin techo guardado) se lo cuenta desde su login, no desde ahora", () => {
    // Las que ya estaban abiertas al desplegar. Contar desde `Date.now()` les regalaría 90 días
    // más y las dejaría eternas otra vez — exactamente el defecto que esto cierra.
    const login = Date.UTC(2026, 0, 1);
    expect(techoDeLaSesion({ createdAt: login }, MAX)).toBe(login + MAX);
  });
});

describe("ttlHastaElTecho", () => {
  it("usa la ventana deslizante mientras el techo esté lejos", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(ttlHastaElTecho(now + MAX, now, 30 * 86400)).toBe(30 * 86400);
  });

  it("recorta el TTL para que la clave no sobreviva al techo", () => {
    // Quedan 3 días de techo: renovar NO puede dejar la clave viva 30 días más.
    const now = Date.UTC(2026, 0, 1);
    expect(ttlHastaElTecho(now + 3 * DIA, now, 30 * 86400)).toBe(3 * 86400);
  });

  it("nunca devuelve 0 ni negativo (Redis rechaza un EX 0)", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(ttlHastaElTecho(now, now, 30 * 86400)).toBe(1);
    expect(ttlHastaElTecho(now - 10 * DIA, now, 30 * 86400)).toBe(1);
  });
});
