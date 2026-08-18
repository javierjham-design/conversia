// Catálogo de ACCIONES del agente para la UI. Cada acción mapea a una o más
// tools reales del orquestador. Al activar una acción, sus tools quedan
// disponibles y su instrucción en lenguaje natural se inyecta en el prompt.

export interface AgentActionDef {
  key: string;
  label: string;
  description: string;
  tools: string[];
  placeholder: string;
  mentions?: boolean; // muestra autocompletado @ (usuarios/equipos/agentes)
}

export const AGENT_ACTIONS: AgentActionDef[] = [
  {
    key: "scheduling",
    label: "Agendar citas",
    description: "Consultar servicios y disponibilidad real, y crear citas en la agenda.",
    tools: ["getServices", "getServicePrice", "getProfessionals", "getAvailability", "createAppointment"],
    placeholder: "Cuando el cliente quiera reservar, ofrece horarios reales desde la agenda y confirma la cita con sus datos.",
  },
  {
    key: "lifecycle",
    label: "Actualizar etapa del lead",
    description: "Mover el lead entre etapas (Nuevo, Caliente, Agendado, Cliente…).",
    tools: ["updateLeadStatus"],
    placeholder: "Marca 'Caliente' cuando muestre interés real; 'Agendado' cuando reserve una hora.",
  },
  {
    key: "tags",
    label: "Etiquetar la conversación",
    description: "Agregar etiquetas para segmentar (interés, campaña, urgencia…).",
    tools: ["addTag"],
    placeholder: "Etiqueta según el tema que plantee el cliente (p. ej. 'implantes', 'urgencia', 'financiamiento').",
  },
  {
    key: "contactFields",
    label: "Actualizar datos del contacto",
    description: "Guardar nombre, apellido o email cuando el cliente los proporciona.",
    tools: ["updateContactFields"],
    placeholder: "Guarda el nombre y el email cuando el cliente los comparta, para personalizar la atención.",
  },
  {
    key: "note",
    label: "Añadir nota interna",
    description: "Dejar una nota para el equipo humano (el cliente no la ve).",
    tools: ["addInternalNote"],
    placeholder: "Deja una nota si detectas algo relevante para el equipo (p. ej. 'cliente molesto por la demora').",
  },
  {
    key: "close",
    label: "Cerrar conversaciones",
    description: "Cerrar la conversación cuando el asunto quedó resuelto.",
    tools: ["closeConversation"],
    placeholder: "Cierra la conversación cuando el cliente confirme que no necesita nada más.",
  },
  {
    key: "assign",
    label: "Asignar / derivar",
    description: "Derivar a otro agente de IA, o asignar a un equipo o persona (la IA deja de responder).",
    tools: ["assignConversation", "transferToAgent", "transferToHuman"],
    mentions: true,
    placeholder: "Si el tema es de ventas, deriva al equipo @Ventas. Si hay urgencia o molestia, escala a un humano.",
  },
  {
    key: "workflow",
    label: "Disparar un flujo",
    description: "Iniciar un workflow de automatización por su nombre.",
    tools: ["triggerWorkflow"],
    placeholder: "Dispara el flujo 'Seguimiento 24h' cuando el cliente no confirme la cita.",
  },
  {
    key: "pricing",
    label: "Cotizar precios vigentes",
    description: "Consultar los planes y precios actuales de TuBot desde el sistema, para cotizar sin inventar ni memorizar valores.",
    tools: ["getPlanes"],
    placeholder: "Antes de dar un precio, consulta los planes vigentes con el sistema (getPlanes); nunca inventes ni repitas valores de memoria.",
  },
  {
    key: "assistedSetup",
    label: "Montaje asistido del cliente",
    description: "Configurar la cuenta del cliente por él: pedirle que autorice y te dicte su código, vincular su cuenta, ver en qué paso va y crearle su agente. Solo para el agente de implementación de TuBot.",
    tools: ["requestAssistedSetup", "vincularMontajeCliente", "getClientSetupState", "upsertClientAgent"],
    placeholder: "Pídele que autorice en su panel y te dicte el código; canjéalo para vincular su cuenta; revisa en qué paso va; y créale su agente con las instrucciones que redactaste desde su entrevista de negocio.",
  },
];

/** Deriva el array de `tools` a partir de las acciones habilitadas (+ extras a preservar). */
export function deriveTools(actions: Record<string, { enabled: boolean }>, extras: string[] = []): string[] {
  const set = new Set<string>(extras);
  for (const def of AGENT_ACTIONS) {
    if (actions[def.key]?.enabled) def.tools.forEach((t) => set.add(t));
  }
  return [...set];
}

/** Infiere qué acciones están activas a partir de un array de tools (agentes previos sin config.actions). */
export function inferActions(tools: string[]): Record<string, { enabled: boolean; instructions: string }> {
  const out: Record<string, { enabled: boolean; instructions: string }> = {};
  for (const def of AGENT_ACTIONS) {
    out[def.key] = { enabled: def.tools.some((t) => tools.includes(t)), instructions: "" };
  }
  return out;
}
