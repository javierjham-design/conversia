import { test, expect } from "@playwright/test";
import { SIM_API, registerAccount, useSession } from "./_fixtures";

/**
 * JORNADA G — "Pago mi plan desde mi panel".
 *
 * El hallazgo 3 de la auditoría (26/27-oct-2026): un cliente de Conversia NO podía pagar
 * desde su panel. El checkout y el registro de tarjeta volvían a `/billing` —ruta de TuBot
 * que no existe en conversia-web— y `/cobros` nunca llamaba `subscription/start` ni
 * `subscription/confirm-card`.
 *
 * Acá el navegador hace lo del dueño: entra a /cobros, contrata su plan (en el sim no hay
 * pasarela real → checkout MOCK, sin cobro) y lo ve activo; vuelve de la pasarela por los
 * URLs de retorno y ve un mensaje claro en vez de quedar perdido. Y se verifica contra la
 * API que los retornos son los de SU marca, con la regresión explícita de que los de TuBot
 * no cambiaron.
 *
 * Requiere el stack Docker (RUN_DUENO=1). El sim no tiene Flow/Stripe/Lemon configurados
 * → `createPaymentProvider` cae a Mock y `mock-confirm` está permitido (igual que Jornada C).
 */
test.skip(!process.env.RUN_DUENO, "Suite 'como el dueño': requiere el stack Docker (RUN_DUENO=1).");

const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

type PlanRow = { code: string; name: string; priceClp: number; custom: boolean };

test.describe("Jornada G — pago mi plan", () => {
  test("el dueño contrata su plan desde /cobros (checkout mock) y lo ve activo", async ({ page, request }, testInfo) => {
    test.skip(!["desktop", "iphone"].includes(testInfo.project.name), "El viaje de pago corre en desktop + iphone.");
    test.setTimeout(120_000);
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "dental" });
    await useSession(page, cuenta.token);

    // El catálogo de SU marca (el plan de prueba, costo 0, no aparece: no es contratable).
    const plans = (await request.get(`${SIM_API}/billing/plans`, { headers: auth(cuenta.token) }).then((r) => r.json())) as PlanRow[];
    const plan = plans.find((p) => !p.custom && p.priceClp > 0);
    expect(plan, "el catálogo conversia debe traer al menos un plan de pago").toBeTruthy();

    await page.goto("/cobros", { waitUntil: "domcontentloaded" });

    // Antes de pagar: la tarjeta NO está registrada y la pantalla dice qué hacer primero.
    const metodo = page.locator('[data-copilot="cobros-metodo-pago"]');
    await expect(metodo).toBeVisible({ timeout: 20_000 });
    await expect(metodo.getByText(/Registra tu tarjeta una sola vez/i)).toBeVisible();

    // Contrato el plan. Con Flow sin configurar en el sim, la UI cae al checkout único:
    // mock → se confirma sin cobro real y queda dicho en pantalla.
    await page.locator(`[data-copilot="cobros-contratar-${plan!.code}"]`).click();
    await expect(page.getByRole("status")).toContainText(/Pago de PRUEBA confirmado/i, { timeout: 30_000 });
    // Nunca salimos de /cobros (no hay redirección a un /billing inexistente).
    await expect(page).toHaveURL(/\/cobros$/);

    // El plan quedó activo de verdad (no solo el mensaje).
    await expect
      .poll(
        async () => {
          const me = await request.get(`${SIM_API}/billing/me`, { headers: auth(cuenta.token) }).then((r) => r.json());
          return me?.plan?.code ?? null;
        },
        { timeout: 30_000, message: "la suscripción debía quedar en el plan contratado" },
      )
      .toBe(plan!.code);

    // Y el dueño lo ve: la tarjeta del plan pasa a "Actual".
    await page.reload({ waitUntil: "domcontentloaded" });
    const tarjetaPlan = page.locator("div.card").filter({ hasText: plan!.name }).first();
    await expect(tarjetaPlan.getByText("Actual")).toBeVisible({ timeout: 20_000 });
  });

  test("los retornos de la pasarela aterrizan en /cobros con un mensaje claro", async ({ page, request }, testInfo) => {
    test.skip(!["desktop", "iphone"].includes(testInfo.project.name), "Retornos en desktop + iphone.");
    const cuenta = await registerAccount(request, { brand: "conversia" });
    await useSession(page, cuenta.token);

    // Pagó: volvemos a SU pantalla con el aviso de pago recibido (lo confirma el webhook).
    await page.goto("/cobros?pago=ok", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status")).toContainText(/Pago recibido/i, { timeout: 20_000 });
    await expect(page.locator('[data-cobros-aviso="ok"]')).toBeVisible();
    // La URL queda limpia: refrescar no repite el aviso.
    await expect(page).toHaveURL(/\/cobros$/);

    // Canceló: se le dice que no se le cobró nada.
    await page.goto("/cobros?pago=cancelado", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status")).toContainText(/no te cobramos nada/i, { timeout: 20_000 });
    await expect(page.locator('[data-cobros-aviso="warn"]')).toBeVisible();

    // Volvió del registro de tarjeta en otro navegador (sin el token de la operación):
    // no se queda en blanco ni miente — explica qué pasó y qué mirar.
    await page.goto("/cobros?card=1", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("status")).toContainText(/no pudimos retomar la operación/i, { timeout: 20_000 });
  });

  test("la API devuelve los retornos de la MARCA de la org (y los de TuBot no cambian)", async ({ request }) => {
    // Conversia: checkout y compra de créditos vuelven a /cobros?pago=ok.
    const conversia = await registerAccount(request, { brand: "conversia" });
    const planesCv = (await request.get(`${SIM_API}/billing/plans`, { headers: auth(conversia.token) }).then((r) => r.json())) as PlanRow[];
    const planCv = planesCv.find((p) => !p.custom && p.priceClp > 0);
    expect(planCv).toBeTruthy();
    const checkoutCv = await request
      .post(`${SIM_API}/billing/checkout`, { headers: auth(conversia.token), data: { planCode: planCv!.code } })
      .then((r) => r.json());
    expect(checkoutCv.url).toContain("/cobros?pago=ok");
    expect(checkoutCv.url).not.toContain("/billing");

    const wallet = await request.get(`${SIM_API}/billing/wallet`, { headers: auth(conversia.token) }).then((r) => r.json());
    const pack = (wallet?.packages ?? [])[0];
    if (pack) {
      const compra = await request
        .post(`${SIM_API}/billing/buy-package`, { headers: auth(conversia.token), data: { code: pack.code } })
        .then((r) => r.json());
      expect(compra.url).toContain("/cobros?pago=ok");
      expect(compra.url).not.toContain("/settings/plan");
    }

    // REGRESIÓN TuBot: una org tubot sigue volviendo a /billing, sin ?pago.
    const tubot = await registerAccount(request, { brand: "tubot" });
    const planesTb = (await request.get(`${SIM_API}/billing/plans`, { headers: auth(tubot.token) }).then((r) => r.json())) as PlanRow[];
    const planTb = planesTb.find((p) => !p.custom && p.priceClp > 0);
    expect(planTb, "el catálogo tubot debe traer al menos un plan de pago").toBeTruthy();
    const checkoutTb = await request
      .post(`${SIM_API}/billing/checkout`, { headers: auth(tubot.token), data: { planCode: planTb!.code } })
      .then((r) => r.json());
    expect(checkoutTb.url).toContain("/billing");
    expect(checkoutTb.url).not.toContain("/cobros");
    expect(checkoutTb.url).not.toContain("pago=ok");
  });
});
