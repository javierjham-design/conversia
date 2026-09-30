import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { type BroadcastJob } from "@conversia/types";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { getTemplatesEntitlement } from "../common/plan-limits";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

/** Normaliza a E.164 conservando solo dígitos (mismo criterio que la ingesta/import). */
function normalizePhone(raw?: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  return digits.length >= 8 ? `+${digits}` : null;
}

const newContactSchema = z.object({
  phone: z.string().min(6).max(32),
  firstName: z.string().trim().max(120).optional(),
  lastName: z.string().trim().max(120).optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  templateId: z.string().min(1),
  channelId: z.string().min(1).optional(),
  audience: z.object({
    /** uno o varios grupos existentes (unión de miembros) */
    groupIds: z.array(z.string()).max(50).optional(),
    /** contactos nuevos a cargar (se crean en el CRM si no existen) */
    contacts: z.array(newContactSchema).max(20000).optional(),
    /** grupo al que asignar los contactos NUEVOS cargados (opcional) */
    newContactsGroupId: z.string().optional(),
  }),
});

/**
 * Difusiones: envío masivo de una plantilla de WhatsApp APROBADA por Meta a una
 * audiencia (grupos de contactos y/o contactos nuevos cargados). Cada destinatario
 * genera un Message TEMPLATE que pasa por la MISMA cadena de gating del envío
 * individual (plan + interruptor + bolsa + tope diario + fusible), así que aquí
 * solo resolvemos la audiencia, persistimos la difusión y encolamos el trabajo.
 */
@Controller("broadcasts")
export class BroadcastsController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
  ) {}

  /** Datos para el asistente de nueva difusión: plantillas aprobadas, grupos,
   *  capacidad (plan+interruptor) y saldo de la bolsa. */
  @Get("meta")
  meta() {
    const ctx = requirePermission("conversations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const [templates, groups, groupCounts, channels, wallet, ent] = await Promise.all([
        tx.whatsappTemplate.findMany({ where: { status: "APPROVED" }, orderBy: { name: "asc" }, select: { id: true, name: true, language: true, category: true, body: true } }),
        tx.contactGroup.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, color: true } }),
        tx.contactGroupMember.groupBy({ by: ["groupId"], _count: { _all: true } }),
        tx.channelConnection.findMany({ where: { type: "WHATSAPP_CLOUD", status: "active" }, select: { id: true, name: true }, orderBy: { createdAt: "asc" } }),
        tx.messageWallet.findUnique({ where: { organizationId: ctx.organizationId }, select: { balance: true } }),
        getTemplatesEntitlement(tx),
      ]);
      const countByGroup = new Map<string, number>(groupCounts.map((c) => [c.groupId, c._count._all]));
      return {
        entitlement: ent, // { planAllows, switchOn, enabled }
        walletBalance: wallet?.balance ?? 0,
        channels,
        groups: groups.map((g) => ({ id: g.id, name: g.name, color: g.color, count: countByGroup.get(g.id) ?? 0 })),
        templates: templates.map((t) => {
          const components = ((t.body as Record<string, any>)?.components ?? []) as any[];
          const bodyText = components.find((c) => c?.type === "BODY")?.text ?? "";
          return { id: t.id, name: t.name, language: t.language, category: t.category, bodyText };
        }),
      };
    });
  }

  /** Historial de difusiones del tenant. */
  @Get()
  list() {
    const ctx = requirePermission("conversations:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const rows = await tx.broadcast.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
      return rows.map((b) => ({
        id: b.id,
        name: b.name,
        templateName: b.templateName,
        status: b.status,
        total: b.total,
        sent: b.sent,
        failed: b.failed,
        createdAt: b.createdAt,
        startedAt: b.startedAt,
        completedAt: b.completedAt,
      }));
    });
  }

  @Get(":id")
  detail(@Param("id") id: string) {
    const ctx = requirePermission("conversations:read");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const b = await tx.broadcast.findUnique({ where: { id } });
      if (!b) throw new NotFoundException("Difusión no encontrada");
      const byStatus = await tx.broadcastRecipient.groupBy({ by: ["status"], where: { broadcastId: id }, _count: { _all: true } });
      const counts: Record<string, number> = {};
      for (const r of byStatus) counts[r.status] = r._count._all;
      return {
        id: b.id,
        name: b.name,
        templateName: b.templateName,
        status: b.status,
        total: b.total,
        sent: b.sent,
        failed: b.failed,
        createdAt: b.createdAt,
        startedAt: b.startedAt,
        completedAt: b.completedAt,
        recipientCounts: counts,
      };
    });
  }

  /** Crea la difusión: valida capacidad + plantilla aprobada, resuelve la audiencia
   *  y encola el envío. Rechaza si el tenant no tiene la capacidad de plantillas. */
  @Post()
  async create(@Body() body: unknown) {
    const ctx = requireContext();
    requirePermission("conversations:write");
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const input = parsed.data;

    const result = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      // 1) Capacidad: plan incluye plantillas + interruptor del tenant encendido.
      const ent = await getTemplatesEntitlement(tx);
      if (!ent.enabled) {
        throw new BadRequestException(
          ent.planAllows
            ? "Las plantillas de WhatsApp no están activadas para tu cuenta. Contacta a soporte para habilitarlas."
            : "Tu plan no incluye envío de plantillas de WhatsApp. Contacta a soporte para habilitarlas.",
        );
      }

      // 2) Plantilla aprobada por Meta (única vía permitida).
      const template = await tx.whatsappTemplate.findUnique({ where: { id: input.templateId } });
      if (!template) throw new BadRequestException("Plantilla no encontrada — sincroniza las plantillas del canal");
      if (template.status !== "APPROVED") {
        throw new BadRequestException(`La plantilla «${template.name}» no está aprobada por Meta (estado: ${template.status})`);
      }

      // 3) Canal de WhatsApp activo.
      const channel = input.channelId
        ? await tx.channelConnection.findFirst({ where: { id: input.channelId, type: "WHATSAPP_CLOUD" }, select: { id: true } })
        : await tx.channelConnection.findFirst({ where: { type: "WHATSAPP_CLOUD", status: "active" }, orderBy: { createdAt: "asc" }, select: { id: true } });
      if (!channel) throw new BadRequestException("No hay un canal de WhatsApp activo para la difusión");

      // 4) Resolver audiencia → set de contactIds (con teléfono).
      const contactIds = new Set<string>();

      if (input.audience.groupIds?.length) {
        const members = await tx.contactGroupMember.findMany({ where: { groupId: { in: input.audience.groupIds } }, select: { contactId: true } });
        const ids = [...new Set(members.map((m) => m.contactId))];
        if (ids.length) {
          const withPhone = await tx.contact.findMany({ where: { id: { in: ids }, deletedAt: null, phone: { not: null }, blocked: false, doNotContact: false }, select: { id: true } });
          for (const c of withPhone) contactIds.add(c.id);
        }
      }

      // Contactos nuevos: se crean en el CRM (dedupe por teléfono) y opcionalmente
      // se agregan a un grupo. Quedan "agarrados" a la cuenta como cualquier lead.
      if (input.audience.contacts?.length) {
        let newGroup: { id: string } | null = null;
        if (input.audience.newContactsGroupId) {
          newGroup = await tx.contactGroup.findFirst({ where: { id: input.audience.newContactsGroupId }, select: { id: true } });
        }
        for (const nc of input.audience.contacts) {
          const phone = normalizePhone(nc.phone);
          if (!phone) continue;
          let contact = await tx.contact.findFirst({ where: { phone, deletedAt: null }, select: { id: true, blocked: true, doNotContact: true } });
          if (!contact) {
            contact = await tx.contact.create({
              data: {
                organizationId: ctx.organizationId,
                firstName: nc.firstName || null,
                lastName: nc.lastName || null,
                phone,
                source: "broadcast",
                createdVia: "import",
                acquisitionSource: "organic",
              },
              select: { id: true, blocked: true, doNotContact: true },
            });
          }
          if (newGroup) {
            await tx.contactGroupMember.createMany({ data: [{ organizationId: ctx.organizationId, groupId: newGroup.id, contactId: contact.id }], skipDuplicates: true });
          }
          if (!contact.blocked && !contact.doNotContact) contactIds.add(contact.id);
        }
      }

      const ids = [...contactIds];
      if (ids.length === 0) throw new BadRequestException("La audiencia quedó vacía (sin contactos con teléfono válido y contactables)");

      // 5) Persistir difusión + destinatarios (PENDING) y encolar.
      const broadcast = await tx.broadcast.create({
        data: {
          organizationId: ctx.organizationId,
          name: input.name,
          templateId: template.id,
          templateName: template.name,
          channelConnectionId: channel.id,
          audienceType: input.audience.contacts?.length && !input.audience.groupIds?.length ? "list" : "group",
          audienceRef: { groupIds: input.audience.groupIds ?? [], newContacts: input.audience.contacts?.length ?? 0 },
          status: "QUEUED",
          total: ids.length,
          createdById: ctx.userId,
        },
        select: { id: true },
      });
      // createMany por lotes para audiencias grandes.
      for (let i = 0; i < ids.length; i += 1000) {
        await tx.broadcastRecipient.createMany({
          data: ids.slice(i, i + 1000).map((contactId) => ({ organizationId: ctx.organizationId, broadcastId: broadcast.id, contactId })),
          skipDuplicates: true,
        });
      }
      const wallet = await tx.messageWallet.findUnique({ where: { organizationId: ctx.organizationId }, select: { balance: true } });
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "broadcast.create", entityType: "broadcast", entityId: broadcast.id, after: { template: template.name, total: ids.length } },
      });
      return { id: broadcast.id, total: ids.length, walletBalance: wallet?.balance ?? 0 };
    });

    await this.queues.broadcast.add(
      "send",
      { organizationId: ctx.organizationId, broadcastId: result.id } satisfies BroadcastJob,
      { jobId: `broadcast:${result.id}`, removeOnComplete: { age: 86400 }, removeOnFail: { age: 86400 } },
    );
    return {
      ok: true,
      id: result.id,
      total: result.total,
      walletBalance: result.walletBalance,
      insufficientWallet: result.walletBalance < result.total,
    };
  }

  /** Cancela una difusión: el worker deja de encolar los destinatarios pendientes. */
  @Post(":id/cancel")
  async cancel(@Param("id") id: string) {
    const ctx = requirePermission("conversations:write");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const b = await tx.broadcast.findUnique({ where: { id }, select: { id: true, status: true } });
      if (!b) throw new NotFoundException("Difusión no encontrada");
      if (["COMPLETED", "CANCELED", "FAILED"].includes(b.status)) return { ok: true, status: b.status };
      await tx.broadcast.update({ where: { id }, data: { status: "CANCELED" } });
      return { ok: true, status: "CANCELED" };
    });
  }
}
