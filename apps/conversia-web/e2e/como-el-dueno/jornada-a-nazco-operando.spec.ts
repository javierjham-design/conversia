import { test, expect } from "@playwright/test";
import {
  RUBROS,
  collectConsoleErrors,
  dejarOperando,
  orgSlug,
  registrarEnNavegador,
  sendInbound,
  tokenFromBrowser,
  waitForBotReply,
  walletBalance,
} from "./_fixtures";

/**
 * JORNADA A — "Nazco y quedo operando".
 *
 * El dueño se registra desde el apex Conversia, nace con 30/30 conversaciones de regalo, el
 * asistente lo saluda y le dice qué falta, carga servicios, conecta su canal, recibe a un
 * cliente, ve la conversación en la Bandeja, responde a mano y ve bajar el crédito.
 *
 * Nota honesta (IA mock en el sim): los pasos que exigen IA real (cargar servicios POR EL CHAT,
 * que el bot genere respuestas de calidad) no se verifican sin ANTHROPIC_API_KEY. Aquí los
 * servicios se cargan por el FORMULARIO (el otro camino real del dueño) y el bot responde con el
 * texto mock; ambos son deterministas. El saludo del asistente y el contexto SÍ son reales (los
 * calcula el backend, no la IA).
 *
 * Requiere el stack Docker (RUN_DUENO=1).
 */
test.skip(!process.env.RUN_DUENO, "Suite 'como el dueño': requiere el stack Docker (RUN_DUENO=1).");

// ── A1: "Nazco" por CADA uno de los 14 rubros (registro + 30/30). Desktop (rápido). ──
test.describe("Jornada A — nazco (14 rubros)", () => {
  for (let i = 0; i < RUBROS.length; i++) {
    const rubro = RUBROS[i];
    test(`nazco con rubro "${rubro}" → panel con 30 de regalo`, async ({ page, request }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "El barrido de 14 rubros corre solo en desktop.");
      await registrarEnNavegador(page, { negocio: `QA ${rubro} ${Date.now()}`, rubroIndex: i });
      // En /inicio: la cuenta nace con 30 conversaciones de prueba (dos superficies lo dicen).
      await expect(page.getByText(/Te quedan\s+30\s+de\s+30\s+conversaciones gratis/i)).toBeVisible({ timeout: 15_000 });
      // Y el token existe (sesión iniciada) + el saldo real es 30.
      const token = await tokenFromBrowser(page);
      expect(await walletBalance(request, token)).toBe(30);
    });
  }
});

// ── A2: "Quedo operando" — el viaje completo en un rubro representativo (gimnasio). ──
test.describe("Jornada A — quedo operando (viaje completo)", () => {
  test("registro → 30/30 → asistente saluda → servicios → cliente escribe → Bandeja → respondo → crédito baja", async ({ page, request }, testInfo) => {
    test.skip(!["desktop", "iphone"].includes(testInfo.project.name), "El viaje completo corre en desktop + iphone (móvil+escritorio).");
    test.setTimeout(120_000);
    const errores = collectConsoleErrors(page);
    const gimnasioIdx = RUBROS.indexOf("gimnasio");

    // 1) Nazco desde el apex con 30 de regalo.
    await registrarEnNavegador(page, { negocio: `Gimnasio QA ${Date.now()}`, rubroIndex: gimnasioIdx });
    await expect(page.getByText(/Te quedan\s+30\s+de\s+30\s+conversaciones gratis/i)).toBeVisible({ timeout: 15_000 });
    const token = await tokenFromBrowser(page);

    // 2) COP 2 — Convi se presenta SOLO en la primera entrada y me dice qué falta (contexto
    //    REAL del backend, no IA). En escritorio aparece el panel acoplado completo; en móvil
    //    aparece COMPACTO —saludo + progreso— para no taparme el panel que vengo a ver, y se
    //    expande al tocar. Las dos formas llevan el nombre del negocio y el paso que sigue.
    const esMovil = testInfo.project.name !== "desktop";
    if (esMovil) {
      await expect(page.getByText(/Convi te acompaña/i)).toBeVisible({ timeout: 15_000 });
      // El progreso del montaje se ve sin abrir nada.
      await expect(page.getByText(/Paso \d+ de \d+/)).toBeVisible();
      await page.getByRole("button", { name: /Empecemos|Abrir/i }).dispatchEvent("click");
    }
    await expect(page.getByRole("dialog", { name: /Convi/i })).toBeVisible({ timeout: 15_000 });
    // Saluda por el nombre del negocio y propone el paso pendiente (no un texto genérico).
    await expect(page.getByText(/Soy Convi/i)).toBeVisible();
    await expect(page.getByText(/Gimnasio QA/i).first()).toBeVisible();
    // Barra de progreso del montaje, siempre visible mientras falte algo.
    await expect(page.getByRole("progressbar", { name: /Avance del montaje/i })).toBeVisible();
    await expect(page.getByText(/not found/i)).toHaveCount(0);
    // Lo cierro (en móvil taparía el compositor de la Bandeja más adelante).
    await page.getByRole("dialog", { name: /Convi/i }).getByRole("button", { name: "Cerrar" }).dispatchEvent("click");
    await expect(page.getByRole("dialog", { name: /Convi/i })).toHaveCount(0);

    // 3) Cargo 2 servicios con su precio (por el formulario; la vía por chat exige IA real).
    await page.goto("/agenda/configurar", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Servicios" })).toBeVisible({ timeout: 15_000 });
    // "Agregar" de la SECCIÓN Servicios (hay otro en "Equipo y recursos"): el botón vecino del h2.
    const agregarServicio = page.getByRole("heading", { name: "Servicios" }).locator("..").getByRole("button", { name: /Agregar/i });
    for (const svc of [
      { nombre: "Plan mensual", dur: "30", precio: "25000" },
      { nombre: "Clase de prueba", dur: "45", precio: "8000" },
    ]) {
      await agregarServicio.click();
      await expect(page.getByRole("heading", { name: "Nuevo servicio" })).toBeVisible();
      await page.getByLabel("Nombre").fill(svc.nombre);
      await page.getByLabel(/Duración/i).fill(svc.dur);
      await page.getByLabel(/Precio/i).fill(svc.precio);
      await page.getByRole("button", { name: /^Guardar$/i }).click();
      await expect(page.getByText(svc.nombre)).toBeVisible({ timeout: 10_000 });
    }
    // Quedaron los 2 que cargué, con su precio formateado es-CL.
    await expect(page.getByText("Plan mensual")).toBeVisible();
    // `exact` a propósito: sin esto también matchea "Clase de prueba (gratis)" y el test
    // se caía por strict mode de forma intermitente (según qué servicios trae el rubro).
    await expect(page.getByText("Clase de prueba", { exact: true })).toBeVisible();
    await expect(page.getByText("30 min · $25.000")).toBeVisible();
    await expect(page.getByText("45 min · $8.000")).toBeVisible();

    // 4) Conecto el canal (en prod lo hace Meta; en el sim, MOCK) y publico el agente que atiende.
    await dejarOperando(request, token);
    const slug = await orgSlug(request, token);

    // 5) Un "cliente" me escribe por WhatsApp (webhook mock).
    await sendInbound(request, slug, "Hola, ¿cuánto cuesta el plan mensual?");

    // 6) Veo la conversación en la Bandeja y el bot respondió. El bot tarda ~8s (debounce del
    //    worker); espero su reply por API y abro el hilo por deep-link (trae todos los mensajes).
    const convId = await waitForBotReply(request, token);
    await page.goto("/conversaciones", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/Cliente Simulado/i).first()).toBeVisible({ timeout: 30_000 });
    await page.goto(`/conversaciones?c=${convId}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Hola, ¿cuánto cuesta el plan mensual?", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^IA ·/).first()).toBeVisible({ timeout: 15_000 });

    // 7) Respondo yo a mano desde la Bandeja.
    const composer = page.getByPlaceholder(/Escribe un mensaje/i);
    await composer.fill("¡Hola! El plan mensual son $25.000. ¿Te apunto a una clase de prueba?");
    // Enter envía el form (en móvil la barra de pestañas fija tapa el botón para el hit-test).
    await composer.press("Enter");
    // Aparece tanto en el preview de la lista como en la burbuja del hilo → tomo la última (la burbuja).
    await expect(
      page.getByText("¡Hola! El plan mensual son $25.000. ¿Te apunto a una clase de prueba?", { exact: true }).last(),
    ).toBeVisible({ timeout: 10_000 });

    // 8) El contador de créditos bajó (una conversación consumida): 30 → 29.
    await expect.poll(async () => walletBalance(request, token), { timeout: 30_000, message: "el crédito debía bajar a 29" }).toBe(29);
    await page.goto("/cobros", { waitUntil: "domcontentloaded" });
    // CRE 3 — el título del saldo sigue a la UNIDAD del plan: a quien cobra por conversación
    // se le dice "Conversaciones disponibles". Decirle "Créditos" es la misma mezcla de
    // unidades que CRE 2 salió a corregir (1 conversación ≈ 4 créditos, no son lo mismo).
    await expect(page.getByText("Conversaciones disponibles")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/^29$/)).toBeVisible({ timeout: 10_000 });

    // Consola limpia (cuenta conversia sana): sin errores inesperados.
    const inesperados = errores.filter((e) => !/favicon|manifest|load resource/i.test(e));
    expect(inesperados, `Errores de consola: ${inesperados.join(" | ")}`).toEqual([]);
  });
});
