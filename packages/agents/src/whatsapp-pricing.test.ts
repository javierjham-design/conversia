import { describe, expect, it } from "vitest";
import { computeWhatsappCostUsd, WHATSAPP_PRICING, type WhatsappRateSchedule } from "./pricing.js";

describe("costo de mensajes de WhatsApp (Meta)", () => {
  it("cobra por categoría según el país", () => {
    expect(computeWhatsappCostUsd("marketing", "CL")).toBe(WHATSAPP_PRICING.CL.marketing);
    expect(computeWhatsappCostUsd("utility", "CL")).toBe(WHATSAPP_PRICING.CL.utility);
    expect(computeWhatsappCostUsd("authentication", "MX")).toBe(WHATSAPP_PRICING.MX.authentication);
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

describe("tarifa de servicio por fecha de vigencia (schedule — octubre 2026)", () => {
  // Fechas SIEMPRE inyectadas vía opts.at: jamás el reloj del sistema.
  const schedule: WhatsappRateSchedule = {
    CL: { service: [{ effectiveFrom: "2026-10-01T00:00:00Z", rateUsd: 0.02 }] },
  };

  it("servicio CL un instante antes de la vigencia → 0 (tramo aún no rige, cae a tabla base)", () => {
    const at = new Date("2026-09-30T23:59:59Z");
    expect(computeWhatsappCostUsd("service", "CL", undefined, { at, schedule })).toBe(0);
  });

  it("servicio CL en el límite exacto 2026-10-01T00:00:00Z (INCLUSIVE) → 0.02", () => {
    const at = new Date("2026-10-01T00:00:00Z");
    expect(computeWhatsappCostUsd("service", "CL", undefined, { at, schedule })).toBe(0.02);
  });

  it("servicio CL sin schedule, solo override plano service: 0.02 → 0.02 (el override no tiene fecha)", () => {
    const overrides = { CL: { marketing: 0, utility: 0, authentication: 0, service: 0.02 } };
    // producción usará schedule justamente porque el override plano no distingue fecha.
    expect(computeWhatsappCostUsd("service", "CL", overrides)).toBe(0.02);
  });

  it("país sin entrada en el schedule → cae a override plano → tabla base", () => {
    const at = new Date("2026-10-01T00:00:00Z");
    // AR no está en el schedule (solo CL) → ignora schedule.
    expect(computeWhatsappCostUsd("service", "AR", undefined, { at, schedule })).toBe(
      WHATSAPP_PRICING.AR.service, // 0 en la tabla base
    );
    const overrides = { AR: { marketing: 0, utility: 0, authentication: 0, service: 0.05 } };
    expect(computeWhatsappCostUsd("service", "AR", overrides, { at, schedule })).toBe(0.05);
  });

  it("schedule con dos tramos → gana el más reciente vigente", () => {
    const twoTiers: WhatsappRateSchedule = {
      CL: {
        service: [
          { effectiveFrom: "2026-10-01T00:00:00Z", rateUsd: 0.02 },
          { effectiveFrom: "2027-01-01T00:00:00Z", rateUsd: 0.03 },
        ],
      },
    };
    expect(computeWhatsappCostUsd("service", "CL", undefined, { at: new Date("2026-12-31T23:59:59Z"), schedule: twoTiers })).toBe(0.02);
    expect(computeWhatsappCostUsd("service", "CL", undefined, { at: new Date("2027-01-01T00:00:00Z"), schedule: twoTiers })).toBe(0.03);
  });

  it("categoría desconocida → 0 aun con schedule (no inventa costo)", () => {
    const at = new Date("2026-10-01T00:00:00Z");
    expect(computeWhatsappCostUsd("otra_cosa", "CL", undefined, { at, schedule })).toBe(0);
  });

  it("marketing con schedule de servicio → el schedule no aplica, usa tabla base", () => {
    const at = new Date("2026-10-01T00:00:00Z");
    expect(computeWhatsappCostUsd("marketing", "CL", undefined, { at, schedule })).toBe(WHATSAPP_PRICING.CL.marketing);
  });
});
