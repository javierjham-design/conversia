import { describe, expect, it } from "vitest";
import { MemoryRateStore, RateLimiter } from "../src/common/rate-limit";

describe("RateLimiter (ventana fija)", () => {
  it("permite hasta el máximo y bloquea después", async () => {
    const limiter = new RateLimiter(new MemoryRateStore());
    let lastAllowed = true;
    for (let i = 0; i < 5; i++) {
      lastAllowed = (await limiter.check("k", 5, 60)).allowed;
      expect(lastAllowed).toBe(true);
    }
    expect((await limiter.check("k", 5, 60)).allowed).toBe(false); // 6º intento
  });

  it("cuenta por clave de forma independiente", async () => {
    const limiter = new RateLimiter(new MemoryRateStore());
    await limiter.check("a@x.cl", 2, 60);
    await limiter.check("a@x.cl", 2, 60);
    expect((await limiter.check("a@x.cl", 2, 60)).allowed).toBe(false);
    expect((await limiter.check("b@x.cl", 2, 60)).allowed).toBe(true); // otra cuenta no afectada
  });

  it("reinicia al vencer la ventana", async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(new MemoryRateStore(() => now));
    await limiter.check("k", 1, 10);
    expect((await limiter.check("k", 1, 10)).allowed).toBe(false);
    now += 11_000; // avanza más allá de la ventana
    expect((await limiter.check("k", 1, 10)).allowed).toBe(true);
  });
});
