import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GUARDIÁN de la regresión del drawer de TuBot.
 *
 * El test de `google-oauth-permisos.spec.ts` prueba la REGLA (`scopesForAuthorize`); esto
 * prueba que el endpoint la USE. Son cosas distintas y la segunda es la que se rompió: la
 * regla por función estaba bien, pero `authorize` la aplicaba con `.default("calendar")`, así
 * que "el cliente no declaró nada" quedaba indistinguible de "el cliente pidió Calendar".
 *
 * Un escáner y no un test de integración porque el endpoint pide JWT, permisos y una conexión
 * en base: montar todo eso probaría el andamio, no el defecto.
 */

const CONTROLADOR = resolve(__dirname, "../src/integrations/oauth.controller.ts");
const PANEL_TUBOT = resolve(__dirname, "../../web/src/app/(app)/integrations/drawers.tsx");

function leer(ruta: string): string {
  return readFileSync(ruta, "utf8");
}

/** El cuerpo del handler `googleAuthorize`, hasta el `return`. */
function cuerpoDeGoogleAuthorize(src: string): string {
  const desde = src.indexOf("async googleAuthorize(");
  expect(desde, "no existe el handler googleAuthorize").toBeGreaterThan(-1);
  const hasta = src.indexOf("accounts.google.com/o/oauth2/v2/auth", desde);
  expect(hasta, "no se encontró el final de googleAuthorize").toBeGreaterThan(desde);
  return src.slice(desde, hasta);
}

describe("authorize de Google: los permisos salen de scopesForAuthorize", () => {
  it("el handler pide los permisos con scopesForAuthorize", () => {
    expect(cuerpoDeGoogleAuthorize(leer(CONTROLADOR))).toContain("scopesForAuthorize(");
  });

  it("el handler NO usa scopesForFeature para armar el `scope` que se le manda a Google", () => {
    // `scopesForFeature` sigue siendo válida para preguntar "qué pide Calendar"; lo que no
    // puede es decidir lo que se PIDE en authorize, porque ahí falta el caso "no declaró".
    expect(cuerpoDeGoogleAuthorize(leer(CONTROLADOR))).not.toContain("scopesForFeature(");
  });

  it("no hay ningún default a 'calendar' que borre el caso 'no declaró función'", () => {
    const cuerpo = cuerpoDeGoogleAuthorize(leer(CONTROLADOR));
    expect(cuerpo).not.toMatch(/\.default\(\s*["']calendar["']\s*\)/);
    expect(cuerpo).not.toMatch(/feature\s*\?\?\s*["']calendar["']/);
  });

  it("distingue 'declarada' de 'no declarada' antes de pedir permisos", () => {
    expect(cuerpoDeGoogleAuthorize(leer(CONTROLADOR))).toMatch(/declarada/);
  });
});

describe("el panel de TuBot sigue llamando sin declarar función (por eso importa el default)", () => {
  /**
   * Si algún día el drawer de TuBot pasara `?feature=`, este test se cae y avisa que el caso
   * "no declaró" ya no tiene dueño — momento de revisar si sigue haciendo falta. Mientras
   * falle, el arreglo de arriba es obligatorio.
   */
  it("apps/web pide authorize sin parámetro de función", () => {
    const src = leer(PANEL_TUBOT);
    expect(src).toContain('api<{ url: string }>("/integrations/oauth/google/authorize")');
    expect(src).not.toContain("oauth/google/authorize?feature=");
  });

  it("y su tarjeta única cubre Calendar y Sheets, que es la razón de pedir los 3", () => {
    const src = leer(PANEL_TUBOT);
    expect(src).toContain("/integrations/google/config");
    expect(src).toContain("/integrations/google/calendars");
  });
});
