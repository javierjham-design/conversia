import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateInstallGate } from "../src/organizations/vertical.service";

const CATALOG = JSON.parse(
  readFileSync(join(__dirname, "../../../packages/database/seeds/vertical-templates.json"), "utf-8"),
) as Array<{ key: string; wave: number; status: string; variant: string; requiresFeature: string[] }>;

const none = new Set<string>();

describe("evaluateInstallGate (gates del catálogo de rubros)", () => {
  it("registro público: solo ola 1 active", () => {
    expect(evaluateInstallGate({ status: "active", wave: 1, requiresFeature: [] }, "registration", none).ok).toBe(true);
    expect(evaluateInstallGate({ status: "active", wave: 2, requiresFeature: [] }, "registration", none).ok).toBe(false);
    expect(evaluateInstallGate({ status: "beta", wave: 3, requiresFeature: [] }, "registration", none).ok).toBe(false);
  });

  it("tenant: cualquier active, nunca beta", () => {
    expect(evaluateInstallGate({ status: "active", wave: 2, requiresFeature: [] }, "tenant", none).ok).toBe(true);
    expect(evaluateInstallGate({ status: "beta", wave: 3, requiresFeature: [] }, "tenant", none).ok).toBe(false);
  });

  it("plataforma (equipo): puede instalar beta", () => {
    expect(evaluateInstallGate({ status: "beta", wave: 3, requiresFeature: [] }, "platform", none).ok).toBe(true);
  });

  it("requiresFeature bloquea a TODOS hasta que exista la feature", () => {
    for (const source of ["registration", "tenant", "platform"] as const) {
      expect(evaluateInstallGate({ status: "active", wave: 2, requiresFeature: ["groupClasses"] }, source, none).ok).toBe(false);
    }
    // Con la feature disponible, pasa (salvo otros gates).
    expect(evaluateInstallGate({ status: "active", wave: 1, requiresFeature: ["groupClasses"] }, "registration", new Set(["groupClasses"])).ok).toBe(true);
  });
});

describe("Catálogo de rubros (vertical-templates.json)", () => {
  it("cubre las 6 variantes de producto", () => {
    const variants = new Set(CATALOG.map((t) => t.variant));
    for (const v of ["citas", "leads", "mesas", "intake", "estadias", "pedidos"]) {
      expect(variants.has(v)).toBe(true);
    }
  });

  it("todas las plantillas beta son de ola 3 (no instalables en registro)", () => {
    for (const t of CATALOG.filter((t) => t.status === "beta")) {
      expect(t.wave).toBe(3);
      expect(evaluateInstallGate(t, "registration", none).ok).toBe(false);
    }
  });

  it("gimnasio está sembrado pero bloqueado por groupClasses (no activable aún)", () => {
    const gym = CATALOG.find((t) => t.key === "gimnasio");
    expect(gym).toBeTruthy();
    expect(gym!.requiresFeature).toContain("groupClasses");
    expect(evaluateInstallGate(gym!, "platform", none).ok).toBe(false);
  });

  it("instalar un vertical de CADA variante: el gate correcto lo permite", () => {
    for (const variant of ["citas", "leads", "mesas", "intake", "estadias", "pedidos"]) {
      const tpl = CATALOG.find((t) => t.variant === variant)!;
      // El origen adecuado (registro para ola1 active; plataforma para el resto/beta) lo permite.
      const source = tpl.status === "active" && tpl.wave === 1 ? "registration" : "platform";
      const r = evaluateInstallGate(tpl, source as "registration" | "platform", tpl.requiresFeature?.length ? new Set(tpl.requiresFeature) : none);
      expect(r.ok).toBe(true);
    }
  });
});
