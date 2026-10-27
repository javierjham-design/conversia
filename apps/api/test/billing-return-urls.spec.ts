import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * RETORNOS DE COBRO POR MARCA (hallazgo 3 de la auditoría 26/27-oct-2026).
 *
 * Un cliente de Conversia no podía pagar desde su panel: los `successUrl`/`cancelUrl` del
 * checkout y el `urlReturn` del registro de tarjeta apuntaban a `/billing`, una ruta que
 * existe en TuBot (apps/web) y NO en conversia-web. Ahora la ruta se elige por la marca de
 * la organización. Estos tests fijan ambas cosas: que Conversia vuelva a `/cobros…` y —
 * sobre todo— que TuBot siga EXACTAMENTE igual que en producción.
 */

// El env se fija ANTES de que @conversia/config cachee getEnv (vi.hoisted corre primero).
vi.hoisted(() => {
  process.env.WEB_URL = "https://app.tubot.cl";
  process.env.WEB_URL_CONVERSIA = "https://app.conversia.cl";
});

import { appendQuery, billingReturnUrls } from "@conversia/config";
import { FlowPaymentProvider, MockPaymentProvider } from "../src/billing/payment-provider";

const CONVERSIA = { brand: "conversia" };
const TUBOT = { brand: "tubot" };

describe("billingReturnUrls — org CONVERSIA vuelve a /cobros", () => {
  it("checkout pagado/cancelado y tarjeta aterrizan en la pantalla que SÍ existe", () => {
    const u = billingReturnUrls(CONVERSIA);
    expect(u.home).toBe("https://app.conversia.cl/cobros");
    expect(u.success).toBe("https://app.conversia.cl/cobros?pago=ok");
    expect(u.cancel).toBe("https://app.conversia.cl/cobros?pago=cancelado");
    expect(u.card).toBe("https://app.conversia.cl/cobros?card=1");
  });

  it("la compra de créditos también vuelve a /cobros (no a /settings/plan, que no existe)", () => {
    const u = billingReturnUrls(CONVERSIA);
    expect(u.packagesSuccess).toBe("https://app.conversia.cl/cobros?pago=ok");
    expect(u.packagesCancel).toBe("https://app.conversia.cl/cobros?pago=cancelado");
  });

  it("ninguna URL de Conversia apunta a una ruta de TuBot", () => {
    for (const url of Object.values(billingReturnUrls(CONVERSIA))) {
      expect(url).not.toMatch(/\/billing\b/);
      expect(url).not.toMatch(/\/settings\/plan\b/);
      expect(url.startsWith("https://app.conversia.cl/")).toBe(true);
    }
  });
});

describe("billingReturnUrls — REGRESIÓN TuBot: nada cambió", () => {
  it("TuBot mantiene byte a byte las rutas de hoy en producción", () => {
    const u = billingReturnUrls(TUBOT);
    expect(u.home).toBe("https://app.tubot.cl/billing");
    expect(u.success).toBe("https://app.tubot.cl/billing");
    expect(u.cancel).toBe("https://app.tubot.cl/billing");
    expect(u.card).toBe("https://app.tubot.cl/billing?card=1");
    expect(u.packagesSuccess).toBe("https://app.tubot.cl/settings/plan");
    expect(u.packagesCancel).toBe("https://app.tubot.cl/settings/plan");
  });

  it("una org sin marca (o con marca desconocida) se comporta como TuBot", () => {
    const orgs: Array<{ brand?: string | null } | null | undefined> = [null, undefined, {}, { brand: null }, { brand: "otra" }];
    for (const org of orgs) {
      expect(billingReturnUrls(org).card).toBe("https://app.tubot.cl/billing?card=1");
    }
  });
});

describe("appendQuery — las pasarelas agregan su marca sin romper la URL", () => {
  it("usa ? la primera vez y & cuando ya hay query", () => {
    expect(appendQuery("https://x/billing", "paid=1")).toBe("https://x/billing?paid=1");
    expect(appendQuery("https://x/cobros?pago=ok", "paid=1")).toBe("https://x/cobros?pago=ok&paid=1");
    expect(appendQuery("https://x/cobros?pago=ok", "")).toBe("https://x/cobros?pago=ok");
  });

  it("el checkout MOCK conserva el ?pago=ok de Conversia (sin dos ?)", async () => {
    const s = await new MockPaymentProvider().createCheckout({
      organizationId: "org1",
      planCode: "conversia_base",
      amount: 18900,
      currency: "CLP",
      successUrl: billingReturnUrls(CONVERSIA).success,
      cancelUrl: billingReturnUrls(CONVERSIA).cancel,
    });
    expect(s.url).toMatch(/^https:\/\/app\.conversia\.cl\/cobros\?pago=ok&mock_session=/);
    expect(s.url.split("?").length).toBe(2); // un solo "?"
  });

  it("Flow manda al cliente de Conversia de vuelta a /cobros?pago=ok&paid=1", async () => {
    const calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      calls.push(String((init as RequestInit)?.body ?? ""));
      return new Response(JSON.stringify({ url: "https://flow.cl/pay", token: "tok1" }), { status: 200 });
    });
    try {
      await new FlowPaymentProvider("k", "s", "https://flow.cl/api").createCheckout({
        organizationId: "org1",
        planCode: "conversia_base",
        amount: 18900,
        currency: "CLP",
        successUrl: billingReturnUrls(CONVERSIA).success,
        cancelUrl: billingReturnUrls(CONVERSIA).cancel,
      });
    } finally {
      fetchSpy.mockRestore();
    }
    const sent = new URLSearchParams(calls[0]);
    expect(sent.get("urlReturn")).toBe("https://app.conversia.cl/cobros?pago=ok&paid=1");
  });
});

describe("las rutas por marca EXISTEN en el frontend de esa marca", () => {
  // La causa raíz del hallazgo 3 fue mandar a un cliente a una ruta inexistente. Este test
  // falla si alguien cambia una ruta de marca sin que la pantalla exista.
  const apps = join(__dirname, "..", "..");
  it("conversia → apps/conversia-web/src/app/cobros", () => {
    expect(existsSync(join(apps, "conversia-web", "src", "app", "cobros", "page.tsx"))).toBe(true);
  });
  it("tubot → apps/web/.../billing y .../settings/plan", () => {
    expect(existsSync(join(apps, "web", "src", "app", "(app)", "billing", "page.tsx"))).toBe(true);
    expect(existsSync(join(apps, "web", "src", "app", "(app)", "settings", "plan", "page.tsx"))).toBe(true);
  });
});
