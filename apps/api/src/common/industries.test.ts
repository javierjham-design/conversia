import { describe, expect, it } from "vitest";
import { BASE_VOCAB, resolvePersonalization } from "./industries";

describe("personalización por rubro", () => {
  it("sin settings → rubro genérico + vocabulario base", () => {
    const r = resolvePersonalization({});
    expect(r.industry).toBe("generico");
    expect(r.vocabulary.contacts).toBe(BASE_VOCAB.contacts);
    expect(r.modules.agenda).toBe(true);
  });

  it("rubro salud → paciente/tratamiento", () => {
    const r = resolvePersonalization({ general: { industry: "salud" } });
    expect(r.vocabulary.contact).toBe("Paciente");
    expect(r.vocabulary.service).toBe("Tratamiento");
  });

  it("comercio oculta la agenda por defecto", () => {
    const r = resolvePersonalization({ general: { industry: "comercio" } });
    expect(r.modules.agenda).toBe(false);
    expect(r.vocabulary.service).toBe("Producto");
  });

  it("override del tenant manda sobre el default del rubro", () => {
    const r = resolvePersonalization({ general: { industry: "salud" }, vocabulary: { contact: "Cliente" }, modules: { agenda: false } });
    expect(r.vocabulary.contact).toBe("Cliente"); // override
    expect(r.vocabulary.service).toBe("Tratamiento"); // del rubro
    expect(r.modules.agenda).toBe(false); // override
  });

  it("override vacío no borra la etiqueta", () => {
    const r = resolvePersonalization({ general: { industry: "salud" }, vocabulary: { contact: "  " } });
    expect(r.vocabulary.contact).toBe("Paciente");
  });
});
