import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * M0 — el aviso de cookies NO puede tapar los botones del embudo.
 *
 * Este test existe por un bug que metí yo: el aviso es `position: fixed` abajo, y en pantallas
 * de celular **se comía el botón "Crear cuenta"** de `/registro` — el último clic de todo el
 * embudo, en el dispositivo del que viene casi todo el tráfico de los anuncios. En desktop no
 * se veía, porque el formulario no llega tan abajo. Lo cazó la suite `dueno` con
 * "intercepts pointer events", después de que mis tests unitarios dieran todos verdes: la
 * lógica del consentimiento estaba perfecta y la geometría estaba mal.
 *
 * Se afirma la GEOMETRÍA (que los rectángulos no se cruzan) y no solo que el clic funcione:
 * Playwright desplaza el elemento a la vista antes de hacer clic, así que un `click()` puede
 * pasar en el test y el botón seguir tapado para una persona que no desplaza.
 *
 * No necesita API: corre contra un `next start` pelado, en el job `e2e-conversia`.
 */

const AVISO = '[data-testid="aviso-cookies"]';

/** ¿Se cruzan los rectángulos de estos dos elementos? */
async function seSuperponen(a: Locator, b: Locator): Promise<boolean> {
  const [ra, rb] = [await a.boundingBox(), await b.boundingBox()];
  if (!ra || !rb) return false;
  return ra.x < rb.x + rb.width && rb.x < ra.x + ra.width && ra.y < rb.y + rb.height && rb.y < ra.y + ra.height;
}

/** Entra sin haber contestado el aviso (es el estado de quien llega por un anuncio). */
async function entrarSinConsentimiento(page: Page, ruta: string) {
  await page.context().clearCookies();
  await page.goto(ruta);
  await expect(page.locator(AVISO)).toBeVisible();
}

test.describe("aviso de cookies", () => {
  test("no tapa el botón de crear la cuenta", async ({ page }) => {
    await entrarSinConsentimiento(page, "/registro");
    const boton = page.getByRole("button", { name: "Crear cuenta" });
    await expect(boton).toBeVisible();

    // DESPLAZAR AL FINAL antes de medir. Con el formulario vacío el botón no llega tan abajo y
    // el caso no aparece: el fallo real de la suite `dueno` llega a /registro desde /crear con
    // un borrador, que agrega altura. Desplazar es lo que hace cualquiera en un celular, y
    // reproduce la misma geometría sin depender de tener un borrador.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(150);

    // Lo que de verdad importa: los rectángulos no se cruzan.
    expect(await seSuperponen(boton, page.locator(AVISO)), "el aviso de cookies tapa el botón de crear cuenta").toBe(false);

    // Y el clic llega al botón, no al aviso (es el síntoma exacto que vio la suite `dueno`).
    await boton.click({ timeout: 5_000, trial: true });
  });

  test("no tapa el botón de crear el asistente en el generador", async ({ page }) => {
    await entrarSinConsentimiento(page, "/crear");
    const boton = page.getByRole("button", { name: /Crear mi asistente|Construir|Crear/i }).first();
    if (!(await boton.count())) test.skip(true, "el generador no mostró su botón sin API");
    await expect(boton).toBeVisible();
    // Igual que en /registro: se mide con la página desplazada al final, que es lo que hace
    // cualquiera en un celular. Un aviso fijo abajo SIEMPRE cubre la franja inferior de la
    // ventana; lo que no puede pasar —y es lo que pasaba— es que no haya forma de sacar el
    // botón de abajo del aviso ni desplazando.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(150);
    expect(await seSuperponen(boton, page.locator(AVISO)), "el aviso de cookies tapa el botón del generador").toBe(false);
  });

  test("en celular el aviso no se come la pantalla", async ({ page }, info) => {
    // La primera versión medía 184px de alto en un iPhone 13 (28% de la ventana). Un tope
    // explícito, porque "se ve bien" no es verificable y el alto depende del texto.
    test.skip(!info.project.name.startsWith("iphone") && info.project.name !== "pixel", "solo celular");
    await entrarSinConsentimiento(page, "/registro");
    const caja = await page.locator(AVISO).boundingBox();
    const alto = await page.evaluate(() => window.innerHeight);
    expect(caja).not.toBeNull();
    expect(caja!.height, `el aviso ocupa ${Math.round((caja!.height / alto) * 100)}% de la pantalla`).toBeLessThan(alto * 0.22);
  });

  test("reserva el espacio mientras está arriba y lo devuelve al contestar", async ({ page }) => {
    await entrarSinConsentimiento(page, "/registro");
    // Mientras está arriba, la página reserva el alto del aviso (medido, no fijo).
    await expect(page.locator("html")).toHaveAttribute("data-aviso-cookies", "1");
    const reservado = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--cv-aviso-h").trim());
    expect(parseInt(reservado, 10)).toBeGreaterThan(24);

    await page.getByRole("button", { name: "Solo necesarias" }).click();
    await expect(page.locator(AVISO)).toHaveCount(0);
    // Al contestar se devuelve el espacio: si quedara reservado, todas las pantallas
    // arrastrarían un hueco abajo para siempre.
    await expect(page.locator("html")).not.toHaveAttribute("data-aviso-cookies", "1");
  });

  test("'Solo necesarias' no deja cookies de medición y no vuelve a preguntar", async ({ page }) => {
    await entrarSinConsentimiento(page, "/");
    await page.getByRole("button", { name: "Solo necesarias" }).click();
    await expect(page.locator(AVISO)).toHaveCount(0);

    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === "cv_consent")?.value).toBe("solo-necesarias");
    expect(cookies.map((c) => c.name)).not.toContain("_fbp");
    expect(cookies.map((c) => c.name)).not.toContain("_fbc");

    // Navegar a otra ruta de marketing no vuelve a preguntar.
    await page.goto("/registro");
    await expect(page.locator(AVISO)).toHaveCount(0);
  });

  test("no aparece en el panel ni en el mini-sitio de un cliente", async ({ page }) => {
    await page.context().clearCookies();
    // `/inicio` sin sesión redirige al login, y el login tampoco es ruta de marketing.
    await page.goto("/login");
    await expect(page.locator(AVISO)).toHaveCount(0);
    await page.goto("/legal/privacidad");
    await expect(page.locator(AVISO)).toHaveCount(0);
  });
});
