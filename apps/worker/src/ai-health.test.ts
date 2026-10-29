import { describe, expect, it, vi } from "vitest";
import { expectedProviderFor, observeTurnModel, type ObserveDeps } from "./ai-health";
import { aiDegradedRedisKey } from "@conversia/types";

/**
 * Regresión del incidente Digital-Dent (~24-oct): murió OPENAI_API_KEY, el router
 * respondió gpt-* con Haiku durante ~5 días y nadie se enteró. Esta vigilancia marca la
 * degradación en Redis (→ /health/status 503 → alerta) con dedup por incidente, y la
 * limpia cuando el proveedor vuelve.
 */

/** Redis en memoria mínimo: soporta get/set (con EX/NX) y del, como lo usa el módulo. */
function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, ..._args: unknown[]) => {
      const nx = _args.includes("NX");
      if (nx && store.has(k)) return null;
      store.set(k, v);
      return "OK";
    }),
    del: vi.fn(async (k: string) => (store.delete(k) ? 1 : 0)),
  };
}

function deps(redis: ReturnType<typeof fakeRedis>) {
  const record = vi.fn(async () => {});
  const d: ObserveDeps = { redis: redis as any, record, enabled: true };
  return { d, record };
}

describe("expectedProviderFor", () => {
  it("rutea gpt-*/o1/chatgpt/embeddings a openai y claude-* a anthropic (igual que el router)", () => {
    expect(expectedProviderFor("gpt-4o-mini")).toBe("openai");
    expect(expectedProviderFor("gpt-4o")).toBe("openai");
    expect(expectedProviderFor("o1-mini")).toBe("openai");
    expect(expectedProviderFor("text-embedding-3-small")).toBe("openai");
    expect(expectedProviderFor("claude-haiku-4-5")).toBe("anthropic");
    expect(expectedProviderFor("claude-opus-4-8")).toBe("anthropic");
    expect(expectedProviderFor("modelo-raro")).toBeNull();
  });
});

describe("observeTurnModel", () => {
  const degradedTurn = {
    organizationId: "org1",
    configuredModel: "gpt-4o-mini",
    respondedModel: "claude-haiku-4-5",
    respondedProvider: "anthropic",
  };
  const healthyTurn = {
    organizationId: "org1",
    configuredModel: "gpt-4o-mini",
    respondedModel: "gpt-4o-mini",
    respondedProvider: "openai",
  };

  it("configurado=gpt-* pero respondió anthropic → marca Redis y alerta UNA vez (dedup)", async () => {
    const redis = fakeRedis();
    const { d, record } = deps(redis);

    await observeTurnModel(degradedTurn, d);
    expect(redis.store.get(aiDegradedRedisKey("openai"))).toBeTruthy();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("org1", "error", "ai.openai_down", expect.any(String), expect.any(Object));

    // Segundo turno degradado idéntico: NO vuelve a alertar (solo refresca la marca).
    await observeTurnModel(degradedTurn, d);
    expect(record).toHaveBeenCalledTimes(1);
    expect(redis.store.get(aiDegradedRedisKey("openai"))).toBeTruthy();
  });

  it("tras degradarse, un turno sano con openai limpia la marca y avisa del restablecimiento", async () => {
    const redis = fakeRedis();
    const { d, record } = deps(redis);

    await observeTurnModel(degradedTurn, d); // degrada
    record.mockClear();

    await observeTurnModel(healthyTurn, d); // OpenAI volvió
    expect(redis.store.has(aiDegradedRedisKey("openai"))).toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith("org1", "ok", "ai.openai_restored", expect.any(String), expect.any(Object));

    // Ya sano: siguientes turnos no avisan nada.
    record.mockClear();
    await observeTurnModel(healthyTurn, d);
    expect(record).not.toHaveBeenCalled();
  });

  it("turno sano desde el principio: ni marca ni aviso", async () => {
    const redis = fakeRedis();
    const { d, record } = deps(redis);
    await observeTurnModel(healthyTurn, d);
    expect(redis.store.size).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  it("sin llaves (responde el Mock) con un modelo gpt-* configurado → degradado", async () => {
    const redis = fakeRedis();
    const { d, record } = deps(redis);
    await observeTurnModel({ ...degradedTurn, respondedModel: undefined, respondedProvider: "mock" }, d);
    expect(redis.store.get(aiDegradedRedisKey("openai"))).toBeTruthy();
    expect(record).toHaveBeenCalledWith("org1", "error", "ai.openai_down", expect.any(String), expect.any(Object));
  });

  it("un agente en claude-* no se marca cuando responde anthropic (sano)", async () => {
    const redis = fakeRedis();
    const { d, record } = deps(redis);
    await observeTurnModel(
      { organizationId: "org1", configuredModel: "claude-haiku-4-5", respondedModel: "claude-haiku-4-5", respondedProvider: "anthropic" },
      d,
    );
    expect(redis.store.size).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });

  it("proveedor no concluyente (router/undefined) o deshabilitado: no hace nada", async () => {
    const redis = fakeRedis();
    const { d, record } = deps(redis);
    await observeTurnModel({ ...degradedTurn, respondedProvider: "router" }, d);
    await observeTurnModel({ ...degradedTurn, respondedProvider: undefined }, d);
    await observeTurnModel(degradedTurn, { ...d, enabled: false });
    expect(redis.store.size).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });
});
