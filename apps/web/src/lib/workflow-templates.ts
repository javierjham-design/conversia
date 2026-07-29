// Plantillas de workflow GENÉRICAS (multi-rubro). Data estática, sin datos de
// ningún tenant. Cada una es un WorkflowDefinition válido para el motor v0
// (triggers cableados + nodos soportados) con posiciones para el canvas.

export interface WorkflowTemplate {
  key: string;
  name: string;
  description: string;
  definition: {
    trigger: { type: string; config: Record<string, unknown> };
    variables: Record<string, unknown>;
    nodes: { id: string; type: string; config: Record<string, unknown>; position: { x: number; y: number } }[];
    edges: { from: string; to: string; when?: string }[];
  };
}

const COL = 280; // x de la columna principal

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: "bienvenida-lead",
    name: "Bienvenida y captura de lead",
    description: "Saluda al primer contacto, lo etiqueta como lead nuevo y deja que el agente IA continúe.",
    definition: {
      trigger: { type: "conversation_started", config: {} },
      variables: {},
      nodes: [
        { id: "n1", type: "send_text", config: { text: "¡Hola {{contact.firstName}}! 👋 Gracias por escribir a {{organization.name}}. Cuéntame en qué te puedo ayudar." }, position: { x: COL, y: 150 } },
        { id: "n2", type: "add_tag", config: { tag: "nuevo-lead" }, position: { x: COL, y: 290 } },
        { id: "n3", type: "run_agent", config: { agentSlug: "" }, position: { x: COL, y: 430 } },
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
    definition: {
      trigger: { type: "conversation_started", config: {} },
      variables: {},
      nodes: [
        { id: "n1", type: "run_agent", config: { agentSlug: "" }, position: { x: COL, y: 120 } },
        { id: "n2", type: "wait", config: { minutes: 30, cancelOn: "contact_reply" }, position: { x: COL, y: 250 } },
        { id: "n3", type: "condition", config: { kind: "no_reply" }, position: { x: COL, y: 380 } },
        { id: "n4", type: "send_text", config: { text: "¿Sigues por ahí, {{contact.firstName}}? 😊 Con gusto retomo tu consulta cuando quieras." }, position: { x: COL, y: 520 } },
        { id: "n5", type: "wait", config: { hours: 24, cancelOn: "contact_reply" }, position: { x: COL, y: 650 } },
        { id: "n6", type: "condition", config: { kind: "no_reply" }, position: { x: COL, y: 780 } },
        { id: "n7", type: "add_tag", config: { tag: "lead-frio" }, position: { x: COL, y: 920 } },
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
    definition: {
      trigger: { type: "message_received", config: { keyword: "precio" } },
      variables: {},
      nodes: [
        { id: "n1", type: "send_text", config: { text: "¡Con gusto te cuento los valores! Dame un momento y te detallo. 💬" }, position: { x: COL, y: 150 } },
        { id: "n2", type: "add_tag", config: { tag: "interes-precio" }, position: { x: COL, y: 290 } },
        { id: "n3", type: "run_agent", config: { agentSlug: "" }, position: { x: COL, y: 430 } },
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
    definition: {
      trigger: { type: "conversation_closed", config: {} },
      variables: {},
      nodes: [
        { id: "n1", type: "send_text", config: { text: "¡Gracias por contactarnos, {{contact.firstName}}! 🙏 ¿Cómo fue tu atención? Responde del 1 (mala) al 5 (excelente)." }, position: { x: COL, y: 150 } },
        { id: "n2", type: "add_tag", config: { tag: "encuesta-enviada" }, position: { x: COL, y: 290 } },
      ],
      edges: [{ from: "n1", to: "n2" }],
    },
  },
];
