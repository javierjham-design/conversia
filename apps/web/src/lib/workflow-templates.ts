// Plantillas de workflow por RUBRO. Data estática, sin datos de ningún tenant.
// Cada una es un WorkflowDefinition válido para el motor v0 (triggers cableados +
// nodos soportados, con posiciones para el canvas). Se crean como BORRADOR listo
// para editar: los pasos que piden datos (agente IA, etapa…) quedan por completar
// y el editor los marca. Ninguna usa integraciones que bloqueen (sin send_template
// ni Sheets/CAPI), para que se puedan probar y publicar sin configuración externa.

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  /** Rubro para agrupar la galería. */
  industry: string;
  /** Emoji ilustrativo (evita importar iconos en un módulo de datos). */
  icon: string;
  definition: {
    trigger: { type: string; config: Record<string, unknown> };
    variables: Record<string, unknown>;
    nodes: { id: string; type: string; config: Record<string, unknown>; position: { x: number; y: number } }[];
    edges: { from: string; to: string; when?: string }[];
  };
}

const COL = 280; // x de la columna principal
const y = (i: number) => 130 + i * 140; // filas del canvas

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  // ─────────────────────────── Dental ───────────────────────────
  {
    key: "dental-captacion-qr",
    name: "Captación por enlace / QR",
    description: "Un QR o enlace inicia el flujo: envía la oferta y ESPERA la respuesta. Si responde, la IA de ventas retoma; si no, insiste una vez. Elige tu agente de ventas en los pasos «Ejecutar agente IA».",
    industry: "Dental",
    icon: "📲",
    definition: {
      trigger: { type: "link_scan", config: { code: "promo-limpieza", linkMessage: "¡Hola! Quiero más información 🙌" } },
      variables: {},
      nodes: [
        { id: "promo", type: "send_text", config: { text: "Hola {{contact.firstName}} 👋 Te escribimos de {{organization.name}}: nuestra limpieza premium tiene un valor de $28.990. ¿Te gustaría agendar tu hora?" }, position: { x: COL, y: y(0) } },
        { id: "wr1", type: "wait_reply", config: { minutes: 5 }, position: { x: COL, y: y(1) } },
        // Rama: respondió al toque → la IA de ventas responde.
        { id: "agent1", type: "run_agent", config: { agentSlug: "" }, position: { x: COL + 260, y: y(2) } },
        // Rama: no respondió → insiste una vez y vuelve a esperar.
        { id: "nudge", type: "send_text", config: { text: "¿Te quedó alguna duda, {{contact.firstName}}? Con gusto te ayudo a agendar cuando quieras 😊" }, position: { x: COL - 240, y: y(2) } },
        { id: "wr2", type: "wait_reply", config: { minutes: 5 }, position: { x: COL - 240, y: y(3) } },
        { id: "agent2", type: "run_agent", config: { agentSlug: "" }, position: { x: COL - 240, y: y(4) } },
        { id: "tag", type: "add_tag", config: { tag: "sin-respuesta" }, position: { x: COL - 500, y: y(4) } },
      ],
      edges: [
        { from: "promo", to: "wr1" },
        { from: "wr1", to: "agent1", when: "replied" },
        { from: "wr1", to: "nudge", when: "no_reply" },
        { from: "nudge", to: "wr2" },
        { from: "wr2", to: "agent2", when: "replied" },
        { from: "wr2", to: "tag", when: "no_reply" },
      ],
    },
  },
  {
    key: "dental-recordatorio-cita",
    name: "Recordatorio de cita (24 h antes)",
    description: "Avisa al paciente un día antes de su cita y lo etiqueta. Para que llegue fuera de las 24 h, cambia el mensaje por «Enviar plantilla WhatsApp».",
    industry: "Dental",
    icon: "🦷",
    definition: {
      trigger: { type: "appointment_upcoming", config: { hoursBefore: 24, avoidOffHours: true } },
      variables: {},
      nodes: [
        { id: "n1", type: "send_text", config: { text: "Hola {{contact.firstName}} 👋 Te recordamos tu cita en {{organization.name}} para mañana. ¿La confirmas? Responde *SÍ* para confirmar o *REAGENDAR* si necesitas otra hora." }, position: { x: COL, y: y(0) } },
        { id: "n2", type: "wait_reply", config: { hours: 20 }, position: { x: COL, y: y(1) } },
        { id: "n3", type: "add_tag", config: { tag: "cita-confirmada" }, position: { x: COL - 170, y: y(2) } },
        { id: "n4", type: "transfer_human", config: { reason: "El paciente no confirmó el recordatorio" }, position: { x: COL + 190, y: y(2) } },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3", when: "replied" },
        { from: "n2", to: "n4", when: "no_reply" },
      ],
    },
  },
  {
    key: "dental-confirmacion-agenda",
    name: "Confirmación al agendar",
    description: "Cuando se agenda una cita, envía la confirmación con los datos y etiqueta al paciente.",
    industry: "Dental",
    icon: "📅",
    definition: {
      trigger: { type: "appointment_created", config: {} },
      variables: {},
      nodes: [
        { id: "n1", type: "send_text", config: { text: "¡Listo, {{contact.firstName}}! 🎉 Tu cita en {{organization.name}} quedó agendada. Te enviaremos un recordatorio antes. Si necesitas cambiarla, escríbenos por aquí." }, position: { x: COL, y: y(0) } },
        { id: "n2", type: "add_tag", config: { tag: "cita-agendada" }, position: { x: COL, y: y(1) } },
      ],
      edges: [{ from: "n1", to: "n2" }],
    },
  },
  {
    key: "dental-reactivacion",
    name: "Reactivación de pacientes",
    description: "Lánzalo a mano (o desde una acción masiva) sobre pacientes inactivos para invitarlos a volver. Si responden, deriva a recepción.",
    industry: "Dental",
    icon: "💫",
    definition: {
      trigger: { type: "manual", config: {} },
      variables: {},
      nodes: [
        { id: "n1", type: "send_text", config: { text: "Hola {{contact.firstName}} 😊 En {{organization.name}} te extrañamos. Ya es buen momento para tu control y limpieza. ¿Te gustaría que te agendemos una hora esta semana?" }, position: { x: COL, y: y(0) } },
        { id: "n2", type: "wait_reply", config: { hours: 48 }, position: { x: COL, y: y(1) } },
        { id: "n3", type: "transfer_human", config: { reason: "Paciente reactivado quiere agendar" }, position: { x: COL - 170, y: y(2) } },
        { id: "n4", type: "add_tag", config: { tag: "reactivacion-sin-respuesta" }, position: { x: COL + 190, y: y(2) } },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3", when: "replied" },
        { from: "n2", to: "n4", when: "no_reply" },
      ],
    },
  },
  {
    key: "dental-noshow",
    name: "Recuperación de no-show",
    description: "Cuando un paciente no asiste, le escribe para reagendar sin fricción y deriva a recepción si responde.",
    industry: "Dental",
    icon: "🔁",
    definition: {
      trigger: { type: "no_show", config: {} },
      variables: {},
      nodes: [
        { id: "n1", type: "send_text", config: { text: "Hola {{contact.firstName}}, notamos que no pudiste asistir a tu cita 🙏 No te preocupes, ¡reagendemos! ¿Qué día te acomoda esta semana?" }, position: { x: COL, y: y(0) } },
        { id: "n2", type: "wait_reply", config: { hours: 24 }, position: { x: COL, y: y(1) } },
        { id: "n3", type: "transfer_human", config: { reason: "No-show quiere reagendar" }, position: { x: COL - 170, y: y(2) } },
        { id: "n4", type: "add_tag", config: { tag: "no-show-sin-respuesta" }, position: { x: COL + 190, y: y(2) } },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3", when: "replied" },
        { from: "n2", to: "n4", when: "no_reply" },
      ],
    },
  },

  // ─────────────────────────── General ───────────────────────────
  {
    key: "bienvenida-lead",
    name: "Bienvenida y captura de lead",
    description: "Saluda al primer contacto, lo etiqueta como lead nuevo y deja que el agente IA continúe.",
    industry: "General",
    icon: "👋",
    definition: {
      trigger: { type: "conversation_started", config: {} },
      variables: {},
      nodes: [
        { id: "n1", type: "send_text", config: { text: "¡Hola {{contact.firstName}}! 👋 Gracias por escribir a {{organization.name}}. Cuéntame en qué te puedo ayudar." }, position: { x: COL, y: y(0) } },
        { id: "n2", type: "add_tag", config: { tag: "nuevo-lead" }, position: { x: COL, y: y(1) } },
        { id: "n3", type: "run_agent", config: { agentSlug: "" }, position: { x: COL, y: y(2) } },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
      ],
    },
  },
  {
    key: "seguimiento-sin-respuesta",
    name: "Seguimiento si no responde",
    description: "Si el contacto no responde, envía un recordatorio y, si sigue sin responder, lo marca como frío.",
    industry: "General",
    icon: "⏰",
    definition: {
      trigger: { type: "conversation_started", config: {} },
      variables: {},
      nodes: [
        { id: "n1", type: "run_agent", config: { agentSlug: "" }, position: { x: COL, y: y(0) } },
        { id: "n2", type: "wait", config: { minutes: 30, cancelOn: "contact_reply" }, position: { x: COL, y: y(1) } },
        { id: "n3", type: "condition", config: { kind: "no_reply" }, position: { x: COL, y: y(2) } },
        { id: "n4", type: "send_text", config: { text: "¿Sigues por ahí, {{contact.firstName}}? 😊 Con gusto retomo tu consulta cuando quieras." }, position: { x: COL, y: y(3) } },
        { id: "n5", type: "wait", config: { hours: 24, cancelOn: "contact_reply" }, position: { x: COL, y: y(4) } },
        { id: "n6", type: "condition", config: { kind: "no_reply" }, position: { x: COL, y: y(5) } },
        { id: "n7", type: "add_tag", config: { tag: "lead-frio" }, position: { x: COL, y: y(6) } },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
        { from: "n3", to: "n4", when: "true" },
        { from: "n4", to: "n5" },
        { from: "n5", to: "n6" },
        { from: "n6", to: "n7", when: "true" },
      ],
    },
  },
  {
    key: "palabra-clave-precios",
    name: "Respuesta a palabra clave (precios)",
    description: "Cuando el mensaje contiene una palabra clave (p. ej. “precio”), responde y deja que el agente detalle.",
    industry: "General",
    icon: "💬",
    definition: {
      trigger: { type: "message_received", config: { keywords: ["precio", "valor", "cuánto"] } },
      variables: {},
      nodes: [
        { id: "n1", type: "send_text", config: { text: "¡Con gusto te cuento los valores! Dame un momento y te detallo. 💬" }, position: { x: COL, y: y(0) } },
        { id: "n2", type: "add_tag", config: { tag: "interes-precio" }, position: { x: COL, y: y(1) } },
        { id: "n3", type: "run_agent", config: { agentSlug: "" }, position: { x: COL, y: y(2) } },
      ],
      edges: [
        { from: "n1", to: "n2" },
        { from: "n2", to: "n3" },
      ],
    },
  },
  {
    key: "encuesta-post-cierre",
    name: "Encuesta al cerrar la conversación",
    description: "Cuando se cierra la conversación, envía una breve encuesta de satisfacción.",
    industry: "General",
    icon: "⭐",
    definition: {
      trigger: { type: "conversation_closed", config: {} },
      variables: {},
      nodes: [
        { id: "n1", type: "send_text", config: { text: "¡Gracias por contactarnos, {{contact.firstName}}! 🙏 ¿Cómo fue tu atención? Responde del 1 (mala) al 5 (excelente)." }, position: { x: COL, y: y(0) } },
        { id: "n2", type: "add_tag", config: { tag: "encuesta-enviada" }, position: { x: COL, y: y(1) } },
      ],
      edges: [{ from: "n1", to: "n2" }],
    },
  },
];

/** Rubros en orden de presentación (los no listados van al final). */
const INDUSTRY_ORDER = ["Dental", "General"];

/** Plantillas agrupadas por rubro para la galería. */
export function templatesByIndustry(): { industry: string; items: WorkflowTemplate[] }[] {
  const groups = new Map<string, WorkflowTemplate[]>();
  for (const t of WORKFLOW_TEMPLATES) {
    const g = groups.get(t.industry) ?? [];
    g.push(t);
    groups.set(t.industry, g);
  }
  return [...groups.keys()]
    .sort((a, b) => {
      const ia = INDUSTRY_ORDER.indexOf(a), ib = INDUSTRY_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    })
    .map((industry) => ({ industry, items: groups.get(industry)! }));
}
