import { BadRequestException, Controller, ForbiddenException, HttpCode, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { verifyMetaSignature } from "../channels/signature";

// Eventos del contrato Cláriva → Conversia (docs/CLARIVA.md).
const CLARIVA_EVENTS = [
  "appointment.created",
  "appointment.updated",
  "appointment.confirmed",
  "appointment.cancelled",
  "appointment.rescheduled",
  "appointment.attendance",
  "patient.updated",
] as const;

const clarivaBody = z.object({
  event: z.enum(CLARIVA_EVENTS),
  occurredAt: z.string(),
  data: z.record(z.unknown()),
});

/**
 * Receptor de webhooks de Cláriva. La URL incluye el id de la conexión de
 * agenda (se la damos a Cláriva al conectar): así el tenant queda resuelto sin
 * búsqueda global y cada conexión firma con su propio secreto
 * (config.webhookSecret, mismo esquema sha256=HMAC que Meta). Solo valida y
 * encola; el worker actualiza la proyección local y dispara los workflows.
 */
@Controller("webhooks/clariva")
export class ClarivaWebhookController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
  ) {}

  @Post(":connectionId")
  @HttpCode(200)
  async receive(@Param("connectionId") connectionId: string, @Req() req: Request & { rawBody?: Buffer }) {
    // Cliente admin SOLO para ruteo (webhook público, sin JWT) — igual que la
    // resolución de tenant por número en WhatsApp.
    const conn = await this.prisma.admin.schedulingConnection.findUnique({ where: { id: connectionId } });
    if (!conn || conn.provider !== "CLARIVA" || conn.status !== "active") {
      throw new NotFoundException("Conexión no encontrada");
    }
    const secret = (conn.config as Record<string, unknown> | null)?.webhookSecret;
    if (typeof secret !== "string" || !secret) {
      throw new ForbiddenException("Webhook no habilitado para esta conexión");
    }
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), "utf-8");
    const signature = req.headers["x-clariva-signature"] as string | undefined;
    if (!verifyMetaSignature(raw, signature, secret)) {
      throw new ForbiddenException("Firma de webhook inválida");
    }

    const parsed = clarivaBody.safeParse(req.body);
    if (!parsed.success) throw new BadRequestException("Payload inválido");

    await this.queues.events.add(
      "emit",
      {
        organizationId: conn.organizationId,
        type: "__clariva_webhook__",
        data: { connectionId, event: parsed.data.event, payload: parsed.data.data },
        occurredAt: parsed.data.occurredAt,
      },
      { removeOnComplete: 1000, removeOnFail: 5000 },
    );
    return { received: true };
  }
}
