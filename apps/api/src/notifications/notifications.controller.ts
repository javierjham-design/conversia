import { BadRequestException, Body, Controller, Delete, Get, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { CLP_PER_USD_REF, computeWhatsappCostUsd } from "@conversia/agents";
import { listEvents } from "@conversia/notifications";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { requireContext } from "../tenancy/context";

const deviceSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(300), auth: z.string().max(300) }),
  platform: z.enum(["web", "ios", "android", "desktop"]).default("web"),
  label: z.string().max(80).optional(),
});

/**
 * Notificaciones del usuario: campana in-app (tabla notifications) + registro de
 * dispositivos de Web Push + presencia (para no mandar push de la conversación
 * que el usuario ya está mirando).
 */
@Controller("notifications")
export class NotificationsController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
  ) {}

  /** Lista de la campana: no leídas primero, últimas 30. */
  @Get()
  list() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const items = await tx.notification.findMany({
        where: { userId: ctx.userId },
        orderBy: { createdAt: "desc" },
        take: 30,
      });
      const unread = await tx.notification.count({ where: { userId: ctx.userId, readAt: null } });
      return {
        unread,
        items: items.map((n) => ({
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          link: (n.meta as any)?.link ?? null,
          readAt: n.readAt,
          createdAt: n.createdAt,
        })),
      };
    });
  }

  /** Marca notificaciones como leídas (todas o una). */
  @Post("read")
  read(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ id: z.string().optional() }).safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.notification.updateMany({
        where: { userId: ctx.userId, readAt: null, ...(parsed.data.id ? { id: parsed.data.id } : {}) },
        data: { readAt: new Date() },
      });
      return { ok: true };
    });
  }

  /** Catálogo de eventos para pintar la matriz de preferencias. */
  @Get("catalog")
  catalog() {
    requireContext();
    return {
      events: listEvents().map((e) => ({
        key: e.key,
        title: e.title,
        urgency: e.urgency,
        channels: e.channels,
        defaultChannels: e.defaultChannels,
        lockedChannels: e.lockedChannels ?? [],
      })),
    };
  }

  /** Preferencias del usuario (matriz evento×canal + horario silencioso + WhatsApp). */
  @Get("preferences")
  getPreferences() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
      const all = (((org?.settings ?? {}) as any).notifPrefs ?? {}) as Record<string, any>;
      const p = all[ctx.userId!] ?? {};
      return {
        matrix: p.matrix ?? {},
        quietHours: p.quietHours ?? { enabled: false, start: "22:00", end: "08:00" },
        whatsapp: p.whatsapp ?? { enabled: false, throttlePerHour: 4, delayMinutes: 5 },
      };
    });
  }

  /** Guarda las preferencias del usuario. */
  @Post("preferences")
  savePreferences(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z
      .object({
        matrix: z.record(z.record(z.boolean())).optional(),
        quietHours: z.object({ enabled: z.boolean(), start: z.string(), end: z.string() }).optional(),
        whatsapp: z
          .object({ enabled: z.boolean(), throttlePerHour: z.number().int().min(1).max(20), delayMinutes: z.number().int().min(1).max(60) })
          .optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Preferencias inválidas");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
      const settings = (org?.settings ?? {}) as Record<string, any>;
      const all = (settings.notifPrefs ?? {}) as Record<string, any>;
      all[ctx.userId!] = { ...(all[ctx.userId!] ?? {}), ...parsed.data };
      await tx.organization.update({ where: { id: ctx.organizationId }, data: { settings: { ...settings, notifPrefs: all } as object } });
      return { ok: true };
    });
  }

  /** Clave pública VAPID para suscribirse desde el navegador (no es secreta). */
  @Get("vapid-public-key")
  vapidKey() {
    requireContext();
    return { publicKey: getEnv().VAPID_PUBLIC_KEY || null };
  }

  /** Registra (o refresca) una suscripción de Web Push como dispositivo. */
  @Post("devices")
  registerDevice(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = deviceSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Suscripción inválida");
    const d = parsed.data;
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.pushDevice.upsert({
        where: { userId_identifier: { userId: ctx.userId!, identifier: d.endpoint } },
        create: {
          organizationId: ctx.organizationId,
          userId: ctx.userId!,
          platform: d.platform,
          kind: "web_push",
          identifier: d.endpoint,
          keys: d.keys as object,
          label: d.label ?? null,
        },
        update: { keys: d.keys as object, active: true, lastSeenAt: new Date(), label: d.label ?? undefined },
      });
      return { ok: true };
    });
  }

  /** Da de baja un dispositivo (logout / desuscripción). */
  @Delete("devices")
  removeDevice(@Query("endpoint") endpoint?: string) {
    const ctx = requireContext();
    if (!endpoint) throw new BadRequestException("endpoint requerido");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      await tx.pushDevice.deleteMany({ where: { userId: ctx.userId, identifier: endpoint } });
      return { ok: true };
    });
  }

  /**
   * Estimación de costo de la escalera de WhatsApp: cuántos escalamientos hubo en
   * los últimos 30 días (proxy de avisos) y el costo por plantilla + proyección
   * mensual, para que nadie active la escalera sin saber lo que gasta.
   */
  @Get("whatsapp/estimate")
  whatsappEstimate() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: ctx.organizationId }, select: { country: true } });
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const escalations30d = await tx.humanHandoff.count({ where: { createdAt: { gte: since } } }).catch(() => 0);
      const perNoticeClp = Math.round(computeWhatsappCostUsd("utility", org?.country ?? "CL") * CLP_PER_USD_REF);
      return {
        escalations30d,
        perNoticeClp,
        monthlyClp: escalations30d * perNoticeClp,
        note: "Estimación: cada aviso consume una plantilla de utilidad de tu WhatsApp. Se envía solo si nadie atiende a tiempo, así que el gasto real suele ser menor.",
      };
    });
  }

  /**
   * Presencia: marca qué conversación mira el usuario (TTL 60 s). El despachador
   * la lee para no mandar push de una conversación que ya está abierta.
   */
  @Post("viewing")
  async viewing(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ conversationId: z.string().nullable() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Datos inválidos");
    const key = `notif:viewing:${ctx.userId}`;
    if (parsed.data.conversationId) {
      await this.queues.connection.set(key, parsed.data.conversationId, "EX", 60);
      // Atender la conversación cancela la escalera de WhatsApp pendiente de esa
      // conversación (flag que el worker respeta al disparar el aviso).
      await this.queues.connection.set(`wa:attended:${parsed.data.conversationId}`, "1", "EX", 1800);
    } else {
      await this.queues.connection.del(key);
    }
    return { ok: true };
  }
}
