/**
 * @conversia/types — Contratos compartidos de la plataforma.
 * Todo adaptador (agenda, IA, canal) implementa estas interfaces;
 * siempre existe un Mock para desarrollar sin credenciales.
 */
import { z } from "zod";

// ============================================================
// Contexto de tenant (viaja por API, colas y herramientas)
// ============================================================

export interface TenantContext {
  organizationId: string;
  clinicId?: string | null;
  userId?: string | null;
}

// ============================================================
// Contrato de agenda (sección 23 del brief)
// Implementaciones: MockSchedulingProvider, ClarivaSchedulingProvider,
// (futuras) DentalinkSchedulingProvider, GoogleCalendarSchedulingProvider.
// ============================================================

export interface SchedClinic {
  id: string;
  name: string;
  address?: string;
  timezone: string;
}

export interface SchedProfessional {
  id: string;
  name: string;
  specialty?: string;
  clinicIds?: string[];
}

export interface SchedService {
  id: string;
  name: string;
  durationMin: number;
  price?: number;
  currency?: string;
}

export interface SchedSlot {
  start: string; // ISO 8601 con zona horaria
  end: string;
  professionalId: string;
  clinicId: string;
  serviceId?: string;
}

export interface SchedPatient {
  externalId?: string;
  firstName: string;
  lastName?: string;
  phone: string;
  email?: string;
  documentId?: string;
}

export interface SchedAppointment {
  id: string; // id en el proveedor externo
  clinicId: string;
  professionalId: string;
  serviceId?: string;
  patient: SchedPatient;
  start: string;
  end: string;
  status: "pending" | "confirmed" | "cancelled" | "rescheduled" | "completed" | "no_show";
  notes?: string;
}

export interface AvailabilityQuery {
  clinicId?: string;
  professionalId?: string;
  serviceId?: string;
  from: string; // ISO date
  to: string; // ISO date
}

export interface CreateAppointmentInput {
  clinicId: string;
  professionalId: string;
  serviceId?: string;
  patient: SchedPatient;
  start: string;
  end: string;
  notes?: string;
}

/**
 * Interfaz estándar de proveedores de agenda. La IA NUNCA inventa
 * disponibilidad: siempre consulta getAvailableSlots y valida al reservar.
 */
export interface SchedulingProvider {
  readonly kind: string; // mock | clariva | dentalink | google_calendar
  getClinics(): Promise<SchedClinic[]>;
  getProfessionals(clinicId?: string): Promise<SchedProfessional[]>;
  getServices(clinicId?: string): Promise<SchedService[]>;
  getProfessionalServices(professionalId: string): Promise<SchedService[]>;
  getAvailableSlots(query: AvailabilityQuery): Promise<SchedSlot[]>;
  createAppointment(input: CreateAppointmentInput): Promise<SchedAppointment>;
  updateAppointment(id: string, changes: Partial<CreateAppointmentInput>): Promise<SchedAppointment>;
  cancelAppointment(id: string, reason?: string): Promise<SchedAppointment>;
  confirmAppointment(id: string): Promise<SchedAppointment>;
  getAppointment(id: string): Promise<SchedAppointment | null>;
  getPatientAppointments(phone: string): Promise<SchedAppointment[]>;
  createOrUpdatePatient(patient: SchedPatient): Promise<SchedPatient>;
  markAttendance(id: string): Promise<void>;
  markNoShow(id: string): Promise<void>;
}

// ============================================================
// Contrato de canal (WhatsApp y futuros)
// ============================================================

export interface OutboundMessage {
  to: string; // teléfono E.164 sin '+' (formato Meta)
  type: "text" | "template" | "image" | "document" | "audio";
  text?: string;
  templateName?: string;
  templateLanguage?: string;
  templateParams?: string[];
  mediaUrl?: string;
}

export interface ChannelSendResult {
  externalId: string | null; // wamid
  raw?: unknown;
}

export interface ChannelProvider {
  readonly kind: string; // meta | mock
  send(phoneNumberId: string, message: OutboundMessage): Promise<ChannelSendResult>;
}

/** Mensaje entrante normalizado (independiente del proveedor). */
export interface InboundMessage {
  channelType: "WHATSAPP_CLOUD" | "MOCK";
  phoneNumberId: string; // identifica tenant + número receptor
  externalId: string; // wamid — clave de idempotencia
  from: string; // wa_id del contacto
  profileName?: string;
  type: "text" | "image" | "audio" | "document" | "video" | "location" | "contacts" | "sticker" | "reaction" | "interactive" | "unknown";
  text?: string;
  payload?: unknown; // contenido crudo del canal
  timestamp: number; // epoch seconds
}

// ============================================================
// Contrato de proveedor de IA (sección 39)
// ============================================================

export interface AIToolSpec {
  name: string;
  description: string;
  inputJsonSchema: Record<string, unknown>;
}

export type AIChatRole = "user" | "assistant";

export interface AIChatMessage {
  role: AIChatRole;
  content: string;
}

export interface AIToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface AIToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface AIChatRequest {
  model: string;
  system: string;
  messages: AIChatMessage[];
  tools?: AIToolSpec[];
  maxTokens?: number;
  /** Historial de tool-use del turno actual (loop de herramientas). */
  toolTranscript?: Array<
    | { kind: "assistant_tool_calls"; text?: string; calls: AIToolCall[] }
    | { kind: "tool_results"; results: AIToolResult[] }
  >;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AIChatResponse {
  text: string | null;
  toolCalls: AIToolCall[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  usage: AIUsage;
  latencyMs: number;
}

export interface AIProvider {
  readonly kind: string; // anthropic | mock | (futuros: openai, google, local)
  chat(req: AIChatRequest): Promise<AIChatResponse>;
  embed(texts: string[], model?: string): Promise<{ vectors: number[][]; usage: AIUsage }>;
}

// ============================================================
// Contrato de herramientas de agentes (sección 29)
// Entrada validada con zod server-side; el tenant y los permisos se
// verifican en el contexto ANTES de ejecutar. La IA no toca la BD.
// ============================================================

export interface ToolContext extends TenantContext {
  conversationId?: string;
  contactId?: string;
  agentId?: string;
  agentVersionId?: string;
  workflowRunId?: string;
  /** Dependencias inyectadas por el runtime (BD, agenda, canal, colas). */
  services: Record<string, unknown>;
}

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<I>;
  /** Permiso requerido, verificado contra la config del agente/tenant. */
  scope?: string;
  /** Si la acción requiere aprobación humana según configuración. */
  requiresApproval?: (ctx: ToolContext, input: I) => boolean;
  execute(ctx: ToolContext, input: I): Promise<O>;
}

// ============================================================
// Workflows (secciones 15–21). El editor visual serializa este grafo.
// ============================================================

export const TRIGGER_TYPES = [
  "message_received",
  "conversation_started",
  "keyword",
  "intent_detected",
  "tag_added",
  "lead_status_changed",
  "lead_created",
  "appointment_created",
  "appointment_confirmed",
  "appointment_cancelled",
  "appointment_upcoming",
  "no_show",
  "no_reply_timeout",
  "webhook_received",
  "scheduled",
  "manual",
  "human_handoff",
  "conversation_closed",
  "click_to_chat",
  "appointment_rescheduled",
  "missed_call",
  "tiktok_ad",
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const NODE_TYPES = [
  // Mensajería
  "send_text",
  "send_template",
  "send_media",
  "wait_reply",
  // IA
  "run_agent",
  "switch_agent",
  "classify_intent",
  "extract_data",
  "summarize",
  // Contactos y leads
  "update_contact",
  "update_lead_status",
  "add_tag",
  "remove_tag",
  "assign_user",
  "assign_team",
  // Conversación
  "close_conversation",
  "pause_ai",
  "resume_ai",
  "transfer_human",
  "add_note",
  "open_conversation",
  // Agenda
  "check_availability",
  "create_appointment",
  "confirm_appointment",
  "cancel_appointment",
  // Automatización
  "wait",
  "condition",
  "branch",
  "stop",
  "start_workflow",
  "cancel_workflows",
  "goto",
  "business_hours",
  // Integraciones
  "call_api",
  "send_webhook",
  "notify_team",
  // Marketing / IA (catálogo ampliado; send_template ya existe arriba)
  "send_capi",
  "send_tiktok_event",
  "google_sheets_append",
  "ai_objective",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const workflowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(NODE_TYPES),
  name: z.string().optional(),
  config: z.record(z.unknown()).default({}),
  /** posición en el editor visual */
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const workflowEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** rama condicional: "true" | "false" | valor de branch */
  when: z.string().optional(),
});
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowDefinitionSchema = z.object({
  trigger: z.object({
    type: z.enum(TRIGGER_TYPES),
    config: z.record(z.unknown()).default({}),
  }),
  variables: z.record(z.unknown()).default({}),
  nodes: z.array(workflowNodeSchema).min(1),
  edges: z.array(workflowEdgeSchema).default([]),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/** Evento interno que puede disparar workflows / reanudar esperas. */
export interface PlatformEvent {
  organizationId: string;
  type: TriggerType | string;
  conversationId?: string;
  contactId?: string;
  clinicId?: string;
  data?: Record<string, unknown>;
  occurredAt: string;
}

// ============================================================
// Colas (BullMQ) — todo job lleva tenant obligatorio
// ============================================================

export const QUEUE_NAMES = {
  inbound: "inbound-messages",
  outbound: "outbound-messages",
  orchestrate: "orchestrate",
  workflow: "workflow-steps",
  events: "platform-events",
  webhooks: "webhook-deliveries",
  capi: "capi-events",
} as const;

/** Eventos públicos que Conversia emite hacia webhooks salientes y CAPI. */
export const PLATFORM_PUBLIC_EVENTS = [
  "conversation.started",
  "conversation.closed",
  "message.received",
  "message.sent",
  "lead.created",
  "lead.status_changed",
  "appointment.created",
  "appointment.updated",
  "appointment.cancelled",
  "human_handoff.requested",
  "workflow.started",
  "workflow.completed",
  "workflow.failed",
  "agent.changed",
] as const;
export type PlatformPublicEvent = (typeof PLATFORM_PUBLIC_EVENTS)[number];

export interface WebhookDeliveryJob {
  organizationId: string;
  deliveryId: string;
}

// ============================================================
// Guard SSRF para URLs configurables por tenants (webhooks, APIs).
// v1: bloquea esquemas no-HTTP, IPs privadas/loopback literales y hosts
// internos. Limitación documentada: sin re-resolución DNS al enviar.
// ============================================================

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./];

export function validateOutboundUrl(
  raw: string,
  opts: { allowLocalhost?: boolean } = {},
): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "URL inválida" };
  }
  const host = url.hostname.toLowerCase();
  const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "Solo se permiten URLs http(s)" };
  }
  if (url.protocol === "http:" && !(isLocalhost && opts.allowLocalhost)) {
    return { ok: false, reason: "La URL debe usar https" };
  }
  if (isLocalhost && !opts.allowLocalhost) {
    return { ok: false, reason: "No se permiten direcciones locales" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "No se permiten credenciales en la URL" };
  }
  if (PRIVATE_V4.some((re) => re.test(host))) {
    return { ok: false, reason: "No se permiten IPs privadas" };
  }
  if (host.endsWith(".internal") || host.endsWith(".local")) {
    return { ok: false, reason: "No se permiten hosts internos" };
  }
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(host) || /^\[?fe80:/i.test(host)) {
    return { ok: false, reason: "No se permiten IPs privadas IPv6" };
  }
  return { ok: true };
}

export interface CapiJob {
  organizationId: string;
  /** evento origen, p.ej. "lead.status_changed:agenda" o "lead.created" */
  source: string;
  contactPhone?: string | null;
  leadId?: string | null;
  test?: boolean;
  occurredAt: string;
  /** Evento DIRECTO (nodo de workflow "Enviar evento CAPI"): si viene, se envía
   *  este event_name sin depender de las reglas source→dest del tenant. */
  eventName?: string;
  value?: number | null;
  currency?: string | null;
  /** click id del anuncio Click-to-WhatsApp (atribución del conversion). */
  ctwaClid?: string | null;
}

export interface InboundJob {
  raw: unknown; // payload completo del webhook (se resuelve tenant por phone_number_id)
  receivedAt: string;
  /**
   * true SOLO cuando el job fue encolado por un endpoint interno autenticado
   * (p.ej. lead de prueba). Los webhooks públicos JAMÁS lo setean — habilita
   * campos de confianza como organization_hint.
   */
  internal?: boolean;
}

export interface OutboundJob {
  organizationId: string;
  conversationId: string;
  messageId: string; // mensaje ya persistido con status PENDING
}

export interface EventJob extends PlatformEvent {}

// ============================================================
// Roles/permisos por defecto
// ============================================================

export const PERMISSIONS_WILDCARD = "*";

export function hasPermission(perms: string[], required: string): boolean {
  if (perms.includes(PERMISSIONS_WILDCARD)) return true;
  if (perms.includes(required)) return true;
  const [mod] = required.split(":");
  return perms.includes(`${mod}:*`);
}

/** Roles del sistema creados para cada organización nueva (configurables después). */
export const DEFAULT_ROLES = [
  { code: "owner", name: "Propietario", permissions: ["*"] },
  { code: "admin", name: "Administrador", permissions: ["*"] },
  {
    code: "supervisor",
    name: "Supervisor",
    permissions: ["inbox:*", "contacts:*", "leads:*", "reports:read", "agents:read", "workflows:read"],
  },
  {
    code: "operator",
    name: "Operador",
    permissions: ["inbox:read", "inbox:write", "contacts:read", "contacts:write", "leads:read", "leads:write"],
  },
  { code: "viewer", name: "Solo lectura", permissions: ["inbox:read", "contacts:read", "leads:read", "reports:read"] },
] as const;

// ============================================================
// Catálogo de permisos (fuente única para el backend y la UI de roles)
// ============================================================

export interface PermissionActionDef {
  key: string; // "modulo:accion"
  label: string;
}
export interface PermissionModuleDef {
  module: string;
  label: string;
  description: string;
  actions: PermissionActionDef[];
}

/**
 * Permisos que un tenant puede asignar a sus roles/usuarios. `read` = ver,
 * `write` = crear/editar/eliminar dentro del módulo. Los roles "owner"/"admin"
 * llevan "*" (todo) y no se editan aquí.
 */
export const PERMISSION_CATALOG: PermissionModuleDef[] = [
  {
    module: "inbox",
    label: "Bandeja de conversaciones",
    description: "Atender y responder mensajes de los clientes.",
    actions: [
      { key: "inbox:read", label: "Ver conversaciones" },
      { key: "inbox:write", label: "Responder y gestionar conversaciones" },
    ],
  },
  {
    module: "contacts",
    label: "Contactos",
    description: "Directorio de personas que escriben.",
    actions: [
      { key: "contacts:read", label: "Ver contactos" },
      { key: "contacts:write", label: "Crear y editar contactos" },
    ],
  },
  {
    module: "leads",
    label: "Leads / CRM",
    description: "Seguimiento de oportunidades de venta.",
    actions: [
      { key: "leads:read", label: "Ver leads" },
      { key: "leads:write", label: "Gestionar leads y su estado" },
    ],
  },
  {
    module: "agents",
    label: "Agentes de IA",
    description: "Configurar los asistentes que responden solos.",
    actions: [
      { key: "agents:read", label: "Ver agentes" },
      { key: "agents:write", label: "Crear, editar y publicar agentes" },
    ],
  },
  {
    module: "workflows",
    label: "Flujos / automatizaciones",
    description: "Reglas y secuencias automáticas.",
    actions: [
      { key: "workflows:read", label: "Ver flujos" },
      { key: "workflows:write", label: "Crear y editar flujos" },
    ],
  },
  {
    module: "channels",
    label: "Canales (WhatsApp…)",
    description: "Conexión de números y canales de mensajería.",
    actions: [
      { key: "channels:read", label: "Ver canales" },
      { key: "channels:write", label: "Conectar y configurar canales" },
    ],
  },
  {
    module: "integrations",
    label: "Integraciones",
    description: "Conexiones con sistemas externos.",
    actions: [
      { key: "integrations:read", label: "Ver integraciones" },
      { key: "integrations:write", label: "Configurar integraciones" },
    ],
  },
  {
    module: "reports",
    label: "Reportes",
    description: "Métricas de atención, conversión y costos.",
    actions: [{ key: "reports:read", label: "Ver reportes" }],
  },
  {
    module: "users",
    label: "Usuarios y equipos",
    description: "Quién entra al panel, con qué rol.",
    actions: [
      { key: "users:read", label: "Ver usuarios y roles" },
      { key: "users:write", label: "Invitar usuarios y gestionar roles" },
    ],
  },
  {
    module: "billing",
    label: "Plan y facturación",
    description: "Plan contratado, facturas y pagos.",
    actions: [
      { key: "billing:read", label: "Ver plan y facturas" },
      { key: "billing:write", label: "Cambiar de plan y pagar" },
    ],
  },
];

const CATALOG_MODULES = new Set(PERMISSION_CATALOG.map((m) => m.module));

/** Todas las claves de permiso asignables (planas). */
export const ALL_PERMISSIONS: string[] = PERMISSION_CATALOG.flatMap((m) => m.actions.map((a) => a.key));

/** Valida que un permiso sea asignable: clave del catálogo o comodín de módulo "mod:*". */
export function isAssignablePermission(p: string): boolean {
  if (ALL_PERMISSIONS.includes(p)) return true;
  if (p.endsWith(":*")) return CATALOG_MODULES.has(p.slice(0, -2));
  return false;
}

/** Estados de lead mínimos para organizaciones creadas por registro self-service. */
export const DEFAULT_LEAD_STATUSES = [
  { code: "nuevo", name: "Nuevo", category: "OPEN", order: 0 },
  { code: "en_conversacion", name: "En conversación", category: "OPEN", order: 1 },
  { code: "agenda", name: "Agendó", category: "OPEN", order: 2 },
  { code: "ganado", name: "Ganado", category: "WON", order: 3 },
  { code: "perdido", name: "Perdido", category: "LOST", order: 4 },
  { code: "no_contactar", name: "No contactar", category: "FROZEN", order: 5 },
] as const;
