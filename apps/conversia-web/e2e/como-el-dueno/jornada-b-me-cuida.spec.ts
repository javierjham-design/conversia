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
    const conectar = page.getByRole("button", { name: /Conectar mi WhatsApp/i });
    await expect(conectar).toBeEnabled({ timeout: 15_000 });
    await conectar.click();

    // El sistema me cuida: explica QUÉ pasó y QUÉ hacer, con un botón para reintentar.
    await expect(page.getByText(/Tu navegador bloqueó la ventana de Meta/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Permite las ventanas emergentes/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Reintentar/i })).toBeVisible();

    // Pido ayuda al asistente: como es cuenta conversia (elegible), la burbuja ABRE con mi error.
    await page.getByRole("button", { name: /Pedir ayuda al asistente/i }).click();
    await expect(page.getByRole("dialog", { name: /Convi/i })).toBeVisible({ timeout: 10_000 });
    // Mi consulta llegó con el contexto del error (lo arma el botón, no la IA).
    // .first(): el prellenado puede aparecer a la vez en el compositor y en la burbuja
    // enviada (carrera breve) → sin .first() el strict mode falla con "2 elements".
    await expect(page.getByText(/Necesito ayuda con esto/i).first()).toBeVisible({ timeout: 10_000 });
    // Y el asistente responde ALGO (mock o real) — jamás un "(Not Found)" crudo.
    await expect(page.getByText(/^Convi$/).first()).toBeVisible({ timeout: 20_000 });
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

  /**
   * CRE 3 — EL MEDIDOR DE CRÉDITOS, EN PANTALLA.
   *
   * Un saldo en créditos no le dice nada al dueño: lo que necesita saber es cuántas
   * conversaciones más le alcanzan. Ese bloque solo aparece cuando el plan cobra Créditos
   * IA, que es un catálogo que todavía está apagado — así que hasta acá NADIE lo había
   * renderizado en un navegador. El día del go-live se estrenaría en la pantalla del primer
   * cliente que pague.
   *
   * La respuesta del saldo se sirve con la forma EXACTA que arma la API (y que el test
   * `apps/api/test/creditos-medidor.spec.ts` encierra campo por campo): el saldo en
   * créditos, el medidor con su estimación y la explicación de dónde sale el número.
   */
  test("con Créditos IA el medidor dice cuántas conversaciones alcanzan, en Inicio y en Cobros", async ({ page, request }) => {
    const errores = collectConsoleErrors(page);
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "barberia" });
    await useSession(page, cuenta.token);

    // 1.240 créditos, 9 por conversación (promedio de SUS últimas 40) → 137 conversaciones;
    // 18 créditos al día → 68 días. Los dos textos los arma `frasePorSaldo`/`explicarBase`.
    const saldoEnCreditos = {
      unit: "credit",
      balance: 1240,
      included: 100,
      consumed: 0,
      remaining: 1240,
      graceUsed: 0,
      graceLimit: 100,
      expiringThisMonth: 0,
      byCategory: {},
      projected: 12,
      pctUsed: 0,
      over80: false,
      medidor: {
        conversaciones: 137,
        dias: 68,
        creditosPorConversacion: 9,
        base: "org",
        muestra: 40,
        frase: "1.240 créditos · ≈ 137 conversaciones · ≈ 68 días a tu ritmo",
        explicacion: "Calculado con tus últimas 40 conversaciones: 9 créditos cada una en promedio.",
      },
    };
    await page.route("**/billing/wallet/summary", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(saldoEnCreditos) }),
    );

    // --- Inicio: el medidor, con la explicación a mano (title) y el CTA de SU unidad.
    await page.goto("/inicio", { waitUntil: "domcontentloaded" });
    const medidorInicio = page.getByText(/137\s*conversaciones más/i);
    await expect(medidorInicio).toBeVisible({ timeout: 15_000 });
    await expect(medidorInicio).toContainText(/68\s*días a tu ritmo/i);
    await expect(medidorInicio).toHaveAttribute("title", /Calculado con tus últimas 40 conversaciones/i);
    await expect(page.getByRole("link", { name: /Recargar créditos/i })).toBeVisible();

    // --- Cobros: la unidad correcta, el saldo, el medidor y de dónde sale el número.
    await page.goto("/cobros", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Créditos disponibles")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("1.240", { exact: true })).toBeVisible();
    await expect(page.getByText(/≈\s*137\s*conversaciones/i)).toBeVisible();
    await expect(page.getByText(/≈\s*68\s*días a tu ritmo/i)).toBeVisible();
    // La explicación va VISIBLE en Cobros (no en un tooltip): una estimación que no se puede
    // auditar es una cifra que el dueño no va a creer.
    await expect(page.getByText(/Calculado con tus últimas 40 conversaciones/i)).toBeVisible();
    // Y jamás "Conversaciones disponibles" sobre un saldo que está en créditos.
    await expect(page.getByText("Conversaciones disponibles")).toHaveCount(0);

    // Ningún número a medio formatear en ninguna de las dos pantallas.
    for (const basura of [/NaN/, /undefined/, /\[object/, /Infinity/]) {
      await expect(page.getByText(basura)).toHaveCount(0);
    }
    const inesperados = errores.filter((e) => !/connect\.facebook\.net|content security policy|failed to load resource/i.test(e));
    expect(inesperados, `Errores de consola inesperados: ${inesperados.join(" | ")}`).toEqual([]);
  });
});
