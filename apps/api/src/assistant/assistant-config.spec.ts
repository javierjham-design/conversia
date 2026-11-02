import { describe, expect, it } from "vitest";
import {
  ASSISTANT_CONFIG_VACIA,
  configEfectiva,
  modeloDeRespaldoDelAsistente,
  modeloIgnorado,
  parseAssistantConfig,
  proveedoresConLlave,
  resolveAssistantModel,
  type EnvDelAsistente,
} from "./assistant-config";

/**
 * El configurador de Convi en el Super Admin.
 *
 * Contexto: Convi estuvo caído con las llaves cargadas porque su proveedor y su modelo vivían
 * SOLO en variables de entorno del servicio `api`. No se podían ver desde ninguna pantalla ni
 * corregir sin entrar a Railway. Lo que estos tests encierran es que mover esa decisión a la
 * consola no rompa el camino viejo y no abra agujeros nuevos.
 */

const env: EnvDelAsistente = {
  AI_PROVIDER: "anthropic",
  ASSISTANT_MODEL: "",
  AI_DEFAULT_MODEL: "gpt-4o-mini",
  AI_FALLBACK_MODEL: "claude-haiku-4-5",
};

describe("parseAssistantConfig", () => {
  it("sin fila guardada no decide nada (todo cae al entorno)", () => {
    expect(parseAssistantConfig(null)).toEqual(ASSISTANT_CONFIG_VACIA);
    expect(parseAssistantConfig("no soy un objeto")).toEqual(ASSISTANT_CONFIG_VACIA);
    expect(parseAssistantConfig({})).toEqual(ASSISTANT_CONFIG_VACIA);
  });

  it("un proveedor inventado se descarta en vez de dejar a Convi sin proveedor", () => {
    expect(parseAssistantConfig({ provider: "gemini" }).provider).toBeNull();
    expect(parseAssistantConfig({ provider: 42 }).provider).toBeNull();
    expect(parseAssistantConfig({ provider: "openai" }).provider).toBe("openai");
  });

  it("recorta los modelos: un espacio pegado al nombre da 404 en el proveedor", () => {
    expect(parseAssistantConfig({ model: "  gpt-4o-mini  " }).model).toBe("gpt-4o-mini");
    expect(parseAssistantConfig({ fallbackModel: " gpt-4o " }).fallbackModel).toBe("gpt-4o");
  });
});

describe("proveedoresConLlave", () => {
  it("solo ofrece los que tienen llave en ESTE servicio", () => {
    expect(proveedoresConLlave({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "" })).toEqual(["anthropic"]);
    expect(proveedoresConLlave({ ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "sk-oai" })).toEqual(["openai"]);
    expect(proveedoresConLlave({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" })).toEqual(["anthropic", "openai"]);
  });

  it("sin ninguna llave no ofrece nada (elegir ahí es garantizar un 401)", () => {
    expect(proveedoresConLlave({})).toEqual([]);
  });

  it("nunca ofrece mock: Convi contestaría frases de simulación como reales", () => {
    expect(proveedoresConLlave({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-oai" })).not.toContain("mock");
  });
});

describe("configEfectiva", () => {
  it("sin nada guardado se comporta EXACTAMENTE como antes del configurador", () => {
    const c = configEfectiva(ASSISTANT_CONFIG_VACIA, env);
    // AI_DEFAULT_MODEL es gpt-4o-mini y el proveedor es anthropic → el default de la familia.
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-sonnet-4-6");
    expect(c.origen).toEqual({ provider: "entorno", model: "entorno" });
  });

  it("lo elegido en la consola le gana al entorno (poder corregir sin desplegar)", () => {
    const c = configEfectiva({ provider: "openai", model: "gpt-4o-mini", fallbackModel: "gpt-4o" }, env);
    expect(c.provider).toBe("openai");
    expect(c.model).toBe("gpt-4o-mini");
    expect(c.fallbackModel).toBe("gpt-4o");
    expect(c.origen).toEqual({ provider: "consola", model: "consola" });
  });

  it("elegir proveedor sin elegir modelo no manda un modelo de la otra familia", () => {
    // El agujero: AI_DEFAULT_MODEL=gpt-4o-mini quedaría yéndose a Anthropic.
    const c = configEfectiva({ provider: "anthropic", model: "", fallbackModel: "" }, env);
    expect(c.model).toBe("claude-sonnet-4-6");
    expect(c.modelPedido).toBe("gpt-4o-mini");
    expect(modeloIgnorado(c.modelPedido, c.model)).toBe(true);
  });

  it("el respaldo también se fuerza a la familia del proveedor elegido", () => {
    // Consola dice openai; AI_FALLBACK_MODEL del entorno es un claude-*.
    const c = configEfectiva({ provider: "openai", model: "gpt-4o", fallbackModel: "" }, env);
    expect(c.fallbackModel).toBe("gpt-4o-mini");
  });

  it("si el respaldo resuelve al mismo modelo principal, no hay respaldo", () => {
    const c = configEfectiva({ provider: "openai", model: "gpt-4o-mini", fallbackModel: "" }, env);
    expect(c.fallbackModel).toBeUndefined();
  });
});

describe("guardas que ya existían (siguen valiendo tras mover el módulo)", () => {
  it("resolveAssistantModel nunca cruza familias", () => {
    expect(resolveAssistantModel("anthropic", "gpt-4o-mini")).toBe("claude-sonnet-4-6");
    expect(resolveAssistantModel("openai", "claude-sonnet-4-6")).toBe("gpt-4o-mini");
    expect(resolveAssistantModel("anthropic", "claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("modeloDeRespaldoDelAsistente respeta la familia y evita el respaldo falso", () => {
    expect(modeloDeRespaldoDelAsistente("openai", "claude-haiku-4-5", "gpt-4o")).toBe("gpt-4o-mini");
    expect(modeloDeRespaldoDelAsistente("anthropic", "", "claude-sonnet-4-6")).toBeUndefined();
  });
});
