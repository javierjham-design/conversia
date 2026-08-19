import { Controller, ForbiddenException, Get, HttpCode, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { getEnv } from "@conversia/config";
import { QueueService } from "../queues";
import { verifyMetaSignature } from "../channels/signature";

/**
 * Webhook de la app de Meta SEPARADA «TuBot CRM» (Lead Ads → CRM). Es otra app
 * en developers.facebook.com (patrón Cláriva CRM): firma con SU App Secret
 * (META_CRM_APP_SECRET) y verifica con SU token (META_CRM_VERIFY_TOKEN).
 * Suscripción esperada: topic `page`, campo `leadgen`. El payload entra al
 * MISMO pipeline inbound (parseLeadgenChanges → processLeadgen → CRM + CAPI).
 * Sin envs CRM definidas cae a las de la app principal (setup de una sola app).
 */
@Controller("webhooks/meta-crm")
export class MetaCrmWebhookController {
  constructor(private queues: QueueService) {}

  /** Verificación inicial del webhook (hub.challenge). */
  @Get()
  verify(
    @Query("hub.mode") mode?: string,
    @Query("hub.verify_token") token?: string,
    @Query("hub.challenge") challenge?: string,
  ) {
    const env = getEnv();
    const expected = env.META_CRM_VERIFY_TOKEN || env.META_VERIFY_TOKEN;
    if (mode === "subscribe" && token === expected) {
      return challenge ?? "";
    }
    throw new ForbiddenException("Token de verificación inválido");
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() req: Request & { rawBody?: Buffer }) {
    const env = getEnv();
    const secret = env.META_CRM_APP_SECRET || env.META_APP_SECRET;
    if (secret) {
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), "utf-8");
      if (!verifyMetaSignature(raw, signature, secret)) {
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
