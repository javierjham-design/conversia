import { test, expect } from "@playwright/test";

/* M5 — flujos completos con API. Requieren el stack Docker (M6) → se corren con RUN_FLOWS=1;
 * en el CI ligero (sin BD) se SALTAN. Registra una cuenta nueva (marca conversia por el
 * origen) para no depender de la marca del seed. Nada contra producción. */

test.skip(!process.env.RUN_FLOWS, "Requiere el stack con API (RUN_FLOWS=1).");

test("alta → panel 30/30 → bandeja → cobros → ajustes notificaciones → prompt de instalación", async ({ page, context }) => {
  // Permiso de notificaciones concedido (para ejercitar el switch maestro).
  await context.grantPermissions(["notifications"]);

  // 1) Landing → crear → registro (crea tenant marca conversia).
  const email = `qa+${Date.now()}@conversia.local`;
  await page.goto("/registro", { waitUntil: "domcontentloaded" });
  const inputs = page.locator("form input");
  await inputs.nth(0).fill("QA Bot"); // nombre
  await inputs.nth(1).fill("Negocio QA"); // nombre del negocio
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill("ClaveSegura123");
  await page.getByRole("button", { name: /crear|registr|empez/i }).first().click();

  // 2) Panel "Hoy" con créditos de regalo (30 conversaciones).
  await page.waitForURL(/\/inicio|\/$/, { timeout: 20000 });
  await expect(page).toHaveURL(/\/inicio|\/$/);

  // 3) Bandeja.
  await page.goto("/conversaciones", { waitUntil: "domcontentloaded" });
  await expect(page.getByText(/Conversaciones/i).first()).toBeVisible();

  // 4) Cobros.
  await page.goto("/cobros", { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1")).toBeVisible();

  // 5) Ajustes → Notificaciones (sección + preferencias por tipo).
  await page.goto("/ajustes", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Avisos en este dispositivo")).toBeVisible({ timeout: 15000 });
  await expect(page.locator('input[type="checkbox"]').first()).toBeVisible();

  // 6) Prompt de instalación: simulamos beforeinstallprompt y verificamos el banner.
  await page.evaluate(() => {
    const e: any = new Event("beforeinstallprompt");
    e.prompt = () => Promise.resolve();
    e.userChoice = Promise.resolve({ outcome: "dismissed" });
    window.dispatchEvent(e);
  });
  await expect(page.getByText(/Instala Conversia|Instalar/i).first()).toBeVisible({ timeout: 8000 });
});
