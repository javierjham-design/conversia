import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { getEnv } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { requireContext } from "../tenancy/context";

const sendMessageSchema = z.object({ text: z.string().min(1).max(4096) });

@Controller("conversations")
export class ConversationsController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
  ) {}

  @Get()
  list(
    @Query("status") status?: string,
    @Query("q") q?: string,
    @Query("ai") ai?: string,
    @Query("assigned") assigned?: string,
  ) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.conversation.findMany({
        where: {
          ...(status && status !== "all" ? { status: status.toUpperCase() as any } : {}),
          ...(ai === "on" ? { aiEnabled: true } : ai === "off" ? { aiEnabled: false } : {}),
          ...(assigned === "me"
            ? { assignedUserId: ctx.userId }
            : assigned === "unassigned"
              ? { assignedUserId: null }
              : {}),
          ...(q
            ? {
                contact: {
                  OR: [
                    { firstName: { contains: q, mode: "insensitive" } },
                    { lastName: { contains: q, mode: "insensitive" } },
                    { phone: { contains: q } },
                  ],
                },
              }
            : {}),
        },
        include: { contact: { select: { id: true, firstName: true, lastName: true, profileName: true, phone: true } } },
        orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
        take: 50,
      }),
    );
  }

  /** Cierra la conversación (los workflows con trigger de cierre se disparan en fase 4). */
  @Post(":id/close")
  close(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      // findUnique bajo RLS → null si es de otro tenant (404 limpio, no 500)
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      await tx.conversation.update({ where: { id }, data: { status: "CLOSED" } });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "conversation.close",
          entityType: "conversation",
          entityId: id,
        },
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
      return r;
    });
  }

  @Post(":id/reopen")
  reopen(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      await tx.conversation.update({ where: { id }, data: { status: "OPEN" } });
      return { ok: true };
    });
  }

  /** Asigna la conversación a un usuario del equipo (null = sin asignar). */
  @Post(":id/assign")
  assign(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ userId: z.string().nullable() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("userId requerido (o null)");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      if (parsed.data.userId) {
        const member = await tx.organizationUser.findUnique({
          where: { organizationId_userId: { organizationId: ctx.organizationId, userId: parsed.data.userId } },
        });
        if (!member || !member.active) throw new BadRequestException("El usuario no pertenece a la organización");
      }
      await tx.conversation.update({ where: { id }, data: { assignedUserId: parsed.data.userId } });
      return { ok: true };
    });
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
        take: 200,
      });
      return { conversation, messages };
    });
  }

  /** Transmite el audio original de una nota de voz (lo descarga de Meta on-demand
   *  con el token de la plataforma). Permite al operador escucharlo por si acaso. */
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

  /** Envío manual desde el panel (autor humano). */
  @Post(":id/messages")
  async send(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = sendMessageSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Texto requerido");
    const message = await this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const msg = await tx.message.create({
        data: {
          organizationId: ctx.organizationId,
          conversationId: id,
          direction: "OUTBOUND",
          type: "TEXT",
          body: parsed.data.text,
          authorType: "USER",
          authorUserId: ctx.userId,
          status: "PENDING",
        },
      });
      await tx.conversation.update({
        where: { id },
        data: { lastMessageAt: new Date(), lastMessagePreview: parsed.data.text.slice(0, 120) },
      });
      return msg;
    });
    await this.queues.outbound.add("send", {
      organizationId: ctx.organizationId,
      conversationId: id,
      messageId: message.id,
    });
    return message;
  }

  /** Toma de control humano: la IA deja de responder (sección 7). */
  @Post(":id/takeover")
  takeover(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
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
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "conversation.takeover",
          entityType: "conversation",
          entityId: id,
        },
      });
      return { ok: true, aiEnabled: false };
    });
  }

  /** Devuelve el control a la IA. */
  @Post(":id/release")
  release(@Param("id") id: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      await tx.conversation.update({ where: { id }, data: { aiEnabled: true } });
      await tx.humanHandoff.updateMany({
        where: { conversationId: id, status: "ACTIVE" },
        data: { status: "RETURNED_TO_AI", resolvedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "conversation.release_to_ai",
          entityType: "conversation",
          entityId: id,
        },
      });
      return { ok: true, aiEnabled: true };
    });
  }

  /**
   * Asigna (o cambia) el agente de IA a cargo de la conversación. Al asignar uno,
   * la IA retoma el control (aiEnabled=true) y responde según su configuración;
   * agentId=null desactiva la IA. Cierra cualquier handoff humano activo.
   */
  @Post(":id/agent")
  setAgent(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const parsed = z.object({ agentId: z.string().min(1).nullable() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException("agentId inválido");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conversation = await tx.conversation.findUnique({ where: { id } });
      if (!conversation) throw new NotFoundException("Conversación no encontrada");
      const agentId = parsed.data.agentId;
      if (agentId) {
        const agent = await tx.agent.findFirst({ where: { id: agentId, deletedAt: null } });
        if (!agent) throw new BadRequestException("Agente no encontrado");
      }
      await tx.conversation.update({ where: { id }, data: { activeAgentId: agentId, aiEnabled: !!agentId } });
      if (agentId) {
        await tx.humanHandoff.updateMany({
          where: { conversationId: id, status: "ACTIVE" },
          data: { status: "RETURNED_TO_AI", resolvedAt: new Date() },
        });
      }
      await tx.auditLog.create({
        data: {
          organizationId: ctx.organizationId,
          actorType: "user",
          actorId: ctx.userId,
          action: "conversation.set_agent",
          entityType: "conversation",
          entityId: id,
          after: { agentId },
        },
      });
      return { ok: true, activeAgentId: agentId, aiEnabled: !!agentId };
    });
  }

  /**
   * Tiempo real v0: SSE con sondeo cada 3s de conversaciones actualizadas.
   * (Upgrade documentado: pub/sub Redis → websockets.)
   */
  @Get("stream/updates")
  stream(@Res() res: Response) {
    const ctx = requireContext();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    let since = new Date();
    const interval = setInterval(async () => {
      try {
        const updated = await this.prisma.withTenant(ctx.organizationId, (tx) =>
          tx.conversation.findMany({
            where: { updatedAt: { gt: since } },
            include: { contact: { select: { firstName: true, lastName: true, profileName: true, phone: true } } },
            take: 20,
          }),
        );
        since = new Date();
        if (updated.length) {
          res.write(`data: ${JSON.stringify({ type: "conversations.updated", items: updated })}\n\n`);
        } else {
          res.write(`: keepalive\n\n`);
        }
      } catch {
        // la conexión se limpia en 'close'
      }
    }, 3000);

    res.on("close", () => clearInterval(interval));
  }
}
