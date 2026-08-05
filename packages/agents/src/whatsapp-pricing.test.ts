import { describe, expect, it } from "vitest";
import { computeWhatsappCostUsd, WHATSAPP_PRICING } from "./pricing.js";

describe("costo de mensajes de WhatsApp (Meta)", () => {
  it("cobra por categoría según el país", () => {
    expect(computeWhatsappCostUsd("marketing", "CL")).toBe(WHATSAPP_PRICING.CL.marketing);
    expect(computeWhatsappCostUsd("utility", "CL")).toBe(WHATSAPP_PRICING.CL.utility);
    expect(computeWhatsappCostUsd("authentication", "MX")).toBe(WHATSAPP_PRICING.MX.authentication);
  });

  it("servicio (dentro de la ventana de 24 h) es gratis", () => {
    expect(computeWhatsappCostUsd("service", "CL")).toBe(0);
  });

  it("país sin tarifa cargada → fallback default", () => {
    expect(computeWhatsappCostUsd("marketing", "ZZ")).toBe(WHATSAPP_PRICING.default.marketing);
    expect(computeWhatsappCostUsd("marketing", null)).toBe(WHATSAPP_PRICING.default.marketing);
  });

  it("categoría desconocida → 0 (no inventa costo)", () => {
    expect(computeWhatsappCostUsd("otra_cosa", "CL")).toBe(0);
  });

  it("override desde platform_settings manda", () => {
    const overrides = { CL: { marketing: 0.1, utility: 0, authentication: 0, service: 0 } };
    expect(computeWhatsappCostUsd("marketing", "CL", overrides)).toBe(0.1);
  });
});
