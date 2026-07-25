import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { getEnv } from "@conversia/config";
import { QueueService } from "../queues";
import { verifyMetaSignature } from "./signature";

/**
 * Webhook de WhatsApp Cloud API (Meta).
 * El tenant se resuelve en el worker por metadata.phone_number_id — este
 * endpoint solo valida y encola, respondiendo 200 lo antes posible.
 */
@Controller("webhooks/whatsapp")
export class WhatsappController {
  constructor(private queues: QueueService) {}

  /** Verificación inicial del webhook (hub.challenge). */
  @Get()
  verify(
    @Query("hub.mode") mode?: string,
    @Query("hub.verify_token") token?: string,
    @Query("hub.challenge") challenge?: string,
  ) {
    const env = getEnv();
    if (mode === "subscribe" && token === env.META_VERIFY_TOKEN) {
      return challenge ?? "";
    }
    throw new ForbiddenException("Token de verificación inválido");
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }) {
    const env = getEnv();
    const signature = req.headers["x-hub-signature-256"] as string | undefined;

    // Con proveedor meta + app secret configurado, la firma es OBLIGATORIA.
    if (env.WHATSAPP_PROVIDER === "meta" && env.META_APP_SECRET) {
      const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), "utf-8");
      if (!verifyMetaSignature(raw, signature, env.META_APP_SECRET)) {
        throw new ForbiddenException("Firma de webhook inválida");
      }
    }

    await this.queues.inbound.add(
      "inbound",
      { raw: req.body, receivedAt: new Date().toISOString() },
      { removeOnComplete: 1000, removeOnFail: 5000 },
    );
    return { received: true };
  }
}
