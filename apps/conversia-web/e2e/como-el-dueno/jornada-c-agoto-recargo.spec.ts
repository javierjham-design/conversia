import { test, expect } from "@playwright/test";
import {
  dejarOperando,
  firstPackCode,
  orgSlug,
  registerAccount,
  rechargePack,
  sendInbound,
  useSession,
  walletBalance,
} from "./_fixtures";

/**
 * JORNADA C — "Agoto y recargo".
 *
 * El dueño consume conversaciones (clientes que escriben y el bot atiende), ve BAJAR el saldo en
 * /cobros, recarga un pack por checkout (mock en el sim) y ve SUBIR el saldo en la UI.
 *
 * Nota: el agotamiento TOTAL hasta la gracia (30 conversaciones) lo cubre la carga sim250; aquí
 * se verifica la MECÁNICA del dinero en la UI (baja y sube) con pocas conversaciones. Que el
 * asistente responda "¿cuánto me queda?" con el número real exige IA real (RUN_DUENO_AI).
 *
 * Requiere el stack Docker (RUN_DUENO=1).
 */
test.skip(!process.env.RUN_DUENO, "Suite 'como el dueño': requiere el stack Docker (RUN_DUENO=1).");

/** Lee el número grande "Créditos disponibles" que ve el dueño en /cobros. */
async function saldoEnPantalla(page: import("@playwright/test").Page): Promise<number> {
  const card = page.locator("div.card").filter({ hasText: "Créditos disponibles" }).first();
  const txt = await card.innerText();
  const m = txt.replace(/\./g, "").match(/Créditos disponibles\s+(\d+)/i);
  return m ? Number(m[1]) : NaN;
}

test.describe("Jornada C — agoto y recargo", () => {
  test("consumo → el saldo baja en /cobros → recargo → el saldo sube en la UI", async ({ page, request }, testInfo) => {
    test.skip(!["desktop", "iphone"].includes(testInfo.project.name), "El viaje de saldo corre en desktop + iphone.");
    test.setTimeout(120_000);
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "kinesiologia" });
    await useSession(page, cuenta.token);
    await dejarOperando(request, cuenta.token);
    const slug = await orgSlug(request, cuenta.token);

    // Nazco con 30.
    expect(await walletBalance(request, cuenta.token)).toBe(30);
    await page.goto("/cobros", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Créditos disponibles")).toBeVisible({ timeout: 15_000 });
    expect(await saldoEnPantalla(page)).toBe(30);

    // 3 clientes distintos escriben → el bot atiende → 3 conversaciones consumidas (30 → 27).
    for (const waId of ["56911100001", "56911100002", "56911100003"]) {
      await sendInbound(request, slug, "Hola, ¿tienen hora disponible?", waId);
    }
    await expect.poll(async () => walletBalance(request, cuenta.token), { timeout: 70_000, message: "el saldo debía bajar a 27" }).toBe(27);

    // El dueño ve el saldo BAJO en /cobros.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => saldoEnPantalla(page), { timeout: 15_000 }).toBe(27);

    // Recargo un pack por checkout (mock) → el saldo SUBE.
    const pack = await firstPackCode(request);
    await rechargePack(request, cuenta.token, pack);
    await expect.poll(async () => walletBalance(request, cuenta.token), { timeout: 30_000, message: "el saldo debía subir tras recargar" }).toBeGreaterThan(27);
    const nuevo = await walletBalance(request, cuenta.token);

    // Y lo veo subir EN LA UI.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(async () => saldoEnPantalla(page), { timeout: 15_000 }).toBe(nuevo);
    expect(nuevo).toBeGreaterThan(27);
  });
});
