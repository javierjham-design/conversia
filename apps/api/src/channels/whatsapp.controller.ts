import {
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { createHash } from "crypto";
import type { Request } from "express";
import { getEnv } from "@conversia/config";
import { QueueService } from "../queues";
import { verifyMetaSignature } from "./signature";

/**
 * ¿El payload apunta a un canal SIMULADO? Se decide por el `phone_number_id` REAL del
 * webhook (`entry[].changes[].value.metadata.phone_number_id` que empieza con "mock:"),
 * NUNCA por el texto serializado del cuerpo (§4.1): un cliente podía escribir `hola "mock:`
 * (o ponerlo en su nombre de perfil) y, al hacer `JSON.stringify(body)`, disparar el 403 que
 * tumbaba el lote COMPLETO de mensajes reales — un DoS de ingreso sin autenticación.
 */
export function isMockWhatsappPayload(body: unknown): boolean {
  const entries = (body as { entry?: unknown } | null | undefined)?.entry;
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown } | null | undefined)?.changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      const pnid = (change as { value?: { metadata?: { phone_number_id?: unknown } } } | null | undefined)?.value?.metadata
        ?.phone_number_id;
      if (typeof pnid === "string" && pnid.startsWith("mock:")) return true;
    }
  }
  return false;
}

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
    // tenant ajeno conociendo solo su slug. Se decide por el phone_number_id real,
    // no por el texto del cuerpo (§4.1), para no descartar mensajes reales que
    // contengan la cadena `"mock:`.
    if (isMockWhatsappPayload(req.body)) {
      // SEGURIDAD (auditoría sim 250, 2026-10-17): en producción con proveedor real la
      // ruta mock queda CERRADA aunque el token coincida — el default del token viene
      // en .env.example (público) y bastaba el slug del tenant para inyectarle mensajes
      // (quemar sus créditos/IA). El simulador solo existe con WHATSAPP_PROVIDER=mock.
      if (env.NODE_ENV === "production" && env.WHATSAPP_PROVIDER !== "mock") {
        throw new ForbiddenException("Canal de simulación deshabilitado en producción");
      }
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
    } else if (env.NODE_ENV === "production") {
      // SEGURIDAD: en producción SIN app secret configurado el webhook real queda
      // fail-closed (antes pasaba sin validación alguna). Configurar META_APP_SECRET.
      throw new ForbiddenException("Webhook sin verificación de firma configurada");
    }

    // Reintentos en la RUTA CRÍTICA de ingreso: un fallo transitorio (DB/Redis/latencia)
    // no puede perder el mensaje entrante. El worker deduplica por wamid (external_id),
    // así que reprocesar es idempotente. Antes: attempts=1 (un fallo = mensaje perdido).
    // jobId = hash del payload: si Meta RE-ENTREGA el mismo webhook (timeout), BullMQ
    // ignora el duplicado mientras el job siga retenido (defensa en profundidad + dedup en BD).
    const jobId = `wh_${createHash("sha256").update(rawText).digest("hex").slice(0, 32)}`;
    await this.queues.inbound.add(
      "inbound",
      { raw: req.body, receivedAt: new Date().toISOString() },
      {
        jobId,
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );
    return { received: true };
  }
}
