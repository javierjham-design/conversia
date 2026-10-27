import { describe, expect, it, vi } from "vitest";

// El env se fija ANTES de que @conversia/config cachee getEnv (vi.hoisted corre
// previo a los imports): habilita probar la familia de dominios conversia.
vi.hoisted(() => {
  process.env.WEB_URL_CONVERSIA = "https://app.conversia.cl";
  process.env.MAIL_REPLY_TO = "respuestas-test@tubot.cl";
  process.env.RESEND_API_KEY = "re_test_tubot";
  process.env.RESEND_API_KEY_CONVERSIA = "re_test_conversia";
});

import { brandOf } from "@conversia/config";
import { brandFromOrigin } from "../src/auth/auth.controller";

describe("brandOf (marca por organización)", () => {
  it("org sin marca → tubot (comportamiento actual)", () => {
    const b = brandOf(null);
    expect(b.key).toBe("tubot");
    expect(b.name).toBe("TuBot");
  });

  it("org con brand=tubot → config tubot", () => {
    expect(brandOf({ brand: "tubot" }).name).toBe("TuBot");
  });

  it("org con brand=conversia → config conversia", () => {
    const b = brandOf({ brand: "conversia" });
    expect(b.key).toBe("conversia");
    expect(b.name).toBe("Conversia");
    expect(b.mailFrom).toBe("Conversia <no-reply@conversia.cl>");
    expect(b.mfaIssuer).toBe("Conversia.cl");
    expect(b.paymentSubjectPrefix).toBe("Conversia");
  });

  it("MAIL_REPLY_TO llega al replyTo de AMBAS marcas (respuestas a un solo buzón)", () => {
    expect(brandOf({ brand: "conversia" }).replyTo).toBe("respuestas-test@tubot.cl");
    expect(brandOf({ brand: "tubot" }).replyTo).toBe("respuestas-test@tubot.cl");
  });

  it("cada marca usa SU key de Resend (restringidas por dominio)", () => {
    // Las keys de Resend están scope-adas por dominio: la de conversia.cl no envía como
    // tubot.cl. Por eso conversia usa su key propia y tubot la por defecto.
    expect(brandOf({ brand: "conversia" }).resendApiKey).toBe("re_test_conversia");
    expect(brandOf({ brand: "tubot" }).resendApiKey).toBe("re_test_tubot");
  });

  it("marca desconocida → fallback a tubot", () => {
    expect(brandOf({ brand: "otra" }).key).toBe("tubot");
  });
});

describe("brandFromOrigin (marca server-side por Origin, no por el body)", () => {
  it("sin Origin o Origin desconocido → tubot (default seguro)", () => {
    expect(brandFromOrigin(undefined)).toBe("tubot");
    expect(brandFromOrigin("https://app.tubot.cl")).toBe("tubot");
    expect(brandFromOrigin("https://tubot.cl")).toBe("tubot");
    expect(brandFromOrigin("https://evil.example.com")).toBe("tubot");
    // Un dominio que CONTIENE conversia.cl pero no ES la familia → tubot (no sufijos).
    expect(brandFromOrigin("https://evil-conversia.cl.example.com")).toBe("tubot");
  });

  it("FIX prod 2026-10-17: TODA la familia del dominio Conversia da conversia (apex/www/app)", () => {
    // Antes solo el valor exacto de WEB_URL_CONVERSIA: registrarse desde conversia.cl
    // (habilitado por el fix de CORS) creaba la cuenta TUBOT — catálogo de precios,
    // trial y asistente equivocados (reporte de Javier con pantallazo de Cobros).
    expect(brandFromOrigin("https://app.conversia.cl")).toBe("conversia");
    expect(brandFromOrigin("https://conversia.cl")).toBe("conversia");
    expect(brandFromOrigin("https://www.conversia.cl")).toBe("conversia");
    expect(brandFromOrigin("https://App.Conversia.CL/")).toBe("conversia"); // case + barra
  });
});
