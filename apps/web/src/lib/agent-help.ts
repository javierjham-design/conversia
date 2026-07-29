// Contenido de ayuda del editor de Agentes IA (estático, en español). Una
// entrada por sección + variables disponibles + snippets de prompt reutilizables.

/** Variables que el sistema reemplaza en tiempo de ejecución (inyectadas por el orquestador). */
export const AGENT_VARIABLES: { key: string; label: string; example: string }[] = [
  { key: "organization.name", label: "Nombre del negocio", example: "Clínica Sonrisas" },
  { key: "clinic.name", label: "Nombre de la sede", example: "Sede Centro" },
  { key: "clinic.city", label: "Ciudad de la sede", example: "Temuco" },
  { key: "clinic.address", label: "Dirección de la sede", example: "Av. Alemania 123" },
  { key: "contact.firstName", label: "Nombre del contacto", example: "María" },
  { key: "agent.name", label: "Nombre del agente", example: "Recepcionista" },
];

export const AGENT_VARIABLE_KEYS = AGENT_VARIABLES.map((v) => v.key);

/** Snippets reutilizables para el prompt (dropdown "Plantillas de prompt"). */
export const PROMPT_SNIPPETS: { label: string; text: string }[] = [
  {
    label: "Contexto de negocio",
    text:
      "Eres el asistente virtual de {{organization.name}}. Atiendes a los clientes por WhatsApp de forma amable y resolutiva.\n" +
      "Datos del negocio:\n" +
      "- Rubro: [describe el rubro]\n" +
      "- Servicios principales: [lista tus servicios]\n" +
      "- Horario de atención: [ej. Lun a Vie 9:00–18:00]\n" +
      "- Ubicación: {{clinic.address}}, {{clinic.city}}\n",
  },
  {
    label: "Tono y estilo",
    text:
      "Tono: cálido, cercano y profesional. Trata al cliente por su nombre ({{contact.firstName}}) cuando lo tengas.\n" +
      "Sé breve: 2 o 3 frases por mensaje, como en un chat real. Evita párrafos largos y tecnicismos.\n" +
      "Usa emojis con moderación. Termina ofreciendo el siguiente paso.\n",
  },
  {
    label: "Restricciones",
    text:
      "Reglas estrictas:\n" +
      "- Nunca inventes precios, horarios ni disponibilidad: usa siempre las herramientas para obtener datos reales.\n" +
      "- Si no tienes la información, dilo con honestidad y ofrece derivar a una persona del equipo.\n" +
      "- No entregues diagnósticos ni consejos que requieran un profesional.\n" +
      "- No pidas datos sensibles innecesarios.\n",
  },
];

export interface HelpExample {
  good: string;
  bad: string;
}
export interface SectionHelp {
  title: string;
  intro: string;
  points: string[];
  examples?: HelpExample;
  showVariables?: boolean;
}

export const AGENT_HELP: Record<string, SectionHelp> = {
  instrucciones: {
    title: "Cómo escribir las instrucciones",
    intro:
      "Las instrucciones son el 'cerebro' del agente: definen quién es, qué sabe, cómo habla y qué puede o no hacer. Escríbelas como si le explicaras el trabajo a un empleado nuevo.",
    points: [
      "Empieza por el ROL: quién es el agente y para qué negocio trabaja.",
      "Dale CONTEXTO real: servicios, horarios, políticas. (Los datos que cambian —precios, agenda— salen de las herramientas, no los escribas a mano.)",
      "Define el TONO y el largo de las respuestas (breve, cálido, sin tecnicismos).",
      "Pon LÍMITES claros: qué NO debe hacer y cuándo derivar a un humano.",
      "Usa {{variables}} para personalizar (nombre del cliente, sede, negocio).",
      "Termina con el OBJETIVO: qué quieres lograr (agendar, calificar, resolver la duda).",
    ],
    examples: {
      good:
        "Eres la recepcionista virtual de {{organization.name}} en {{clinic.city}}. Saluda por su nombre a {{contact.firstName}}, identifica qué necesita y, si quiere una hora, usa las herramientas de agenda para ofrecer horarios reales. Responde en 2–3 frases, tono cálido. Si detectas urgencia o molestia, deriva a una persona.",
      bad:
        "Eres un bot. Responde las preguntas. El implante cuesta $300.000 y hay horas el martes. (❌ inventa precios y disponibilidad en vez de usar las herramientas; sin rol, tono ni límites.)",
    },
    showVariables: true,
  },
  acciones: {
    title: "Cómo configurar las acciones",
    intro:
      "Cada acción es una capacidad que le das al agente (agendar, etiquetar, derivar, etc.). Al activarla, escribe en lenguaje natural CUÁNDO y CÓMO debe usarla. Esa instrucción se suma al cerebro del agente.",
    points: [
      "Activa solo las acciones que este agente realmente necesita: menos es más.",
      "En 'cuándo y cómo', sé concreto: describe la situación gatillo y qué hacer.",
      "Una acción apagada NO está disponible para el agente (no puede ejecutarla).",
      "Para derivar, indica a quién (equipo, agente o humano) y en qué casos.",
    ],
    examples: {
      good:
        "Actualizar etapa: cuando el cliente confirme que quiere agendar, marca la etapa como 'Caliente'. Si agenda una hora, márcalo como 'Agendado'.",
      bad: "Actualizar etapa: úsala cuando quieras. (❌ sin criterio; el agente no sabrá cuándo aplicarla.)",
    },
  },
  knowledge: {
    title: "Cómo usar las fuentes de conocimiento",
    intro:
      "Las fuentes de conocimiento son documentos (FAQ, políticas, convenios) que el agente puede consultar para responder con información real de tu negocio, sin inventar.",
    points: [
      "Activa para este agente solo las fuentes relevantes a su rol.",
      "Un agente de soporte se apoya mucho en el conocimiento; uno de ventas, menos.",
      "Mantén los documentos actualizados: el agente responde con lo que dice ahí.",
      "Si la respuesta no está en las fuentes, el agente lo reconoce y deriva.",
    ],
  },
};
