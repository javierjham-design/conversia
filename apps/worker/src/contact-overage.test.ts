import { describe, expect, it } from "vitest";
import { computeContactOverage, applyOverageBillable, OVERAGE_KIND } from "./contact-overage";

describe("computeContactOverage", () => {
  const base = { packSize: 100, packPrice: 14900 };

  it("no cobra si está dentro del cupo", () => {
    expect(computeContactOverage({ ...base, contactsInPeriod: 700, cupo: 750 })).toBeNull();
    expect(computeContactOverage({ ...base, contactsInPeriod: 750, cupo: 750 })).toBeNull();
  });

  it("cobra 1 pack apenas se pasa (redondea hacia arriba)", () => {
    expect(computeContactOverage({ ...base, contactsInPeriod: 751, cupo: 750 })).toEqual({ packs: 1, amount: 14900 });
    expect(computeContactOverage({ ...base, contactsInPeriod: 850, cupo: 750 })).toEqual({ packs: 1, amount: 14900 });
  });

  it("cobra 2 packs al pasar 100 de excedente", () => {
    expect(computeContactOverage({ ...base, contactsInPeriod: 851, cupo: 750 })).toEqual({ packs: 2, amount: 29800 });
  });

  it("cupo 0/negativo = ilimitado → sin excedente", () => {
    expect(computeContactOverage({ ...base, contactsInPeriod: 5000, cupo: 0 })).toBeNull();
  });

  it("sin precio de pack configurado → no cobra (no inventa)", () => {
    expect(computeContactOverage({ contactsInPeriod: 2000, cupo: 750, packSize: 100, packPrice: 0 })).toBeNull();
  });
});

describe("applyOverageBillable", () => {
  it("agrega el billable de excedente preservando los manuales", () => {
    const settings = { billables: [{ concept: "Ajuste manual", amount: 5000 }] };
    const out = applyOverageBillable(settings, { packs: 2, amount: 29800 }, "Excedente x2");
    const billables = (out.billables as any[]);
    expect(billables).toHaveLength(2);
    expect(billables.find((b) => b.concept === "Ajuste manual")).toBeTruthy();
    expect(billables.find((b) => b.kind === OVERAGE_KIND)).toMatchObject({ amount: 29800 });
  });

  it("es idempotente: reemplaza el excedente previo, no lo duplica", () => {
    let settings: Record<string, unknown> = { billables: [] };
    settings = applyOverageBillable(settings, { packs: 1, amount: 14900 }, "Excedente x1");
    settings = applyOverageBillable(settings, { packs: 3, amount: 44700 }, "Excedente x3");
    const billables = settings.billables as any[];
    expect(billables.filter((b) => b.kind === OVERAGE_KIND)).toHaveLength(1);
    expect(billables[0].amount).toBe(44700);
  });

  it("limpia el excedente cuando ya no hay (nuevo período)", () => {
    let settings: Record<string, unknown> = { billables: [{ concept: "Excedente x2", amount: 29800, kind: OVERAGE_KIND }] };
    settings = applyOverageBillable(settings, null, "");
    expect((settings.billables as any[]).filter((b) => b.kind === OVERAGE_KIND)).toHaveLength(0);
  });
});
