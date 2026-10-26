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
    await page.goto("/inicio", { waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(/\/inicio/);

    // En móvil el botón vive en la hoja "Más"; en escritorio, al final del riel.
    const vp = page.viewportSize();
    if (vp && vp.width < 768) {
      await page.getByRole("button", { name: "Más" }).click();
    }
    await page.getByRole("button", { name: "Cerrar sesión" }).click();

    await page.waitForURL(/\/login/, { timeout: 15_000 });
    const token = await page.evaluate(() => { try { return localStorage.getItem("conversia_token"); } catch { return null; } });
    expect(token).toBeNull(); // sesión borrada
  });
});
