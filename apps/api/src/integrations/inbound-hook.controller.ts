import { Controller, ForbiddenException, HttpCode, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { PrismaService } from "../prisma.service";
import { QueueService } from "../queues";
import { decryptSecret } from "../common/crypto";
import { verifyMetaSignature } from "../channels/signature";

const MAX_PAYLOAD_BYTES = 64 * 1024; // el payload viaja como variables de flujo — acotado

/**
 * Receptor PÚBLICO de webhooks entrantes por tenant (/hooks/t/{token}).
 * El token único resuelve la organización sin JWT (mismo criterio que el
 * webhook de WhatsApp por phone_number_id). Con secreto configurado exige
 * firma sha256=HMAC(raw) en X-Conversia-Signature. Solo valida, registra y
 * encola: el worker dispara los workflows con trigger "Webhook entrante" y el
 * payload queda disponible como variables ({{webhook.campo}}).
 */
@Controller("hooks")
export class InboundHookController {
  constructor(
    private prisma: PrismaService,
    private queues: QueueService,
  ) {}

  @Post("t/:token")
  @HttpCode(200)
  async receive(@Param("token") token: string, @Req() req: Request & { rawBody?: Buffer }) {
    // Cliente admin SOLO para el ruteo por token (endpoint público).
    const hook = await this.prisma.admin.inboundWebhook.findUnique({ where: { token } });
    if (!hook || !hook.active) throw new NotFoundException("Webhook no encontrado");

    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), "utf-8");
    if (raw.length > MAX_PAYLOAD_BYTES) throw new ForbiddenException("Payload demasiado grande (máx. 64 KB)");
    if (hook.secretCiphertext) {
      const signature = req.headers["x-conversia-signature"] as string | undefined;
      let secret = "";
      try {
        secret = decryptSecret(hook.secretCiphertext);
      } catch {
        /* secreto ilegible → rechazar */
      }
      if (!secret || !verifyMetaSignature(raw, signature, secret)) {
        throw new ForbiddenException("Firma inválida (X-Conversia-Signature: sha256=HMAC_SHA256(secreto, cuerpo))");
      }
    }

    const payload = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const organizationId = hook.organizationId;

    await this.prisma.withTenant(organizationId, async (tx) => {
      await tx.inboundWebhook.update({ where: { id: hook.id }, data: { lastReceivedAt: new Date() } });
      await tx.integrationEvent.create({
        data: {
          organizationId,
          provider: "inbound_webhook",
          type: "webhook.received",
          status: "ok",
          message: `Webhook «${hook.name}» recibido`,
          // payload completo para debug del tenant (acotado por MAX_PAYLOAD_BYTES)
          payload: { webhookId: hook.id, body: payload } as object,
        },
      });
    });

    // eventsWorker: "webhook.received" → trigger webhook_received de workflows.
    await this.queues.events.add(
      "emit",
      {
        organizationId,
        type: "webhook.received",
        data: { webhookId: hook.id, webhookName: hook.name, payload },
        occurredAt: new Date().toISOString(),
      },
      { removeOnComplete: 1000, removeOnFail: 5000 },
    );
    return { received: true };
  }
}
