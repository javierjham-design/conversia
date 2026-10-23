import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { registerAccount, useSession } from "./_fixtures";

/**
 * JORNADA E — Registro insertado de Meta: FINISH / coexistencia / CANCEL (hallazgos 21-oct).
 *
 * El navegador recorre /canales con el popup de Meta MOCKEADO: inyectamos un `window.FB` falso
 * (junto a un escenario fijo, antes del paint) que dispara el postMessage WA_EMBEDDED_SIGNUP y el
 * callback como lo haría Meta. Cubre:
 *  - FINISH (número nuevo)         → el POST a /channels/embedded-signup lleva `event: "FINISH"`.
 *  - coexistencia (app onboarding) → POST a /channels/coexistence con el `event` de coexistencia.
 *  - CANCEL                         → mensaje HONESTO con el paso donde quedó (nunca error genérico).
 *
 * Requiere el stack Docker (RUN_DUENO=1) sirviendo conversia-web con la captura de `event`.
 */
test.skip(!process.env.RUN_DUENO, "Suite 'como el dueño': requiere el stack Docker (RUN_DUENO=1).");

const META_CONFIG = { appId: "0", configId: "0", graphVersion: "v26.0", ready: true };
type Scenario = { event?: string; code?: string; currentStep?: string; waba?: string; phone?: string };

/** Inyecta, ANTES del paint, un window.FB falso que emula el popup de Meta con un escenario fijo. */
async function setup(page: Page, scenario: Scenario) {
  await page.addInitScript((s: Scenario) => {
    const w = window as unknown as { FB?: unknown };
    w.FB = {
      init() {},
      login(cb: (r: unknown) => void) {
        const data: Record<string, unknown> = {};
        if (s.waba) data.waba_id = s.waba;
        if (s.phone) data.phone_number_id = s.phone;
        if (s.currentStep) data.current_step = s.currentStep;
        // Meta primero manda el postMessage WA_EMBEDDED_SIGNUP (origin facebook.com)…
        window.dispatchEvent(new MessageEvent("message", { origin: "https://www.facebook.com", data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: s.event, data }) }));
        // …y luego resuelve el callback (con code si terminó, sin code si canceló).
        setTimeout(() => cb(s.code ? { authResponse: { code: s.code } } : {}), 20);
      },
    };
  }, scenario);
  await page.route("**/public/meta-config**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(META_CONFIG) }));
  await page.route("**/channels/connection-extras**", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ preVerifiedPhoneId: null }) }));
}

test.describe("Jornada E — registro insertado (FINISH / coexistencia / CANCEL)", () => {
  test("FINISH (número nuevo): el POST lleva event=FINISH", async ({ page, request }) => {
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "barberia" });
    await useSession(page, cuenta.token);
    await setup(page, { event: "FINISH", code: "test-code-finish", waba: "WABA_E", phone: "PHONE_E", currentStep: "FINISH" });
    let body: any = null;
    await page.route("**/channels/embedded-signup", (r) => {
      body = JSON.parse(r.request().postData() || "{}");
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, displayPhone: "+56 9 1234 5678", warnings: [] }) });
    });
    await page.goto("/canales", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Usar un número nuevo/i }).click();
    await expect.poll(() => body?.event, { timeout: 10_000, message: "el POST debía llevar event=FINISH" }).toBe("FINISH");
    expect(body.wabaId).toBe("WABA_E");
    await expect(page.getByText(/¡Listo! WhatsApp conectado/i)).toBeVisible({ timeout: 10_000 });
  });

  test("coexistencia: el POST va a /channels/coexistence con su event", async ({ page, request }) => {
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "peluqueria" });
    await useSession(page, cuenta.token);
    // Phone Number First: el evento de coexistencia trae SOLO waba_id (sin phone_number_id).
    await setup(page, { event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING", code: "test-code-coex", waba: "WABA_C" });
    let body: any = null;
    await page.route("**/channels/coexistence", (r) => {
      body = JSON.parse(r.request().postData() || "{}");
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, displayPhone: "+56 9 2222 3333", coexistence: true, warnings: [] }) });
    });
    await page.goto("/canales", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Conectar mi WhatsApp/i }).click();
    await expect.poll(() => body?.event, { timeout: 10_000, message: "el POST de coexistencia debía llevar el event" }).toBe("FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING");
    expect(body.wabaId).toBe("WABA_C");
    expect(body.phoneNumberId).toBeUndefined(); // sin phone_number_id en coexistencia
    await expect(page.getByText(/¡Listo! Conectamos el WhatsApp que ya usas/i)).toBeVisible({ timeout: 10_000 });
  });

  test("CANCEL: mensaje honesto con el paso (nunca error genérico)", async ({ page, request }) => {
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "gimnasio" });
    await useSession(page, cuenta.token);
    await setup(page, { event: "CANCEL", currentStep: "PHONE_NUMBER_SELECTION" });
    await page.goto("/canales", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Conectar mi WhatsApp/i }).click();
    await expect(page.getByText(/Cerraste la ventana de Meta/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/elegir tu número/i)).toBeVisible();
    await expect(page.getByText(/No se pudo conectar/i)).toHaveCount(0);
  });
});
