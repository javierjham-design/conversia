import { Injectable, OnModuleDestroy } from "@nestjs/common";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";

/**
 * Rate limiting con ventana fija sobre un store (Redis en prod).
 *
 * Diseño para la arquitectura real: el panel llama a la API a través de un
 * proxy same-origin, por lo que la IP del cliente NO es confiable en la API
 * (todos comparten la IP del proxy y la API es alcanzable directo con XFF
 * spoofeable). Por eso el login se limita por EMAIL (la credencial atacada,
 * no spoofeable) y las rutas autenticadas por USER ID. El límite por IP real
 * corresponde al borde (Cloudflare/WAF) — ver SECURITY_ROADMAP.md.
 */
export interface RateStore {
  /** Incrementa el contador de `key` y devuelve el conteo tras esta ventana. */
  hit(key: string, windowSeconds: number): Promise<number>;
}

export interface RateResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

export class RateLimiter {
  constructor(private store: RateStore) {}

  async check(key: string, max: number, windowSeconds: number): Promise<RateResult> {
    const count = await this.store.hit(key, windowSeconds);
    return { allowed: count <= max, count, retryAfterSeconds: windowSeconds };
  }
}

/** Store en memoria — para tests y como fallback si Redis no está disponible. */
export class MemoryRateStore implements RateStore {
  private buckets = new Map<string, { count: number; expiresAt: number }>();
  constructor(private now: () => number = () => Date.now()) {}

  async hit(key: string, windowSeconds: number): Promise<number> {
    const t = this.now();
    const b = this.buckets.get(key);
    if (!b || b.expiresAt <= t) {
      this.buckets.set(key, { count: 1, expiresAt: t + windowSeconds * 1000 });
      return 1;
    }
    b.count += 1;
    return b.count;
  }
}

/** Store Redis: INCR + EXPIRE atómico (EXPIRE solo en la primera escritura). */
export class RedisRateStore implements RateStore {
  constructor(private redis: IORedis) {}
  async hit(key: string, windowSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, windowSeconds);
    return count;
  }
}

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
  private limiter: RateLimiter;

  constructor() {
    this.redis.on("error", () => undefined); // no romper el request si Redis cae
    void this.redis.connect().catch(() => undefined);
    this.limiter = new RateLimiter(new RedisRateStore(this.redis));
  }

  /**
   * Aplica el límite. Fail-open ante fallo de Redis (prioriza disponibilidad;
   * el borde/WAF es la segunda capa). Devuelve true si se permite.
   */
  private async allow(key: string, max: number, windowSeconds: number): Promise<RateResult> {
    try {
      return await this.limiter.check(key, max, windowSeconds);
    } catch {
      return { allowed: true, count: 0, retryAfterSeconds: 0 };
    }
  }

  async login(email: string): Promise<RateResult> {
    const env = getEnv();
    const key = `rl:login:${email.trim().toLowerCase()}`;
    return this.allow(key, env.LOGIN_MAX_PER_WINDOW, env.LOGIN_WINDOW_SECONDS);
  }

  async register(bucket: string): Promise<RateResult> {
    const env = getEnv();
    return this.allow(`rl:register:${bucket}`, Math.max(env.LOGIN_MAX_PER_WINDOW, 30), env.LOGIN_WINDOW_SECONDS);
  }

  async api(userId: string): Promise<RateResult> {
    const env = getEnv();
    return this.allow(`rl:api:${userId}:${Math.floor(Date.now() / 60000)}`, env.API_MAX_PER_MINUTE, 60);
  }

  async custom(key: string, max: number, windowSeconds: number): Promise<RateResult> {
    return this.allow(key, max, windowSeconds);
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}
