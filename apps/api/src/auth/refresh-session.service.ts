import { Injectable, OnModuleDestroy } from "@nestjs/common";
import IORedis from "ioredis";
import { createHash, randomBytes } from "node:crypto";
import { getEnv } from "@conversia/config";

/**
 * SESIÓN DESLIZANTE del cliente (Bloque 3) — refresh tokens en Redis, REVOCABLES y ROTATIVOS.
 *
 * El access token sigue siendo un JWT corto y stateless (lo valida el tenancy.middleware); este
 * servicio guarda aparte un refresh token OPACO de larga vida para que el panel renueve la sesión
 * sin re-login (pensado para el móvil, como WhatsApp/apps bancarias ligeras). Mismo patrón que las
 * sesiones de super admin (PlatformSessionService): clave `csess:<hash>` con TTL propio + un set
 * por usuario para "cerrar todas". El token jamás se guarda en claro: en Redis vive su SHA-256.
 *
 * Fail-closed al RESOLVER (si Redis no responde no podemos probar que el refresh es válido → el
 * usuario cae al re-login del Bloque 1, nunca se concede acceso a ciegas). Fail-open al CREAR/
 * revocar (un corte de Redis no debe tumbar el login; el access token conserva su expiración).
 */
export interface RefreshSessionData {
  userId: string;
  orgId: string;
  createdAt: number;
}

/**
 * Convierte "30d" | "12h" | "45m" | "90s" | "3600" a segundos. Exportada y pura para poder
 * testearla sin Redis. Ante un valor ilegible cae a 30 días (nunca 0 → nunca un TTL inválido).
 */
export function parseDurationSeconds(raw: string | undefined, fallback = 30 * 24 * 3600): number {
  if (!raw) return fallback;
  const s = String(raw).trim();
  const m = /^(\d+)\s*([smhd])?$/i.exec(s);
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  return n * mult;
}

@Injectable()
export class RefreshSessionService implements OnModuleDestroy {
  private redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
  private ttl = parseDurationSeconds(getEnv().JWT_REFRESH_EXPIRES_IN);

  constructor() {
    this.redis.on("error", () => undefined);
    void this.redis.connect().catch(() => undefined);
  }

  /** Genera un refresh token opaco (no es un JWT: no se decodifica, solo se compara su hash). */
  private mint(): string {
    return `rt_${randomBytes(32).toString("base64url")}`;
  }
  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }
  private key(hash: string) {
    return `csess:${hash}`;
  }
  private userKey(userId: string) {
    return `csess:user:${userId}`;
  }

  /** Crea una sesión de refresh y devuelve el token EN CLARO (solo se ve aquí; en Redis va su hash). */
  async create(userId: string, orgId: string): Promise<string> {
    const token = this.mint();
    const h = this.hash(token);
    const data: RefreshSessionData = { userId, orgId, createdAt: Date.now() };
    try {
      await this.redis.set(this.key(h), JSON.stringify(data), "EX", this.ttl);
      await this.redis.sadd(this.userKey(userId), h);
      await this.redis.expire(this.userKey(userId), this.ttl);
    } catch {
      // fail-open: si Redis no está, el login igual sale (el access token tiene su propia expiración);
      // simplemente no habrá sesión deslizante hasta que Redis vuelva.
    }
    return token;
  }

  /** Resuelve un refresh token a su sesión. null = inválido/expirado/revocado (o Redis caído). */
  async resolve(token: string): Promise<RefreshSessionData | null> {
    if (!token || !token.startsWith("rt_")) return null;
    try {
      const raw = await this.redis.get(this.key(this.hash(token)));
      return raw ? (JSON.parse(raw) as RefreshSessionData) : null;
    } catch {
      return null; // fail-closed: no podemos probar validez → se trata como inválido
    }
  }

  /** Revoca un refresh token puntual (logout). Best-effort. */
  async revoke(token: string): Promise<void> {
    if (!token) return;
    try {
      const h = this.hash(token);
      const raw = await this.redis.get(this.key(h));
      await this.redis.del(this.key(h));
      if (raw) {
        const data = JSON.parse(raw) as RefreshSessionData;
        await this.redis.srem(this.userKey(data.userId), h);
      }
    } catch {
      // noop
    }
  }

  /** Cierra TODAS las sesiones deslizantes de un usuario (p. ej. al cambiar la contraseña). */
  async revokeAllForUser(userId: string): Promise<number> {
    try {
      const hashes = await this.redis.smembers(this.userKey(userId));
      if (hashes.length) await this.redis.del(...hashes.map((h) => this.key(h)));
      await this.redis.del(this.userKey(userId));
      return hashes.length;
    } catch {
      return 0;
    }
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}
