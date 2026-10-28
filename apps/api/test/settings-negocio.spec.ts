import { describe, it, expect } from "vitest";
import { RUBROS_VALIDOS, businessDataSchema, businessHoursSchema, esRubroValido } from "../src/organizations/business-data";
import { EMPTY_SETUP_FACTS, buildSetupSteps, summarizeSetupChecklist } from "../src/onboarding/setup-checklist";

/**
 * COP 1 — datos del negocio y HORARIO: el paso bloqueante nº1 del montaje.
 *
 * El bloque del horario es la regresión del bug que lo hacía imposible: las expresiones
 * usaban `d{2}` en vez de `\d{2}`, así que un horario de verdad se rechazaba y una cadena
 * literal "dd:dd" se aceptaba. Con el paso exigiendo `businessHours.hours`, el montaje no
 * se podía terminar desde el panel.
 */
describe("PUT /settings/hours — un horario REAL se acepta", () => {
  it("lunes a viernes de 09:00 a 18:00", () => {
    const r = businessHoursSchema.safeParse({
      hours: {
        mon: [{ from: "09:00", to: "18:00" }],
        tue: [{ from: "09:00", to: "18:00" }],
        wed: [{ from: "09:00", to: "18:00" }],
        thu: [{ from: "09:00", to: "18:00" }],
        fri: [{ from: "09:00", to: "18:00" }],
      },
    });
    expect(r.success).toBe(true);
  });

  it("un negocio que cierra a mediodía (dos tramos el mismo día)", () => {
    const r = businessHoursSchema.safeParse({
      hours: { sat: [{ from: "09:00", to: "13:00" }, { from: "15:00", to: "19:00" }] },
    });
    expect(r.success).toBe(true);
  });

  it("un feriado en formato ISO", () => {
    const r = businessHoursSchema.safeParse({ hours: {}, holidays: ["2026-12-25"] });
    expect(r.success).toBe(true);
  });
});

describe("PUT /settings/hours — lo que NO es una hora se rechaza", () => {
  it('"dd:dd" ya no pasa (era lo único que pasaba con el bug)', () => {
    expect(businessHoursSchema.safeParse({ hours: { mon: [{ from: "dd:dd", to: "dd:dd" }] } }).success).toBe(false);
  });

  it("una hora sin ceros ni separador no pasa (el formulario manda HH:MM)", () => {
    expect(businessHoursSchema.safeParse({ hours: { mon: [{ from: "9", to: "18" }] } }).success).toBe(false);
  });

  it("un feriado mal escrito no pasa", () => {
    expect(businessHoursSchema.safeParse({ hours: {}, holidays: ["dddd-dd-dd"] }).success).toBe(false);
    expect(businessHoursSchema.safeParse({ hours: {}, holidays: ["25/12/2026"] }).success).toBe(false);
  });

  it("un día que no es día de la semana no pasa", () => {
    expect(businessHoursSchema.safeParse({ hours: { lunes: [{ from: "09:00", to: "18:00" }] } }).success).toBe(false);
  });

  it("más de 4 tramos en un día no pasa", () => {
    const tramos = ["08", "10", "12", "14", "16"].map((h) => ({ from: `${h}:00`, to: `${h}:30` }));
    expect(businessHoursSchema.safeParse({ hours: { mon: tramos } }).success).toBe(false);
  });
});

describe("PUT /settings/hours — los feriados no se borran por omisión", () => {
  it("si no viene `holidays`, la clave queda AUSENTE (el guardado hace merge)", () => {
    const r = businessHoursSchema.safeParse({ hours: { mon: [{ from: "09:00", to: "18:00" }] } });
    expect(r.success).toBe(true);
    if (r.success) expect("holidays" in r.data).toBe(false);
  });
});

describe("PUT /settings/business — datos del negocio", () => {
  it("acepta guardar un solo campo (no obliga a repetir todo)", () => {
    expect(businessDataSchema.safeParse({ direccion: "Av. Siempre Viva 742" }).success).toBe(true);
  });

  it("el nombre tiene un mínimo: una letra no es el nombre de un negocio", () => {
    expect(businessDataSchema.safeParse({ nombre: "A" }).success).toBe(false);
    expect(businessDataSchema.safeParse({ nombre: "Barbería Central" }).success).toBe(true);
  });

  it("el rubro se valida contra el catálogo, no es texto libre", () => {
    expect(esRubroValido("dental")).toBe(true);
    expect(esRubroValido("lo-que-se-me-ocurra")).toBe(false);
    expect(RUBROS_VALIDOS).toContain("generico");
  });
});

describe("el paso nº1 del montaje se completa con esos cuatro datos", () => {
  it("falta mientras no estén los cuatro", () => {
    const parcial = buildSetupSteps({ ...EMPTY_SETUP_FACTS, hasBusinessName: true, hasIndustry: true, hasAddress: true });
    expect(parcial.find((s) => s.key === "negocio")?.done).toBe(false);
  });

  it("queda hecho con nombre, rubro, dirección y horario", () => {
    const steps = buildSetupSteps({
      ...EMPTY_SETUP_FACTS,
      hasBusinessName: true,
      hasIndustry: true,
      hasAddress: true,
      hasBusinessHours: true,
    });
    expect(steps.find((s) => s.key === "negocio")?.done).toBe(true);
  });

  it("y manda a /ajustes, que es donde ahora SÍ está el formulario", () => {
    const paso = buildSetupSteps(EMPTY_SETUP_FACTS).find((s) => s.key === "negocio");
    expect(paso?.href).toBe("/ajustes");
    expect(paso?.blocking).toBe(true);
  });

  it("es el primer paso pendiente de una cuenta nueva", () => {
    expect(summarizeSetupChecklist(buildSetupSteps(EMPTY_SETUP_FACTS)).nextStep?.key).toBe("negocio");
  });
});
