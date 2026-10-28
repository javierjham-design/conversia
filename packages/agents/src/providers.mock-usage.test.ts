import { describe, expect, it } from "vitest";
import { createAIProvider } from "./providers";

/**
 * El proveedor MOCK tiene que informar TOKENS, no cero.
 *
 * Es la única IA que corre en el simulador y en los e2e "como el dueño". Con cero tokens, la
 * fórmula de Créditos IA no cobra el turno —y hace bien: un turno sin tokens es un proveedor
 * caído, y nuestras caídas no se le cobran al cliente— pero el efecto colateral era que
 * TODO el camino del dinero quedaba invisible justo en la prueba que recorre el producto
 * como lo recorre el dueño: ni un crédito debitado, ni un asiento en el libro, ni un
 * medidor con datos propios, ni un aviso de saldo. El ensayo del go-live lo encontró: el bot
 * respondía dos veces y el saldo seguía intacto.
 *
 * El COSTO sí queda en cero: el mock no gasta dinero y fingir que sí haría mentir al
 * reporte de margen del simulador.
 */
describe("proveedor mock — informa tokens", () => {
  const mock = createAIProvider({ provider: "mock", apiKey: "", defaultModel: "gpt-4o-mini" });

  it("un turno normal informa tokens de entrada y de salida", async () => {
    const r = await mock.chat({
      model: "gpt-4o-mini",
      system: "Eres el asistente de una barbería.",
      messages: [{ role: "user", content: "hola, ¿a qué hora abren?" }],
    });
    expect(r.usage.inputTokens).toBeGreaterThan(0);
    expect(r.usage.outputTokens).toBeGreaterThan(0);
    expect(r.usage.costUsd).toBe(0); // el mock no gasta plata
  });

  it("un prompt más largo informa más tokens de entrada", async () => {
    const base = { model: "gpt-4o-mini", messages: [{ role: "user" as const, content: "hola" }] };
    const corto = await mock.chat({ ...base, system: "Corto." });
    const largo = await mock.chat({ ...base, system: "Largo. ".repeat(500) });
    expect(largo.usage.inputTokens).toBeGreaterThan(corto.usage.inputTokens);
  });

  it("con esos tokens la fórmula de créditos SÍ cobra el turno", async () => {
    const { creditsForTurn } = await import("./credit-formula");
    const r = await mock.chat({
      model: "gpt-4o-mini",
      system: "Eres el asistente.",
      messages: [{ role: "user", content: "hola" }],
    });
    const tokens = r.usage.inputTokens + r.usage.outputTokens;
    expect(creditsForTurn({ model: "gpt-4o-mini", tokens }).credits).toBeGreaterThan(0);
  });
});
