/**
 * AGENDA-2 — respuestas del recordatorio de cita.
 *
 * Cuando el paciente toca "Confirmar" / "Reagendar" en el recordatorio (o lo
 * escribe), el inbound ya lo entrega como texto. Aquí lo interpretamos y hacemos
 * algo REAL sobre la cita, en vez de dejar que el agente improvise:
 *  - Confirmar  → marca la cita CONFIRMED, la confirma en la agenda externa
 *                 (write-back best-effort, p. ej. Cláriva), dispara el trigger
 *                 `appointment_confirmed` y acusa recibo al paciente.
 *  - Reagendar  → deriva a recepción (handoff humano) y acusa recibo.
 *
 * La respuesta se ata a la PRÓXIMA cita del contacto (PENDING/CONFIRMED más
 * cercana): las plantillas de WhatsApp no permiten payload por-envío, así que la
 * correlación es "su cita próxima", que para una clínica es lo esperable.
 */
import { withTenant } from "@conversia/database";
import { ChannelAuthError, markChannelAuthError, resolveChannelAuth } from "./channel-auth";
import { getChannelProvider } from "./channel-providers";
import { dispatchEvent } from "./workflow-runtime";
import { getSchedulingProviderFor } from "./tool-services";
import { enqueueEscalationEmail } from "./mailer";

export type ApptResponse = "confirm" | "reschedule";

/**
 * ¿El texto (o el tap de un botón del recordatorio) es Confirmar o Reagendar?
 * Puro y determinista. Deliberadamente estricto para no capturar frases largas.
 */
export function detectAppointmentResponse(text: string | null | undefined): ApptResponse | null {
  const t = (text ?? "").trim().toLowerCase();
  if (!t || t.length > 40) return null;
  if (/^(s[ií],?\s*)?(confirm(o|ar|ada|o mi cita)?|confirmo asistencia|s[ií] confirmo|asistir[eé])\b/.test(t)) return "confirm";
  if (/\b(reagend|reprogram|cambiar( la)? (hora|cita)|otro (d[ií]a|horario))/.test(t)) return "reschedule";
  return null;
}

/** Envía un texto de acuse por el canal de la conversación (dentro de la ventana). */
async function sendReplyText(orgId: string, conversationId: string, text: string): Promise<void> {
  const data = await withTenant(orgId, async (tx) => {
    const conv = await tx.conversation.findUnique({ where: { id: conversationId }, include: { contact: true } });
    if (!conv?.contact.phone) return null;
    const msg = await tx.message.create({
      data: { organizationId: orgId, conversationId, direction: "OUTBOUND", type: "TEXT", body: text, authorType: "SYSTEM", status: "PENDING" },
    });
    await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date(), lastMessagePreview: text.slice(0, 120) } });
    return { msgId: msg.id, phone: conv.contact.phone, channelConnectionId: conv.channelConnectionId };
  });
  if (!data) return;
  const auth = await resolveChannelAuth(orgId, { channelConnectionId: data.channelConnectionId });
  try {
    const sent = await getChannelProvider().send(auth.phoneNumberId, { to: data.phone, type: "text", text }, { accessToken: auth.accessToken });
    await withTenant(orgId, (tx) => tx.message.update({ where: { id: data.msgId }, data: { status: "SENT", externalId: sent.externalId, sentAt: new Date() } }));
  } catch (err) {
    await withTenant(orgId, (tx) => tx.message.update({ where: { id: data.msgId }, data: { status: "FAILED", error: (err as Error).message.slice(0, 500) } }));
    if (err instanceof ChannelAuthError) await markChannelAuthError(orgId, auth.channelConnectionId, err.message);
  }
}

async function logAgenda(orgId: string, status: "ok" | "error", message: string): Promise<void> {
  await withTenant(orgId, (tx) =>
    tx.integrationEvent.create({
      data: { organizationId: orgId, provider: "agenda", type: status === "ok" ? "appointment.confirmed" : "appointment.writeback_error", status, message: message.slice(0, 300) },
    }),
  );
}

/**
 * Procesa una posible respuesta al recordatorio. Devuelve true si la manejó
 * (el inbound entonces omite el turno del agente y el trigger message_received).
 */
export async function handleAppointmentResponse(
  orgId: string,
  conversationId: string,
  contactId: string | null,
  text: string | null | undefined,
): Promise<boolean> {
  const kind = detectAppointmentResponse(text);
  if (!kind || !contactId) return false;

  const now = new Date();
  const appt = await withTenant(orgId, (tx) =>
    tx.appointment.findFirst({
      where: { contactId, startsAt: { gte: now }, status: { in: ["PENDING", "CONFIRMED"] } },
      orderBy: { startsAt: "asc" },
    }),
  );
  if (!appt) return false; // sin cita próxima → que siga el flujo normal (agente)

  if (kind === "confirm") {
    if (appt.status !== "CONFIRMED") {
      await withTenant(orgId, (tx) => tx.appointment.update({ where: { id: appt.id }, data: { status: "CONFIRMED" } }));
    }
    // Write-back a la agenda externa (best-effort: no bloquea la confirmación local).
    if (appt.externalId) {
      try {
        const provider = await getSchedulingProviderFor(orgId);
        await provider.confirmAppointment(appt.externalId);
        await logAgenda(orgId, "ok", `Cita ${appt.externalId} confirmada por el paciente (write-back OK)`);
      } catch (err) {
        await logAgenda(orgId, "error", `No se pudo confirmar en la agenda externa: ${(err as Error).message}`);
      }
    }
    // Dispara workflows con trigger "Cita confirmada" (idempotente por contacto+evento).
    await dispatchEvent({
      organizationId: orgId,
      type: "appointment_confirmed",
      conversationId,
      contactId,
      data: { appointmentId: appt.id, externalId: appt.externalId, source: "whatsapp_button" },
      occurredAt: now.toISOString(),
    });
    await sendReplyText(orgId, conversationId, "¡Listo! Tu cita quedó confirmada ✅ Te esperamos.");
    return true;
  }

  // Reagendar → derivar a recepción (handoff humano) + acuse.
  await sendReplyText(orgId, conversationId, "Con gusto te ayudo a reagendar 📅. Te comunico con recepción para coordinar el nuevo horario.");
  const handoff = await withTenant(orgId, async (tx) => {
    await tx.conversation.update({ where: { id: conversationId }, data: { aiEnabled: false } });
    return tx.humanHandoff.create({
      data: { organizationId: orgId, conversationId, requestedBy: "rule", reason: "Reagendar cita (recordatorio)", status: "PENDING" },
    });
  });
  await enqueueEscalationEmail(orgId, handoff.id, conversationId);
  return true;
}
