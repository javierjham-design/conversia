import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { getEnv, withAppSecretProof } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { RealtimeService } from "../common/realtime.service";
import { decryptSecret } from "../common/crypto";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

const sendMessageSchema = z.object({
  text: z.string().min(1).max(4096),
  /** true = comentario interno del equipo: NUNCA se envía al canal. */
  internal: z.boolean().optional(),
});

/**
 * Definición de una bandeja personalizada (inbox_views.definition) y de los
 * filtros avanzados de la lista. Exportada para tests.
 */
export interface InboxViewDefinition {
  status?: "open" | "pending" | "closed" | "all";
  channelId?: string;
  assigned?: "me" | "unassigned" | string; // userId concreto
  ai?: "on" | "off";
  stageCode?: string; // etapa del ciclo de vida (leads)
  tags?: string[];
  hasAd?: boolean; // conversaciones nacidas de anuncio (CTWA)
}

/** where de Prisma para conversaciones según una definición de bandeja (puro; testeado). */
export function buildViewWhere(def: InboxViewDefinition, meUserId: string, tagContactIds?: string[]): Record<string, unknown> {
  const contactAnd: Record<string, unknown>[] = [];
  if (def.hasAd === true) contactAnd.push({ OR: [{ ctwaClid: { not: null } }, { adId: { not: null } }] });
  if (def.hasAd === false) contactAnd.push({ ctwaClid: null, adId: null });
  // Etapa: contacto cuyo lead más reciente esté en esa etapa (aprox. some(); el
  // conteo exacto por etapa del sidebar usa SQL con lateral join).
  if (def.stageCode) contactAnd.push({ leads: { some: { status: { code: def.stageCode } } } });
  if (def.tags?.length && tagContactIds) contactAnd.push({ id: { in: tagContactIds } });

  return {
    ...(def.status && def.status !== "all" ? { status: def.status.toUpperCase() } : {}),
    ...(def.channelId ? { channelConnectionId: def.channelId } : {}),
    ...(def.ai === "on" ? { aiEnabled: true } : def.ai === "off" ? { aiEnabled: false } : {}),
    ...(def.assigned === "me"
      ? { assignedUserId: meUserId }
      : def.assigned === "unassigned"
        ? { assignedUserId: null, assignedTeamId: null }
        : def.assigned
          ? { assignedUserId: def.assigned }
          : {}),
    ...(contactAnd.length ? { contact: { AND: contactAnd } } : {}),
  };
}

@Controller("conversations")
export class ConversationsController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
    private realtime: RealtimeService,
  ) {}

  /**
   * Lista con filtros del clasificador + paginación por cursor.
   * Devuelve { items, nextCursor } con etapa, asignado y no leídos por ítem.
   */
  @Get()
  async list(
    @Query("status") status?: string,
    @Query("q") q?: string,
    @Query("ai") ai?: string,
    @Query("assigned") assigned?: string,
    @Query("agentId") agentId?: string,
    @Query("teamId") teamId?: string,
    @Query("stage") stage?: string,
    @Query("unanswered") unanswered?: string,
    @Query("blocked") blocked?: string,
    @Query("view") viewId?: string,
    @Query("order") order?: string,
    @Query("cursor") cursor?: string,
  ) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      // Bandeja guardada: su definición manda; los params sueltos la complementan.
      let viewDef: InboxViewDefinition = {};
      if (viewId) {
        const view = await tx.inboxView.findUnique({ where: { id: viewId } });
        if (view) viewDef = (view.definition as InboxViewDefinition) ?? {};
      }
      let tagContactIds: string[] | undefined;
      if (viewDef.tags?.length) {
        const tags = await tx.tag.findMany({ where: { name: { in: viewDef.tags } } });
        const asg = await tx.tagAssignment.findMany({
          where: { tagId: { in: tags.map((t) => t.id) }, entityType: "contact" },
          select: { entityId: true },
        });
        tagContactIds = [...new Set(asg.map((a) => a.entityId))];
      }

      const where: Record<string, unknown> = {
        ...buildViewWhere(viewDef, ctx.userId, tagContactIds),
        ...(status && status !== "all" && !viewDef.status ? { status: status.toUpperCase() as any } : {}),
        ...(ai === "on" ? { aiEnabled: true } : ai === "off" ? { aiEnabled: false } : {}),
        ...(assigned === "me"
          ? { assignedUserId: ctx.userId }
          : assigned === "unassigned"
            ? { assignedUserId: null, assignedTeamId: null }
            : {}),
        ...(agentId ? { activeAgentId: agentId, aiEnabled: true } : {}),
        ...(teamId ? { assignedTeamId: teamId } : {}),
        ...(unanswered === "1" ? { unreadCount: { gt: 0 } } : {}),
        ...(stage
          ? { contact: { leads: { some: { status: { code: stage } } }, blocked: false } }
          : blocked === "1"
            ? { contact: { blocked: true } }
            : {}),
        ...(q
          ? {
              contact: {
                OR: [
                  { firstName: { contains: q, mode: "insensitive" } },
                  { lastName: { contains: q, mode: "insensitive" } },
                  { profileName: { contains: q, mode: "insensitive" } },
                  { phone: { contains: q } },
                ],
              },
            }
          : {}),
      };

      const orderBy =
        order === "oldest"
          ? [{ lastMessageAt: { sort: "asc" as const, nulls: "last" as const } }]
          : order === "unanswered_first"
            ? [{ unreadCount: "desc" as const }, { lastMessageAt: { sort: "desc" as const, nulls: "last" as const } }]
            : [{ lastMessageAt: { sort: "desc" as const, nulls: "last" as const } }];

      const take = 40;
      const rows = await tx.conversation.findMany({
        where,
        include: {
          contact: {
            select: { id: true, firstName: true, lastName: true, profileName: true, phone: true, country: true, blocked: true, ctwaClid: true, adId: true },
          },
        },
        orderBy,
        take: take + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > take;
      const page = hasMore ? rows.slice(0, take) : rows;

      // Enriquecimiento en lote (sin N+1): etapa actual + nombres de asignados.
      const contactIds = [...new Set(page.map((c) => c.contactId))];
      const stages = contactIds.length
        ? await tx.$queryRaw<{ contact_id: string; code: string; name: string; color: string | null; emoji: string | null }[]>`
            SELECT DISTINCT ON (l.contact_id) l.contact_id, ls.code, ls.name, ls.color, ls.emoji
            FROM leads l JOIN lead_statuses ls ON ls.id = l.status_id
            WHERE l.contact_id = ANY(${contactIds})
            ORDER BY l.contact_id, l.created_at DESC`
        : [];
      const stageByContact = new Map(stages.map((s) => [s.contact_id, { code: s.code, name: s.name, color: s.color, emoji: s.emoji }]));

      const userIds = [...new Set(page.map((c) => c.assignedUserId).filter(Boolean))] as string[];
      const members = userIds.length
        ? await tx.organizationUser.findMany({ where: { userId: { in: userIds } }, include: { user: { select: { id: true, name: true } } } })
        : [];
      const nameByUser = new Map(members.map((m) => [m.userId, m.user.name]));
      const teams = await tx.team.findMany({ select: { id: true, name: true } });
      const nameByTeam = new Map(teams.map((t) => [t.id, t.name]));

      return {
        items: page.map((c) => ({
          id: c.id,
          status: c.status,
          aiEnabled: c.aiEnabled,
          assignedUserId: c.assignedUserId,
          assignedUserName: c.assignedUserId ? (nameByUser.get(c.assignedUserId) ?? null) : null,
          assignedTeamId: c.assignedTeamId,
          assignedTeamName: c.assignedTeamId ? (nameByTeam.get(c.assignedTeamId) ?? null) : null,
          activeAgentId: c.activeAgentId,
          channelConnectionId: c.channelConnectionId,
          unreadCount: c.unreadCount,
          lastMessagePreview: c.lastMessagePreview,
          lastMessageAt: c.lastMessageAt,
          stage: stageByContact.get(c.contactId) ?? null,
          contact: c.contact,
        })),
        nextCursor: hasMore ? page[page.length - 1]!.id : null,
      };
    });
  }

  /**
   * Contexto del panel derecho: contacto completo, etapa, tags, atribución de
   * anuncio/formulario e indicaciones activas para la IA.
   */
  @Get(":id/context")
  context(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id }, include: { contact: true } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const contact = conversation.contact;
      const [lead, tagAsg, aiNotes] = await Promise.all([
        tx.lead.findFirst({ where: { contactId: contact.id }, orderBy: { createdAt: "desc" }, include: { status: true } }),
        tx.tagAssignment.findMany({ where: { entityType: "contact", entityId: contact.id } }),
        tx.conversationAiNote.findMany({ where: { conversationId: id }, orderBy: { createdAt: "desc" }, take: 20 }),
      ]);
      const tagRows = tagAsg.length ? await tx.tag.findMany({ where: { id: { in: tagAsg.map((a) => a.tagId) } } }) : [];
      const meta = (contact.meta as Record<string, any>) ?? {};
      const attributes = (contact.attributes as Record<string, any>) ?? {};
      const referral = meta.referral ?? null;
      // Nombre de campaña/anuncio desde el catálogo (en vez del id crudo).
      const adCatalog = contact.adId
        ? await tx.metaAd.findUnique({
            where: { organizationId_adExternalId: { organizationId: ctx.organizationId, adExternalId: contact.adId } },
            select: { campaignName: true, adName: true },
          })
        : null;
      const noteAuthors = await this.userNames(tx, aiNotes.map((n) => n.createdById).filter(Boolean) as string[]);
      return {
        contact: {
          id: contact.id,
          firstName: contact.firstName,
          lastName: contact.lastName,
          profileName: contact.profileName,
          phone: contact.phone,
          email: contact.email,
          country: contact.country,
          source: contact.source,
          acquisitionSource: contact.acquisitionSource,
          blocked: contact.blocked,
          createdAt: contact.createdAt,
          isReturning: contact.isReturning,
        },
        stage: lead ? { code: lead.status.code, name: lead.status.name, color: lead.status.color, emoji: lead.status.emoji, category: lead.status.category } : null,
        tags: tagRows.map((t) => t.name),
        // Origen por anuncio Click-to-WhatsApp (banner en el hilo + panel)
        ad:
          contact.ctwaClid || contact.adId
            ? {
                ctwaClid: contact.ctwaClid,
                adId: contact.adId,
                campaignName: adCatalog?.campaignName ?? null,
                adName: adCatalog?.adName ?? null,
                headline: referral?.headline ?? null,
                body: referral?.body ?? null,
                imageUrl: referral?.image_url ?? referral?.thumbnail_url ?? null,
                sourceUrl: referral?.source_url ?? null,
                sourceType: referral?.source_type ?? null,
              }
            : null,
        // Origen por formulario de Meta Lead Ads (tarjeta con los datos)
        leadForm: attributes.metaLead
          ? { formId: attributes.metaLead.formId ?? null, fields: Object.entries(attributes.metaLead).filter(([k]) => !["leadgenId", "formId"].includes(k)) }
          : null,
        aiNotes: aiNotes.map((n) => ({
          id: n.id,
          body: n.body,
          active: n.active,
          createdAt: n.createdAt,
          deactivatedAt: n.deactivatedAt,
          createdBy: n.createdById ? (noteAuthors.get(n.createdById) ?? null) : null,
        })),
      };
    });
  }

  /** Cierra la conversación; nota de cierre opcional como comentario interno. */
  @Post(":id/close")
  close(@Param("id") id: string, @Body() body?: unknown) {
    const ctx = requireContext();
    const note = z.object({ note: z.string().max(2000).optional() }).safeParse(body ?? {}).data?.note;
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      await tx.conversation.update({ where: { id }, data: { status: "CLOSED" } });
      const userName = await this.userName(tx, ctx.userId);
      if (note?.trim()) {
        await tx.message.create({
          data: {
            organizationId: ctx.organizationId,
            conversationId: id,
            direction: "OUTBOUND",
            type: "NOTE",
            visibility: "INTERNAL",
            body: `Nota de cierre: ${note.trim()}`,
            authorType: "USER",
            authorUserId: ctx.userId,
            status: "DELIVERED",
          },
        });
      }
      await this.systemMessage(tx, ctx.organizationId, id, `✔ Conversación cerrada por ${userName}`);
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "conversation.close", entityType: "conversation", entityId: id },
      });
      return { ok: true, contactId: conversation.contactId };
    }).then(async (r) => {
      await this.queues.events.add("emit", {
        organizationId: ctx.organizationId,
        type: "conversation.closed",
        conversationId: id,
        contactId: r.contactId ?? undefined,
        data: { conversationId: id },
        occurredAt: new Date().toISOString(),
      });
      await this.publish(ctx.organizationId, id);
      return r;
    });
  }

  /**
   * Elimina UN mensaje del historial de TuBot. No lo borra del teléfono ni del
   * chat del cliente (la API de Meta no lo permite) — solo de la plataforma.
   */
  @Delete(":id/messages/:messageId")
  async deleteMessage(@Param("id") id: string, @Param("messageId") messageId: string) {
    const ctx = requirePermission("inbox:write");
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const msg = await tx.message.findFirst({ where: { id: messageId, conversationId: id } });
      if (!msg) throw new NotFoundException("Mensaje no encontrado");
      await tx.message.delete({ where: { id: messageId } }); // adjuntos caen en cascada
      // Recalcula el preview de la lista con el último mensaje visible restante
      const last = await tx.message.findFirst({
        where: { conversationId: id, visibility: { not: "INTERNAL" } },
        orderBy: { createdAt: "desc" },
        select: { body: true, createdAt: true },
      });
      await tx.conversation.update({
        where: { id },
        data: { lastMessagePreview: last?.body?.slice(0, 120) ?? null, ...(last ? { lastMessageAt: last.createdAt } : {}) },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "conversation.message_deleted",
          entityType: "message",
          entityId: messageId,
          before: { conversationId: id, direction: msg.direction, body: (msg.body ?? "").slice(0, 200) },
        },
      });
    });
    await this.realtime.publish(ctx.organizationId, { type: "message.updated", conversationId: id });
    return { ok: true };
  }

  /**
   * Elimina la conversación completa con su historial de mensajes. El contacto,
   * sus leads, citas y costos quedan intactos (solo se desvincula la referencia).
   */
  @Delete(":id")
  async deleteConversation(@Param("id") id: string) {
    const ctx = requirePermission("inbox:write");
    await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      // Referencias que deben sobrevivir al borrado (histórico de negocio)
      await tx.appointment.updateMany({ where: { conversationId: id }, data: { conversationId: null } });
      await tx.workflowRun.updateMany({ where: { conversationId: id }, data: { conversationId: null } });
      await tx.aiRequest.updateMany({ where: { conversationId: id }, data: { conversationId: null } });
      await tx.approvalRequest.updateMany({ where: { conversationId: id }, data: { conversationId: null } });
      // Dependientes de la conversación
      await tx.conversationAiNote.deleteMany({ where: { conversationId: id } });
      await tx.agentHandoff.deleteMany({ where: { conversationId: id } });
      await tx.humanHandoff.deleteMany({ where: { conversationId: id } });
      await tx.message.deleteMany({ where: { conversationId: id } }); // adjuntos en cascada
      await tx.conversation.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "conversation.deleted",
          entityType: "conversation",
          entityId: id,
          before: { contactId: conversation.contactId, channelConnectionId: conversation.channelConnectionId, preview: conversation.lastMessagePreview },
        },
      });
    });
    await this.realtime.publish(ctx.organizationId, { type: "conversation.updated", conversationId: id });
    return { ok: true };
  }

  @Post(":id/reopen")
  async reopen(@Param("id") id: string) {
    const ctx = requireContext();
    const r = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      await tx.conversation.update({ where: { id }, data: { status: "OPEN" } });
      await this.systemMessage(tx, ctx.organizationId, id, `↩ Conversación reabierta por ${await this.userName(tx, ctx.userId)}`);
      return { ok: true };
    });
    await this.publish(ctx.organizationId, id);
    return r;
  }

  /** Asigna a un usuario y/o equipo (null = quitar). Deja evento en el hilo. */
  @Post(":id/assign")
  async assign(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z
      .object({ userId: z.string().nullable().optional(), teamId: z.string().nullable().optional() })
      .safeParse(body);
    if (!parsed.success || (parsed.data.userId === undefined && parsed.data.teamId === undefined)) {
      throw new BadRequestException("userId y/o teamId requeridos (o null para quitar)");
    }
    const r = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const data: Record<string, unknown> = {};
      let label = "";
      if (parsed.data.userId !== undefined) {
        if (parsed.data.userId) {
          const member = await tx.organizationUser.findUnique({
            where: { organizationId_userId: { organizationId: ctx.organizationId, userId: parsed.data.userId } },
            include: { user: { select: { name: true } } },
          });
          if (!member || !member.active) throw new BadRequestException("El usuario no pertenece a la organización");
          label = `a ${member.user.name}`;
        } else {
          label = "sin responsable";
        }
        data.assignedUserId = parsed.data.userId;
      }
      if (parsed.data.teamId !== undefined) {
        if (parsed.data.teamId) {
          const team = await tx.team.findUnique({ where: { id: parsed.data.teamId } });
          if (!team) throw new BadRequestException("Equipo no encontrado");
          label = label ? `${label} (equipo ${team.name})` : `al equipo ${team.name}`;
        }
        data.assignedTeamId = parsed.data.teamId;
      }
      await tx.conversation.update({ where: { id }, data });
      await this.systemMessage(tx, ctx.organizationId, id, `👤 Asignada ${label || "—"} por ${await this.userName(tx, ctx.userId)}`);
      return { ok: true, assignedUserId: parsed.data.userId ?? null };
    });
    // Aviso por correo al asignado (preferencia personal assignedToMe; best-effort)
    if (r.assignedUserId && r.assignedUserId !== ctx.userId) {
      await this.notifyAssignment(ctx.organizationId, r.assignedUserId, id).catch(() => undefined);
    }
    await this.publish(ctx.organizationId, id);
    return r;
  }

  /**
   * Cambia la etapa del ciclo de vida del contacto desde la cabecera.
   * Deja evento en el hilo, dispara el trigger "Etapa actualizada" y responde
   * si la nueva etapa es de conversión (para ofrecer el envío CAPI).
   */
  @Post(":id/stage")
  async setStage(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ statusCode: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("statusCode requerido");
    const result = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const status = await tx.leadStatus.findUnique({
        where: { organizationId_code: { organizationId: ctx.organizationId, code: parsed.data.statusCode } },
      });
      if (!status) throw new BadRequestException("Etapa desconocida");
      let lead = await tx.lead.findFirst({
        where: { contactId: conversation.contactId },
        orderBy: { createdAt: "desc" },
        include: { status: true },
      });
      const fromCode = lead?.status.code ?? null;
      const fromName = lead?.status.name ?? null;
      if (fromCode === status.code) return { changed: false, from: fromCode, to: status.code, conversion: status.category === "WON", contactId: conversation.contactId };
      if (!lead) {
        lead = await tx.lead.create({ data: { organizationId: ctx.organizationId, contactId: conversation.contactId, statusId: status.id }, include: { status: true } });
      } else {
        await tx.lead.update({ where: { id: lead.id }, data: { statusId: status.id } });
      }
      await tx.leadEvent.create({
        data: { organizationId: ctx.organizationId, leadId: lead.id, type: "status_changed", data: { from: fromCode, to: status.code, via: "inbox" }, actorType: "user", actorId: ctx.userId },
      });
      await this.systemMessage(
        tx,
        ctx.organizationId,
        id,
        `🏷 Etapa: ${fromName ?? "—"} → ${status.name} · por ${await this.userName(tx, ctx.userId)}`,
      );
      // ¿La integración CAPI está lista? (para que la UI ofrezca enviar conversión)
      const mapping = await tx.metaEventMapping.findUnique({ where: { organizationId: ctx.organizationId } });
      return {
        changed: true,
        from: fromCode,
        to: status.code,
        conversion: status.category === "WON",
        capiReady: Boolean(mapping?.datasetId && mapping?.active !== false),
        contactId: conversation.contactId,
      };
    });
    if (result.changed) {
      // statusCode habilita las reglas CAPI por etapa ("lead.status_changed:<code>");
      // sin él, el cambio desde la bandeja no reportaba conversiones a Meta.
      await this.queues.events.add("emit", {
        organizationId: ctx.organizationId,
        type: "lead.status_changed",
        conversationId: id,
        contactId: result.contactId,
        data: { from: result.from, to: result.to, statusCode: result.to, via: "inbox", contactId: result.contactId },
        occurredAt: new Date().toISOString(),
      });
      await this.publish(ctx.organizationId, id);
    }
    return result;
  }

  /** Envío manual de un evento CAPI de conversión desde la cabecera (opt-in). */
  @Post(":id/capi")
  async sendCapi(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z
      .object({ eventName: z.string().min(1).max(60), value: z.number().optional(), currency: z.string().max(3).optional() })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("eventName requerido");
    const info = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id }, include: { contact: { select: { phone: true } } } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const mapping = await tx.metaEventMapping.findUnique({ where: { organizationId: ctx.organizationId } });
      if (!mapping?.datasetId) throw new BadRequestException("Conecta Meta Conversions API en Integraciones primero");
      return { phone: conversation.contact.phone, contactId: conversation.contactId };
    });
    await this.queues.capi.add("send", {
      organizationId: ctx.organizationId,
      source: "inbox.manual",
      contactPhone: info.phone,
      contactId: info.contactId,
      eventName: parsed.data.eventName,
      value: parsed.data.value ?? null,
      currency: parsed.data.currency ?? null,
      occurredAt: new Date().toISOString(),
    });
    return { ok: true };
  }

  /** Atajo manual: ejecutar un flujo publicado sobre esta conversación. */
  @Post(":id/run-workflow")
  async runWorkflow(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ workflowId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("workflowId requerido");
    const info = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const wf = await tx.workflow.findFirst({
        where: { id: parsed.data.workflowId, deletedAt: null, active: true },
        include: { versions: { where: { status: "PUBLISHED" }, take: 1 } },
      });
      if (!wf || wf.versions.length === 0) {
        throw new BadRequestException("El flujo no existe, no está activo o no tiene versión publicada");
      }
      await this.systemMessage(tx, ctx.organizationId, id, `⚡ Flujo «${wf.name}» ejecutado por ${await this.userName(tx, ctx.userId)}`);
      return { contactId: conversation.contactId };
    });
    await this.queues.events.add("emit", {
      organizationId: ctx.organizationId,
      type: "__manual_run__",
      conversationId: id,
      contactId: info.contactId ?? undefined,
      data: { workflowId: parsed.data.workflowId },
      occurredAt: new Date().toISOString(),
    });
    await this.publish(ctx.organizationId, id);
    return { ok: true };
  }

  @Get(":id/messages")
  messages(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id }, include: { contact: true } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const messages = await tx.message.findMany({
        where: { conversationId: id },
        orderBy: { createdAt: "asc" },
        take: 300,
      });
      // Nombres de autores humanos (comentarios internos / envíos del panel)
      const authorIds = [...new Set(messages.map((m) => m.authorUserId).filter(Boolean))] as string[];
      const authors = await this.userNames(tx, authorIds);
      // Marcar como leída al abrirla
      if (conversation.unreadCount > 0) {
        await tx.conversation.update({ where: { id }, data: { unreadCount: 0 } });
      }
      return {
        conversation,
        messages: messages.map((m) => ({ ...m, authorName: m.authorUserId ? (authors.get(m.authorUserId) ?? null) : null })),
      };
    });
  }

  /** Transmite el audio original de una nota de voz (descarga on-demand de Meta). */
  @Get(":id/messages/:messageId/audio")
  async messageAudio(@Param("id") id: string, @Param("messageId") messageId: string, @Res() res: Response) {
    const ctx = requireContext();
    const message = await this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.message.findFirst({ where: { id: messageId, conversationId: id } }),
    );
    if (!message) throw new NotFoundException("Mensaje no encontrado");
    const payload = (message.payload ?? {}) as any;
    const mediaId = payload?.audio?.id ?? payload?.voice?.id;
    if (!mediaId) throw new NotFoundException("Este mensaje no tiene audio");
    const env = getEnv();
    const metaRes = await fetch(withAppSecretProof(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(String(mediaId))}`, env.META_ACCESS_TOKEN), {
      headers: { authorization: `Bearer ${env.META_ACCESS_TOKEN}` },
    });
    const meta: any = await metaRes.json().catch(() => ({}));
    if (!meta?.url) throw new NotFoundException("Audio no disponible (puede haber expirado en Meta)");
    const audioRes = await fetch(meta.url, { headers: { authorization: `Bearer ${env.META_ACCESS_TOKEN}` } });
    if (!audioRes.ok) throw new NotFoundException("No se pudo obtener el audio");
    const buf = Buffer.from(await audioRes.arrayBuffer());
    res.setHeader("content-type", meta.mime_type ?? "audio/ogg");
    res.setHeader("cache-control", "private, max-age=3600");
    res.send(buf);
  }

  /**
   * Envío manual desde el panel (autor humano) — o comentario interno si
   * internal=true: queda en el hilo SOLO para el equipo y JAMÁS va al canal
   * (visibility INTERNAL y sin encolar a outbound).
   */
  @Post(":id/messages")
  async send(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = sendMessageSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Texto requerido");
    const internal = parsed.data.internal === true;
    const message = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const msg = await tx.message.create({
        data: {
          organizationId: ctx.organizationId,
          conversationId: id,
          direction: "OUTBOUND",
          type: internal ? "NOTE" : "TEXT",
          visibility: internal ? "INTERNAL" : "PUBLIC",
          body: parsed.data.text,
          authorType: "USER",
          authorUserId: ctx.userId,
          status: internal ? "DELIVERED" : "PENDING",
        },
      });
      if (!internal) {
        await tx.conversation.update({
          where: { id },
          data: { lastMessageAt: new Date(), lastMessagePreview: parsed.data.text.slice(0, 120) },
        });
      }
      return msg;
    });
    if (!internal) {
      await this.queues.outbound.add("send", {
        organizationId: ctx.organizationId,
        conversationId: id,
        messageId: message.id,
      });
    }
    await this.realtime.publish(ctx.organizationId, { type: "message.created", conversationId: id });
    return message;
  }

  /**
   * Adjunto saliente (imagen/documento): sube el binario a Meta con el token
   * del canal y encola el envío. JSON base64 (tope 5 MB) — sin storage propio.
   */
  @Post(":id/attachments")
  async sendAttachment(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z
      .object({
        kind: z.enum(["image", "document"]),
        filename: z.string().min(1).max(200),
        mime: z.string().min(3).max(100),
        dataBase64: z.string().min(1),
        caption: z.string().max(1024).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Adjunto inválido");
    const buf = Buffer.from(parsed.data.dataBase64, "base64");
    if (buf.length > 5 * 1024 * 1024) throw new BadRequestException("El archivo supera 5 MB");
    if (parsed.data.kind === "image" && !/^image\/(jpeg|png|webp)$/.test(parsed.data.mime)) {
      throw new BadRequestException("Imágenes: JPG, PNG o WebP");
    }

    const env = getEnv();
    const chan = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      if (!conversation.channelConnectionId) throw new BadRequestException("La conversación no tiene canal");
      const number = await tx.whatsappPhoneNumber.findFirst({ where: { channelConnectionId: conversation.channelConnectionId } });
      if (!number) throw new BadRequestException("El canal no tiene número de WhatsApp");
      const account = await tx.whatsappAccount.findUnique({ where: { id: number.accountId } });
      const credential = account?.credentialId ? await tx.integrationCredential.findUnique({ where: { id: account.credentialId } }) : null;
      return { phoneNumberId: number.phoneNumberId, token: credential ? decryptSecret(credential.ciphertext) : env.META_ACCESS_TOKEN };
    });
    if (!chan.token) throw new BadRequestException("El canal no tiene token de acceso");

    // Subir el binario a Meta (media id) — Meta lo hospeda, no necesitamos S3.
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", parsed.data.mime);
    form.append("file", new Blob([new Uint8Array(buf)], { type: parsed.data.mime }), parsed.data.filename);
    const upload = await fetch(withAppSecretProof(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${chan.phoneNumberId}/media`, chan.token), {
      method: "POST",
      headers: { authorization: `Bearer ${chan.token}` },
      body: form,
    });
    const uploaded: any = await upload.json().catch(() => ({}));
    if (!upload.ok || !uploaded.id) {
      throw new BadRequestException(`Meta rechazó el archivo: ${JSON.stringify(uploaded?.error?.message ?? upload.status).slice(0, 200)}`);
    }

    const message = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const msg = await tx.message.create({
        data: {
          organizationId: ctx.organizationId,
          conversationId: id,
          direction: "OUTBOUND",
          type: parsed.data.kind === "image" ? "IMAGE" : "DOCUMENT",
          body: parsed.data.caption ?? (parsed.data.kind === "image" ? "📷 Imagen" : `📎 ${parsed.data.filename}`),
          authorType: "USER",
          authorUserId: ctx.userId,
          status: "PENDING",
          payload: { mediaId: uploaded.id, filename: parsed.data.filename, mime: parsed.data.mime, caption: parsed.data.caption ?? null },
        },
      });
      await tx.conversation.update({
        where: { id },
        data: { lastMessageAt: new Date(), lastMessagePreview: parsed.data.kind === "image" ? "📷 Imagen" : `📎 ${parsed.data.filename}` },
      });
      return msg;
    });
    await this.queues.outbound.add("send", { organizationId: ctx.organizationId, conversationId: id, messageId: message.id });
    await this.realtime.publish(ctx.organizationId, { type: "message.created", conversationId: id });
    return message;
  }

  /** Envía una plantilla HSM aprobada (única vía fuera de la ventana de 24 h). */
  /**
   * Inicia (o reutiliza) una conversación de WhatsApp con un contacto y le
   * envía una plantilla aprobada. Es la vía para contactar leads que nunca
   * escribieron (p. ej. formulario de Lead Ads sin clic al botón de WhatsApp):
   * fuera de la ventana de 24 h solo se puede abrir con plantilla.
   */
  @Post("start")
  async start(@Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z
      .object({
        contactId: z.string().min(1).optional(),
        /** número nuevo: crea el contacto al vuelo (lead que aún no existe en la base) */
        phone: z.string().min(8).max(20).optional(),
        name: z.string().trim().max(120).optional(),
        channelId: z.string().min(1).optional(),
        templateId: z.string().min(1),
      })
      .refine((v) => v.contactId || v.phone, { message: "contactId o phone requerido" })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("contactId (o phone) y templateId requeridos");
    const { contactId, phone: rawPhone, name, channelId, templateId } = parsed.data;

    const conversationId = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      let contact = contactId ? await tx.contact.findFirst({ where: { id: contactId, deletedAt: null } }) : null;
      if (!contact && rawPhone) {
        // Normaliza igual que la ingesta de leads: solo dígitos, sin "+".
        const phone = rawPhone.replace(/[^\d+]/g, "").replace(/^\+/, "");
        if (phone.length < 8) throw new BadRequestException("Número de teléfono inválido");
        contact =
          (await tx.contact.findFirst({ where: { phone, deletedAt: null } })) ??
          (await tx.contact.create({
            data: {
              organizationId: ctx.organizationId,
              firstName: name || null,
              phone,
              source: "manual",
              acquisitionSource: "organic",
            },
          }));
      }
      if (!contact) throw new NotFoundException("Contacto no encontrado");
      if (!contact.phone) {
        throw new BadRequestException("El contacto no tiene teléfono — las plantillas de WhatsApp necesitan un número");
      }

      const channel = channelId
        ? await tx.channelConnection.findFirst({ where: { id: channelId, type: "WHATSAPP_CLOUD" } })
        : await tx.channelConnection.findFirst({ where: { type: "WHATSAPP_CLOUD", status: "active" }, orderBy: { createdAt: "asc" } });
      if (!channel) throw new BadRequestException("No hay un canal de WhatsApp activo para enviar la plantilla");

      // Reutiliza la conversación abierta del contacto EN ESTE canal (si la
      // hay); si su conversación abierta vive en otro canal (p. ej. Instagram)
      // se crea una aparte para no desviar ese hilo.
      let conversation = await tx.conversation.findFirst({
        where: { contactId: contact.id, channelConnectionId: channel.id, status: { in: ["OPEN", "PENDING"] } },
        orderBy: { createdAt: "desc" },
      });
      if (!conversation) {
        conversation = await tx.conversation.create({
          data: {
            organizationId: ctx.organizationId,
            clinicId: contact.clinicId ?? null,
            contactId: contact.id,
            channelConnectionId: channel.id,
            activeAgentId: channel.defaultAgentId ?? null,
            status: "OPEN",
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: ctx.organizationId,
            actorType: "user",
            actorId: ctx.userId,
            action: "conversation.start_outbound",
            entityType: "conversation",
            entityId: conversation.id,
            after: { contactId: contact.id, channelId: channel.id },
          },
        });
      }
      return conversation.id;
    });

    const message = await this.sendTemplate(conversationId, { templateId });
    return { conversationId, message };
  }

  @Post(":id/send-template")
  async sendTemplate(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ templateId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("templateId requerido");
    const message = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const template = await tx.whatsappTemplate.findUnique({ where: { id: parsed.data.templateId } });
      if (!template) throw new BadRequestException("Plantilla no encontrada — sincroniza las plantillas del canal");
      if (template.status !== "APPROVED") {
        throw new BadRequestException(`La plantilla «${template.name}» no está aprobada por Meta (estado: ${template.status})`);
      }
      const components = ((template.body as Record<string, any>)?.components ?? []) as any[];
      const preview = components.find((c) => c?.type === "BODY")?.text ?? `[plantilla ${template.name}]`;
      const msg = await tx.message.create({
        data: {
          organizationId: ctx.organizationId,
          conversationId: id,
          direction: "OUTBOUND",
          type: "TEMPLATE",
          body: preview,
          authorType: "USER",
          authorUserId: ctx.userId,
          status: "PENDING",
          payload: { templateId: template.id, templateName: template.name },
        },
      });
      await tx.conversation.update({
        where: { id },
        data: { lastMessageAt: new Date(), lastMessagePreview: preview.slice(0, 120) },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "conversation.send_template",
          entityType: "conversation",
          entityId: id,
          after: { template: template.name, language: template.language },
        },
      });
      return msg;
    });
    await this.queues.outbound.add("send", {
      organizationId: ctx.organizationId,
      conversationId: id,
      messageId: message.id,
    });
    await this.realtime.publish(ctx.organizationId, { type: "message.created", conversationId: id });
    return message;
  }

  /** Toma de control humano: la IA deja de responder. */
  @Post(":id/takeover")
  async takeover(@Param("id") id: string) {
    const ctx = requireContext();
    const r = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      await tx.conversation.update({
        where: { id },
        data: { aiEnabled: false, assignedUserId: ctx.userId },
      });
      await tx.humanHandoff.create({
        data: {
          organizationId: ctx.organizationId,
          conversationId: id,
          requestedBy: "user",
          status: "ACTIVE",
          userId: ctx.userId,
          takenAt: new Date(),
        },
      });
      await this.systemMessage(tx, ctx.organizationId, id, `🙋 ${await this.userName(tx, ctx.userId)} tomó el control (IA en pausa)`);
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "conversation.takeover", entityType: "conversation", entityId: id },
      });
      return { ok: true, aiEnabled: false };
    });
    await this.publish(ctx.organizationId, id);
    return r;
  }

  /** Devuelve el control a la IA (retoma con historial + indicaciones activas). */
  @Post(":id/release")
  async release(@Param("id") id: string) {
    const ctx = requireContext();
    const r = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      await tx.conversation.update({ where: { id }, data: { aiEnabled: true } });
      await tx.humanHandoff.updateMany({
        where: { conversationId: id, status: "ACTIVE" },
        data: { status: "RETURNED_TO_AI", resolvedAt: new Date() },
      });
      await this.systemMessage(tx, ctx.organizationId, id, `🤖 Control devuelto a la IA por ${await this.userName(tx, ctx.userId)}`);
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "conversation.release_to_ai", entityType: "conversation", entityId: id },
      });
      return { ok: true, aiEnabled: true };
    });
    await this.publish(ctx.organizationId, id);
    // Al devolver el control a la IA, si hay un mensaje del contacto sin responder,
    // el agente retoma y responde.
    await this.maybeTriggerAgentTurn(ctx.organizationId, id).catch(() => undefined);
    return r;
  }

  /** Asigna (o cambia) el agente de IA a cargo. */
  @Post(":id/agent")
  async setAgent(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ agentId: z.string().min(1).nullable() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("agentId inválido");
    const r = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const agentId = parsed.data.agentId;
      let agentName: string | null = null;
      if (agentId) {
        const agent = await tx.agent.findFirst({ where: { id: agentId, deletedAt: null } });
        if (!agent) throw new BadRequestException("Agente no encontrado");
        agentName = agent.name;
      }
      await tx.conversation.update({ where: { id }, data: { activeAgentId: agentId, aiEnabled: !!agentId } });
      if (agentId) {
        await tx.humanHandoff.updateMany({
          where: { conversationId: id, status: "ACTIVE" },
          data: { status: "RETURNED_TO_AI", resolvedAt: new Date() },
        });
      }
      await this.systemMessage(
        tx,
        ctx.organizationId,
        id,
        agentName ? `🤖 Agente «${agentName}» a cargo · por ${await this.userName(tx, ctx.userId)}` : `🤖 IA desactivada por ${await this.userName(tx, ctx.userId)}`,
      );
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "conversation.set_agent", entityType: "conversation", entityId: id, after: { agentId } },
      });
      return { ok: true, activeAgentId: agentId, aiEnabled: !!agentId };
    });
    await this.publish(ctx.organizationId, id);
    // Al poner un agente a cargo, si el contacto escribió y quedó sin responder,
    // el agente responde ahora.
    await this.maybeTriggerAgentTurn(ctx.organizationId, id).catch(() => undefined);
    return r;
  }

  /**
   * Reasigna el CANAL (número de WhatsApp) por el que sale esta conversación.
   * Útil cuando el tenant opera varios números y quiere responder por uno u otro,
   * o cuando una conversación quedó atada a un canal viejo/reconectado. El worker
   * también la re-ata sola al canal que recibe el próximo mensaje entrante.
   */
  @Post(":id/channel")
  async setChannel(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ channelConnectionId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("channelConnectionId requerido");
    const r = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const channel = await tx.channelConnection.findFirst({ where: { id: parsed.data.channelConnectionId } });
      if (!channel) throw new BadRequestException("Canal no encontrado");
      if (channel.status === "inactive") throw new BadRequestException("Ese canal está inactivo");
      if (channel.type === "WHATSAPP_CLOUD") {
        const number = await tx.whatsappPhoneNumber.findFirst({ where: { channelConnectionId: channel.id } });
        if (!number) throw new BadRequestException("Ese canal no tiene un número de WhatsApp asociado");
      }
      await tx.conversation.update({ where: { id }, data: { channelConnectionId: channel.id } });
      await this.systemMessage(tx, ctx.organizationId, id, `📱 Canal de envío: «${channel.name}» · por ${await this.userName(tx, ctx.userId)}`);
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "conversation.set_channel", entityType: "conversation", entityId: id, after: { channelConnectionId: channel.id, name: channel.name } },
      });
      return { ok: true, channelConnectionId: channel.id };
    });
    await this.publish(ctx.organizationId, id);
    return r;
  }

  // ------------------- Indicaciones para la IA (por conversación) -------------------

  @Get(":id/ai-notes")
  aiNotes(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const notes = await tx.conversationAiNote.findMany({ where: { conversationId: id }, orderBy: { createdAt: "desc" }, take: 50 });
      const authors = await this.userNames(tx, notes.map((n) => n.createdById).filter(Boolean) as string[]);
      return notes.map((n) => ({
        id: n.id,
        body: n.body,
        active: n.active,
        createdAt: n.createdAt,
        deactivatedAt: n.deactivatedAt,
        createdBy: n.createdById ? (authors.get(n.createdById) ?? null) : null,
      }));
    });
  }

  /** Crea una indicación para la IA en ESTA conversación (se inyecta al prompt). */
  @Post(":id/ai-notes")
  async createAiNote(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ body: z.string().min(2).max(1000) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Texto de la indicación requerido (2-1000)");
    const note = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const created = await tx.conversationAiNote.create({
        data: { organizationId: ctx.organizationId, conversationId: id, body: parsed.data.body.trim(), createdById: ctx.userId },
      });
      await this.systemMessage(tx, ctx.organizationId, id, `💡 Indicación para la IA agregada por ${await this.userName(tx, ctx.userId)}`);
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "conversation.ai_note_create", entityType: "conversation", entityId: id },
      });
      return created;
    });
    // Si la IA está a cargo y el último mensaje del contacto quedó sin responder,
    // la indicación hace que el agente responda ahora (siguiéndola).
    await this.maybeTriggerAgentTurn(ctx.organizationId, id).catch(() => undefined);
    return note;
  }

  /**
   * Encola un turno del agente si: la IA está activa, hay agente a cargo, y el
   * último mensaje real (no de sistema) es del CONTACTO sin responder. Evita que
   * el bot hable solo si el último mensaje ya era suyo.
   */
  private async maybeTriggerAgentTurn(organizationId: string, conversationId: string): Promise<void> {
    const should = await this.prisma.withTenant(organizationId, async (tx) => {
      const conv = await tx.conversation.findUnique({ where: { id: conversationId }, select: { aiEnabled: true, activeAgentId: true } });
      if (!conv?.aiEnabled || !conv.activeAgentId) return false;
      const last = await tx.message.findFirst({
        where: { conversationId, type: { notIn: ["SYSTEM", "NOTE"] } },
        orderBy: { createdAt: "desc" },
        select: { direction: true },
      });
      return last?.direction === "INBOUND";
    });
    if (should) await this.queues.enqueueAgentTurn({ organizationId, conversationId });
  }

  /** Activa/desactiva una indicación (queda en el historial). */
  @Patch("ai-notes/:noteId")
  toggleAiNote(@Param("noteId") noteId: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ active: z.boolean() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("active requerido");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const note = await tx.conversationAiNote.findUnique({ where: { id: noteId } });
      if (!note) throw new NotFoundException("Indicación no encontrada");
      return tx.conversationAiNote.update({
        where: { id: noteId },
        data: { active: parsed.data.active, deactivatedAt: parsed.data.active ? null : new Date() },
      });
    });
  }

  // ------------------------------- Tiempo real -------------------------------

  /**
   * SSE en vivo vía pub/sub Redis (canal por tenant). El front se conecta con
   * fetch streaming (Authorization normal). Si Redis o la conexión fallan, el
   * panel cae automáticamente a sondeo.
   */
  @Get("stream/updates")
  async stream(@Res() res: Response) {
    const ctx = requireContext();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: "connected", at: new Date().toISOString() })}\n\n`);

    const unsubscribe = await this.realtime.subscribe(ctx.organizationId, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const keepalive = setInterval(() => res.write(`: keepalive\n\n`), 25_000);
    res.on("close", () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  }

  // ------------------------------- Helpers -------------------------------

  /** Evento de sistema inline en el hilo (visible solo para el equipo). */
  private async systemMessage(tx: any, organizationId: string, conversationId: string, text: string): Promise<void> {
    await tx.message.create({
      data: {
        organizationId,
        conversationId,
        direction: "OUTBOUND",
        type: "SYSTEM",
        visibility: "INTERNAL",
        body: text,
        authorType: "SYSTEM",
        status: "DELIVERED",
      },
    });
  }

  private async userName(tx: any, userId: string): Promise<string> {
    const member = await tx.organizationUser.findUnique({
      where: { organizationId_userId: { organizationId: requireContext().organizationId, userId } },
      include: { user: { select: { name: true } } },
    });
    return member?.user?.name ?? "un usuario";
  }

  private async userNames(tx: any, userIds: string[]): Promise<Map<string, string>> {
    if (!userIds.length) return new Map();
    const members = await tx.organizationUser.findMany({
      where: { userId: { in: [...new Set(userIds)] } },
      include: { user: { select: { id: true, name: true } } },
    });
    return new Map(members.map((m: any) => [m.userId, m.user.name]));
  }

  /** Correo «te asignaron una conversación» respetando la preferencia personal. */
  private async notifyAssignment(organizationId: string, userId: string, conversationId: string): Promise<void> {
    // Unificado: el despachador resuelve preferencias y canales (in-app, correo,
    // web push…). Aquí solo emitimos el evento con su contexto.
    const contactName = await this.prisma.withTenant(organizationId, async (tx) => {
      const conv = await tx.conversation.findUnique({
        where: { id: conversationId },
        select: { contact: { select: { firstName: true, lastName: true } } },
      });
      const c = conv?.contact;
      return [c?.firstName, c?.lastName].filter(Boolean).join(" ").trim() || "Contacto";
    });
    await this.queues.notify({
      eventKey: "conversation.assigned",
      organizationId,
      userIds: [userId],
      conversationId,
      data: { contactName, conversationId },
    });
  }

  private async publish(organizationId: string, conversationId: string): Promise<void> {
    await this.realtime.publish(organizationId, { type: "conversation.updated", conversationId });
    await this.realtime.publish(organizationId, { type: "counters.dirty" });
  }
}
