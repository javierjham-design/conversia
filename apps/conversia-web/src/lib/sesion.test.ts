import { describe, expect, it, vi } from "vitest";

// sesion.ts importa api.ts, que fija `const API = apiBase()` al importar.
vi.mock("./api-base", () => ({ apiBase: () => "http://api.test" }));

import { estadoDelVisitante } from "./sesion";

function makeJwt(expSeconds: number): string {
  return `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.s`;
}
const vivo = () => makeJwt(Math.floor(Date.now() / 1000) + 3600);
const vencido = () => makeJwt(Math.floor(Date.now() / 1000) - 3600);

/**
 * La landing pública NO redirige al panel. Esto fija las tres salidas que decide; que no
 * redirija lo fija el test de la página (no hay `router.replace` que llamar).
 */
describe("estadoDelVisitante", () => {
  it("sin token es anónimo", () => {
    expect(estadoDelVisitante(null, null)).toBe("anonimo");
    expect(estadoDelVisitante(null, "rt_loquesea")).toBe("anonimo");
  });

  it("con el access vivo ofrece el panel", () => {
    expect(estadoDelVisitante(vivo(), null)).toBe("con-sesion");
  });

  it("con el access vencido pero refresh guardado, también (es reanudable)", () => {
    expect(estadoDelVisitante(vencido(), "rt_loquesea")).toBe("con-sesion");
  });

  it("access vencido y sin refresh = sesión muerta, se limpia", () => {
    expect(estadoDelVisitante(vencido(), null)).toBe("muerta");
    expect(estadoDelVisitante("basura", null)).toBe("muerta");
  });
});
