import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { row: null as unknown };

vi.mock("@conversia/database", () => ({
  getAdminPrisma: () => ({
    platformSetting: { findUnique: async () => state.row },
  }),
}));

import { mergeAgentTextParts, readMaxAgentMessagesPerTurn } from "./agent-turn-guard";

beforeEach(() => {
  state.row = null;
});

describe("mergeAgentTextParts (una respuesta por turno)", () => {
  it("fusiona varias partes en un solo texto, separadas por salto de línea", () => {
    expect(mergeAgentTextParts(["Hola", "¿En qué te ayudo?"])).toBe("Hola\n¿En qué te ayudo?");
  });

  it("descarta partes vacías o en blanco", () => {
    expect(mergeAgentTextParts(["Hola", "", "   ", null, undefined, "chao"])).toBe("Hola\nchao");
  });

  it("una sola parte queda igual (caso normal del motor)", () => {
    expect(mergeAgentTextParts(["respuesta única"])).toBe("respuesta única");
  });
});

describe("readMaxAgentMessagesPerTurn (tope configurable)", () => {
  it("default 1 sin setting", async () => {
    state.row = null;
    expect(await readMaxAgentMessagesPerTurn()).toBe(1);
  });
});
