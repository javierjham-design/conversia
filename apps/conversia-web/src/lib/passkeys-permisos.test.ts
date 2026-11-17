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

  it("CADA atajo del índice apunta a un ancla que existe en la página", () => {
    // Version barata de lo que `jornada-i` comprueba en el navegador: un atajo a un ancla
    // inexistente no lleva a ninguna parte y la pantalla se ve perfecta. Vale tenerlo acá
    // porque el e2e necesita Docker y el sim, y esto corre en cada `pnpm test`.
    const delIndice = [...ajustes.matchAll(/\{ id: "([a-z-]+)", label:/g)].map((m) => m[1]);
    const anclas = new Set([...ajustes.matchAll(/id="([a-z-]+)"/g)].map((m) => m[1]));
    expect(delIndice.length, "no se pudo leer el índice (si no, este test no prueba nada)").toBeGreaterThan(1);
    for (const id of delIndice) {
      expect(anclas.has(id), `el índice ofrece "#${id}" y en la página no hay ningún id="${id}"`).toBe(true);
    }
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

// P2 — ENTRAR con Face ID/huella: el botón va en la pantalla de LOGIN, no solo en los Ajustes.
// Un botón importado pero no renderizado no deja entrar a nadie, y el typecheck no lo caza.
describe("la pantalla de login ofrece entrar con passkey (P2)", () => {
  const login = readFileSync(join(__dirname, "..", "app", "login", "page.tsx"), "utf8");

  it("usa startAuthentication y pega al endpoint de login por passkey", () => {
    expect(login).toContain("startAuthentication");
    expect(login).toContain("/auth/passkey-login");
  });

  it("pregunta si el navegador puede ANTES de ofrecer el botón", () => {
    expect(login).toContain("browserSupportsWebAuthn");
  });

  it("el botón está RENDERIZADO y dispara el login por passkey", () => {
    expect(login).toMatch(/onClick=\{\(\)\s*=>\s*void entrarConPasskey\(\)\}/);
    expect(login).toContain("Entrar con Face ID o huella");
  });
});

/**
 * P4 — «que no parezca un login». Las tres cosas que lo rompen sin avisar:
 *
 * 1. **El token `webauthn` del `autocomplete`.** Es lo que hace que el passkey se ofrezca DENTRO
 *    del campo de correo. Sin él, `startAuthentication({ useBrowserAutofill: true })` tira error
 *    (`verifyBrowserAutofillInput`) y nosotros nos lo tragamos a propósito, porque una ceremonia
 *    abortada es normal. Resultado de borrar el token: el autocompletado desaparece, la pantalla
 *    se ve perfecta y no hay ningún error en ninguna parte.
 * 2. **Un aviso FLOTANTE.** Ya pasó una vez en producción: un aviso `position: fixed` abajo se
 *    apoyaba sobre la barra de pestañas, que en teléfono es el menú entero, y se comía el toque.
 *    Un `toBeVisible` no lo ve, porque los dos elementos están visibles.
 * 3. **Un componente que nadie renderiza.** Igual que la tarjeta de Ajustes: puede estar perfecto
 *    y no existir para la persona.
 */
describe("P4 — el autocompletado del passkey en el login", () => {
  const login = readFileSync(join(__dirname, "..", "app", "login", "page.tsx"), "utf8");
  const autocompletados = [...login.matchAll(/autoComplete="([^"]+)"/g)].map((m) => m[1]);

  it("se pudieron leer los autoComplete del formulario (si no, esto no prueba nada)", () => {
    expect(autocompletados).toContain("current-password");
  });

  it("el campo de identidad declara el token `webauthn` AL FINAL", () => {
    const conWebauthn = autocompletados.filter((v) => v.endsWith("webauthn"));
    expect(conWebauthn, `autoComplete presentes: ${autocompletados.join(" · ")}`).toHaveLength(1);
    // El orden importa: el token tiene que ser el último de la lista.
    expect(conWebauthn[0]).toBe("username webauthn");
  });

  it("y ya no quedó un `email` suelto (sería el campo viejo, sin passkey)", () => {
    expect(autocompletados).not.toContain("email");
  });

  it("arranca la ceremonia en modo autocompletado y la cancela al salir", () => {
    expect(login).toContain("browserSupportsWebAuthnAutofill");
    expect(login).toMatch(/useBrowserAutofill:\s*true/);
    // Sin cancelar, la ceremonia queda viva tras dejar la pantalla y la siguiente falla.
    expect(login).toContain("WebAuthnAbortService.cancelCeremony()");
  });

  it("recuerda el aparato al entrar, que es lo que cambia la pantalla la próxima vez", () => {
    expect(login).toContain("recordarPasskeyEnEsteAparato");
    expect(login).toContain("hayPasskeyEnEsteAparato");
  });
});

describe("P4 — la sugerencia de activar Face ID no tapa la navegación", () => {
  const aviso = readFileSync(join(__dirname, "..", "components", "SugerirPasskey.tsx"), "utf8");
  const shell = readFileSync(join(__dirname, "..", "components", "AppShell.tsx"), "utf8");

  /**
   * Se miran los ESTILOS, no los comentarios: el propio componente explica por qué no va
   * `position: fixed`, y buscar el texto a secas encontraría esa explicación y daría rojo.
   */
  const sinComentarios = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("el aviso NO flota: nada de position fixed ni anclado al borde de abajo", () => {
    const codigo = sinComentarios(aviso);
    expect(codigo).not.toMatch(/position:\s*["']?fixed/);
    expect(codigo).not.toMatch(/\bbottom:/);
    // `fixed` de Tailwind tampoco (este panel usa estilos en línea, pero por si cambia).
    expect(codigo).not.toMatch(/className="[^"]*\bfixed\b/);
  });

  it("el detector sirve: en el AppShell SÍ encuentra elementos fijos", () => {
    // Control positivo. Sin esto, las aserciones de arriba pasarían con una regex equivocada.
    expect(sinComentarios(shell)).toMatch(/position:\s*["']?fixed/);
  });

  it("y el limpiador de comentarios no se come el código", () => {
    // Si `sinComentarios` borrara de más, la prueba de arriba se volvería un adorno.
    expect(sinComentarios(aviso)).toContain("platformAuthenticatorIsAvailable");
    expect(sinComentarios("/* position: fixed */ const a = 1;")).not.toContain("fixed");
  });

  it("el AppShell lo importa y lo RENDERIZA", () => {
    expect(shell).toContain('from "@/components/SugerirPasskey"');
    expect(shell).toMatch(/<SugerirPasskey\s*\/>/);
  });

  it("acepta el «no» y no pregunta de nuevo en cada visita", () => {
    expect(aviso).toContain("noOfrecerPasskeyEnEsteAparato");
    // sessionStorage haría que el aviso volviera al abrir el navegador de nuevo.
    expect(aviso).not.toContain("sessionStorage");
  });

  it("solo se ofrece donde hay lector de cara/huella", () => {
    expect(aviso).toContain("platformAuthenticatorIsAvailable");
    expect(aviso).toContain("browserSupportsWebAuthn");
  });
});
