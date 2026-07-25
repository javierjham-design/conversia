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
  list(@Query("status") status?: string, @Query("q") q?: string) {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.conversation.findMany({
        where: {
          ...(status ? { status: status.toUpperCase() as any } : {}),
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
        include: { contact: { select: { id: true, firstName: true, lastName: true, phone: true } } },
        orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
        take: 50,
      }),
    );
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
            include: { contact: { select: { firstName: true, lastName: true, phone: true } } },
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
