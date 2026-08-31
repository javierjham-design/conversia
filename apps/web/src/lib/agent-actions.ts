// Catálogo de ACCIONES del agente para la UI. Cada acción mapea a una o más
// tools reales del orquestador. Al activar una acción, sus tools quedan
// disponibles y su instrucción en lenguaje natural se inyecta en el prompt.

export type AgentActionGroup = "atencion" | "comercio" | "tubot";

export interface AgentActionDef {
  key: string;
  label: string;
  description: string;
  tools: string[];
  placeholder: string;
  group: AgentActionGroup; // agrupa la acción en la UI para no mezclar rubros
  mentions?: boolean; // muestra autocompletado @ (usuarios/equipos/agentes)
}

/** Grupos de acciones (orden y encabezado en la UI). "comercio" solo aplica a
 * negocios que venden productos/menú; se muestra aparte para no mezclarlo. */
export const ACTION_GROUPS: { key: AgentActionGroup; label: string; description: string }[] = [
  { key: "atencion", label: "Atención y CRM", description: "Lo que todo agente puede hacer al conversar: agendar, etiquetar, mover el lead, derivar…" },
  { key: "comercio", label: "Venta con catálogo (comercio)", description: "Solo para negocios que venden productos o tienen menú. Actívalo si tu rubro trabaja con catálogo." },
  { key: "tubot", label: "TuBot (interno)", description: "Acciones propias de los agentes de TuBot (cotizar planes, montaje asistido)." },
];

export const AGENT_ACTIONS: AgentActionDef[] = [
  {
    key: "scheduling",
    label: "Agendar citas",
    description: "Consultar servicios y disponibilidad real, y crear citas en la agenda.",
    tools: ["getServices", "getServicePrice", "getProfessionals", "getAvailability", "createAppointment"],
    placeholder: "Cuando el cliente quiera reservar, ofrece horarios reales desde la agenda y confirma la cita con sus datos.",
    group: "atencion",
  },
  {
    key: "lifecycle",
    label: "Actualizar etapa del lead",
    description: "Mover el lead entre etapas (Nuevo, Caliente, Agendado, Cliente…).",
    tools: ["getLeadStatuses", "updateLeadStatus"],
    placeholder: "Marca 'Caliente' cuando muestre interés real; 'Agendado' cuando reserve una hora.",
    group: "atencion",
  },
  {
    key: "tags",
    label: "Etiquetar la conversación",
    description: "Agregar etiquetas para segmentar (interés, campaña, urgencia…).",
    tools: ["addTag"],
    placeholder: "Etiqueta según el tema que plantee el cliente (p. ej. 'implantes', 'urgencia', 'financiamiento').",
    group: "atencion",
  },
  {
    key: "contactFields",
    label: "Actualizar datos del contacto",
    description: "Guardar nombre, apellido o email cuando el cliente los proporciona.",
    tools: ["updateContactFields"],
    placeholder: "Guarda el nombre y el email cuando el cliente los comparta, para personalizar la atención.",
    group: "atencion",
  },
  {
    key: "note",
    label: "Añadir nota interna",
    description: "Dejar una nota para el equipo humano (el cliente no la ve).",
    tools: ["addInternalNote"],
    placeholder: "Deja una nota si detectas algo relevante para el equipo (p. ej. 'cliente molesto por la demora').",
    group: "atencion",
  },
  {
    key: "close",
    label: "Cerrar conversaciones",
    description: "Cerrar la conversación cuando el asunto quedó resuelto.",
    tools: ["closeConversation"],
    placeholder: "Cierra la conversación cuando el cliente confirme que no necesita nada más.",
    group: "atencion",
  },
  {
    key: "transfer",
    label: "Derivar a otro agente de IA",
    description: "Pasar la conversación a otro agente especializado (por nombre o slug). La IA SIGUE respondiendo: el agente destino toma la conversación al instante.",
    tools: ["transferToAgent"],
    mentions: true,
    placeholder: "Si preguntan por implantes, deriva a @RESP IMPLANTES. Si es agendamiento general, deriva a @Agendador.",
    group: "atencion",
  },
  {
    key: "assign",
    label: "Asignar / escalar a persona o equipo",
    description: "Asignar la conversación a un equipo o persona, o escalar a un humano. La IA deja de responder.",
    tools: ["assignConversation", "transferToHuman"],
    mentions: true,
    placeholder: "Si el tema es de ventas, asigna al equipo @Ventas. Si hay urgencia o molestia, escala a un humano.",
    group: "atencion",
  },
  {
    key: "workflow",
    label: "Disparar un flujo",
    description: "Iniciar un workflow de automatización por su nombre.",
    tools: ["triggerWorkflow"],
    placeholder: "Dispara el flujo 'Seguimiento 24h' cuando el cliente no confirme la cita.",
    group: "atencion",
  },
  {
    key: "web",
    label: "Leer páginas web",
    description: "Leer el sitio web de un prospecto/cliente (por su URL) para analizar su rubro, servicios y tono, y responder con datos reales.",
    tools: ["leerWeb"],
    placeholder: "Si el cliente menciona o comparte su sitio web, léelo para conocer su negocio antes de responder o cotizar.",
    group: "atencion",
  },
  {
    key: "memory",
    label: "Memoria del cliente (ficha viva)",
    description: "Anotar hechos duraderos del cliente (intención, necesidades, presupuesto, objeciones, datos del negocio) en una ficha compartida entre TODOS los agentes y conversaciones. Así lo que te cuenta a ti también lo tiene el resto, sin volver a preguntar. La ficha se inyecta sola en el prompt.",
    tools: ["recordarMemoria"],
    placeholder: "Anota lo importante que el cliente vaya contando (p. ej. 'tiene 4 profesionales', 'presupuesto acotado', 'quiere partir en enero') para no volver a preguntarlo y personalizar la atención.",
    group: "atencion",
  },
  {
    key: "catalog",
    label: "Vender con el catálogo",
    description: "Buscar en el catálogo real del negocio (productos de la tienda o platos del menú), consultar precio/stock/disponibilidad y enviar el enlace de compra. Requiere tener un catálogo cargado o una tienda conectada.",
    tools: ["buscarProductos", "verProducto"],
    placeholder: "Cuando pregunten por un producto, búscalo en el catálogo y responde con precio y disponibilidad reales; si está agotado ofrece alternativas; manda el enlace para comprar.",
    group: "comercio",
  },
  {
    key: "cobro",
    label: "Cobrar con link de pago (Flow)",
    description: "Enviar un link de pago Flow con el monto EXACTO acordado con el cliente, usando la cuenta Flow del negocio. Al activarla, configura tu cuenta de Flow (API Key y Secret Key) en Configuración avanzada, más abajo.",
    tools: ["enviarLinkDePago"],
    placeholder: "Cuando el cliente confirme el pedido y el monto, genera y envía el link de pago con ese monto exacto. Pide la foto/dato que falte antes de cobrar si corresponde.",
    group: "comercio",
  },
  {
    key: "pricing",
    label: "Cotizar precios vigentes",
    description: "Consultar los planes y precios actuales de TuBot desde el sistema, para cotizar sin inventar ni memorizar valores.",
    tools: ["getPlanes"],
    placeholder: "Antes de dar un precio, consulta los planes vigentes con el sistema (getPlanes); nunca inventes ni repitas valores de memoria.",
    group: "tubot",
  },
  {
    key: "assistedSetup",
    label: "Montaje asistido del cliente",
    description: "Configurar la cuenta del cliente por él: pedirle que autorice y te dicte su código, vincular su cuenta, ver en qué paso va y crearle su agente. Solo para el agente de implementación de TuBot.",
    tools: ["requestAssistedSetup", "vincularMontajeCliente", "getClientSetupState", "upsertClientAgent", "marcarPasoMontaje"],
    placeholder: "Pídele que autorice en su panel y te dicte el código; canjéalo para vincular su cuenta; revisa en qué paso va; y créale su agente con las instrucciones que redactaste desde su entrevista de negocio.",
    group: "tubot",
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
