import IORedis from "ioredis";
import { getEnv, calendarsToReadBusy, canUseFeature, parseGoogleCalendarConfig } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { makeExternalBusy, type GoogleBusyDeps } from "@conversia/scheduling";
import { getFreshOAuthToken, NoConnectionError, ReauthorizeError } from "./oauth-tokens.js";

/**
 * ETAPA 2 (lado worker) — el pegamento entre la agenda nativa y Google.
 *
 * Decide si hay algo que leer y, si lo hay, arma el gancho `externalBusy` con el token del
 * tenant, la caché de Redis y el registro de errores. La lógica de verdad (qué eventos
 * cuentan, caché, timeouts) vive en `@conversia/scheduling/google-busy`, compartida con la
 * api: el bot y el panel TIENEN que ofrecer lo mismo.
 */

type RedisLike = Pick<IORedis, "get" | "set">;

let redis: IORedis | undefined;
function conn(): IORedis {
  if (!redis) redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redis;
}

/** Caché de horas ocupadas en Redis. Si Redis falla, se consulta a Google y listo. */
export function busyCache(client?: RedisLike): NonNullable<GoogleBusyDeps["cache"]> {
  const c = client ?? conn();
  return {
    get: (k) => c.get(k),
    set: async (k, v, ttl) => {
      await c.set(k, v, "EX", ttl);
    },
  };
}

/**
 * Registra en el panel que Google no se pudo leer. **Acotado a una vez por hora** por
 * organización: sin eso, una caída de Google llenaría `integration_events` con una fila por
 * turno del bot y la página de Alertas quedaría inservible justo cuando hay que mirarla.
 */
export function registrarErrorDeLectura(organizationId: string, detalle: string, client?: RedisLike): void {
  const c = client ?? conn();
  const marca = `conversia:gcal:busy:err-logged:${organizationId}`;
  void (async () => {
    try {
      const primero = await c.set(marca, "1", "EX", 3600, "NX");
      if (!primero) return; // ya se registró en la última hora
      await withTenant(organizationId, async (tx) => {
        await tx.integrationEvent.create({
          data: { organizationId, provider: "google", type: "calendar.busy_error", status: "error", message: `No se pudieron leer las horas ocupadas: ${detalle}`.slice(0, 500) },
        });
        await tx.integrationConnection.updateMany({ where: { organizationId, provider: "google" }, data: { lastError: `Horas ocupadas: ${detalle}`.slice(0, 500) } });
      });
      console.warn(`⚠ [gcal] ${organizationId}: ${detalle}`);
    } catch {
      /* registrar el error no puede romper el turno del bot */
    }
  })();
}

/**
 * Gancho `externalBusy` para este tenant, o `undefined` si no hay nada que leer: sin
 * conexión, sin el permiso de calendario, o sin ningún calendario marcado para bloquear.
 *
 * Devolver `undefined` importa: así el proveedor nativo ni intenta la llamada y el turno del
 * bot no paga ni un milisegundo cuando el tenant no usa esta función (que hoy son todos).
 */
export async function buildExternalBusy(
  organizationId: string,
  timeZone: string,
  overrides?: { cache?: NonNullable<GoogleBusyDeps["cache"]>; fetchImpl?: typeof fetch },
): Promise<ReturnType<typeof makeExternalBusy> | undefined> {
  const conn0 = await withTenant(organizationId, (tx) =>
    tx.integrationConnection.findFirst({ where: { organizationId, provider: "google" }, select: { config: true, status: true } }),
  );
  if (!conn0 || conn0.status === "reauthorize") return undefined;
  if (!canUseFeature(conn0.config, "calendar")) return undefined;
  const cfg = parseGoogleCalendarConfig(conn0.config);
  // ¿Algún calendario marcado para bloquear horas? Si no, no hay nada que leer.
  const hayLectura = cfg.businessReadBusy || Object.values(cfg.calendars).some((c) => c.readBusy);
  if (!hayLectura) return undefined;

  const deps: GoogleBusyDeps = {
    token: () => getFreshOAuthToken(organizationId, "google"),
    cache: overrides?.cache ?? busyCache(),
    cacheScope: organizationId,
    onError: (detalle) => registrarErrorDeLectura(organizationId, detalle),
    fetchImpl: overrides?.fetchImpl,
  };
  return makeExternalBusy({ calendarsFor: (proId) => calendarsToReadBusy(cfg, proId), timeZone, deps });
}

/** Un token revocado no es un error transitorio: no tiene sentido reintentarlo por turno. */
export function esErrorDeConexion(err: unknown): boolean {
  return err instanceof NoConnectionError || err instanceof ReauthorizeError;
}
