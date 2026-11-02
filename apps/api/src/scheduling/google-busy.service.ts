import { Injectable } from "@nestjs/common";
import IORedis from "ioredis";
import { getEnv, calendarsToReadBusy, canUseFeature, parseGoogleCalendarConfig } from "@conversia/config";
import { makeExternalBusy, type GoogleBusyDeps } from "@conversia/scheduling";
import { PrismaService } from "../prisma.service";
import { OAuthTokenService } from "../integrations/oauth-token.service";

/**
 * ETAPA 2 (lado api) — horas ocupadas de Google para el PANEL.
 *
 * El panel pinta los huecos libres con el mismo motor que usa el bot, así que si no leyera
 * Google el dueño vería libres horas que el bot ya no ofrece (o al revés). La lógica de
 * verdad está en `@conversia/scheduling/google-busy`, compartida con el worker.
 *
 * La caché de Redis es la MISMA que usa el worker (misma clave): el panel y el bot se
 * aprovechan mutuamente y Google recibe una sola consulta por rango cada ~90 s.
 */
@Injectable()
export class GoogleBusyService {
  private redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });

  constructor(
    private prisma: PrismaService,
    private tokens: OAuthTokenService,
  ) {}

  /**
   * Borra la caché de horas ocupadas de una organización. La usa el botón "sincronizar
   * ahora": apretarlo tiene que mostrar el estado de Google REAL, no el de hasta 90 s atrás.
   *
   * Va con SCAN (no KEYS) para no bloquear Redis, y acotado: el botón está limitado a una
   * vez por minuto, así que el costo es irrelevante.
   */
  async invalidate(organizationId: string): Promise<number> {
    const patron = `conversia:gcal:busy:${organizationId}:*`;
    let cursor = "0";
    let borradas = 0;
    try {
      for (let i = 0; i < 50; i++) {
        const [next, keys] = await this.redis.scan(cursor, "MATCH", patron, "COUNT", 200);
        if (keys.length) borradas += await this.redis.del(...keys);
        cursor = next;
        if (cursor === "0") break;
      }
    } catch {
      /* si Redis no responde, la caché caduca sola en 90 s */
    }
    return borradas;
  }

  private cache(): NonNullable<GoogleBusyDeps["cache"]> {
    return {
      get: (k) => this.redis.get(k),
      set: async (k, v, ttl) => {
        await this.redis.set(k, v, "EX", ttl);
      },
    };
  }

  /**
   * Gancho `externalBusy` del tenant, o `undefined` si no hay nada que leer (sin conexión,
   * sin permiso de calendario, o ningún calendario marcado para bloquear). Devolver
   * `undefined` deja la pantalla exactamente igual de rápida para quien no usa la función.
   */
  async forOrg(organizationId: string, timeZone: string): Promise<ReturnType<typeof makeExternalBusy> | undefined> {
    const conn = await this.prisma.withTenant(organizationId, (tx) =>
      tx.integrationConnection.findFirst({ where: { organizationId, provider: "google" }, select: { config: true, status: true } }),
    );
    if (!conn || conn.status === "reauthorize") return undefined;
    if (!canUseFeature(conn.config, "calendar")) return undefined;
    const cfg = parseGoogleCalendarConfig(conn.config);
    if (!cfg.businessReadBusy && !Object.values(cfg.calendars).some((c) => c.readBusy)) return undefined;

    const deps: GoogleBusyDeps = {
      token: () => this.tokens.freshToken(organizationId, "google"),
      cache: this.cache(),
      cacheScope: organizationId,
      onError: (detalle) => {
        // En el panel basta con dejarlo en la conexión: la pantalla lo muestra. El registro
        // acotado en `integration_events` lo hace el worker (es el que corre todo el día).
        void this.prisma
          .withTenant(organizationId, (tx) =>
            tx.integrationConnection.updateMany({ where: { organizationId, provider: "google" }, data: { lastError: `Horas ocupadas: ${detalle}`.slice(0, 500) } }),
          )
          .catch(() => undefined);
      },
    };
    return makeExternalBusy({ calendarsFor: (proId) => calendarsToReadBusy(cfg, proId), timeZone, deps });
  }
}
