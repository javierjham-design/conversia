import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { plazoVencido, shouldRedirectOn401 } from "./api";

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

  it("el refresh y el login por passkey NO disparan el flujo de sesión vencida (P3)", () => {
    // Si el 401 del propio /auth/refresh redirigiera, entraría en bucle con el refresh.
    expect(shouldRedirectOn401("/auth/refresh", "/inbox")).toBe(false);
    expect(shouldRedirectOn401("/auth/passkey-login/options", "/login")).toBe(false);
    expect(shouldRedirectOn401("/auth/logout", "/inbox")).toBe(false);
  });
});

/**
 * SESIÓN DE APARATO en TuBot (passkeys P3): una sesión de passkey NO tiene plazo (sin techo), así
 * que `plazoVencido` nunca debe cortarle el refresh por "no saber".
 */
describe("plazoVencido", () => {
  it("sin plazo conocido (null) NUNCA está vencida → el refresh se sigue intentando", () => {
    expect(plazoVencido(null)).toBe(false);
  });
  it("con un plazo pasado sí; con uno futuro no", () => {
    const now = Date.now();
    expect(plazoVencido(now - 1000, now)).toBe(true);
    expect(plazoVencido(now + 1000, now)).toBe(false);
  });
});

/**
 * La sesión de aparato está CABLEADA en el cliente de TuBot: el refresh hace el Face ID cuando el
 * servidor lo exige, y entrar por passkey / cambiar de organización guardan el REFRESH (`setSession`),
 * no solo el access (`setToken`, que lo borraría y devolvería la sesión a 12 h). Un botón que llame
 * al endpoint pero guarde con `setToken` dejaría la vida larga rota sin un solo error visible.
 */
describe("TuBot P3: el cliente cablea la sesión de aparato", () => {
  const src = (p: string) => readFileSync(join(__dirname, p), "utf8");

  it("el refresh pide la firma del passkey (Face ID) cuando el servidor la exige", () => {
    const api = src("./api.ts");
    expect(api).toContain("needsAssertion");
    expect(api).toContain("startAuthentication");
    expect(api).toContain("/auth/refresh");
  });

  it("entrar por passkey guarda el refresh con setSession, no con setToken", () => {
    const login = src("../app/login/page.tsx");
    expect(login).toMatch(/"\/auth\/passkey-login"[\s\S]*?setSession\(res\)/);
  });

  it("cambiar de organización conserva el refresh (setSession en los dos switch-org)", () => {
    expect(src("../components/OrgSwitcher.tsx")).toContain("setSession(res)");
    expect(src("../app/(app)/layout.tsx")).toContain("setSession(res)");
  });
});
