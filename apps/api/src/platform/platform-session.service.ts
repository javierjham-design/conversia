import { Injectable, OnModuleDestroy } from "@nestjs/common";
import IORedis from "ioredis";
import { randomUUID } from "node:crypto";
import { getEnv } from "@conversia/config";

/**
 * Sesiones de Super Admin en Redis — permiten REVOCAR sesiones (logout remoto,
 * "cerrar todas") sin esperar a que expire el JWT. El `jti` del token apunta a
 * una clave `psess:<jti>`; el guard exige que exista. `reauthAt` habilita el
 * re-auth para acciones críticas. Fail-open ante caída de Redis: el JWT conserva
 * su propia expiración (`SUPER_ADMIN_SESSION_HOURS`), así que un corte de Redis
 * no bloquea al admin, solo suspende temporalmente la revocación.
 */
export interface PlatformSessionData {
  adminId: string;
  createdAt: number;
  reauthAt: number;
}

@Injectable()
export class PlatformSessionService implements OnModuleDestroy {
  private redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
  private ttl = Math.max(1, getEnv().SUPER_ADMIN_SESSION_HOURS) * 3600;

  constructor() {
    this.redis.on("error", () => undefined);
    void this.redis.connect().catch(() => undefined);
  }

  private key(jti: string) {
    return `psess:${jti}`;
  }
  private adminKey(adminId: string) {
    return `psess:admin:${adminId}`;
  }

  /** Crea una sesión y devuelve su jti. El login cuenta como re-auth reciente. */
  async create(adminId: string): Promise<string> {
    const jti = randomUUID();
    const now = Date.now();
    const data: PlatformSessionData = { adminId, createdAt: now, reauthAt: now };
    try {
      await this.redis.set(this.key(jti), JSON.stringify(data), "EX", this.ttl);
      await this.redis.sadd(this.adminKey(adminId), jti);
      await this.redis.expire(this.adminKey(adminId), this.ttl);
    } catch {
      // fail-open: la sesión seguirá siendo válida por firma + exp del JWT
    }
    return jti;
  }

  /** ¿La sesión sigue viva? Fail-open si Redis no responde. */
  async isValid(jti: string): Promise<boolean> {
    if (!jti) return false;
    try {
      return (await this.redis.exists(this.key(jti))) === 1;
    } catch {
      return true;
    }
  }

  async get(jti: string): Promise<PlatformSessionData | null> {
    try {
      const raw = await this.redis.get(this.key(jti));
      return raw ? (JSON.parse(raw) as PlatformSessionData) : null;
    } catch {
      return null;
    }
  }

  /** Marca re-auth reciente (para desbloquear acciones críticas por N minutos). */
  async touchReauth(jti: string): Promise<void> {
    try {
      const raw = await this.redis.get(this.key(jti));
      if (!raw) return;
      const data = JSON.parse(raw) as PlatformSessionData;
      data.reauthAt = Date.now();
      const ttl = await this.redis.ttl(this.key(jti));
      await this.redis.set(this.key(jti), JSON.stringify(data), "EX", ttl > 0 ? ttl : this.ttl);
    } catch {
      // noop
    }
  }

  async revoke(jti: string): Promise<void> {
    try {
      await this.redis.del(this.key(jti));
    } catch {
      // noop
    }
  }

  /** Cierra TODAS las sesiones de un admin (p. ej. tras cambiar credenciales/MFA). */
  async revokeAllForAdmin(adminId: string): Promise<number> {
    try {
      const jtis = await this.redis.smembers(this.adminKey(adminId));
      if (jtis.length) await this.redis.del(...jtis.map((j) => this.key(j)));
      await this.redis.del(this.adminKey(adminId));
      return jtis.length;
    } catch {
      return 0;
    }
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}
