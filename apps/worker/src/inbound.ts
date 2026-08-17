import { getAdminPrisma, withTenant } from "@conversia/database";
import type { InboundJob } from "@conversia/types";
import { computeWhatsappCostUsd } from "@conversia/agents";
import { geoFromPhone } from "./phone-geo";
import { getWhatsappRatesOverride } from "./cost-settings";
import { buildContactCreate, buildContactUpdate } from "./contact-capture";
import { runAgentTurn } from "./agent-turn";
import { transcribeWhatsappAudio } from "./audio";
import { resolveChannelAuth } from "./channel-auth";
import { parseLeadgenChanges, processLeadgen } from "./meta-leads";
import { processMetaHealth } from "./meta-health";
import { emitPlatformEvent } from "./platform-events";
import { cancelTimersOnReply, dispatchEvent, handlePendingObjective, handleWaitReply } from "./workflow-runtime";
import { handleAppointmentResponse } from "./appointment-responses";
import { resolveAdContext } from "./meta-ads-sync";

interface ParsedInbound {
  phoneNumberId: string;
  externalId: string;
  from: string;
  profileName?: string;
  type: string;
  text?: string;
  referral?: any; // objeto referral de Meta (anuncios Click-to-WhatsApp)
  payload: unknown;
}

interface ParsedStatus {
  phoneNumberId: string;
  externalId: string;
  status: string;
  recipientId?: string;
  // Info de precio de Meta (modelo per-message): categoría + si es facturable.
  pricing?: { billable?: boolean; category?: string; pricingModel?: string; conversationId?: string };
}

/** Normaliza el payload del webhook de Meta (o del simulador, mismo formato). */
function parseWebhook(raw: any): { messages: ParsedInbound[]; statuses: ParsedStatus[] } {
  const messages: ParsedInbound[] = [];
  const statuses: ParsedStatus[] = [];
  for (const entry of raw?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      const profileName = value?.contacts?.[0]?.profile?.name;
      for (const m of value?.messages ?? []) {
        messages.push({
          phoneNumberId,
          externalId: m.id,
          from: m.from,
          profileName,
          type: m.type ?? "unknown",
          // Incluye el pie de foto/leyenda de imágenes, documentos y videos como texto.
          text: m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.image?.caption ?? m.document?.caption ?? m.video?.caption,
          referral: m.referral,
          payload: m,
        });
      }
      for (const s of value?.statuses ?? []) {
        statuses.push({
          phoneNumberId,
          externalId: s.id,
          status: s.status,
          recipientId: s.recipient_id,
          pricing: s.pricing
            ? { billable: s.pricing.billable, category: s.pricing.category, pricingModel: s.pricing.pricing_model, conversationId: s.conversation?.id }
            : undefined,
        });
      }
    }
  }
  return { messages, statuses };
}

/**
 * Resuelve el tenant a partir del número receptor. Lookup global (conexión
 * del worker) — ÚNICO punto donde se cruza el límite de tenant, y solo para
 * enrutar. "mock:<slug>" permite simular sin credenciales.
 */
async function resolveTenant(
  phoneNumberId: string,
): Promise<{ organizationId: string; channelConnectionId: string | null; clinicId: string | null } | null> {
  const prisma = getAdminPrisma();
  if (phoneNumberId.startsWith("mock:")) {
    const slug = phoneNumberId.slice(5);
    const org = await prisma.organization.findUnique({ where: { slug } });
    if (!org) return null;
    const channel = await prisma.channelConnection.findFirst({
      where: { organizationId: org.id, type: "MOCK" },
    });
    return { organizationId: org.id, channelConnectionId: channel?.id ?? null, clinicId: channel?.clinicId ?? null };
  }
  const number = await prisma.whatsappPhoneNumber.findUnique({ where: { phoneNumberId } });
  if (!number) return null;
  return {
    organizationId: number.organizationId,
    channelConnectionId: number.channelConnectionId,
    clinicId: number.clinicId,
  };
}

export async function processInbound(job: InboundJob): Promise<void> {
  // Leads de Meta Lead Ads (object=page, field=leadgen) — mismo webhook de Meta
  for (const change of parseLeadgenChanges(job.raw)) {
    try {
      await processLeadgen(change, job.internal === true);
    } catch (err) {
      console.error(`✖ Error procesando leadgen ${change.leadgen_id}:`, (err as Error).message);
    }
  }

  // Monitoreo de salud (calidad/estado de cuenta/plantillas) — early warning
  await processMetaHealth(job.raw).catch((err) =>
    console.error("✖ Error en monitoreo de salud WhatsApp:", (err as Error).message),
  );

  const { messages, statuses } = parseWebhook(job.raw);

  for (const status of statuses) {
    const tenant = await resolveTenant(status.phoneNumberId);
    if (!tenant) continue;
    await withTenant(tenant.organizationId, (tx) =>
      tx.message.updateMany({
        where: { externalId: status.externalId },
        data: {
          status:
            status.status === "read"
              ? "READ"
              : status.status === "delivered"
                ? "DELIVERED"
                : status.status === "failed"
                  ? "FAILED"
                  : "SENT",
        },
      }),
    );

    // Costo que cobra Meta por el mensaje (modelo per-message). Meta manda el
    // objeto `pricing` en el estado; registramos UN usage_event por mensaje
    // facturable, con la categoría y el país para poder recalcular si cambian
    // las tarifas. Dedupe por externalId.
    if (status.pricing?.billable && status.pricing.category) {
      await withTenant(tenant.organizationId, async (tx) => {
        const already = await tx.usageEvent.findFirst({
          where: { type: "whatsapp_message", meta: { path: ["externalId"], equals: status.externalId } },
          select: { id: true },
        });
        if (already) return;
        const country = geoFromPhone(String(status.recipientId ?? "")).country;
        const overrides = await getWhatsappRatesOverride();
        const costUsd = computeWhatsappCostUsd(status.pricing!.category, country, overrides);
        await tx.usageEvent.create({
          data: {
            organizationId: tenant.organizationId,
            type: "whatsapp_message",
            quantity: 1,
            costUsd,
            meta: {
              externalId: status.externalId,
              category: status.pricing!.category,
              pricingModel: status.pricing!.pricingModel ?? null,
              country,
              conversationId: status.pricing!.conversationId ?? null,
            },
          },
        });
      });
    }
  }

  for (const msg of messages) {
    const tenant = await resolveTenant(msg.phoneNumberId);
    if (!tenant) {
      console.warn(`⚠ Mensaje para número desconocido ${msg.phoneNumberId} — descartado`);
      continue;
    }
    const { organizationId } = tenant;

    // Notas de voz: descargar y transcribir el audio para usarlo como texto del
    // agente (fuera de la transacción: es una llamada de red). Degrada a "[audio]".
    let text = msg.text;
    let transcribed = false;
    if (!text && (msg.type === "audio" || msg.type === "voice")) {
      const mediaId = (msg.payload as any)?.audio?.id ?? (msg.payload as any)?.voice?.id;
      // Switch por tenant (org.settings.transcription.enabled; activada por defecto).
      const transcriptionOn = await withTenant(organizationId, async (tx) => {
        const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
        return ((org?.settings as any)?.transcription?.enabled ?? true) !== false;
      });
      if (mediaId && transcriptionOn) {
        // El media se descarga con el token de la WABA receptora (por-canal).
        const auth = await resolveChannelAuth(organizationId, { phoneNumberId: msg.phoneNumberId });
        const t = await transcribeWhatsappAudio(String(mediaId), auth.accessToken);
        if (t) {
          text = t;
          transcribed = true;
        }
      }
    }

    const result = await withTenant(organizationId, async (tx) => {
      // Idempotencia por wamid
      const dup = await tx.message.findUnique({
        where: { organizationId_externalId: { organizationId, externalId: msg.externalId } },
      });
      if (dup) return null;

      // Contacto por identidad de canal
      const channelType = msg.phoneNumberId.startsWith("mock:") ? "MOCK" : "WHATSAPP_CLOUD";
      let identity = await tx.contactIdentity.findUnique({
        where: {
          organizationId_channelType_externalId: {
            organizationId,
            channelType,
            externalId: msg.from,
          },
        },
        include: { contact: true },
      });
      let contact = identity?.contact ?? null;
      // Captura MÁXIMA desde Meta: perfil (separado del nombre real), teléfono
      // E.164, país inferido, atribución CTWA (referral) + payload crudo.
      const parsedContact = { waId: msg.from, profileName: msg.profileName ?? null, referral: msg.referral };
      if (!contact) {
        contact = await tx.contact.create({
          data: { organizationId, clinicId: tenant.clinicId, ...buildContactCreate(parsedContact, new Date()) },
        });
        await tx.contactIdentity.create({
          data: { organizationId, contactId: contact.id, channelType, externalId: msg.from },
        });
      } else {
        await tx.contact.update({ where: { id: contact.id }, data: buildContactUpdate(contact, parsedContact, new Date()) });
      }

      // Conversación abierta o nueva
      let conversation = await tx.conversation.findFirst({
        where: { contactId: contact.id, status: { in: ["OPEN", "PENDING"] } },
        orderBy: { createdAt: "desc" },
      });
      let started = false;
      if (!conversation) {
        const channel = tenant.channelConnectionId
          ? await tx.channelConnection.findUnique({ where: { id: tenant.channelConnectionId } })
          : null;
        conversation = await tx.conversation.create({
          data: {
            organizationId,
            clinicId: tenant.clinicId,
            contactId: contact.id,
            channelConnectionId: tenant.channelConnectionId,
            activeAgentId: channel?.defaultAgentId ?? null,
            status: "OPEN",
          },
        });
        started = true;
      } else if (tenant.channelConnectionId && conversation.channelConnectionId !== tenant.channelConnectionId) {
        // Reatar la conversación al canal que REALMENTE recibió este mensaje. Si el
        // canal se reconectó/renombró/recreó, el puntero viejo quedaba muerto y el
        // envío caía a "primer número activo" → número/token equivocado → #133010.
        // Así la respuesta sale SIEMPRE por el mismo número con el que habló.
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { channelConnectionId: tenant.channelConnectionId },
        });
        conversation = { ...conversation, channelConnectionId: tenant.channelConnectionId };
      }

      await tx.message.create({
        data: {
          organizationId,
          conversationId: conversation.id,
          direction: "INBOUND",
          type:
            msg.type === "audio" || msg.type === "voice" ? "AUDIO"
            : msg.type === "image" ? "IMAGE"
            : msg.type === "document" ? "DOCUMENT"
            : msg.type === "video" ? "VIDEO"
            : "TEXT",
          body: text ?? `[${msg.type}]`,
          payload: (transcribed ? { ...(msg.payload as object), transcribed: true } : msg.payload) as object,
          externalId: msg.externalId,
          status: "DELIVERED",
          authorType: "CONTACT",
          sentAt: new Date(),
        },
      });
      if (transcribed) {
        // Registro de uso: cada transcripción tiene un costo (nota de voz → texto).
        await tx.usageEvent.create({
          data: { organizationId, type: "audio_transcription", quantity: 1, meta: { conversationId: conversation.id } },
        });
      }
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date(),
          lastMessagePreview: (text ?? `[${msg.type}]`).slice(0, 120),
          unreadCount: { increment: 1 },
        },
      });

      return { conversationId: conversation.id, contactId: contact.id, started };
    });

    if (!result) continue; // duplicado

    // Marca de inicio del ciclo de este mensaje: para saber qué runs de flujo lo
    // "tomaron" (arrancaron por él) y así el agente por defecto sea un FALLBACK,
    // no un bot omnipotente que compite con los flujos.
    const cycleStart = new Date();

    // Bandeja en vivo: nuevo mensaje entrante + conteos del clasificador.
    const { publishRealtime } = await import("./realtime.js");
    await publishRealtime(organizationId, { type: "message.created", conversationId: result.conversationId });
    await publishRealtime(organizationId, { type: "counters.dirty" });

    // Sincronización unidireccional a HubSpot (si el tenant la activó)
    const { enqueueHubspotContact } = await import("./hubspot.js");
    await enqueueHubspotContact(organizationId, result.contactId);

    // El contacto respondió → cancelar seguimientos pendientes
    await cancelTimersOnReply(organizationId, result.conversationId);
    // …y continuar por la rama "Sí, respondió" los nodos "¿El contacto respondió?".
    await handleWaitReply(organizationId, result.conversationId).catch((err) => {
      console.error(`✖ Error al reanudar "¿respondió?" (${result.conversationId}):`, (err as Error).message);
      return false;
    });

    // AGENDA-2: ¿es una respuesta al recordatorio (Confirmar/Reagendar)? Si la
    // maneja (confirma la cita / deriva a recepción), no seguimos al agente ni
    // al trigger message_received para no improvisar sobre la cita.
    const apptResponse = await handleAppointmentResponse(organizationId, result.conversationId, result.contactId, text).catch((err) => {
      console.error(`✖ Error en respuesta de recordatorio (${result.conversationId}):`, (err as Error).message);
      return false;
    });
    if (apptResponse) continue;

    // Disparar workflows (conversación iniciada y mensaje recibido)
    const base = {
      organizationId,
      conversationId: result.conversationId,
      contactId: result.contactId,
      data: { text: text ?? "", isFirstMessage: result.started, channel: "whatsapp" },
      occurredAt: new Date().toISOString(),
    };
    if (result.started) {
      await dispatchEvent({ ...base, type: "conversation_started" });
      await emitPlatformEvent(organizationId, "conversation.started", {
        conversationId: result.conversationId,
        contactId: result.contactId,
      });
    }
    await dispatchEvent({ ...base, type: "message_received" });
    await emitPlatformEvent(organizationId, "message.received", {
      conversationId: result.conversationId,
      text: (text ?? "").slice(0, 200),
    });

    // Anuncios Click-to-WhatsApp: la atribución (ctwa_clid/ad_id/referral crudo)
    // ya la guardó buildContactCreate/Update en columnas estructuradas + meta;
    // aquí solo disparamos el flujo click_to_chat con los datos del anuncio.
    if (msg.referral && result.started) {
      const ref = msg.referral;
      const adId = ref.source_id ?? null;
      // Resuelve la campaña del anuncio (catálogo cacheado + sync puntual si falta)
      // para que las selecciones por campaña coincidan sin perder leads.
      const adCtx = adId ? await resolveAdContext(organizationId, String(adId)).catch(() => null) : null;
      // Persistir la campaña en el contacto → filtro "origen: campaña" en Contactos.
      if (adCtx?.campaignId) {
        await withTenant(organizationId, (tx) => tx.contact.update({ where: { id: result.contactId }, data: { campaignId: adCtx.campaignId } })).catch(() => undefined);
      }
      const referral = {
        ad_id: adId ?? ref.source_url ?? null,
        campaign_id: adCtx?.campaignId ?? null,
        campaign_name: adCtx?.campaignName ?? null,
        ad_name: adCtx?.adName ?? null,
        ctwa_clid: ref.ctwa_clid ?? null,
        headline: ref.headline ?? null,
        source_type: ref.source_type ?? null,
      };
      await dispatchEvent({ ...base, type: "click_to_chat", data: { ...base.data, ...referral } });
    }

    // Objetivo multi-turno pendiente (nodo ai_objective): el agente a cargo
    // responde con el objetivo, se re-evalúa y el run se reanuda al resolverse.
    const objectiveHandled = await handlePendingObjective(organizationId, result.conversationId).catch((err) => {
      console.error(`✖ Error en objetivo pendiente (${result.conversationId}):`, (err as Error).message);
      return false;
    });

    // Respuesta del agente activo (bot por defecto del canal) — SOLO como FALLBACK.
    // Se suprime si, en este ciclo, un flujo "tomó" el mensaje:
    //   (a) el objetivo ya corrió el turno;
    //   (b) un flujo ejecutó un agente (run_agent) para esta conversación; o
    //   (c) un flujo ARRANCÓ por este mensaje y quedó esperando (p. ej. promo →
    //       «¿El contacto respondió?»): el flujo es dueño de la conversación aunque
    //       aún no haya corrido su agente. Así el bot por defecto deja de competir
    //       (ya no hace falta «Pausar IA» al inicio del flujo).
    const flowTookMessage =
      objectiveHandled ||
      Boolean(
        await withTenant(organizationId, (tx) =>
          tx.workflowRunStep.findFirst({
            where: {
              nodeType: "run_agent",
              status: "COMPLETED",
              startedAt: { gte: new Date(Date.now() - 60_000) },
              run: { conversationId: result.conversationId },
            },
          }),
        ),
      ) ||
      Boolean(
        await withTenant(organizationId, (tx) =>
          tx.workflowRun.findFirst({
            where: { conversationId: result.conversationId, status: "WAITING", startedAt: { gte: cycleStart } },
            select: { id: true },
          }),
        ),
      );
    if (!flowTookMessage) {
      try {
        await runAgentTurn({ organizationId, conversationId: result.conversationId });
      } catch (err) {
        console.error(`✖ Error en turno de agente (${result.conversationId}):`, (err as Error).message);
      }
    }
  }
}
