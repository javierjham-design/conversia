import type { NotifChannel, NotifEventDef } from "./types.js";

/**
 * CATÁLOGO DE EVENTOS — registro único. Para agregar un evento nuevo, añade una
 * entrada aquí: el despachador y los canales no cambian. `link` y las plantillas
 * usan variables {var} que se rellenan con los datos del evento.
 */
export const NOTIF_EVENTS: NotifEventDef[] = [
  {
    key: "conversation.assigned",
    title: "Conversación asignada",
    body: "{contactName} — te asignaron esta conversación.",
    audience: ["assigned_user"],
    urgency: "info",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app", "web_push"],
    link: "/inbox/{conversationId}",
  },
  {
    // Mensaje entrante cuando la IA está APAGADA (la lleva un humano): que el equipo se entere
    // al instante. La IA encendida NO dispara esto (el bot responde solo). El despachador omite
    // el push de la conversación que el usuario está mirando en ese momento.
    key: "message.received",
    title: "Nuevo mensaje",
    body: "{contactName}: {preview}",
    audience: ["assigned_user", "team"],
    urgency: "info",
    channels: ["in_app", "web_push"],
    defaultChannels: ["in_app", "web_push"],
    link: "/inbox/{conversationId}",
  },
  {
    key: "conversation.unanswered",
    title: "Conversación sin responder",
    body: "{contactName} lleva {minutes} min esperando respuesta.",
    audience: ["assigned_user", "team"],
    urgency: "critical",
    channels: ["in_app", "web_push", "whatsapp"],
    defaultChannels: ["in_app", "web_push"],
    link: "/inbox/{conversationId}",
  },
  {
    key: "ai.escalation",
    title: "La IA escaló a un humano",
    body: "{contactName}: {reason}",
    audience: ["assigned_user", "team", "tenant_admins"],
    urgency: "critical",
    channels: ["in_app", "web_push", "email", "whatsapp"],
    defaultChannels: ["in_app", "web_push"],
    link: "/inbox/{conversationId}",
  },
  {
    key: "lead.created",
    title: "Nuevo lead",
    body: "{contactName} llegó desde {source}. Respóndele antes de que se enfríe.",
    audience: ["tenant_admins", "owner"],
    urgency: "critical",
    channels: ["in_app", "web_push", "email", "whatsapp"],
    defaultChannels: ["in_app", "web_push"],
    link: "/contacts",
  },
  {
    // Mensaje entrante en conversación atendida por un HUMANO (IA apagada):
    // nadie va a responder automáticamente, así que se avisa por mensaje.
    key: "message.received_human",
    title: "Nuevo mensaje de {contactName}",
    body: "{excerpt}",
    audience: ["assigned_user", "team"],
    urgency: "info",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app", "web_push"],
    link: "/inbox/{conversationId}",
  },
  {
    key: "comment.mention",
    title: "Te mencionaron",
    body: "{authorName} te mencionó: {excerpt}",
    audience: ["assigned_user"],
    urgency: "info",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app", "web_push"],
    link: "/inbox/{conversationId}",
  },
  {
    key: "appointment.created",
    title: "Nueva cita agendada",
    body: "{contactName} agendó para el {when}.",
    audience: ["tenant_admins", "assigned_user"],
    urgency: "info",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app"],
    link: "/inbox/{conversationId}",
  },
  {
    key: "appointment.cancelled",
    title: "Cita cancelada",
    body: "{contactName} canceló su cita del {when}.",
    audience: ["tenant_admins", "assigned_user"],
    urgency: "info",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app"],
    link: "/inbox/{conversationId}",
  },
  {
    key: "appointment.rescheduled",
    title: "Cita reprogramada",
    body: "{contactName} movió su cita a {when}.",
    audience: ["tenant_admins", "assigned_user"],
    urgency: "info",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app"],
    link: "/inbox/{conversationId}",
  },
  {
    key: "integration.error",
    title: "Integración con problema",
    body: "{provider}: {message}",
    audience: ["tenant_admins"],
    urgency: "info",
    channels: ["in_app", "email"],
    defaultChannels: ["in_app", "email"],
    link: "/integrations",
  },
  {
    key: "workflow.failed",
    title: "Un flujo de trabajo falló",
    body: "«{workflowName}» se detuvo por un error: {error}",
    audience: ["tenant_admins", "owner"],
    urgency: "critical",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app", "email"],
    link: "/workflows/{workflowId}",
  },
  {
    key: "data.job_done",
    title: "Tarea de datos terminada",
    body: "{jobName} finalizó ({rows} registros).",
    audience: ["assigned_user"],
    urgency: "info",
    channels: ["in_app", "email"],
    defaultChannels: ["in_app"],
    link: "/settings/export",
  },
  {
    key: "billing.payment_failed",
    title: "Pago rechazado",
    body: "No pudimos cobrar tu plan. Revisa tu medio de pago.",
    audience: ["owner"],
    urgency: "critical",
    channels: ["in_app", "email"],
    defaultChannels: ["in_app", "email"],
    lockedChannels: ["in_app", "email"], // facturación al dueño: no se apaga
    link: "/billing",
  },
  {
    key: "billing.grace",
    title: "Período de gracia",
    body: "Tu plan está en período de gracia hasta el {until}.",
    audience: ["owner"],
    urgency: "critical",
    channels: ["in_app", "email"],
    defaultChannels: ["in_app", "email"],
    lockedChannels: ["in_app", "email"],
    link: "/billing",
  },
  {
    key: "billing.suspended",
    title: "Cuenta suspendida",
    body: "Tu cuenta quedó suspendida por falta de pago.",
    audience: ["owner"],
    urgency: "critical",
    channels: ["in_app", "email"],
    defaultChannels: ["in_app", "email"],
    lockedChannels: ["in_app", "email"],
    link: "/billing",
  },
  {
    key: "wallet.low",
    title: "Tu bolsa de mensajes está por agotarse",
    body: "Te quedan {balance} mensajes de plantilla ({pct}% del plan). Compra un paquete para no dejar de avisarle a tus clientes.",
    audience: ["owner", "tenant_admins"],
    urgency: "info",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app", "email"],
    link: "/settings/plan",
  },
  {
    key: "wallet.empty",
    title: "Se agotó tu bolsa de mensajes",
    body: "Tu bolsa de mensajes de plantilla llegó a 0. Compra un paquete o sube de plan para reanudar los envíos. Puedes seguir respondiendo dentro de las 24 h sin costo.",
    audience: ["owner", "tenant_admins"],
    urgency: "critical",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app", "email"],
    lockedChannels: ["in_app"], // el aviso de bolsa vacía no se apaga
    link: "/settings/plan",
  },
  {
    key: "ai.token_cap",
    title: "Tope de tokens de IA alcanzado",
    body: "Se alcanzó el tope diario de tokens de IA. La IA queda en pausa.",
    audience: ["tenant_admins", "owner"],
    urgency: "critical",
    channels: ["in_app", "email"],
    defaultChannels: ["in_app", "email"],
    link: "/settings/ia",
  },
];

const BY_KEY = new Map(NOTIF_EVENTS.map((e) => [e.key, e]));

export function getEvent(key: string): NotifEventDef | undefined {
  return BY_KEY.get(key);
}

export function listEvents(): NotifEventDef[] {
  return NOTIF_EVENTS;
}

/** Eventos elegibles para la escalera de WhatsApp (solo críticos). */
export function isCritical(key: string): boolean {
  return BY_KEY.get(key)?.urgency === "critical";
}

/** Rellena una plantilla "{var}" con los datos del evento. */
export function render(tpl: string, data: Record<string, unknown>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => {
    const v = data[k];
    return v === undefined || v === null ? "" : String(v);
  });
}

export const ALL_CHANNELS: NotifChannel[] = ["in_app", "web_push", "email", "native_push", "whatsapp"];
