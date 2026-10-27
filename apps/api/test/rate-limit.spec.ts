import { describe, expect, it } from "vitest";
import { MemoryRateStore, RateLimiter, RateLimitService, type RateStore } from "../src/common/rate-limit";

/** Store que simula Redis caído: toda escritura revienta. */
class StoreCaido implements RateStore {
  async hit(): Promise<number> {
    throw new Error("Redis no disponible");
  }
}

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

  it("MemoryRateStore no crece sin tope: barre las llaves vencidas", async () => {
    let now = 1_000_000;
    const store = new MemoryRateStore(() => now);
    for (let i = 0; i < 10_000; i++) await store.hit(`k${i}`, 10);
    now += 11_000; // todas vencidas
    // El golpe 10.001 dispara el barrido: la llave nueva queda, las viejas se van.
    await store.hit("nueva", 10);
    expect((store as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(1);
  });
});

/** Limitador espía: registra con qué llave y qué tope lo llamaron, y limita de verdad. */
class LimiterEspia extends RateLimiter {
  llamadas: Array<{ key: string; max: number; windowSeconds: number }> = [];
  constructor() {
    super(new MemoryRateStore());
  }
  async check(key: string, max: number, windowSeconds: number) {
    this.llamadas.push({ key, max, windowSeconds });
    return super.check(key, max, windowSeconds);
  }
}

/**
 * §3.8 — con Redis caído, el login NO queda sin límite: esa es justo la ventana que
 * aprovecha un ataque de fuerza bruta. Los demás límites siguen siendo fail-open a
 * propósito (disponibilidad por sobre precisión).
 *
 * Los topes se leen del entorno (LOGIN_MAX_PER_WINDOW), así que los tests NO los
 * suponen: se observan en el espía. Así no dependen del `.env` de la máquina.
 */
describe("§3.8 — respaldo en memoria para credenciales", () => {
  const caido = () => {
    const espia = new LimiterEspia();
    return { svc: new RateLimitService(new RateLimiter(new StoreCaido()), espia), espia };
  };

  it("el login cae al respaldo en memoria (no queda sin límite)", async () => {
    const { svc, espia } = caido();
    await svc.login("victima@x.cl");
    expect(espia.llamadas.map((l) => l.key)).toEqual(["rl:login:victima@x.cl"]);
  });

  it("y el respaldo BLOQUEA al pasar el tope", async () => {
    // Tope explícito (3) en vez del del entorno: el `.env` de desarrollo puede tener el
    // límite prácticamente apagado y el test quedaría dando vueltas un millón de veces.
    const { svc } = caido();
    const allow = (svc as unknown as { allow: (k: string, max: number, w: number, g?: boolean) => Promise<{ allowed: boolean }> }).allow.bind(svc);
    expect((await allow("rl:login:v@x.cl", 3, 60, true)).allowed).toBe(true);
    expect((await allow("rl:login:v@x.cl", 3, 60, true)).allowed).toBe(true);
    expect((await allow("rl:login:v@x.cl", 3, 60, true)).allowed).toBe(true);
    expect((await allow("rl:login:v@x.cl", 3, 60, true)).allowed).toBe(false); // 4.º intento
  });

  it("sin el guardia de credenciales, el mismo fallo de Redis deja pasar todo", async () => {
    const { svc } = caido();
    const allow = (svc as unknown as { allow: (k: string, max: number, w: number, g?: boolean) => Promise<{ allowed: boolean }> }).allow.bind(svc);
    for (let i = 0; i < 10; i++) expect((await allow("rl:otro:x", 3, 60)).allowed).toBe(true);
  });

  it("el 2.º factor y el refresh usan la misma puerta (`login`), así que también quedan cubiertos", async () => {
    const { svc, espia } = caido();
    await svc.login("mfa:u1");
    await svc.login("refresh:abc");
    expect(espia.llamadas.map((l) => l.key)).toEqual(["rl:login:mfa:u1", "rl:login:refresh:abc"]);
  });

  it("el límite por IP también cae al respaldo", async () => {
    const { svc, espia } = caido();
    await svc.loginByIp("10.0.0.1");
    expect(espia.llamadas[0].key).toBe("rl:login:ip:10.0.0.1");
  });

  it("el tope por IP es 5× el tope por email (oficinas y NAT comparten IP)", async () => {
    const { svc, espia } = caido();
    await svc.login("a@x.cl");
    await svc.loginByIp("10.0.0.2");
    const [porEmail, porIp] = espia.llamadas;
    expect(porIp.max).toBe(porEmail.max * 5);
  });

  it("IPs distintas no se contaminan entre sí", async () => {
    const { svc } = caido();
    const allow = (svc as unknown as { allow: (k: string, max: number, w: number, g?: boolean) => Promise<{ allowed: boolean }> }).allow.bind(svc);
    await allow("rl:login:ip:10.0.0.3", 1, 60, true);
    expect((await allow("rl:login:ip:10.0.0.3", 1, 60, true)).allowed).toBe(false); // agotada
    expect((await allow("rl:login:ip:10.0.0.4", 1, 60, true)).allowed).toBe(true); // otra IP, intacta
  });

  it("los límites NO de credenciales siguen fail-open: no tocan el respaldo", async () => {
    const { svc, espia } = caido();
    expect((await svc.api("u1")).allowed).toBe(true);
    expect((await svc.register("10.0.0.5")).allowed).toBe(true);
    expect(espia.llamadas).toEqual([]);
  });
});
