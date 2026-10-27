import { describe, expect, it } from "vitest";
import { shouldRedirectOn401 } from "./api";

/**
 * §10.1 — Un 401 en una llamada de autenticación (login, registro, MFA, invitación) o estando ya
 * en /login NO debe redirigir/recargar: el formulario debe mostrar el error del backend. El resto
 * (sesión vencida navegando el panel) sí redirige — comportamiento histórico de TuBot, intacto.
 */
describe("shouldRedirectOn401 (§10.1)", () => {
  it("NO redirige en rutas de autenticación", () => {
    for (const p of [
      "/auth/login",
      "/auth/register",
      "/auth/mfa/verify",
      "/auth/mfa/enable",
      "/auth/accept-invite",
      "/auth/invite/abc123",
    ]) {
      expect(shouldRedirectOn401(p, "/login")).toBe(false);
    }
  });

  it("NO redirige si ya estás en /login (evita recarga sin feedback)", () => {
    expect(shouldRedirectOn401("/contacts", "/login")).toBe(false);
  });

  it("SÍ redirige con sesión vencida navegando el panel (comportamiento histórico)", () => {
    expect(shouldRedirectOn401("/contacts", "/inbox")).toBe(true);
    // /auth/me no es una ruta de login: su 401 = sesión vencida → redirige.
    expect(shouldRedirectOn401("/auth/me", "/inbox")).toBe(true);
  });
});
