import { describe, expect, it } from "vitest";
import { computeCostUsd, computeCostUsdCached } from "./pricing";

describe("computeCostUsdCached", () => {
  it("cobra la escritura de caché a 1.25× y la lectura a 0.1× del input", () => {
    // Haiku 4.5: input $1/MTok, output $5/MTok.
    const cost = computeCostUsdCached("claude-haiku-4-5", {
      inputTokens: 1_000_000, // pleno
      cacheCreationTokens: 1_000_000, // 1.25×
      cacheReadTokens: 1_000_000, // 0.1×
      outputTokens: 1_000_000, // $5
    });
    // 1*1 + 1*1.25 + 1*0.1 + 1*5 = 7.35
    expect(cost).toBeCloseTo(7.35, 6);
  });

  it("sin caché equivale a computeCostUsd", () => {
    const a = computeCostUsdCached("claude-haiku-4-5", { inputTokens: 500_000, outputTokens: 200_000 });
    const b = computeCostUsd("claude-haiku-4-5", 500_000, 200_000);
    expect(a).toBeCloseTo(b, 9);
  });

  it("la lectura de caché abarata el prompt repetido (playbook largo)", () => {
    // Un playbook de 10k tokens re-enviado: sin caché se paga pleno; cacheado, 0.1×.
    const sinCache = computeCostUsdCached("claude-haiku-4-5", { inputTokens: 10_000, outputTokens: 0 });
    const conCache = computeCostUsdCached("claude-haiku-4-5", { inputTokens: 0, cacheReadTokens: 10_000, outputTokens: 0 });
    expect(conCache).toBeCloseTo(sinCache * 0.1, 9);
  });

  it("modelo desconocido → 0 (no inventa costo)", () => {
    expect(computeCostUsdCached("modelo-inexistente", { inputTokens: 1000, outputTokens: 1000 })).toBe(0);
  });
});
