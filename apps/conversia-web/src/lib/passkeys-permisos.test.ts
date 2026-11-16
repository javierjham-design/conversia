import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ENTRAR CON FACE ID / HUELLA: las dos cosas que lo matan en silencio.
 *
 * 1. **La política de permisos del sitio.** Es el mismo fallo que ya se envió una vez con el
 *    micrófono (ver `adjuntos.test.ts`): `Permissions-Policy` vive en `next.config.mjs`, a
 *    varios archivos del botón, y una entrada `publickey-credentials-get=()` le niega WebAuthn
 *    **al propio origen**. El resultado sería un botón que no abre ningún diálogo y una
 *    pantalla que no puede explicar por qué, porque no hay ningún permiso que revisar.
 *
 * 2. **Un componente que nadie renderiza.** La pantalla puede estar perfecta y no existir para
 *    la persona si no quedó enganchada en Ajustes. No lo caza ni el typecheck ni el build.
 *
 * Lo que NO hace falta: tocar la CSP. WebAuthn es una API del navegador, no un recurso que se
 * descargue de ningún host, así que no suma orígenes a `connect-src` ni a `script-src`.
 */

const config = readFileSync(join(__dirname, "..", "..", "next.config.mjs"), "utf8");
const politica = /"Permissions-Policy", value: "([^"]+)"/.exec(config)?.[1] ?? "";

describe("la política de permisos no le niega WebAuthn al propio sitio", () => {
  it("se puede leer la política (si no, este test no prueba nada)", () => {
    expect(politica).toContain("camera=");
  });

  it("no hay ninguna entrada que apague publickey-credentials", () => {
    // Formas de matarlo: `publickey-credentials-get=()` y `publickey-credentials-create=()`.
    // Si algún día hay que declararlas (por ejemplo para permitirlas en un iframe), tienen que
    // incluir `self` — nunca la lista vacía.
    for (const rasgo of ["publickey-credentials-get", "publickey-credentials-create"]) {
      const declarada = new RegExp(`${rasgo}=\\(([^)]*)\\)`).exec(politica);
      if (!declarada) continue; // sin declarar = default del navegador = `self`, que sirve
      expect(declarada[1], `${rasgo}=() le niega WebAuthn al propio origen`).toContain("self");
    }
  });

  it("el detector sirve: sabe ver una lista vacía cuando la hay", () => {
    // Sin esto, el test de arriba pasaría igual con una expresión regular equivocada que no
    // encuentra nunca nada. `camera=()` SÍ está en la política, y así se comprueba.
    const camara = /camera=\(([^)]*)\)/.exec(politica);
    expect(camara).not.toBeNull();
    expect(camara![1]).toBe("");
  });
});

describe("la pantalla de aparatos está realmente enganchada", () => {
  const ajustes = readFileSync(join(__dirname, "..", "app", "ajustes", "page.tsx"), "utf8");

  it("Ajustes importa y RENDERIZA PasskeysSettings", () => {
    expect(ajustes).toContain("PasskeysSettings");
    // Importarlo sin usarlo es justo el error que el typecheck no reporta: hay que ver la
    // etiqueta puesta, no solo el import.
    expect(ajustes).toMatch(/<PasskeysSettings\s*\/>/);
  });

  it("y aparece en el índice de la pantalla, para que se pueda llegar", () => {
    expect(ajustes).toMatch(/id: "acceso"/);
    expect(ajustes).toMatch(/id="acceso"/);
  });
});

describe("el componente usa la API de WebAuthn como corresponde", () => {
  const componente = readFileSync(join(__dirname, "..", "components", "PasskeysSettings.tsx"), "utf8");

  it("pregunta si el navegador puede ANTES de ofrecer el botón", () => {
    expect(componente).toContain("browserSupportsWebAuthn");
  });

  it("declara la animación del spinner que usa (la clase no existe en globals.css)", () => {
    // `className="lp-spin"` sin el `<style>` local deja el ícono quieto, y eso no lo caza
    // ningún tipo ni ningún test de comportamiento: se ve, o no se ve.
    if (!componente.includes("lp-spin")) return;
    expect(componente).toMatch(/@keyframes lpspin/);
  });

  it("trata la cancelación del diálogo como algo normal, no como una falla", () => {
    // `NotAllowedError` es lo que devuelve el navegador cuando la persona cierra el diálogo
    // del sistema. Mostrarlo crudo diría "NotAllowedError" en la pantalla de un dentista.
    expect(componente).toContain("NotAllowedError");
  });
});
