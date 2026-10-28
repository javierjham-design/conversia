import { test, expect, type Page } from "@playwright/test";

/*
 * Login del SUPER ADMIN: el paso del código de 2FA.
 *
 * Qué encierra (28-oct-2026): el paso del 2FA seguía mostrando los campos de correo y
 * contraseña, solo `disabled`. Chrome los autocompletaba con cualquier credencial guardada
 * de este dominio, así que al entrar con Google la pantalla mostraba un correo ajeno —de un
 * tenant de prueba— mientras por detrás se verificaba la credencial de Google. Y no había
 * salida: el botón de Google desaparecía y solo se volvía recargando. El dueño leyó un
 * correo que no era el suyo, creyó que el login estaba roto, y quedó afuera de su consola.
 *
 * No necesita backend: las respuestas de la API se interceptan acá.
 */

const CUENTA = "javier.jham@gmail.com";

/** Deja la pantalla en el paso del código, como si el backend hubiera pedido el 2FA. */
async function llegarAlPasoDelCodigo(page: Page) {
  // Sin clientId el botón de Google no se monta: este caso prueba la rama de contraseña.
  await page.route("**/auth/google-config", (r) => r.fulfill({ json: { clientId: "" } }));
  await page.route("**/platform/auth/login", (r) =>
    r.fulfill({ status: 401, json: { message: "Ingresa el código de verificación", mfaRequired: true } }),
  );
  // Esperar a que el componente de cliente HAYA MONTADO antes de tocar el formulario: su
  // efecto pide /auth/google-config, así que esa petición es la señal de que ya hidrató.
  // Sin esto el clic en "Entrar" llega antes que el handler de React y no pasa nada.
  const hidratado = page.waitForRequest("**/auth/google-config");
  await page.goto("/admin/login", { waitUntil: "domcontentloaded" });
  await hidratado;
  await page.getByLabel("Correo").fill(CUENTA);
  await page.getByLabel("Contraseña").fill("una-contrasena-cualquiera");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByLabel(/Código de verificación/)).toBeVisible();
}

test("el paso del 2FA no muestra campos de contraseña que el navegador pueda autocompletar", async ({ page }) => {
  await llegarAlPasoDelCodigo(page);
  // El corazón del arreglo: si no hay campos, el autocompletado no puede mostrar una cuenta ajena.
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.locator('input[type="email"]')).toHaveCount(0);
});

test("el paso del 2FA dice con qué cuenta vas a entrar", async ({ page }) => {
  await llegarAlPasoDelCodigo(page);
  await expect(page.getByText(`Entrando como ${CUENTA}`)).toBeVisible();
});

test('"Usar otra cuenta" devuelve al primer paso sin recargar', async ({ page }) => {
  await llegarAlPasoDelCodigo(page);
  await page.getByRole("button", { name: "Usar otra cuenta" }).click();
  await expect(page.getByLabel("Contraseña")).toBeVisible();
  await expect(page.getByLabel(/Código de verificación/)).toHaveCount(0);
});

test("un código rechazado deja reintentar y deja salir, no encierra", async ({ page }) => {
  await llegarAlPasoDelCodigo(page);
  await page.getByLabel(/Código de verificación/).fill("000000");
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page.getByText("Código inválido. Intenta de nuevo.")).toBeVisible();
  // Tras el error seguís pudiendo volver: este era el estado del que no se salía.
  await expect(page.getByRole("button", { name: "Usar otra cuenta" })).toBeVisible();
  await page.getByRole("button", { name: "Usar otra cuenta" }).click();
  await expect(page.getByLabel("Correo")).toBeVisible();
});

test("el código se verifica contra la cuenta que se escribió, no contra lo autocompletado", async ({ page }) => {
  await llegarAlPasoDelCodigo(page);
  let enviado: { email?: string; code?: string } | null = null;
  await page.route("**/platform/auth/login", async (r) => {
    enviado = JSON.parse(r.request().postData() ?? "{}");
    await r.fulfill({ status: 401, json: { message: "Código inválido", mfaRequired: true } });
  });
  await page.getByLabel(/Código de verificación/).fill("123456");
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page.getByText("Código inválido. Intenta de nuevo.")).toBeVisible();
  expect(enviado).toMatchObject({ email: CUENTA, code: "123456" });
});
