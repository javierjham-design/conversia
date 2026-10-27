import { Injectable, OnModuleDestroy, Optional } from "@nestjs/common";
import IORedis from "ioredis";
import { getEnv } from "@conversia/config";

/**
 * Rate limiting con ventana fija sobre un store (Redis en prod).
 *
 * Diseño para la arquitectura real: el panel llama a la API a través de un
 * proxy same-origin. El login se limita por EMAIL (la credencial atacada, no
 * spoofeable) y las rutas autenticadas por USER ID.
 *
 * §3.8 — además hay límite por IP en el login. Antes se descartó porque la IP "no era
 * confiable": lo era la cabecera leída a mano, no `req.ip`, que Express deriva con
 * `trust proxy` y no se puede falsificar desde afuera (ver `clientIp` en
 * auth.controller.ts). El borde (Cloudflare/WAF) sigue siendo la capa de volumen.
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
  /** Tope de llaves vivas antes de barrer las vencidas (evita crecer sin límite). */
  private static readonly PRUNE_AT = 10_000;
  constructor(private now: () => number = () => Date.now()) {}

  async hit(key: string, windowSeconds: number): Promise<number> {
    const t = this.now();
    // Sin TTL propio (a diferencia de Redis) las llaves quedarían para siempre: como
    // fallback de login se llena con una entrada por email/IP atacada. Se barre lo
    // vencido cuando el mapa crece, no en cada golpe.
    if (this.buckets.size >= MemoryRateStore.PRUNE_AT) {
      for (const [k, v] of this.buckets) if (v.expiresAt <= t) this.buckets.delete(k);
    }
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
  /**
   * §3.8 — respaldo EN MEMORIA solo para las rutas de credenciales (login, 2.º factor,
   * refresh). Los demás límites son fail-open a propósito (disponibilidad por sobre
   * precisión), pero dejar el login SIN límite justo cuando Redis se cae es la ventana
   * que aprovecha un ataque de fuerza bruta. El contador en memoria es por instancia,
   * no global, así que es más laxo que el de Redis: alcanza para frenar el abuso.
   */
  private fallback: RateLimiter;

  /**
   * Los limitadores se pueden inyectar en tests (sin Redis real). En prod se omiten.
   *
   * `@Optional()` NO es decorativo: con `emitDecoratorMetadata`, TypeScript emite
   * `design:paramtypes = [RateLimiter, RateLimiter]` aunque los parámetros sean
   * opcionales en TS. Sin `@Optional()`, Nest busca un provider `RateLimiter`, no lo
   * encuentra y el proceso MUERE al arrancar con `UnknownDependenciesException`
   * (pasó: el contenedor del api no levantaba y el único rastro estaba en sus logs,
   * que el CI no guardaba). Con `@Optional()` inyecta `undefined` y se usan los de
   * siempre.
   */
  constructor(
    @Optional() limiter?: RateLimiter,
    @Optional() fallback?: RateLimiter,
  ) {
    this.fallback = fallback ?? new RateLimiter(new MemoryRateStore());
    if (limiter) {
      this.limiter = limiter;
      return;
    }
    this.redis.on("error", () => undefined); // no romper el request si Redis cae
    void this.redis.connect().catch(() => undefined);
    this.limiter = new RateLimiter(new RedisRateStore(this.redis));
  }

  /**
   * Aplica el límite. Ante fallo de Redis: fail-open por defecto (el borde/WAF es la
   * segunda capa) o, con `guardCredentials`, cae al contador en memoria.
   */
  private async allow(key: string, max: number, windowSeconds: number, guardCredentials = false): Promise<RateResult> {
    try {
      return await this.limiter.check(key, max, windowSeconds);
    } catch {
      if (!guardCredentials) return { allowed: true, count: 0, retryAfterSeconds: 0 };
      try {
        return await this.fallback.check(key, max, windowSeconds);
      } catch {
        return { allowed: true, count: 0, retryAfterSeconds: 0 };
      }
    }
  }

  /** Límite por CREDENCIAL (email, o `mfa:<userId>` / `refresh:<token>`). */
  async login(email: string): Promise<RateResult> {
    const env = getEnv();
    const key = `rl:login:${email.trim().toLowerCase()}`;
    return this.allow(key, env.LOGIN_MAX_PER_WINDOW, env.LOGIN_WINDOW_SECONDS, true);
  }

  /**
   * §3.8 — límite por IP REAL en el login, además del límite por email. El límite por
   * email no frena el "password spraying": una contraseña común probada contra miles de
   * correos distintos nunca golpea dos veces la misma llave. Es más laxo (×5) porque
   * detrás de una oficina o un NAT hay muchos usuarios legítimos compartiendo IP.
   */
  async loginByIp(ip: string): Promise<RateResult> {
    const env = getEnv();
    return this.allow(`rl:login:ip:${ip}`, env.LOGIN_MAX_PER_WINDOW * 5, env.LOGIN_WINDOW_SECONDS, true);
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
