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
