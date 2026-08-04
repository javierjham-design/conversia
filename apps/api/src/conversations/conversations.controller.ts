import {
  BadRequestException,
  Body,
  Controller,
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
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { RealtimeService } from "../common/realtime.service";
import { decryptSecret } from "../common/crypto";
import { requireContext } from "../tenancy/context";

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
      await this.queues.events.add("emit", {
        organizationId: ctx.organizationId,
        type: "lead.status_changed",
        conversationId: id,
        contactId: result.contactId,
        data: { from: result.from, to: result.to, via: "inbox" },
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
      return { phone: conversation.contact.phone };
    });
    await this.queues.capi.add("send", {
      organizationId: ctx.organizationId,
      source: "inbox.manual",
      contactPhone: info.phone,
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
    const metaRes = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(String(mediaId))}`, {
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
    const upload = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${chan.phoneNumberId}/media`, {
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
  createAiNote(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ body: z.string().min(2).max(1000) }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("Texto de la indicación requerido (2-1000)");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const note = await tx.conversationAiNote.create({
        data: { organizationId: ctx.organizationId, conversationId: id, body: parsed.data.body.trim(), createdById: ctx.userId },
      });
      await this.systemMessage(tx, ctx.organizationId, id, `💡 Indicación para la IA agregada por ${await this.userName(tx, ctx.userId)}`);
      await tx.auditLog.create({
        data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId, action: "conversation.ai_note_create", entityType: "conversation", entityId: id },
      });
      return note;
    });
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
    const info = await this.prisma.withTenant(organizationId, async (tx) => {
      const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { settings: true, name: true } });
      const prefs = ((((org?.settings ?? {}) as Record<string, any>).notifPrefs ?? {}) as Record<string, any>)[userId] ?? {};
      if (prefs.assignedToMe === false) return null;
      const member = await tx.organizationUser.findUnique({
        where: { organizationId_userId: { organizationId, userId } },
        include: { user: { select: { email: true, name: true } } },
      });
      return member ? { email: member.user.email, name: member.user.name, orgName: org?.name ?? "TuBot" } : null;
    });
    if (!info) return;
    await this.queues.emails.add("assignment", {
      organizationId,
      kind: "alert",
      to: [info.email],
      subject: `Te asignaron una conversación en ${info.orgName}`,
      html: `<p>Hola ${info.name}: te asignaron una conversación en la Bandeja.</p><p><a href="https://www.tubot.cl/inbox">Abrir la Bandeja</a> (conversación ${conversationId.slice(0, 8)}…)</p>`,
    });
  }

  private async publish(organizationId: string, conversationId: string): Promise<void> {
    await this.realtime.publish(organizationId, { type: "conversation.updated", conversationId });
    await this.realtime.publish(organizationId, { type: "counters.dirty" });
  }
}
