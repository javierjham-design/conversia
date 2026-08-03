import { describe, expect, it } from "vitest";
import { SNIPPET_SEEDS, snippetVisibilityWhere } from "./inbox.controller";

describe("respuestas rápidas", () => {
  it("el ámbito «Solo yo» filtra por el creador (otro usuario no las ve)", () => {
    const whereAna = snippetVisibilityWhere("user-ana");
    const wherePedro = snippetVisibilityWhere("user-pedro");
    expect(whereAna).toEqual({ OR: [{ scope: "team" }, { scope: "mine", createdById: "user-ana" }] });
    // La condición de Pedro jamás matchea una personal de Ana:
    expect(wherePedro.OR[1]).toEqual({ scope: "mine", createdById: "user-pedro" });
  });

  it("los ejemplos sembrados son genéricos y están marcados «edítame»", () => {
    expect(SNIPPET_SEEDS).toHaveLength(5);
    for (const s of SNIPPET_SEEDS) {
      expect(s.body).toContain("edítame");
      expect(/^[a-z0-9_-]+$/.test(s.shortcut)).toBe(true);
      // sin datos de ningún tenant real
      expect(s.body.toLowerCase()).not.toContain("digital");
      expect(s.body.toLowerCase()).not.toContain("dent");
    }
  });
});
