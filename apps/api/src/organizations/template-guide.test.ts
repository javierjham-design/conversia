import { describe, expect, it } from "vitest";
import { templateGuideFor } from "./template-guide";

const names = (settings: any) => templateGuideFor(settings).map((t) => t.name);

describe("guía de plantillas por rubro", () => {
  it("siempre incluye bienvenida, reactivación y promoción", () => {
    const n = names({});
    expect(n).toContain("bienvenida");
    expect(n).toContain("reactivacion");
    expect(n).toContain("promocion");
  });

  it("rubro con agenda (salud) → confirmación y recordatorio de cita", () => {
    const n = names({ general: { industry: "salud" } });
    expect(n).toContain("confirmacion_cita");
    expect(n).toContain("recordatorio_cita");
    expect(n).not.toContain("confirmacion_pedido");
  });

  it("vocabulario del rubro cambia el nombre (inmobiliaria → visita)", () => {
    const n = names({ general: { industry: "inmobiliaria" } });
    expect(n).toContain("recordatorio_visita");
  });

  it("rubro sin agenda (comercio) → pedido y despacho, sin cita", () => {
    const n = names({ general: { industry: "comercio" } });
    expect(n).toContain("confirmacion_pedido");
    expect(n).toContain("despacho_en_camino");
    expect(n.some((x) => x.startsWith("recordatorio_"))).toBe(false);
  });

  it("categorías válidas para Meta", () => {
    for (const t of templateGuideFor({ general: { industry: "salud" } })) {
      expect(["MARKETING", "UTILITY", "AUTHENTICATION"]).toContain(t.category);
      expect(t.body.length).toBeGreaterThan(10);
    }
  });
});
