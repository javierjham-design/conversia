import { test, expect } from "@playwright/test";
import {
  collectConsoleErrors,
  dejarOperando,
  orgSlug,
  registrarEnNavegador,
  sendInbound,
  tokenFromBrowser,
  waitForBotReply,
  walletBalance,
} from "./_fixtures";

test.skip(!process.env.RUN_DUENO, "Suite 'como el dueño': requiere el stack Docker (RUN_DUENO=1).");

/**
 * COP ETAPA 4 — "DUEÑO NUEVO DESDE CERO", **medido**.
 *
 * Las otras jornadas prueban partes del camino. Esta recorre el camino COMPLETO en un
 * navegador real, en el orden en que lo haría Javier, y **mide cuánto tarda**: la promesa
 * del producto es "tu asistente andando en minutos", y una promesa que nadie cronometra se
 * degrada sin que nadie se entere.
 *
 * Lo que recorre:
 *   registro → Convi se presenta solo → datos del negocio y horario por el formulario →
 *   servicios con precio → profesional con horario → asistente publicado → canal con
 *   asistente asignado → un cliente escribe y el bot responde → el saldo baja →
 *   "bot activo" visible en el panel.
 *
 * Qué NO hace y por qué: la conexión con Meta y el checkout de la pasarela se hacen con el
 * canal MOCK y el proveedor de pago falso del sim. Levantar el popup real de Meta o cobrar
 * de verdad en un test es imposible, y fingirlo con un mock que "siempre dice sí" no
 * probaría nada que no prueben las jornadas B (popup bloqueado) y G (retornos de la
 * pasarela). Lo que aquí importa es que las piezas encadenan y cuánto tarda el camino.
 *
 * El tiempo se ADJUNTA al reporte, no se afirma con un tope: un umbral duro en CI convierte
 * una máquina lenta en un build rojo y enseña a ignorar la suite. El dato queda en el
 * reporte para mirarlo entre corridas, que es para lo que sirve.
 */
test.describe("Jornada H — de cero a bot activo (medida)", () => {
  test("registro → montaje completo → el bot responde → el saldo baja", async ({ page, request }, testInfo) => {
    test.skip(!["desktop", "iphone"].includes(testInfo.project.name), "El viaje medido corre en desktop + iphone.");
    test.setTimeout(180_000);
    const errores = collectConsoleErrors(page);
    const t0 = Date.now();
    const hitos: { paso: string; min: number }[] = [];
    const marcar = (paso: string) => hitos.push({ paso, min: Math.round(((Date.now() - t0) / 60_000) * 100) / 100 });

    // ── 1) Nazco ────────────────────────────────────────────────────────────────
    const negocio = `Barbería QA ${Date.now()}`;
    await registrarEnNavegador(page, { negocio, rubroIndex: 0 });
    const token = await tokenFromBrowser(page);
    marcar("registro");

    // ── 2) Convi se presenta SOLO (COP 2) y me dice qué sigue ──────────────────
    const esMovil = testInfo.project.name !== "desktop";
    if (esMovil) {
      await expect(page.getByText(/Convi te acompaña/i)).toBeVisible({ timeout: 20_000 });
      await page.getByRole("button", { name: /Empecemos|Abrir/i }).dispatchEvent("click");
    }
    const panel = page.getByRole("dialog", { name: /Convi/i });
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("progressbar", { name: /Avance del montaje/i })).toBeVisible();
    // El primer paso pendiente de una cuenta nueva son los datos del negocio.
    await expect(page.getByText(/datos de tu negocio/i).first()).toBeVisible();
    marcar("convi_saluda");
    // Lo cierro para operar la pantalla (en móvil taparía los formularios).
    await panel.getByRole("button", { name: "Cerrar" }).dispatchEvent("click");

    // ── 3) Datos del negocio + HORARIO por el formulario (COP 1) ───────────────
    await page.goto("/ajustes", { waitUntil: "domcontentloaded" });
    const tarjeta = page.locator('[data-copilot="negocio-datos"]');
    await expect(tarjeta).toBeVisible({ timeout: 20_000 });
    await tarjeta.getByLabel("Dirección").fill("Av. Siempre Viva 742, Providencia");
    // El rubro ya viene del registro; el nombre también. Falta el horario, que es el dato
    // que hacía imposible cerrar el paso 1 antes de arreglar el endpoint.
    // `setChecked` en vez de `check`: el input vive DENTRO de su `<label>`, y un clic en el
    // centro puede resolverse contra el texto de la etiqueta (que reenvía el clic al control)
    // → Playwright ve "el clic no cambió el estado". Con setChecked se afirma el estado final.
    await tarjeta.getByRole("checkbox", { name: /Lunes: abre/i }).setChecked(true);
    await tarjeta.getByRole("button", { name: /Aplicar el lunes a toda la semana laboral/i }).click();
    await tarjeta.getByRole("button", { name: /Guardar datos del negocio/i }).click();
    await expect(tarjeta.getByText(/tu asistente ya responde con estos datos/i)).toBeVisible({ timeout: 15_000 });
    marcar("datos_negocio");

    // ── 4) Servicios con precio y duración ─────────────────────────────────────
    await page.goto("/agenda/configurar", { waitUntil: "domcontentloaded" });
    const agregarServicio = page.locator('[data-copilot="servicios"]').getByRole("button", { name: /Agregar/i });
    await expect(agregarServicio).toBeVisible({ timeout: 20_000 });
    await agregarServicio.click();
    await expect(page.getByRole("heading", { name: "Nuevo servicio" })).toBeVisible();
    await page.getByLabel("Nombre").fill("Corte clásico");
    await page.getByLabel(/Duración/i).fill("30");
    await page.getByLabel(/Precio/i).fill("12000");
    await page.getByRole("button", { name: /^Guardar$/i }).click();
    await expect(page.getByText("30 min · $12.000")).toBeVisible({ timeout: 15_000 });
    marcar("servicios");

    // ── 5) Quien atiende, con su horario ───────────────────────────────────────
    const agregarPro = page.locator('[data-copilot="profesionales"]').getByRole("button", { name: /Agregar/i });
    await agregarPro.click();
    await expect(page.getByRole("heading", { name: "Nuevo recurso" })).toBeVisible();
    await page.getByLabel("Nombre").fill("Ana");
    await page.getByRole("button", { name: /^Guardar$/i }).click();
    // La fila muestra "Ana · persona" en un solo nodo, así que `exact` no aplica.
    await expect(page.getByText(/Ana\s*·/).first()).toBeVisible({ timeout: 15_000 });
    marcar("profesional");

    // ── 6) Asistente publicado + canal con asistente asignado ─────────────────
    // En prod esto lo hacen el cliente (publicar) y Meta (conectar). En el sim el canal es
    // MOCK: la conexión real con el popup de Meta la cubre la jornada B.
    await dejarOperando(request, token);
    marcar("bot_publicado_y_canal");

    // ── 7) Un cliente escribe y el bot responde DE VERDAD ─────────────────────
    const slug = await orgSlug(request, token);
    await sendInbound(request, slug, "Hola, ¿cuánto sale el corte?");
    const respuesta = await waitForBotReply(request, token, 60_000);
    expect(respuesta, "el bot tenía que responder").toBeTruthy();
    marcar("primera_respuesta");

    // ── 8) El saldo bajó: la conversación se cobró ────────────────────────────
    await expect
      .poll(async () => walletBalance(request, token), { timeout: 30_000, message: "el saldo debía bajar a 29" })
      .toBe(29);
    marcar("saldo_cobrado");

    // ── 9) El panel lo refleja ────────────────────────────────────────────────
    await page.goto("/inicio", { waitUntil: "domcontentloaded" });
    await expect(page.getByText(/Te quedan\s+29\s+de\s+30/i)).toBeVisible({ timeout: 20_000 });

    const totalMin = Math.round(((Date.now() - t0) / 60_000) * 100) / 100;
    await testInfo.attach("tiempo-de-montaje.json", {
      body: JSON.stringify({ proyecto: testInfo.project.name, totalMin, hitos }, null, 2),
      contentType: "application/json",
    });
    // Queda en el log del job para poder compararlo entre corridas sin abrir el adjunto.
    console.log(`⏱ Jornada H [${testInfo.project.name}]: ${totalMin} min · ${hitos.map((h) => `${h.paso}=${h.min}`).join(" · ")}`);

    // Consola limpia: cualquier excepción de JS en este recorrido es un bug real.
    const inesperados = errores.filter((e) => !/favicon|manifest|load resource/i.test(e));
    expect(inesperados, `Errores de consola inesperados: ${inesperados.join(" | ")}`).toEqual([]);
  });
});
