import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCustomSignature } from "./index";

// El contrato estándar de agenda firma cada petición: el sistema del tenant
// debe poder recomputar la MISMA firma para aceptarla (y rechazar el resto).

describe("firma HMAC del contrato de agenda", () => {
  const secret = "secreto-de-prueba-123";

  it("la firma es determinista y verificable por el receptor", () => {
    const sig = buildCustomSignature(secret, "1785600000", "GET", "/professionals", "");
    const expected =
      "sha256=" + createHmac("sha256", secret).update("1785600000.GET./professionals.").digest("hex");
    expect(sig).toBe(expected);
  });

  it("cambiar cualquier parte (método, ruta, cuerpo, timestamp) invalida la firma", () => {
    const base = buildCustomSignature(secret, "1785600000", "POST", "/appointments", '{"a":1}');
    expect(buildCustomSignature(secret, "1785600001", "POST", "/appointments", '{"a":1}')).not.toBe(base);
    expect(buildCustomSignature(secret, "1785600000", "GET", "/appointments", '{"a":1}')).not.toBe(base);
    expect(buildCustomSignature(secret, "1785600000", "POST", "/appointments/x", '{"a":1}')).not.toBe(base);
    expect(buildCustomSignature(secret, "1785600000", "POST", "/appointments", '{"a":2}')).not.toBe(base);
  });

  it("un secreto distinto produce una firma distinta (firma inválida)", () => {
    const a = buildCustomSignature(secret, "1785600000", "GET", "/services", "");
    const b = buildCustomSignature("otro-secreto", "1785600000", "GET", "/services", "");
    expect(a).not.toBe(b);
  });
});
