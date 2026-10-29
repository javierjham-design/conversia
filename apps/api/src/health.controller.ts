import { Controller, Get, Header, Headers, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { getEnv, BRANDS, messagingFuseKeys } from "@conversia/config";
import { getDbRoleStatus } from "@conversia/database";
import { AI_DEGRADED_PROVIDERS, aiDegradedRedisKey } from "@conversia/types";
import { QueueService } from "./queues";
import { PrismaService } from "./prisma.service";

/** Backlog que consideramos "cola atascada" (dispara alerta). */
const QUEUE_BACKLOG_ALERT = 500;
const QUEUE_FAILED_ALERT = 100;
/** Edad máxima del latido del worker antes de considerarlo caído. */
const WORKER_STALE_MS = 90_000;

@Controller("health")
export class HealthController {
  constructor(private queues: QueueService, private prisma: PrismaService) {}

  /** Liveness simple (sin dependencias): para el balanceador/plataforma. */
  @Get()
  health() {
    return { ok: true, service: "conversia-api", env: getEnv().NODE_ENV, uptime: process.uptime() };
  }

  /**
   * Estado del FUSIBLE de mensajería para un monitor de BetterStack: devuelve
   * **503** cuando el fusible global está cortado hoy (gasto de plantillas superó
   * el techo) → el monitor lo ve "caído" y te llama al teléfono. 200 si todo ok.
   */
  @Get("fuse")
  @Header("cache-control", "no-store")
  async fuse() {
    const date = new Date().toISOString().slice(0, 10);
    // §6.1 — el fusible es POR MARCA, así que se reportan TODAS: si solo se mirara la de
    // TuBot, un corte de Conversia dejaría al monitor diciendo "todo bien" mientras sus
    // clientes no pueden enviar. Las claves las arma `messagingFuseKeys` (en
    // @conversia/config), la MISMA función que usa el worker para escribirlas.
    const marcas = Object.keys(BRANDS);
    const porMarca: Record<string, { templates: boolean; service: boolean }> = {};
    for (const m of marcas) porMarca[m] = { templates: false, service: false };
    try {
      // M4 — se exponen AMBOS fusibles: plantillas y SERVICIO (ventana de 24 h). Antes
      // solo se veía el de plantillas → el monitor no alertaba si cortaba el de servicio.
      const claves = marcas.flatMap((m) => {
        const k = messagingFuseKeys(m, date);
        return [k.templateFuse, k.serviceFuse];
      });
      const valores = await this.queues.connection.mget(...claves);
      marcas.forEach((m, i) => {
        porMarca[m] = { templates: valores[i * 2] === "1", service: valores[i * 2 + 1] === "1" };
      });
    } catch {
      /* redis caído → no afirmamos que el fusible cortó */
    }
    const cortadas = marcas.filter((m) => porMarca[m].templates || porMarca[m].service);
    if (cortadas.length) {
      const detalle = cortadas
        .map((m) => {
          const q = [porMarca[m].templates ? "plantillas" : null, porMarca[m].service ? "servicio" : null].filter(Boolean).join(" + ");
          return `${m}: ${q}`;
        })
        .join("; ");
      throw new ServiceUnavailableException({
        ok: false,
        fuse: "tripped",
        brands: porMarca,
        // `tripped` se mantiene para no romper lo que ya lo lee (smoke-prod, monitores):
        // es el agregado de todas las marcas.
        tripped: {
          templates: cortadas.some((m) => porMarca[m].templates),
          service: cortadas.some((m) => porMarca[m].service),
        },
        message: `Fusible de mensajería cortado (${detalle}): envíos en pausa.`,
      });
    }
    return { ok: true, fuse: "ok", brands: porMarca };
  }

  /**
   * Health PROFUNDO para el monitor externo (BetterStack/UptimeRobot): comprueba
   * DB, Redis, latido del worker y backlog de colas. Devuelve **503** si algo
   * crítico falla → el monitor lo detecta como caída y avisa al teléfono.
   * Protegido por `MONITOR_TOKEN` (header `x-monitor-token`) si está configurado,
   * para no exponer métricas internas públicamente.
   */
  @Get("status")
  @Header("cache-control", "no-store")
  async status(@Headers("x-monitor-token") token?: string) {
    const monitorToken = getEnv().MONITOR_TOKEN;
    if (monitorToken && token !== monitorToken) {
      throw new UnauthorizedException("Token de monitoreo inválido");
    }

    const checks: Record<string, { ok: boolean; detail?: string | number }> = {};

    // 1. Base de datos.
    try {
      await this.prisma.admin.$queryRaw`SELECT 1`;
      checks.database = { ok: true };
    } catch (e) {
      checks.database = { ok: false, detail: (e as Error).message };
    }

    // 2. Redis + latido del worker.
    try {
      const redis = this.queues.connection;
      checks.redis = { ok: (await redis.ping()) === "PONG" };
      const raw = await redis.get("conversia:health:worker");
      const beat = raw ? (JSON.parse(raw) as { ts: number }) : null;
      const age = beat ? Date.now() - beat.ts : Infinity;
      checks.worker = { ok: age < WORKER_STALE_MS, detail: beat ? `${Math.round(age / 1000)}s` : "sin latido" };
    } catch (e) {
      checks.redis = { ok: false, detail: (e as Error).message };
      checks.worker = { ok: false, detail: "redis no disponible" };
    }

    // 3. Backlog de las colas críticas (esperando/retrasadas + fallidas).
    try {
      let waiting = 0;
      let failed = 0;
      for (const q of [this.queues.inbound, this.queues.outbound, this.queues.events]) {
        const c = await q.getJobCounts("waiting", "failed", "delayed");
        waiting += (c.waiting ?? 0) + (c.delayed ?? 0);
        failed += c.failed ?? 0;
      }
      checks.queues = { ok: waiting < QUEUE_BACKLOG_ALERT && failed < QUEUE_FAILED_ALERT, detail: `esperando ${waiting} · fallidas ${failed}` };
    } catch (e) {
      checks.queues = { ok: false, detail: (e as Error).message };
    }

    // 4. Canario del bot de TuBot: responde, completo y con sentido. Lo escribe el
    //    worker (reliability-monitor) cada 15 min. Tolerante al arranque en frío.
    try {
      const raw = await this.queues.connection.get("conversia:health:canary");
      if (!raw) {
        checks.canary = { ok: true, detail: "sin datos aún" };
      } else {
        const c = JSON.parse(raw) as { ok: boolean; ts: number; detail: string };
        const stale = Date.now() - c.ts > 25 * 60_000; // debería correr cada 15 min
        checks.canary = { ok: c.ok && !stale, detail: stale ? `viejo ${Math.round((Date.now() - c.ts) / 60000)}min` : c.detail };
      }
    } catch (e) {
      checks.canary = { ok: false, detail: (e as Error).message };
    }

    // 5. Salud de los TOKENS de WhatsApp: lo escribe el worker (whatsapp-token-health) cada 15
    //    min. Un token muerto (Meta 190) hace que los ENVÍOS fallen en silencio aunque todo "se
    //    vea" normal → el monitor externo debe verlo como caída. Tolerante al arranque en frío.
    try {
      const raw = await this.queues.connection.get("conversia:health:whatsapp-token");
      if (!raw) {
        checks.whatsappToken = { ok: true, detail: "sin datos aún" };
      } else {
        const c = JSON.parse(raw) as { ok: boolean; ts: number; globalOk: boolean; checked: number; dead: unknown[] };
        const stale = Date.now() - c.ts > 25 * 60_000; // debería correr cada 15 min
        const deadN = Array.isArray(c.dead) ? c.dead.length : 0;
        checks.whatsappToken = {
          ok: c.ok && !stale,
          detail: stale ? `viejo ${Math.round((Date.now() - c.ts) / 60000)}min` : c.ok ? `${c.checked} canal(es) OK` : `${deadN} caído(s)${c.globalOk ? "" : " + token global caído"}`,
        };
      }
    } catch (e) {
      checks.whatsappToken = { ok: false, detail: (e as Error).message };
    }

    // 6. Rol de BD del cliente de TENANT (auditoría §2.0 / etapa 2): si el usuario de
    //    DATABASE_URL puede saltarse la RLS (rolsuper/rolbypassrls), el aislamiento entre
    //    clientes queda dependiendo solo de los filtros del código → caída para el monitor.
    //    "sin verificar" (dev, o no se pudo consultar) NO rompe el health.
    const dbRole = getDbRoleStatus();
    checks.dbRole =
      dbRole.ok === false
        ? { ok: false, detail: "el usuario de DATABASE_URL puede saltarse la RLS (rolsuper/rolbypassrls)" }
        : { ok: true, detail: dbRole.checked ? "rol restringido" : "sin verificar" };

    // 7. Degradación SILENCIOSA del router de IA: el worker marca
    //    `conversia:ai:degraded:<provider>` cuando responde con un proveedor distinto al del
    //    modelo configurado (p. ej. gpt-* → Haiku porque murió OPENAI_API_KEY). El bot sigue
    //    respondiendo, pero con otro modelo y a otro costo, y hay que reponer la llave → el
    //    monitor externo debe verlo como caída. Sin marca = sano. La marca caduca sola (TTL) si
    //    deja de haber tráfico, y se borra cuando el proveedor vuelve (el incidente se resuelve).
    try {
      const claves = AI_DEGRADED_PROVIDERS.map(aiDegradedRedisKey);
      const valores = await this.queues.connection.mget(...claves);
      const caidos = AI_DEGRADED_PROVIDERS.map((p, i) => ({ p, raw: valores[i] })).filter((x) => x.raw);
      if (caidos.length === 0) {
        checks.ai = { ok: true };
      } else {
        const detalle = caidos
          .map(({ p, raw }) => {
            try {
              const j = JSON.parse(raw as string) as { actualProvider?: string; respondedModel?: string };
              return `${p}→${j.actualProvider ?? "?"}(${j.respondedModel ?? "?"})`;
            } catch {
              return p;
            }
          })
          .join(", ");
        checks.ai = { ok: false, detail: `IA degradada: ${detalle}` };
      }
    } catch {
      // redis ya está cubierto en el check 2; aquí no afirmamos degradación si no se pudo leer.
      checks.ai = { ok: true, detail: "no verificable" };
    }

    const ok = Object.values(checks).every((c) => c.ok);
    // `whatsappTokenOk`, `dbRoleOk` y `aiOk` explícitos para el humo (smoke-prod) además del agregado.
    const whatsappTokenOk = checks.whatsappToken?.ok ?? true;
    const dbRoleOk = checks.dbRole?.ok ?? true;
    const aiOk = checks.ai?.ok ?? true;
    if (!ok) throw new ServiceUnavailableException({ ok, whatsappTokenOk, dbRoleOk, aiOk, checks });
    return { ok, whatsappTokenOk, dbRoleOk, aiOk, checks };
  }
}
