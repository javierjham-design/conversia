import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { registerAccount, useSession } from "./_fixtures";

/**
 * JORNADA F — Sesión, token vencido y cerrar sesión (hallazgo de producción 26-oct).
 *
 * Contra el stack Docker (RUN_DUENO=1). Cubre el encargo docs/PROMPT_SESION_LOGOUT.md:
 *  - Bloque 1: con el access token VENCIDO/ inválido y SIN refresh, el panel no te deja en una
 *    sesión muerta: lib/api detecta el 401 → limpia → /login?expirada=1&volver=<ruta>; el login
 *    muestra el aviso y, tras entrar, vuelve a la ruta original.
 *  - Bloque 2: hay botón "Cerrar sesión" en el panel (riel/escritorio y hoja "Más"/móvil) que
 *    borra la sesión y lleva a /login.
 */
test.skip(!process.env.RUN_DUENO, "Suite 'como el dueño': requiere el stack Docker (RUN_DUENO=1).");

/** access token con exp en el FUTURO pero firma INVÁLIDA → el cliente lo cree vivo (no corta en el
 *  guard) pero la API lo rechaza con 401 → ejerce el camino de lib/api (refrescar/redirigir). */
function craftedExpiredAccess(): string {
  const payload = { sub: "x", orgId: "y", role: "viewer", exp: Math.floor(Date.now() / 1000) + 3600 };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.firma-invalida`;
}

/** Inyecta un token de access dado (y NINGÚN refresh) en localStorage antes del paint. */
async function inyectarSesionRota(page: Page, token: string): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("conversia_token", t);
      localStorage.removeItem("conversia_refresh");
    } catch {
      /* private mode */
    }
  }, token);
}

test.describe("Jornada F — sesión vencida y cerrar sesión", () => {
  test("token vencido sin refresh → aviso de sesión expirada → login → vuelve a la ruta original", async ({ page, request }) => {
    // Cuenta REAL (para el login final). No usamos su token todavía: inyectamos uno roto.
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "barberia" });
    await inyectarSesionRota(page, craftedExpiredAccess());

    // Entra directo a una pantalla privada → la API responde 401 → debe acabar en /login?expirada.
    await page.goto("/clientes", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/login\?expirada=1/, { timeout: 15_000 });
    expect(decodeURIComponent(page.url())).toContain("volver=/clientes");
    await expect(page.getByText(/Tu sesión expiró por seguridad/i)).toBeVisible();

    // Entra con las credenciales reales → vuelve a /clientes (la ruta donde estaba).
    await page.getByLabel("Correo").fill(cuenta.email);
    await page.getByLabel("Contraseña").fill(cuenta.password);
    await page.getByRole("button", { name: /^Entrar$/ }).click();
    await page.waitForURL(/\/clientes/, { timeout: 20_000 });
    await expect(page).toHaveURL(/\/clientes/);
  });

  test('cerrar sesión desde el panel ("Cerrar sesión") borra la sesión y lleva a /login', async ({ page, request }) => {
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "peluqueria" });
    await useSession(page, cuenta.token); // sesión REAL y válida
    // Silencia el banner de instalación PWA (fijo abajo): en iPhone tapa la pestaña "Más".
    await page.addInitScript(() => { try { localStorage.setItem("conversia_pwa_install_dismissed", "1"); } catch { /* noop */ } });
    await page.goto("/inicio", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/inicio/);

    // En móvil el botón vive en la hoja "Más"; en escritorio, al final del riel.
    //
    // `dispatchEvent` y no `.click()`, por lo mismo que la jornada I (ver el comentario
    // largo allí): con `isMobile`, el punto que Playwright calcula para tocar una barra
    // `position: fixed` pegada abajo no coincide con el que mide el navegador, y el clic se
    // queda 45 s reintentando señalando a la burbuja de Convi. Reventó el job `dueno` del 2
    // al 6 de noviembre —cinco días, rotando de proyecto— y NUNCA se reprodujo en local con
    // el mismo `devices["iPhone 13"]`, ni en serie, ni repitiendo, ni con la API frenada a
    // propósito.
    //
    // Que el menú se pueda tocar DE VERDAD no se deja de comprobar: lo garantiza la jornada
    // I, que pregunta por `elementFromPoint` en los cinco ítems durante 1,2 s con la burbuja
    // de Convi en pantalla — esa es la que cazó los estorbos reales. Acá lo que importa es
    // otra cosa: que exista "Cerrar sesión" y que borre la sesión.
    const vp = page.viewportSize();
    if (vp && vp.width < 768) {
      await page.locator("nav.shell-tabs").getByRole("button", { name: "Más" }).dispatchEvent("click");
    }
    await page.getByRole("button", { name: "Cerrar sesión" }).click();

    await page.waitForURL(/\/login/, { timeout: 15_000 });
    const token = await page.evaluate(() => { try { return localStorage.getItem("conversia_token"); } catch { return null; } });
    expect(token).toBeNull(); // sesión borrada
  });

  test("con sesión iniciada, conversia.cl muestra la PÁGINA PÚBLICA y no salta al panel", async ({ page, request }) => {
    // Hallazgo del dueño: entrar al apex con sesión te metía directo a /inicio, así que la web
    // pública —precios, cómo funciona, preguntas— era inalcanzable para quien tenía cuenta.
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "barberia" });
    await useSession(page, cuenta.token); // sesión REAL y válida
    await page.addInitScript(() => { try { localStorage.setItem("conversia_pwa_install_dismissed", "1"); } catch { /* noop */ } });

    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Se queda en la landing: contenido público visible y la URL sin moverse.
    await expect(page.getByRole("heading", { level: 1 })).toContainText(/las 24 horas/i);
    await expect(page).toHaveURL(/\/$/);
    // Y sigue sin redirigir un rato después (el salto vivía en un useEffect, no en el primer paint).
    await page.waitForTimeout(1500);
    await expect(page).toHaveURL(/\/$/);

    // Desde ahí se entra al panel con un clic. En móvil el menú está detrás de la hamburguesa.
    const vp = page.viewportSize();
    if (vp && vp.width <= 680) await page.getByRole("button", { name: "Menú" }).click();
    await page.getByRole("link", { name: /Ir a mi panel/i }).first().click();
    await page.waitForURL(/\/inicio/, { timeout: 20_000 });
  });

  test("pasado el plazo de 24 h: la landing ofrece Entrar y el panel echa al login", async ({ page, request }) => {
    // Hallazgo del dueño (3-nov): volvía a conversia.cl días después, apretaba "Ir a mi panel"
    // y entraba. El techo de la sesión ahora son 24 h; acá se simula una sesión FUERA DE PLAZO
    // (token válido + plazo vencido, que es lo que vería alguien al día siguiente) en un
    // navegador real. Esperar 24 h no es un test: el plazo lo guarda el cliente y se siembra.
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "barberia" });
    await useSession(page, cuenta.token);
    await page.addInitScript(() => {
      try {
        localStorage.setItem("conversia_session_until", String(Date.now() - 60_000));
        localStorage.setItem("conversia_pwa_install_dismissed", "1");
      } catch {
        /* private mode */
      }
    });

    // 1) La landing no ofrece el panel: el botón vuelve a ser "Entrar".
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // Primero se espera a que el efecto HAYA CORRIDO, y se prueba por su efecto secundario:
    // limpiar la sesión muerta. Sin esta espera, "Ir a mi panel" no existe todavía por falta
    // de hidratación y la aserción de abajo pasaría en verde sin probar nada.
    await expect
      .poll(async () => page.evaluate(() => { try { return localStorage.getItem("conversia_token"); } catch { return "?"; } }), { timeout: 10_000 })
      .toBeNull();
    const vp = page.viewportSize();
    if (vp && vp.width <= 680) await page.getByRole("button", { name: "Menú" }).click();
    await expect(page.getByRole("link", { name: /Entrar/i }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Ir a mi panel/i })).toHaveCount(0);

    // 2) Y entrar a mano a una pantalla privada termina en el login con el aviso.
    await page.goto("/inicio", { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/login\?expirada=1/, { timeout: 15_000 });
    await expect(page.getByText(/Tu sesión expiró por seguridad/i)).toBeVisible();
  });
});
