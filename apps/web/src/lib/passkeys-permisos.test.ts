import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ENTRAR CON FACE ID / HUELLA EN TUBOT: los guardianes que atrapan las formas de romperlo EN
 * SILENCIO. Espejo de `apps/conversia-web/src/lib/passkeys-permisos.test.ts`, adaptado a TuBot
 * (otra pantalla donde vive la tarjeta y una trampa propia del proxy same-origin, ver §4).
 *
 * 1. **La política de permisos del sitio.** Es el mismo fallo que ya se envió una vez con el
 *    micrófono: `Permissions-Policy` vive en `next.config.mjs` y una entrada
 *    `publickey-credentials-get=()` le niega WebAuthn **al propio origen** — un botón que no
 *    abre ningún diálogo y una pantalla que no puede explicar por qué.
 * 2. **Un componente que nadie renderiza.** La tarjeta puede estar perfecta y no existir para la
 *    persona si no quedó enganchada en "Mi perfil". No lo caza ni el typecheck ni el build.
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
    // Formas de matarlo: `publickey-credentials-get=()` y `publickey-credentials-create=()`. Si
    // algún día hay que declararlas (por ejemplo para permitirlas en un iframe), tienen que
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

describe("la tarjeta de aparatos está realmente enganchada en «Mi perfil»", () => {
  const page = readFileSync(join(__dirname, "..", "app", "(app)", "settings", "profile", "page.tsx"), "utf8");

  it("«Mi perfil» importa y RENDERIZA PasskeysCard", () => {
    expect(page).toContain("PasskeysCard");
    // Importarlo sin usarlo es justo el error que el typecheck no reporta: hay que ver la
    // etiqueta puesta, no solo el import.
    expect(page).toMatch(/<PasskeysCard\s*\/>/);
  });
});

describe("el componente usa la API de WebAuthn como corresponde", () => {
  const componente = readFileSync(join(__dirname, "..", "app", "(app)", "settings", "profile", "passkeys-card.tsx"), "utf8");

  it("pregunta si el navegador puede ANTES de ofrecer el botón", () => {
    expect(componente).toContain("browserSupportsWebAuthn");
  });

  it("trata la cancelación del diálogo como algo normal, no como una falla", () => {
    // `NotAllowedError` es lo que devuelve el navegador cuando la persona cierra el diálogo del
    // sistema. Mostrarlo crudo diría "NotAllowedError" en la pantalla de un dentista.
    expect(componente).toContain("NotAllowedError");
  });

  it("el spinner gira: usa `animate-spin` (de Tailwind), no una clase sin declarar", () => {
    // conversia-web declara su propia `lp-spin` con un `<style>` local porque la clase no existe
    // en su CSS. TuBot NO necesita ese truco: `animate-spin` lo provee Tailwind (lo usa
    // StatusBadge). Si alguien copiara `lp-spin` de Conversia sin el `<style>`, el ícono quedaría
    // quieto y no lo caza ningún tipo ni ningún test de comportamiento.
    if (componente.includes("lp-spin")) {
      expect(componente).toMatch(/@keyframes lpspin/);
    } else {
      expect(componente).toContain("animate-spin");
    }
  });

  it("defiende la lista contra datos incompletos (no hace `.map` sobre `undefined`)", () => {
    // El smoke e2e-robustness manda cuerpos vacíos; `GET /auth/passkeys` podría venir sin
    // `aparatos`. La lista arranca en `[]` y solo se reemplaza si de verdad viene un arreglo.
    expect(componente).toContain("Array.isArray");
  });
});

/**
 * §4 — LA TRAMPA PROPIA DE TUBOT: el proxy same-origin y el `Origin` ausente en los GET.
 *
 * TuBot llama a la API por un proxy SAME-ORIGIN (`API_URL = "/backend"`, ver `lib/api.ts`), a
 * diferencia de conversia-web que llama cross-origin. En una petición same-origin el navegador
 * manda `Origin` en los POST pero **no en los GET**, así que `GET /auth/passkeys` (la lista de
 * aparatos) llega SIN `Origin` y la API resuelve la marca con `brandFromOrigin(undefined)`, que
 * cae en la MARCA POR DEFECTO. De esa marca sale el `rp_id` (`rpDeLaMarca` → `WEB_URL` → apex),
 * y contra ese `rp_id` se buscan las credenciales.
 *
 * Funciona, pero funciona por el default, no porque el dato esté. El día que alguien cambie la
 * marca por defecto, la lista de aparatos de TuBot buscaría con el `rp_id` equivocado y en
 * pantalla se vería como «se borraron mis aparatos», sin ningún error. Este guardián fija ese
 * default SIN tocar código de producción (opción (a) del encargo): es barato y suficiente,
 * porque el default no cambia por accidente.
 */
describe("§4 la lista de aparatos de TuBot depende de que la marca por defecto sea «tubot»", () => {
  const brands = readFileSync(join(__dirname, "..", "..", "..", "..", "packages", "config", "src", "brands.ts"), "utf8");
  const cuerpo = /export function brandFromOrigin\([^)]*\)\s*:\s*string\s*\{([\s\S]*?)\n\}/.exec(brands)?.[1] ?? "";
  const retornos = [...cuerpo.matchAll(/return "(tubot|conversia)"/g)].map((m) => m[1]);

  it("se pudo leer la función (si no, este test no prueba nada)", () => {
    expect(cuerpo).not.toBe("");
    expect(retornos.length).toBeGreaterThan(1);
  });

  it("la rama «conversia» está CONDICIONADA a que haya `Origin`", () => {
    // El único `return "conversia"` vive dentro del `if (origin && …)`: sin Origin no se llega.
    expect(cuerpo).toMatch(/if\s*\(origin[\s\S]*return "conversia"/);
  });

  it("el retorno por DEFECTO (sin `Origin`, como el GET de TuBot) es «tubot»", () => {
    // La última instrucción de la función, fuera de todo `if`, devuelve "tubot".
    expect(retornos.at(-1)).toBe("tubot");
  });
});

// P2 — ENTRAR con Face ID/huella: el botón va en la pantalla de LOGIN, no solo en la tarjeta de
// gestión de «Mi perfil». Un botón importado pero no renderizado no deja entrar a nadie, y el
// typecheck no lo caza.
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
 * 2. **Un aviso FLOTANTE.** Ya pasó una vez en producción (en el otro panel): un aviso fijo abajo
 *    se apoyaba sobre la navegación de teléfono y se comía el toque. Un `toBeVisible` no lo ve,
 *    porque los dos elementos están visibles.
 * 3. **Un componente que nadie renderiza.** Igual que la tarjeta de Mi perfil: puede estar
 *    perfecto y no existir para la persona.
 */
describe("P4 — el autocompletado del passkey en el login", () => {
  const loginP4 = readFileSync(join(__dirname, "..", "app", "login", "page.tsx"), "utf8");
  const autocompletados = [...loginP4.matchAll(/autoComplete="([^"]+)"/g)].map((m) => m[1]);

  it("se pudieron leer los autoComplete del formulario (si no, esto no prueba nada)", () => {
    expect(autocompletados).toContain("current-password");
  });

  it("el campo de identidad declara el token `webauthn` AL FINAL", () => {
    const conWebauthn = autocompletados.filter((v) => v.endsWith("webauthn"));
    expect(conWebauthn, `autoComplete presentes: ${autocompletados.join(" · ")}`).toHaveLength(1);
    expect(conWebauthn[0]).toBe("username webauthn");
  });

  it("y ya no quedó un `email` suelto (sería el campo viejo, sin passkey)", () => {
    expect(autocompletados).not.toContain("email");
  });

  it("arranca la ceremonia en modo autocompletado y la cancela al salir", () => {
    expect(loginP4).toContain("browserSupportsWebAuthnAutofill");
    expect(loginP4).toMatch(/useBrowserAutofill:\s*true/);
    expect(loginP4).toContain("WebAuthnAbortService.cancelCeremony()");
  });

  it("recuerda el aparato al entrar, que es lo que cambia la pantalla la próxima vez", () => {
    expect(loginP4).toContain("recordarPasskeyEnEsteAparato");
    expect(loginP4).toContain("hayPasskeyEnEsteAparato");
  });
});

describe("P4 — la sugerencia de activar Face ID no tapa la navegación", () => {
  const aviso = readFileSync(join(__dirname, "..", "components", "SugerirPasskey.tsx"), "utf8");
  const layout = readFileSync(join(__dirname, "..", "app", "(app)", "layout.tsx"), "utf8");

  /**
   * Se miran los ESTILOS, no los comentarios: el propio componente explica por qué no va fijo,
   * y buscar el texto a secas encontraría esa explicación y daría rojo.
   */
  const sinComentarios = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("el aviso NO flota: ni `fixed` de Tailwind ni anclado al borde de abajo", () => {
    const codigo = sinComentarios(aviso);
    expect(codigo).not.toMatch(/className=\{?["'`][^"'`]*\bfixed\b/);
    expect(codigo).not.toMatch(/className=\{?["'`][^"'`]*\bbottom-/);
    expect(codigo).not.toMatch(/position:\s*["']?fixed/);
  });

  it("el detector sirve: en el layout del panel SÍ encuentra clases fijas", () => {
    // Control positivo. Sin esto, las aserciones de arriba pasarían con una regex equivocada.
    expect(sinComentarios(layout)).toMatch(/className=\{?["'`][^"'`]*\bfixed\b/);
  });

  it("y el limpiador de comentarios no se come el código", () => {
    expect(sinComentarios(aviso)).toContain("platformAuthenticatorIsAvailable");
    expect(sinComentarios("/* fixed */ const a = 1;")).not.toContain("fixed");
  });

  it("el layout del panel lo importa y lo RENDERIZA", () => {
    expect(layout).toContain('from "@/components/SugerirPasskey"');
    expect(layout).toMatch(/<SugerirPasskey\s*\/>/);
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
