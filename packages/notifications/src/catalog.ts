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
    link: "/inbox?c={conversationId}",
  },
  {
    key: "conversation.unanswered",
    title: "Conversación sin responder",
    body: "{contactName} lleva {minutes} min esperando respuesta.",
    // §8.5: el monitor busca conversaciones SIN asignar → sin assigned_user ni team la alerta no
    // llegaba a nadie. Se agregan los admins del tenant para que alguien la vea.
    audience: ["assigned_user", "team", "tenant_admins"],
    urgency: "critical",
    channels: ["in_app", "web_push", "whatsapp"],
    defaultChannels: ["in_app", "web_push"],
    link: "/inbox?c={conversationId}",
  },
  {
    key: "ai.escalation",
    title: "La IA escaló a un humano",
    body: "{contactName}: {reason}",
    audience: ["assigned_user", "team", "tenant_admins"],
    urgency: "critical",
    channels: ["in_app", "web_push", "email", "whatsapp"],
    defaultChannels: ["in_app", "web_push"],
    link: "/inbox?c={conversationId}",
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
    link: "/inbox?c={conversationId}",
  },
  {
    // Mensaje entrante que ATIENDE LA IA (aiEnabled=true). Útil al SETEAR la IA para ver cómo
    // responde. OPT-IN: apagado por defecto (defaultChannels vacío) para no saturar — se enciende
    // desde Ajustes → Notificaciones. Va a admins/owner (quien monitorea el arranque).
    key: "message.received_ai",
    title: "Mensaje atendido por la IA",
    body: "{contactName}: {excerpt}",
    audience: ["tenant_admins", "owner"],
    urgency: "info",
    channels: ["in_app", "web_push"],
    defaultChannels: [],
    link: "/inbox?c={conversationId}",
  },
  {
    key: "comment.mention",
    title: "Te mencionaron",
    body: "{authorName} te mencionó: {excerpt}",
    audience: ["assigned_user"],
    urgency: "info",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app", "web_push"],
    link: "/inbox?c={conversationId}",
  },
  {
    key: "appointment.created",
    title: "Nueva cita agendada",
    body: "{contactName} agendó para el {when}.",
    audience: ["tenant_admins", "assigned_user"],
    urgency: "info",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app"],
    link: "/inbox?c={conversationId}",
  },
  {
    key: "appointment.cancelled",
    title: "Cita cancelada",
    body: "{contactName} canceló su cita del {when}.",
    audience: ["tenant_admins", "assigned_user"],
    urgency: "info",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app"],
    link: "/inbox?c={conversationId}",
  },
  {
    key: "appointment.rescheduled",
    title: "Cita reprogramada",
    body: "{contactName} movió su cita a {when}.",
    audience: ["tenant_admins", "assigned_user"],
    urgency: "info",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app"],
    link: "/inbox?c={conversationId}",
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
    body: "Tu bolsa de mensajes de plantilla llegó a 0. Compra un paquete o sube de plan para reanudar los envíos. Las respuestas dentro de las 24 h no usan esta bolsa: descuentan de tu cupo mensual de conversaciones.",
    audience: ["owner", "tenant_admins"],
    urgency: "critical",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app", "email"],
    lockedChannels: ["in_app"], // el aviso de bolsa vacía no se apaga
    link: "/settings/plan",
  },
  {
    // Aviso único a clientes por el cambio de cobro de Meta (E5). hidden: no aparece en
    // la matriz de preferencias. Se dispara UNA vez por org con scripts/send-oct2026-notice.mjs.
    key: "announcement.oct2026",
    title: "Cambio de WhatsApp desde el 1 de octubre",
    body: "WhatsApp cobra las respuestas dentro de 24 h desde el 1 de octubre. Tu plan ya incluye un cupo mensual de conversaciones y avisos al 80 %. Revisa los detalles en Plan y facturación.",
    audience: ["owner", "tenant_admins"],
    urgency: "critical",
    channels: ["in_app", "email"],
    defaultChannels: ["in_app", "email"],
    hidden: true,
    link: "/billing",
  },
  {
    key: "conversations.low",
    title: "Tu cupo de conversaciones va en alza",
    body: "Tu cupo de conversaciones va en {pct}% ({used} de {included}). Te avisaremos al llegar al 100%.",
    audience: ["owner", "tenant_admins"],
    urgency: "critical",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app", "email"],
    link: "/billing",
  },
  {
    key: "conversations.limit",
    title: "Alcanzaste el 100% de tu cupo de conversaciones",
    body: "Alcanzaste el 100% de tu cupo de conversaciones ({included}). Sigues atendiendo sin cortes: te contactaremos para ajustar tu plan.",
    audience: ["owner", "tenant_admins"],
    urgency: "critical",
    channels: ["in_app", "web_push", "email"],
    defaultChannels: ["in_app", "email"],
    link: "/billing",
  },
  {
    // V2-1 — crédito-conversación: aviso al 75% y 90% de las conversaciones del plan.
    key: "credits.low",
    title: "Te quedan pocas conversaciones",
    body: "Llevas {used} de {included} conversaciones de tu plan ({pct}%). Recarga para no quedarte sin atención automática.",
    audience: ["owner", "tenant_admins"],
    urgency: "critical",
    channels: ["in_app", "web_push", "email", "whatsapp"],
    defaultChannels: ["in_app", "whatsapp"],
    link: "/facturacion",
  },
  {
    // V2-1 — entraste en GRACIA (saldo 0): el bot sigue atendiendo hasta 20 conversaciones.
    key: "credits.grace",
    title: "Tu bolsa de conversaciones llegó a 0",
    body: "Se acabaron tus conversaciones. Tu asistente sigue atendiendo {grace} conversaciones de cortesía; recarga para no interrumpir el servicio.",
    audience: ["owner", "tenant_admins"],
    urgency: "critical",
    channels: ["in_app", "web_push", "email", "whatsapp"],
    defaultChannels: ["in_app", "whatsapp"],
    link: "/facturacion",
  },
  {
    // CRE 2 (§6) — se cobró la recarga automática. El cliente tiene que enterarse de CADA
    // cobro a su tarjeta: es plata suya saliendo sin que él apriete nada.
    key: "credits.auto_recharge",
    title: "Recargamos tus Créditos IA",
    body:
      "Tu saldo se estaba agotando, así que cobramos ${amountClp} a tu tarjeta y sumamos {credits} Créditos IA. " +
      "Tu asistente sigue atendiendo sin cortes. Puedes desactivar la recarga automática cuando quieras en Cobros.",
    audience: ["owner", "tenant_admins"],
    urgency: "info",
    channels: ["in_app", "email"],
    defaultChannels: ["in_app", "email"],
    link: "/cobros",
  },
  {
    // La tarjeta falló: aviso INMEDIATO. Al bot le queda la gracia, que existe para esto.
    key: "credits.auto_recharge_failed",
    title: "No pudimos recargar tus Créditos IA",
    body:
      "Intentamos cobrar la recarga automática y tu tarjeta no la aceptó. Tu asistente sigue atendiendo con el saldo de " +
      "cortesía, pero conviene revisar el medio de pago o recargar a mano para no quedarte sin atención automática.",
    audience: ["owner", "tenant_admins"],
    urgency: "critical",
    channels: ["in_app", "web_push", "email", "whatsapp"],
    defaultChannels: ["in_app", "email"],
    link: "/cobros",
  },
  {
    // Tope mensual alcanzado: no se cobra más. Se avisa una vez por mes.
    key: "credits.auto_recharge_cap",
    title: "Alcanzaste tu tope de recarga automática",
    body:
      "Tu recarga automática llegó al tope mensual que fijaste (${monthlyCapClp}), así que no cobramos más. " +
      "Si necesitas seguir, puedes subir el tope o recargar a mano en Cobros.",
    audience: ["owner", "tenant_admins"],
    urgency: "critical",
    channels: ["in_app", "email"],
    defaultChannels: ["in_app", "email"],
    link: "/cobros",
  },
  {
    // CRE 1 (§4) — el equipo propone un modelo de IA más potente para un asistente. El
    // cliente tiene que aceptarlo porque le cambia cuánto le rinde el saldo.
    key: "ai.model_change_pending",
    title: "Te propusimos un modelo de IA más potente",
    body:
      "Para {agentName} proponemos un modelo más potente: cada respuesta consumiría {creditsPerReply} créditos. " +
      "Con tu saldo actual te alcanzaría para ~{conversationsAfter} conversaciones en vez de ~{conversationsBefore}. " +
      "Revísalo y acéptalo si te acomoda; mientras no lo aceptes, nada cambia.",
    audience: ["owner", "tenant_admins"],
    urgency: "info",
    channels: ["in_app", "email"],
    defaultChannels: ["in_app", "email"],
    link: "/ajustes",
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
  {
    // Notificación de PRUEBA (botón "Enviar prueba" en Ajustes → Notificaciones). El test la
    // manda solo a uno mismo (userIds override). hidden: no aparece en la matriz de preferencias.
    key: "system.test",
    title: "Notificación de prueba",
    body: "Si ves esto, las notificaciones funcionan ✔",
    audience: ["assigned_user"],
    urgency: "info",
    channels: ["in_app", "web_push"],
    defaultChannels: ["in_app", "web_push"],
    link: "/settings/notifications",
    hidden: true,
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
