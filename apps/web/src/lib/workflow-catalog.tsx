import type { ReactNode } from "react";
import {
  Bot, CalendarClock, Clock, CornerUpRight, Crosshair, FileText, GitBranch, Megaphone, MessageSquare, MessageSquarePlus,
  Pause, Pencil, PlayCircle, Share2, Sheet, Square, StickyNote, Tag, Tags, Target, UserRound, Users, Webhook, XCircle, Zap,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// FUENTE ÚNICA DE VERDAD del catálogo de PASOS de Flujos. La consumen el editor,
// el probador (depuración) y el detalle de ejecución (revisión) — mismos iconos,
// etiquetas, categorías y color, sin duplicar ni divergir. (El servidor solo
// mantiene el catálogo de DISPARADORES.)
// ─────────────────────────────────────────────────────────────────────────────

export const CATEGORIES = ["Mensajes", "Contacto", "Conversación", "Control de flujo", "Marketing", "Integraciones", "IA", "Agenda"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface NodeDef {
  type: string;
  label: string;
  description: string;
  category: Category;
  icon: ReactNode;
  defaultConfig: Record<string, unknown>;
  branches?: { handle: string; label: string }[];
  terminal?: boolean;
  soon?: boolean; // "Próximamente" — deshabilitado, no lo ejecuta el motor
  premium?: boolean; // requiere plan superior (se valida al publicar)
}

export const NODE_DEFS: NodeDef[] = [
  // Mensajes
  { type: "send_text", label: "Enviar mensaje", description: "Envía un texto (admite variables {{...}})", category: "Mensajes", icon: <MessageSquare size={15} />, defaultConfig: { text: "" } },
  { type: "send_template", label: "Enviar plantilla WhatsApp", description: "Mensaje con plantilla HSM aprobada (funciona fuera de la ventana de 24h)", category: "Mensajes", icon: <FileText size={15} />, defaultConfig: {} },
  // Contacto
  { type: "update_lead_status", label: "Cambiar etapa del lead", description: "Mueve el lead a otra etapa del ciclo de vida", category: "Contacto", icon: <Tag size={15} />, defaultConfig: { statusCode: "" } },
  { type: "add_tag", label: "Agregar etiqueta", description: "Etiqueta la conversación/contacto", category: "Contacto", icon: <Tag size={15} />, defaultConfig: { tag: "" } },
  { type: "remove_tag", label: "Quitar etiqueta", description: "Quita una etiqueta", category: "Contacto", icon: <Tags size={15} />, defaultConfig: { tag: "" } },
  { type: "update_contact", label: "Actualizar datos del contacto", description: "Guarda nombre, apellido o email", category: "Contacto", icon: <Pencil size={15} />, defaultConfig: { fields: {} } },
  // Conversación
  { type: "open_conversation", label: "Abrir conversación", description: "Abre una conversación para el contacto si no hay una activa", category: "Conversación", icon: <MessageSquarePlus size={15} />, defaultConfig: {} },
  { type: "add_note", label: "Añadir comentario", description: "Comentario interno, solo lo ve el equipo", category: "Conversación", icon: <StickyNote size={15} />, defaultConfig: { text: "" } },
  { type: "assign_user", label: "Asignar a usuario", description: "Asigna a una persona (pausa la IA)", category: "Conversación", icon: <UserRound size={15} />, defaultConfig: { userId: "" } },
  { type: "assign_team", label: "Asignar a equipo", description: "Asigna a un equipo (pausa la IA)", category: "Conversación", icon: <Users size={15} />, defaultConfig: { teamId: "" } },
  { type: "transfer_human", label: "Escalar a humano", description: "Pausa la IA y notifica al equipo", category: "Conversación", icon: <UserRound size={15} />, defaultConfig: { reason: "" } },
  { type: "pause_ai", label: "Pausar IA", description: "Detiene las respuestas automáticas del agente en esta conversación (p. ej. durante una derivación a humano)", category: "Conversación", icon: <Pause size={15} />, defaultConfig: {} },
  { type: "resume_ai", label: "Reanudar IA", description: "Vuelve a activar las respuestas automáticas del agente", category: "Conversación", icon: <PlayCircle size={15} />, defaultConfig: {} },
  { type: "close_conversation", label: "Cerrar conversación", description: "Marca la conversación como cerrada", category: "Conversación", icon: <XCircle size={15} />, defaultConfig: {} },
  // Control de flujo
  { type: "wait", label: "Esperar", description: "Pausa el flujo; opcional cancelar si el contacto responde", category: "Control de flujo", icon: <Clock size={15} />, defaultConfig: { minutes: 5, cancelOn: "contact_reply" } },
  {
    type: "wait_reply", label: "¿El contacto respondió?", description: "Espera una respuesta un tiempo y ramifica: Sí respondió / No respondió. Ambas ramas continúan.", category: "Control de flujo", icon: <GitBranch size={15} />, defaultConfig: { hours: 24 },
    branches: [{ handle: "replied", label: "Sí, respondió" }, { handle: "no_reply", label: "No respondió" }],
  },
  {
    type: "condition", label: "¿Sigue sin responder? (instantáneo)", description: "Ramifica al instante según si el contacto ya respondió (no espera). Para esperar una respuesta usa «¿El contacto respondió?».", category: "Control de flujo", icon: <GitBranch size={15} />, defaultConfig: { kind: "no_reply" },
    branches: [{ handle: "true", label: "Sin respuesta" }, { handle: "false", label: "Respondió" }],
  },
  {
    type: "business_hours", label: "Fecha y hora", description: "Ramifica según el horario de atención del negocio", category: "Control de flujo", icon: <CalendarClock size={15} />,
    defaultConfig: { timezone: "America/Santiago", hours: { mon: [{ from: "09:00", to: "18:00" }], tue: [{ from: "09:00", to: "18:00" }], wed: [{ from: "09:00", to: "18:00" }], thu: [{ from: "09:00", to: "18:00" }], fri: [{ from: "09:00", to: "18:00" }], sat: [], sun: [] }, holidays: [] },
    branches: [{ handle: "in", label: "Dentro de horario" }, { handle: "out", label: "Fuera de horario" }],
  },
  { type: "goto", label: "Saltar a otro paso", description: "Continúa en cualquier otro paso del flujo", category: "Control de flujo", icon: <CornerUpRight size={15} />, defaultConfig: { targetNodeId: "" } },
  { type: "start_workflow", label: "Disparar otro flujo", description: "Inicia otro workflow por su nombre", category: "Control de flujo", icon: <Share2 size={15} />, defaultConfig: { workflowName: "" } },
  { type: "stop", label: "Terminar flujo", description: "Finaliza la ejecución", category: "Control de flujo", icon: <Square size={15} />, defaultConfig: {}, terminal: true },
  // Marketing
  { type: "send_capi", label: "Enviar evento CAPI (Meta)", description: "Envía un evento de conversión a Meta (Lead, Schedule, Purchase…)", category: "Marketing", icon: <Target size={15} />, defaultConfig: { eventName: "Lead", value: "", currency: "CLP" } },
  { type: "send_ga4_event", label: "Enviar evento GA4", description: "Envía un evento a Google Analytics con parámetros y variables", category: "Marketing", icon: <Target size={15} />, defaultConfig: { eventName: "", params: {} } },
  { type: "send_tiktok_event", label: "Enviar evento TikTok", description: "Evento a TikTok Events API", category: "Marketing", icon: <Megaphone size={15} />, defaultConfig: {}, soon: true },
  // IA
  { type: "run_agent", label: "Ejecutar agente IA", description: "El agente elegido responde la conversación", category: "IA", icon: <Bot size={15} />, defaultConfig: { agentSlug: "" } },
  { type: "switch_agent", label: "Cambiar agente IA", description: "Otro agente IA toma el control", category: "IA", icon: <Bot size={15} />, defaultConfig: { agentSlug: "" } },
  {
    type: "ai_objective", label: "Agente IA con objetivo", description: "Entrega la conversación a un agente con un objetivo y ramifica según el resultado",
    category: "IA", icon: <Crosshair size={15} />, defaultConfig: { agentSlug: "", objective: "", maxTurns: 1, timeoutHours: 24 },
    branches: [{ handle: "met", label: "Objetivo cumplido" }, { handle: "unmet", label: "No cumplido / escalado" }],
  },
  // Integraciones
  { type: "call_api", label: "Petición HTTP", description: "Llama a un endpoint externo y mapea la respuesta a variables", category: "Integraciones", icon: <Webhook size={15} />, premium: true, defaultConfig: { method: "GET", url: "", headers: {}, body: "", responseMapping: {} } },
  { type: "send_internal_email", label: "Enviar correo interno", description: "Aviso por correo al equipo (nunca a contactos), con variables", category: "Integraciones", icon: <FileText size={15} />, defaultConfig: { to: [], subject: "", body: "" } },
  { type: "google_sheets_append", label: "Añadir fila a Google Sheets", description: "Agrega una fila a una hoja de cálculo (requiere conectar Google en Integraciones)", category: "Integraciones", icon: <Sheet size={15} />, defaultConfig: { spreadsheetId: "", sheetName: "", values: [] } },
];

export const NODE_DEF = (type: string): NodeDef | undefined => NODE_DEFS.find((n) => n.type === type);
export const nodeLabel = (type: string): string => NODE_DEF(type)?.label ?? type;
export const nodeIcon = (type: string): ReactNode => NODE_DEF(type)?.icon ?? <Zap size={15} />;
export const nodeCategory = (type: string): Category | null => NODE_DEF(type)?.category ?? null;

/**
 * Color SUTIL por categoría (tokens del sistema; ámbar reservado a "atención").
 * `chip` = fondo tenue del ícono; `text` = color del ícono; `bar` = barra
 * superior del nodo. Coherentes en claro y oscuro.
 */
export const CATEGORY_META: Record<Category, { chip: string; text: string; bar: string }> = {
  Mensajes: { chip: "bg-brand-50 dark:bg-brand-500/15", text: "text-brand-600 dark:text-brand-300", bar: "bg-brand-500" },
  Contacto: { chip: "bg-emerald-50 dark:bg-emerald-500/15", text: "text-emerald-600 dark:text-emerald-300", bar: "bg-emerald-500" },
  Conversación: { chip: "bg-sky-50 dark:bg-sky-500/15", text: "text-sky-600 dark:text-sky-300", bar: "bg-sky-500" },
  "Control de flujo": { chip: "bg-indigo-50 dark:bg-indigo-500/15", text: "text-indigo-600 dark:text-indigo-300", bar: "bg-indigo-500" },
  IA: { chip: "bg-violet-50 dark:bg-violet-500/15", text: "text-violet-600 dark:text-violet-300", bar: "bg-violet-500" },
  Agenda: { chip: "bg-teal-50 dark:bg-teal-500/15", text: "text-teal-600 dark:text-teal-300", bar: "bg-teal-500" },
  Marketing: { chip: "bg-rose-50 dark:bg-rose-500/15", text: "text-rose-600 dark:text-rose-300", bar: "bg-rose-500" },
  Integraciones: { chip: "bg-cyan-50 dark:bg-cyan-500/15", text: "text-cyan-600 dark:text-cyan-300", bar: "bg-cyan-500" },
};
export const categoryMeta = (type: string) => {
  const c = nodeCategory(type);
  return c ? CATEGORY_META[c] : { chip: "bg-app", text: "text-ink-subtle", bar: "bg-line-strong" };
};
