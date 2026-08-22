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
    const rawText = JSON.stringify(req.body ?? {});

    // Aislamiento: los payloads que apuntan a canales simulados ("mock:<slug>")
    // exigen el token del simulador — nadie puede inyectar mensajes a un
    // tenant ajeno conociendo solo su slug.
    if (rawText.includes('"mock:')) {
      const mockToken = req.headers["x-conversia-mock-token"];
      if (mockToken !== env.MOCK_INBOUND_TOKEN) {
        throw new ForbiddenException("Token de simulación inválido");
      }
    } else if (env.META_APP_SECRET) {
      // Tráfico real de Meta: firma HMAC OBLIGATORIA si hay app secret.
      const raw = req.rawBody ?? Buffer.from(rawText, "utf-8");
      if (!verifyMetaSignature(raw, signature, env.META_APP_SECRET)) {
        throw new ForbiddenException("Firma de webhook inválida");
      }
    }

    // Reintentos en la RUTA CRÍTICA de ingreso: un fallo transitorio (DB/Redis/latencia)
    // no puede perder el mensaje entrante. El worker deduplica por wamid (external_id),
    // así que reprocesar es idempotente. Antes: attempts=1 (un fallo = mensaje perdido).
    await this.queues.inbound.add(
      "inbound",
      { raw: req.body, receivedAt: new Date().toISOString() },
      {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    return { received: true };
  }
}
