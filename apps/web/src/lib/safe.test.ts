import { describe, it, expect } from "vitest";
import { money, expandPerms, withStringDefaults } from "./safe";

// Fixtures DELIBERADAMENTE incompletas: tenant nuevo, registros con null.
// Estos casos rompían las pantallas de Plan y facturación, Usuarios y
// Configuración general (pantalla en blanco) antes de blindarlos.

describe("money — planes con importe ausente", () => {
  it("un plan 'a medida' (Enterprise) tiene importe nulo y no revienta", () => {
    expect(money(null, "CLP")).toBe("A medida");
    expect(money(undefined, "USD")).toBe("A medida");
  });
  it("formatea CLP y USD cuando hay importe", () => {
    expect(money(29990, "CLP")).toContain("CLP");
    expect(money(39, "USD")).toContain("US$");
  });
});

describe("expandPerms — rol recién creado / catálogo ausente", () => {
  const catalog = [
    { module: "inbox", actions: [{ key: "inbox:read" }, { key: "inbox:write" }] },
    { module: "contacts", actions: [{ key: "contacts:read" }] },
  ];

  it("no revienta con permisos null", () => {
    expect(expandPerms(null, catalog)).toEqual([]);
  });
  it("no revienta con catálogo null", () => {
    expect(expandPerms(["*"], null)).toEqual([]);
  });
  it("tolera un módulo sin acciones (actions null)", () => {
    const cat = [{ module: "x", actions: null as unknown as { key: string }[] }];
    expect(expandPerms(["*"], cat)).toEqual([]);
  });
  it("expande el comodín total '*'", () => {
    expect(expandPerms(["*"], catalog).sort()).toEqual(["contacts:read", "inbox:read", "inbox:write"]);
  });
  it("expande el comodín por módulo 'inbox:*'", () => {
    expect(expandPerms(["inbox:*"], catalog).sort()).toEqual(["inbox:read", "inbox:write"]);
  });
  it("conserva permisos concretos", () => {
    expect(expandPerms(["contacts:read"], catalog)).toEqual(["contacts:read"]);
  });
});

describe("withStringDefaults — ajustes de tenant sin configurar", () => {
  const defaults = { name: "", slug: "", website: "", industry: "" };

  it("rellena con '' los campos ausentes (objeto vacío)", () => {
    const out = withStringDefaults(defaults, {});
    expect(out).toEqual(defaults);
    expect(out.name.trim()).toBe(""); // no revienta .trim()
  });
  it("descarta valores null/undefined y mantiene los presentes", () => {
    const out = withStringDefaults(defaults, { name: "Digital Dent", website: null, industry: undefined });
    expect(out.name).toBe("Digital Dent");
    expect(out.website).toBe("");
    expect(out.industry).toBe("");
  });
  it("tolera data null/undefined", () => {
    expect(withStringDefaults(defaults, null)).toEqual(defaults);
    expect(withStringDefaults(defaults, undefined)).toEqual(defaults);
  });
});
