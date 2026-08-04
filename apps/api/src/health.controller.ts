import { Controller, Get, Header, Headers, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { getEnv } from "@conversia/config";
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

    const ok = Object.values(checks).every((c) => c.ok);
    if (!ok) throw new ServiceUnavailableException({ ok, checks });
    return { ok, checks };
  }
}
