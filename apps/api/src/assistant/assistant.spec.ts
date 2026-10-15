import { describe, it, expect } from "vitest";
import { assistantMode, isWebOwner } from "./assistant.service";

describe("Asistente Conversia — guardas puras", () => {
  it("modo implementación mientras el checklist no está al 100%", () => {
    expect(assistantMode(0)).toBe("implementacion");
    expect(assistantMode(66)).toBe("implementacion");
    expect(assistantMode(99)).toBe("implementacion");
  });
  it("modo asistencia al completar el checklist", () => {
    expect(assistantMode(100)).toBe("asistencia");
  });
  it("webOwnerContext: solo owner/admin pueden configurar", () => {
    expect(isWebOwner("owner")).toBe(true);
    expect(isWebOwner("admin")).toBe(true);
    expect(isWebOwner("viewer")).toBe(false);
    expect(isWebOwner("support")).toBe(false);
    expect(isWebOwner("operador")).toBe(false);
  });
});
