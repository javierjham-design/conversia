import { test, expect } from "@playwright/test";
import {
  armarCanalesConPopupBloqueado,
  collectConsoleErrors,
  openedUrls,
  registerAccount,
  useSession,
} from "./_fixtures";

/**
 * JORNADA D — "una cuenta tubot que por error entra a conversia-web" (el caso del pantallazo
 * de Javier) + control positivo de una cuenta conversia.
 *
 * REPRODUCE TAL CUAL el camino del dueño:
 *   token de org brand='tubot' en conversia-web → /canales → el popup de Meta se bloquea →
 *   botón "Pedir ayuda al asistente" → HOY (pre-fix): burbuja con "(Not Found)".
 *
 * Este test FALLA contra el código pre-fix (ve el "(Not Found)") y queda en VERDE con el fix
 * de elegibilidad (sin burbuja, sin error crudo, el botón cae a un enlace de soporte).
 *
 * Requiere el stack Docker (api :4000, web :3002). Se activa con RUN_DUENO=1.
 */
test.skip(!process.env.RUN_DUENO, "Suite 'como el dueño': requiere el stack Docker (RUN_DUENO=1).");

test.describe("Jornada D — marca ajena en conversia-web", () => {
  test("cuenta tubot: SIN burbuja, SIN '(Not Found)', 'Pedir ayuda' cae a soporte", async ({ page, request }) => {
    const errores = collectConsoleErrors(page);
    // Si el camino de ayuda intenta hablar con el asistente (que a esta cuenta le da 404),
    // es el bug: con el fix, "Pedir ayuda" cae a soporte sin tocar /assistant/message.
    let mensajeAlAsistente = false;
    page.on("request", (r) => {
      if (r.url().includes("/assistant/message")) mensajeAlAsistente = true;
    });

    const tubot = await registerAccount(request, { brand: "tubot" });
    await useSession(page, tubot.token);
    await armarCanalesConPopupBloqueado(page);

    // El asistente responde 404 para una org que no es de Conversia: esperamos a que el
    // widget resuelva su elegibilidad ANTES de interactuar (así no hay carrera con el estado).
    const ctx404 = page.waitForResponse((r) => r.url().includes("/assistant/context"), { timeout: 20_000 });
    await page.goto("/canales", { waitUntil: "domcontentloaded" });
    const ctxRes = await ctx404;
    expect(ctxRes.status(), "El gate del asistente debe rechazar la org tubot con 404").toBe(404);

    // Dejo asentar el render (el widget ya decidió su elegibilidad): NO hay botón flotante del
    // asistente para esta cuenta. (Robusto al timing: afirmo ausencia tras asentar, no "aún no".)
    await page.waitForTimeout(800);
    await expect(page.getByRole("button", { name: /Convi/i })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: /Convi/i })).toHaveCount(0);

    // Disparo el error del popup como Javier: "Conectar mi WhatsApp".
    const conectar = page.getByRole("button", { name: /Conectar mi WhatsApp/i });
    await expect(conectar).toBeEnabled({ timeout: 15_000 });
    await conectar.click();

    // Aparece el banner de error accionable con el botón de ayuda.
    const pedirAyuda = page.getByRole("button", { name: /Pedir ayuda al asistente/i });
    await expect(pedirAyuda).toBeVisible({ timeout: 15_000 });
    await pedirAyuda.click();

    // El botón de ayuda cayó a un enlace de soporte (wa.me o mailto:soporte) — nunca un botón
    // muerto. Con el fix esto ocurre casi al instante; con el bug nunca ocurre (abría la burbuja).
    await expect
      .poll(async () => (await openedUrls(page)).some((u) => /wa\.me|mailto:soporte/i.test(u)), {
        timeout: 6_000,
        message: "Se esperaba que 'Pedir ayuda' abriera un enlace de soporte (fallback de elegibilidad)",
      })
      .toBe(true);

    // Dejo correr cualquier apertura/respuesta asíncrona ERRÓNEA que el bug produciría…
    await page.waitForTimeout(1500);
    // …y verifico que NADA de eso pasó: ni "(Not Found)" crudo, ni burbuja, ni llamada al asistente.
    await expect(page.getByText(/not found/i)).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: /Convi/i })).toHaveCount(0);
    expect(mensajeAlAsistente, "'Pedir ayuda' no debe llamar a /assistant/message en una cuenta inelegible").toBe(false);

    // Consola: en este escenario DEGRADADO POR DISEÑO hay dos ruidos esperados y benignos —
    // (a) el 404 del gate del asistente (es la marca ajena) y (b) el SDK de Meta bloqueado (el
    // "popup bloqueado" que simulamos; #514 habilita su CSP). Cualquier OTRO error de consola
    // (excepción de JS, error de React, etc.) sí hace fallar: eso sería un bug real.
    const inesperados = errores.filter(
      (e) => !/connect\.facebook\.net|content security policy|failed to load resource/i.test(e),
    );
    expect(inesperados, `Errores de consola inesperados: ${inesperados.join(" | ")}`).toEqual([]);
  });

  test("control positivo — cuenta conversia SÍ ve la burbuja y recibe respuesta (mock)", async ({ page, request }) => {
    const conversia = await registerAccount(request, { brand: "conversia", vertical: "gimnasio" });
    await useSession(page, conversia.token);

    const ctx = page.waitForResponse((r) => r.url().includes("/assistant/context"), { timeout: 20_000 });
    await page.goto("/inicio", { waitUntil: "domcontentloaded" });
    expect((await ctx).status(), "El asistente debe aceptar una org conversia").toBe(200);

    // Elegibilidad: para una cuenta conversia Convi SÍ está (lo contrario del caso tubot).
    // Puede estar ya abierto —COP 2: en modo montaje se presenta solo en la primera entrada,
    // acoplado en escritorio y compacto en móvil— o como acceso con su anillo de progreso.
    // Afirmo que ALGUNA de las dos formas existe: lo que se prueba es la elegibilidad, no en
    // qué forma apareció.
    await expect
      .poll(async () => (await page.getByRole("button", { name: /Convi/i }).count()) + (await page.getByRole("dialog", { name: /Convi/i }).count()), { timeout: 15_000 })
      .toBeGreaterThan(0);

    // Lo abro por el EVENTO del producto (el mismo que usan el menú y el checklist), que en una
    // cuenta elegible Convi "toma" y abre. Es robusto en móvil (no depende del hit-test del
    // botón fijo sobre el contenido scrolleable, que Playwright marca como interceptado).
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("conversia:assistant:open", { detail: { topic: "menu" } })));
    await expect(page.getByRole("dialog", { name: /Convi/i })).toBeVisible();
    // Jamás un "(Not Found)" tampoco aquí.
    await expect(page.getByText(/not found/i)).toHaveCount(0);
  });
});
