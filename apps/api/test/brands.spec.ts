import { describe, expect, it } from "vitest";
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

  it("marca desconocida → fallback a tubot", () => {
    expect(brandOf({ brand: "otra" }).key).toBe("tubot");
  });
});

describe("brandFromOrigin (marca server-side por Origin, no por el body)", () => {
  it("sin Origin o Origin desconocido → tubot (default seguro)", () => {
    expect(brandFromOrigin(undefined)).toBe("tubot");
    expect(brandFromOrigin("https://app.tubot.cl")).toBe("tubot");
    expect(brandFromOrigin("https://evil.example.com")).toBe("tubot");
  });
  // Nota: el caso conversia depende de WEB_URL_CONVERSIA en el entorno; aquí se valida
  // la regla de default-seguro (un Origin cualquiera NUNCA da conversia).
});
