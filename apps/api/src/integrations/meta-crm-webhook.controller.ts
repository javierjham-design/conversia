import { Controller, ForbiddenException, Get, HttpCode, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { createHash } from "node:crypto";
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
/**
 * §4.5 — Qué hacer con un webhook según si hay secreto de firma configurado.
 *
 * Función aparte y pura porque es la decisión de SEGURIDAD de este endpoint, y `getEnv()`
 * está memoizado: probarla manipulando `process.env` daría un test que se auto-salta sin
 * avisar (y un test que solo pasa en verde no prueba nada).
 */
export type DecisionFirma = "rechazar" | "verificar" | "aceptar_sin_firma";

export function decidirVerificacionDeFirma(nodeEnv: string, secret: string | undefined | null): DecisionFirma {
  if (secret) return "verificar";
  // Sin secreto: en producción NO se acepta. Este endpoint es público y lo que entra va a
  // la cola `inbound`, el mismo pipeline que procesa mensajes y leads reales, así que un
  // olvido de configuración abriría la inyección de leads y conversaciones falsas.
  return nodeEnv === "production" ? "rechazar" : "aceptar_sin_firma";
}

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
    const object = String((req.body as any)?.object ?? "?");
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}), "utf-8");

    // §4.5 — FAIL-CLOSED sin secreto en producción. Antes la verificación estaba dentro de
    // un `if (secret)`: sin la variable configurada no se verificaba NADA. En desarrollo se
    // deja seguir (es lo que permite probar el webhook con ngrok), pero se avisa.
    const decision = decidirVerificacionDeFirma(env.NODE_ENV, secret);
    if (decision === "rechazar") {
      console.error("📥 meta-crm webhook RECHAZADO: no hay META_CRM_APP_SECRET ni META_APP_SECRET. Sin secreto no se verifica la firma y el endpoint es público — configúralo en Railway.");
      throw new ForbiddenException("Webhook no configurado: falta el secreto de la app de Meta.");
    }
    if (decision === "aceptar_sin_firma") {
      console.warn("📥 meta-crm webhook SIN FIRMA VERIFICADA (no hay secreto configurado) — aceptado solo porque NODE_ENV no es production.");
    } else {
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      if (!verifyMetaSignature(raw, signature, secret!)) {
        // Log SIEMPRE: si el secret de Railway no coincide con el de la app,
        // todos los webhooks morirían acá en silencio (403) — hacerlo visible.
        console.warn(`📥 meta-crm webhook RECHAZADO (firma inválida) object=${object} — revisa META_CRM_APP_SECRET`);
        throw new ForbiddenException("Firma de webhook inválida");
      }
    }

    console.log(`📥 meta-crm webhook OK object=${object} entries=${((req.body as any)?.entry ?? []).length}`);
    // §4.5 — `jobId` por CONTENIDO: Meta reintenta el mismo webhook si no contesta rápido,
    // y sin jobId cada reintento era un job más (leads y conversaciones duplicadas). El
    // hash del cuerpo crudo identifica el reenvío exacto. `attempts: 5` con backoff: un
    // fallo transitorio del worker ya no pierde el lead, que antes se perdía al primer
    // error porque no había reintentos.
    const jobId = `meta-crm:${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
    await this.queues.inbound.add(
      "inbound",
      { raw: req.body, receivedAt: new Date().toISOString() },
      { jobId, attempts: 5, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 },
    );
    return { received: true };
  }
}
