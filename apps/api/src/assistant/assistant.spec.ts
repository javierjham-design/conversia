import { describe, it, expect } from "vitest";
import { assistantMode, isWebOwner } from "./assistant.service";
// Las decisiones de proveedor/modelo se mudaron a assistant-config.ts (configurador del Super
// Admin). Sus tests propios viven en assistant-config.spec.ts; acá quedan los del servicio.
import { modeloDeRespaldoDelAsistente, modeloIgnorado, resolveAssistantModel } from "./assistant-config";

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

  it("resolveAssistantModel: nunca manda un modelo de otra familia al proveedor (hallazgo prod 26-oct)", () => {
    // El caso del bug: provider anthropic + default de config gpt-4o-mini → NO se lo manda a Anthropic.
    expect(resolveAssistantModel("anthropic", "gpt-4o-mini")).toBe("claude-sonnet-4-6");
    // Respeta un modelo de la misma familia.
    expect(resolveAssistantModel("anthropic", "claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveAssistantModel("openai", "gpt-4o")).toBe("gpt-4o");
    // Provider openai con un claude configurado → usa el default openai.
    expect(resolveAssistantModel("openai", "claude-sonnet-4-6")).toBe("gpt-4o-mini");
    // mock: da igual (el MockAIProvider ignora el modelo).
    expect(resolveAssistantModel("mock", "lo-que-sea")).toBe("lo-que-sea");
  });
});

/**
 * HALLAZGO 1-nov: Convi caído con las llaves de IA habilitadas y los bots de los clientes
 * respondiendo normal. La causa no eran las llaves: los bots pasan por `ResilientAIProvider`
 * (3 intentos + modelo de respaldo + timeout) y Convi llamaba al proveedor A PELO. Un 429
 * pasajero, una sobrecarga o —lo peor— un `ASSISTANT_MODEL` que el proveedor ya no sirve
 * dejaban a Convi caído el 100% de las veces, para siempre, sin que nada lo notara.
 *
 * El respaldo tiene que respetar la familia del proveedor o volvemos al bug del 26-oct
 * (mandarle un `claude-*` a OpenAI): `AI_FALLBACK_MODEL` trae `claude-haiku-4-5` por default,
 * así que con AI_PROVIDER=openai hay que traducirlo, no pasarlo tal cual.
 */
describe("modeloDeRespaldoDelAsistente", () => {
  it("con Anthropic usa el haiku de respaldo tal cual", () => {
    expect(modeloDeRespaldoDelAsistente("anthropic", "claude-haiku-4-5", "claude-sonnet-4-6")).toBe("claude-haiku-4-5");
  });

  it("con OpenAI NO le manda el claude de respaldo (bug del 26-oct)", () => {
    expect(modeloDeRespaldoDelAsistente("openai", "claude-haiku-4-5", "gpt-4o")).toBe("gpt-4o-mini");
  });

  it("si el respaldo coincide con el principal, no hay respaldo (reintentar el mismo modelo no es respaldo)", () => {
    expect(modeloDeRespaldoDelAsistente("anthropic", "claude-sonnet-4-6", "claude-sonnet-4-6")).toBeUndefined();
    // El caso real: provider openai, principal ya resuelto a gpt-4o-mini y respaldo claude-*
    // que se traduce al MISMO gpt-4o-mini → no hay a dónde caer, solo reintentos.
    expect(modeloDeRespaldoDelAsistente("openai", "claude-haiku-4-5", "gpt-4o-mini")).toBeUndefined();
  });

  it("sin AI_FALLBACK_MODEL configurado no inventa un respaldo", () => {
    expect(modeloDeRespaldoDelAsistente("anthropic", "", "claude-sonnet-4-6")).toBeUndefined();
  });
});

/**
 * La trampa del 1-nov: el dueño pide "dejalo con gpt-4o-mini" y pone
 * `ASSISTANT_MODEL=gpt-4o-mini`… con `AI_PROVIDER=anthropic`. `resolveAssistantModel` lo
 * REESCRIBE a `claude-sonnet-4-6` —y hace bien, mandarle un gpt a Anthropic da 404— pero lo
 * hacía EN SILENCIO: el dueño queda convencido de que cambió el modelo, nada cambia, y a
 * diagnosticarlo de nuevo desde cero. El guardián no cambia la decisión, solo la hace visible.
 */
describe("modeloIgnorado", () => {
  it("avisa cuando el modelo pedido se reescribe por no ser de la familia del proveedor", () => {
    expect(modeloIgnorado("gpt-4o-mini", "claude-sonnet-4-6")).toBe(true);
    expect(modeloIgnorado("claude-sonnet-4-6", "gpt-4o-mini")).toBe(true);
  });

  it("no avisa cuando el modelo pedido se respeta tal cual", () => {
    expect(modeloIgnorado("claude-opus-4-8", "claude-opus-4-8")).toBe(false);
    expect(modeloIgnorado("gpt-4o", "gpt-4o")).toBe(false);
  });

  it("sin ASSISTANT_MODEL configurado no hay nada que avisar (el default no es una decisión del dueño)", () => {
    expect(modeloIgnorado("", "claude-sonnet-4-6")).toBe(false);
  });
});
