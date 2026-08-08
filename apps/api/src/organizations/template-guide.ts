import { resolvePersonalization } from "../common/industries";

/**
 * Plantilla de WhatsApp SUGERIDA para el tenant: texto listo para copiar y pegar
 * en Meta. El nombre respeta el formato de Meta (minúsculas + guion bajo). Los
 * placeholders {{1}}, {{2}}… los rellena el tenant al enviar. La categoría define
 * si Meta la cobra (marketing/utility) — ver docs/calculadora.
 */
export interface SuggestedTemplate {
  name: string;
  title: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  language: string;
  body: string;
  why: string;
}

/**
 * Devuelve las plantillas recomendadas según el RUBRO del tenant, con el
 * vocabulario ya aplicado (cita/visita/reserva, cliente/paciente…). Incluye un
 * set base (bienvenida, reactivación, promo) + específicas de agenda o de pedidos
 * según si el rubro usa el módulo de agenda.
 */
export function templateGuideFor(settings: Record<string, any> | null | undefined): SuggestedTemplate[] {
  const { vocabulary: v, modules } = resolvePersonalization(settings);
  const appt = v.appointment.toLowerCase();
  const contact = v.contact.toLowerCase();

  const base: SuggestedTemplate[] = [
    {
      name: "bienvenida",
      title: "Bienvenida / primer contacto",
      category: "UTILITY",
      language: "es",
      body: "Hola {{1}}, gracias por escribir a {{2}}. Soy tu asistente y te ayudo al instante. ¿En qué te puedo apoyar hoy?",
      why: "Responde de inmediato al primer mensaje y da una buena primera impresión.",
    },
    {
      name: "reactivacion",
      title: "Reactivar contacto inactivo",
      category: "MARKETING",
      language: "es",
      body: `Hola {{1}}, hace un tiempo no sabemos de ti. En {{2}} tenemos novedades para ti. ¿Retomamos?`,
      why: `Recupera ${contact}s que dejaron de responder (mensaje fuera de la ventana de 24 h).`,
    },
    {
      name: "promocion",
      title: "Promoción / novedad",
      category: "MARKETING",
      language: "es",
      body: "Hola {{1}} 🎉 {{2}} Válido hasta el {{3}}. Responde este mensaje y te damos todos los detalles.",
      why: "Difunde ofertas o lanzamientos a tu base con una plantilla aprobada.",
    },
  ];

  if (modules.agenda !== false) {
    // Rubros con agenda: recordatorio y confirmación de cita/visita/reserva.
    base.splice(1, 0,
      {
        name: `confirmacion_${slug(appt)}`,
        title: `Confirmación de ${appt}`,
        category: "UTILITY",
        language: "es",
        body: `Hola {{1}}, tu ${appt} en {{2}} quedó agendada para el {{3}} a las {{4}}. ¡Te esperamos! Si necesitas cambiarla, responde este mensaje.`,
        why: `Confirma cada ${appt} apenas se agenda y reduce las inasistencias.`,
      },
      {
        name: `recordatorio_${slug(appt)}`,
        title: `Recordatorio de ${appt}`,
        category: "UTILITY",
        language: "es",
        body: `Hola {{1}}, te recordamos tu ${appt} en {{2}} el {{3}} a las {{4}}. Responde CONFIRMAR para asistir o CANCELAR si no podrás.`,
        why: `Recordatorio automático 24 h antes: menos ausencias y agenda ordenada.`,
      },
    );
  } else {
    // Rubros sin agenda (comercio/e-commerce): pedido y despacho.
    base.splice(1, 0,
      {
        name: "confirmacion_pedido",
        title: "Confirmación de pedido",
        category: "UTILITY",
        language: "es",
        body: "Hola {{1}}, recibimos tu pedido {{2}} por un total de {{3}}. Te avisamos apenas esté listo. ¡Gracias por tu compra!",
        why: "Confirma la compra al instante y baja los reclamos por incertidumbre.",
      },
      {
        name: "despacho_en_camino",
        title: "Despacho en camino",
        category: "UTILITY",
        language: "es",
        body: "Hola {{1}}, tu pedido {{2}} va en camino 🚚 Puedes seguirlo aquí: {{3}}. Cualquier duda, responde este mensaje.",
        why: "Mantén informado al cliente del envío sin que tenga que preguntar.",
      },
    );
  }

  return base;
}

function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}
