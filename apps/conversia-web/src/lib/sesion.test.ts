import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// sesion.ts importa api.ts, que fija `const API = apiBase()` al importar.
vi.mock("./api-base", () => ({ apiBase: () => "http://api.test" }));

import { estadoDelVisitante } from "./sesion";

function makeJwt(expSeconds: number): string {
  return `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url")}.s`;
}
const vivo = () => makeJwt(Math.floor(Date.now() / 1000) + 3600);
const vencido = () => makeJwt(Math.floor(Date.now() / 1000) - 3600);
const HORA = 3_600_000;

/**
 * La landing pública NO redirige al panel. Esto fija las salidas que decide; que no
 * redirija lo fija el test de la página (no hay `router.replace` que llamar).
 *
 * El tercer argumento es el PLAZO MÁXIMO de la sesión (24 h, el techo que manda el servidor).
 * Es obligatorio a propósito: el bug que esto cierra era ofrecer "Ir a mi panel" mirando solo
 * si había un refresh token guardado, sin importar de cuándo era. Con el plazo opcional, un
 * llamador nuevo se lo olvidaría y volvería el agujero sin que nada se pusiera rojo.
 */
describe("estadoDelVisitante", () => {
  it("sin token es anónimo", () => {
    expect(estadoDelVisitante(null, null, null)).toBe("anonimo");
    expect(estadoDelVisitante(null, "rt_loquesea", null)).toBe("anonimo");
  });

  it("con el access vivo ofrece el panel", () => {
    expect(estadoDelVisitante(vivo(), null, null)).toBe("con-sesion");
  });

  it("con el access vencido pero refresh guardado, también (es reanudable)", () => {
    expect(estadoDelVisitante(vencido(), "rt_loquesea", null)).toBe("con-sesion");
  });

  it("access vencido y sin refresh = sesión muerta, se limpia", () => {
    expect(estadoDelVisitante(vencido(), null, null)).toBe("muerta");
    expect(estadoDelVisitante("basura", null, null)).toBe("muerta");
  });

  // ── El techo de 24 h ──────────────────────────────────────────────────────
  it("pasado el plazo de 24 h la sesión está MUERTA, aunque el access siga vivo", () => {
    // Esto es lo que vio el dueño: entraba a conversia.cl días después y el botón lo metía
    // derecho al panel. El servidor ya no lo dejaría pasar; el botón mentía.
    expect(estadoDelVisitante(vivo(), "rt_loquesea", Date.now() - 1)).toBe("muerta");
    expect(estadoDelVisitante(vivo(), null, Date.now() - HORA)).toBe("muerta");
  });

  it("dentro del plazo se comporta como siempre", () => {
    expect(estadoDelVisitante(vivo(), null, Date.now() + HORA)).toBe("con-sesion");
    expect(estadoDelVisitante(vencido(), "rt_loquesea", Date.now() + HORA)).toBe("con-sesion");
  });

  it("sin plazo guardado NO se asume vencida", () => {
    // Dos casos reales: la sesión que ya estaba en el navegador antes de este cambio, y la
    // web desplegada ANTES que la api (conversia-web se despliega sola al mergear). Si un
    // plazo ausente contara como vencido, sacaríamos al login a gente con sesión válida.
    expect(estadoDelVisitante(vivo(), null, null)).toBe("con-sesion");
    expect(estadoDelVisitante(vencido(), "rt_loquesea", null)).toBe("con-sesion");
  });
});

/**
 * Las DOS puertas por las que se entra al panel tienen que CONSULTAR el plazo. Que la regla
 * esté bien probada no prueba que la pantalla la use: es exactamente el error que ya cometí
 * una vez (probar `scopesForFeature` mientras el endpoint seguía llamando a otra cosa).
 * Estas pantallas son componentes de React con `useEffect` y no se pueden ejercitar desde
 * vitest sin montar Next, así que se revisa el código fuente.
 */
describe("la landing y el shell consultan el plazo", () => {
  const leer = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

  it("la landing pasa el plazo a estadoDelVisitante", () => {
    const src = leer("app/page.tsx");
    expect(src).toContain("getSessionDeadline()");
    expect(src).toMatch(/estadoDelVisitante\(\s*getToken\(\),\s*getRefreshToken\(\),\s*getSessionDeadline\(\)\s*\)/);
  });

  it("el shell del panel echa al login cuando el plazo venció", () => {
    const src = leer("components/AppShell.tsx");
    expect(src).toContain("plazoVencido(getSessionDeadline())");
    // Y manda al login con el aviso, no a una pantalla en blanco.
    expect(src).toContain("expirada=1");
  });
});
