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
  /**
   * TECHO ABSOLUTO (ms epoch): cuándo muere esta sesión pase lo que pase. Se fija en el LOGIN y
   * viaja intacto por cada rotación — por eso está en el dato guardado y no se recalcula.
   * Las sesiones creadas antes de que existiera el techo no lo traen (ver `techoDeLaSesion`).
   */
  absoluteExpiresAt?: number;
  /**
   * SESIÓN DE APARATO (passkeys P3): id de la credencial WebAuthn que sostiene esta sesión. Su
   * PRESENCIA es lo que le quita el techo absoluto (ver `techoDeLaSesion`) y lo que obliga a una
   * aserción fresca del passkey en cada `/auth/refresh` (ver auth.service). NUNCA se infiere "sin
   * techo" de la ausencia de `absoluteExpiresAt`: una sesión vieja sin techo guardado se cuenta
   * desde `createdAt`, como siempre. Solo la tienen las sesiones nacidas de un login por passkey.
   */
  credentialId?: string;
}

/**
 * Momento en que la sesión muere aunque se siga usando (ms epoch), o `undefined` = SIN techo.
 *
 * SESIÓN DE APARATO: si trae `credentialId`, no tiene techo absoluto — la sostiene la biometría
 * del aparato en cada refresh, y solo la ventana deslizante (TTL de Redis) la mata por desuso.
 * «Sin techo» sale de la PRESENCIA de `credentialId`, JAMÁS de la ausencia de `absoluteExpiresAt`
 * (invertir eso vuelve eternas las sesiones viejas grandfathered → es el bug original de #609).
 *
 * El resto, igual que siempre: el MÍNIMO entre el techo que se le guardó al nacer y el de la
 * política de HOY (`maxMs` desde su login) — así apretar la política alcanza a las sesiones ya
 * abiertas (una política nueva solo puede ACORTAR). Una sesión vieja sin techo guardado se
 * cuenta desde su `createdAt`; usar `Date.now()` para esas la volvería eterna otra vez.
 */
export function techoDeLaSesion(data: Pick<RefreshSessionData, "createdAt" | "absoluteExpiresAt" | "credentialId">, maxMs: number): number | undefined {
  if (data.credentialId) return undefined; // sesión de aparato: sin techo
  const porPolitica = data.createdAt + maxMs;
  return typeof data.absoluteExpiresAt === "number" ? Math.min(data.absoluteExpiresAt, porPolitica) : porPolitica;
}

/**
 * Segundos de vida del ACCESS token: el configurado, pero recortado al techo de la sesión.
 *
 * El agujero que cierra: el access es un JWT stateless y no hay lista de revocación, así que
 * un refresh pedido 10 minutos antes del techo entregaba un token de 12 h y la sesión llegaba
 * a 36 h con un techo de 24. Recortar el `exp` es lo que hace que el techo sea un techo —
 * mirar solo el refresh token no alcanza, porque el access vive solo.
 *
 * Mínimo 1: `jsonwebtoken` rechaza un `expiresIn` de 0 o negativo.
 */
export function vidaDelAccessToken(accessRaw: string | undefined, techoMs: number | undefined, nowMs = Date.now()): number {
  const configurado = parseDurationSeconds(accessRaw, 12 * 3600);
  // Sin techo (sesión de aparato): 12 h limpias, nada que recortar. `undefined` EXPLÍCITO en vez
  // de `Infinity` —que "funcionaría" por `Math.min(43200, Infinity)`— para que la intención sea clara.
  if (techoMs === undefined) return configurado;
  return Math.max(1, Math.min(configurado, Math.ceil((techoMs - nowMs) / 1000)));
}

/** Una sesión de refresh recién creada: su token EN CLARO y el techo que le quedó fijado. */
export interface SesionDeRefresh {
  token: string;
  /** Techo absoluto (ms epoch). AUSENTE = sesión de aparato sin techo (ver `create`). */
  absoluteExpiresAt?: number;
}

/**
 * TTL (segundos) de la clave en Redis: la ventana deslizante, pero NUNCA más allá del techo.
 * Sin el recorte, la última renovación antes del techo dejaría la clave viva 30 días más.
 * Mínimo 1 porque Redis rechaza un `EX 0`.
 */
export function ttlHastaElTecho(techoMs: number, nowMs: number, deslizanteSeg: number): number {
  return Math.max(1, Math.min(deslizanteSeg, Math.ceil((techoMs - nowMs) / 1000)));
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
  private absoluteMaxMs = parseDurationSeconds(getEnv().JWT_REFRESH_ABSOLUTE_MAX, 90 * 86400) * 1000;
  // Ventana deslizante de la SESIÓN DE APARATO (sin techo absoluto): muere solo por desuso.
  private deviceTtl = parseDurationSeconds(getEnv().JWT_DEVICE_REFRESH_EXPIRES_IN, 30 * 86400);

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

  /**
   * Crea una sesión de refresh y devuelve el token EN CLARO (solo se ve aquí; en Redis va su hash).
   * `heredaTecho` es el techo absoluto de la sesión que se está rotando: al renovar NO se estrena
   * uno nuevo, porque entonces el techo se correría en cada uso y no sería un techo.
   *
   * `credentialId` presente = SESIÓN DE APARATO (passkey P3): sin techo absoluto, solo la ventana
   * deslizante larga (`deviceTtl`). El `heredaTecho` se IGNORA en ese caso (no hay techo que heredar).
   */
  async create(userId: string, orgId: string, heredaTecho?: number, credentialId?: string): Promise<SesionDeRefresh> {
    const token = this.mint();
    const h = this.hash(token);
    const now = Date.now();
    // El set del usuario ("cerrar todas") vive la ventana más larga posible, para que incluya a
    // las sesiones de aparato (30 d): si lo acortáramos a `ttl`, cambiar la contraseña dejaría de
    // revocar una sesión de aparato pasadas las 24 h.
    const userSetTtl = Math.max(this.ttl, this.deviceTtl);
    if (credentialId) {
      // SIN techo absoluto (`absoluteExpiresAt` AUSENTE a propósito). TTL = ventana deslizante larga.
      const data: RefreshSessionData = { userId, orgId, createdAt: now, credentialId };
      try {
        await this.redis.set(this.key(h), JSON.stringify(data), "EX", this.deviceTtl);
        await this.redis.sadd(this.userKey(userId), h);
        await this.redis.expire(this.userKey(userId), userSetTtl);
      } catch {
        // fail-open (igual que abajo): el access token conserva su propia expiración.
      }
      return { token }; // sin `absoluteExpiresAt` = sin techo
    }
    // El techo heredado también se recorta a la política de hoy: si viene de un token viejo
    // (p. ej. el `sxp` de una sesión de 90 d), heredarlo tal cual reviviría la vida vieja.
    const absoluteExpiresAt = heredaTecho ? Math.min(heredaTecho, now + this.absoluteMaxMs) : now + this.absoluteMaxMs;
    const data: RefreshSessionData = { userId, orgId, createdAt: now, absoluteExpiresAt };
    const ttl = ttlHastaElTecho(absoluteExpiresAt, now, this.ttl);
    try {
      await this.redis.set(this.key(h), JSON.stringify(data), "EX", ttl);
      await this.redis.sadd(this.userKey(userId), h);
      // El set del usuario vive la ventana deslizante COMPLETA, no el `ttl` recortado: es el
      // índice de "cerrar todas las sesiones" y si se acortara por una sesión que está por
      // llegar a su techo, dejaría fuera del barrido a las otras sesiones del mismo usuario.
      await this.redis.expire(this.userKey(userId), userSetTtl);
    } catch {
      // fail-open: si Redis no está, el login igual sale (el access token tiene su propia expiración);
      // simplemente no habrá sesión deslizante hasta que Redis vuelva.
    }
    return { token, absoluteExpiresAt };
  }

  /** Resuelve un refresh token a su sesión. null = inválido/expirado/revocado (o Redis caído). */
  async resolve(token: string): Promise<RefreshSessionData | null> {
    if (!token || !token.startsWith("rt_")) return null;
    try {
      const raw = await this.redis.get(this.key(this.hash(token)));
      if (!raw) return null;
      const data = JSON.parse(raw) as RefreshSessionData;
      // TECHO: el TTL de Redis ya la mataría, pero una sesión GRANDFATHEREADA (creada antes de
      // que el techo existiera) tiene en Redis un TTL de 30 d que no lo conoce. Comprobarlo
      // acá es lo que hace que el techo también alcance a las sesiones que ya estaban abiertas.
      // Una sesión de aparato devuelve techo `undefined` (sin techo) → nunca cae por acá.
      const techo = techoDeLaSesion(data, this.absoluteMaxMs);
      if (techo !== undefined && Date.now() >= techo) {
        await this.redis.del(this.key(this.hash(token))).catch(() => undefined);
        return null;
      }
      return data;
    } catch {
      return null; // fail-closed: no podemos probar validez → se trata como inválido
    }
  }

  /**
   * Rota el refresh token: revoca el usado y entrega uno nuevo CONSERVANDO el techo absoluto Y el
   * `credentialId`. Existe como un solo método (en vez de revoke + create por separado en el
   * llamador) porque cualquiera de los dos se pierde con solo olvidarse de pasarlo: perder el techo
   * vuelve eterna una sesión normal, y perder el `credentialId` convierte una sesión de aparato en
   * una normal a las 24 h (o, peor, lava una normal en una sin techo — el 3.er agujero de #609).
   */
  async rotate(tokenUsado: string, data: RefreshSessionData): Promise<SesionDeRefresh> {
    await this.revoke(tokenUsado);
    return this.create(data.userId, data.orgId, techoDeLaSesion(data, this.absoluteMaxMs), data.credentialId);
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
