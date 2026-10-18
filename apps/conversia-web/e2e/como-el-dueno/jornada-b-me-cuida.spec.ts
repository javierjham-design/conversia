import { test, expect } from "@playwright/test";
import { armarCanalesConPopupBloqueado, collectConsoleErrors, registerAccount, useSession } from "./_fixtures";

/**
 * JORNADA B — "Me equivoco y el sistema me cuida".
 *
 * El dueño (cuenta Conversia, elegible) se topa con errores y el producto lo cuida: mensajes
 * accionables, botón de reintento, ayuda del asistente, y recuperación sin pantallas blancas ni
 * "(Not Found)" crudos.
 *
 * Nota IA (mock en el sim): que la respuesta del asistente mencione ESPECÍFICAMENTE las ventanas
 * emergentes exige IA real → ese assert se activa con RUN_DUENO_AI=1. Sin eso, se verifica que la
 * burbuja abre con el error cargado, responde algo y NUNCA muestra "(Not Found)".
 *
 * Requiere el stack Docker (RUN_DUENO=1).
 */
test.skip(!process.env.RUN_DUENO, "Suite 'como el dueño': requiere el stack Docker (RUN_DUENO=1).");

test.describe("Jornada B — me equivoco y el sistema me cuida", () => {
  test("popup de Meta bloqueado → banner accionable + Reintentar + el asistente ayuda (sin '(Not Found)')", async ({ page, request }) => {
    const errores = collectConsoleErrors(page);
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "barberia" });
    await useSession(page, cuenta.token);
    await armarCanalesConPopupBloqueado(page);

    await page.goto("/canales", { waitUntil: "domcontentloaded" });
    const conectar = page.getByRole("button", { name: /Conectar mi número/i });
    await expect(conectar).toBeEnabled({ timeout: 15_000 });
    await conectar.click();

    // El sistema me cuida: explica QUÉ pasó y QUÉ hacer, con un botón para reintentar.
    await expect(page.getByText(/Tu navegador bloqueó la ventana de Meta/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Permite las ventanas emergentes/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Reintentar/i })).toBeVisible();

    // Pido ayuda al asistente: como es cuenta conversia (elegible), la burbuja ABRE con mi error.
    await page.getByRole("button", { name: /Pedir ayuda al asistente/i }).click();
    await expect(page.getByText("Asistente Conversia")).toBeVisible({ timeout: 10_000 });
    // Mi consulta llegó con el contexto del error (lo arma el botón, no la IA).
    await expect(page.getByText(/Necesito ayuda con esto/i)).toBeVisible({ timeout: 10_000 });
    // Y el asistente responde ALGO (mock o real) — jamás un "(Not Found)" crudo.
    await expect(page.getByText(/^Asistente$/).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/not found/i)).toHaveCount(0);

    if (process.env.RUN_DUENO_AI) {
      // Con IA real, la respuesta menciona ESPECÍFICAMENTE las ventanas emergentes.
      await expect(page.getByText(/ventana|emergente|popup|bloqueador/i).last()).toBeVisible({ timeout: 20_000 });
    }

    const inesperados = errores.filter((e) => !/connect\.facebook\.net|content security policy|failed to load resource/i.test(e));
    expect(inesperados, `Errores de consola inesperados: ${inesperados.join(" | ")}`).toEqual([]);
  });

  test("API caída a mitad de navegación → error accionable y recuperación sola (sin pantalla blanca)", async ({ page, request }) => {
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "psicologia" });
    await useSession(page, cuenta.token);

    // Simulo la API caída SOLO para el saldo (lo que el dueño ve en 'Hoy').
    let caida = true;
    await page.route("**/billing/wallet/summary", (route) => {
      if (caida) return route.abort();
      return route.continue();
    });

    await page.goto("/inicio", { waitUntil: "domcontentloaded" });
    // La UI me cuida: mensaje claro + reintentar, NO una pantalla en blanco ni un crudo.
    await expect(page.getByText(/No pudimos cargar tu saldo/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /Reintentar/i })).toBeVisible();
    await expect(page.getByText(/not found/i)).toHaveCount(0);
    // La pantalla sigue viva (la navegación responde): el panel "Hoy" sigue ahí.
    await expect(page.getByRole("heading", { name: "Créditos" })).toBeVisible();

    // Vuelve la API y reintento: se recupera sola, el saldo aparece.
    caida = false;
    await page.getByRole("button", { name: /Reintentar/i }).click();
    await expect(page.getByText(/No pudimos cargar tu saldo/i)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(/Te quedan\s+30\s+conversaciones de prueba/i)).toBeVisible({ timeout: 15_000 });
  });
});
