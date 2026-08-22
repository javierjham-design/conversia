/**
 * Acciones del agente: mapeo clave→etiqueta y ensamblado del system prompt con
 * las instrucciones en lenguaje natural de cada acción habilitada. Lo usa el
 * worker (runtime real) y el probador (misma verdad), para que el agente reciba
 * exactamente la misma guía que configuró el usuario.
 */
import { CORE_SCOPE_PREAMBLE } from "./core-guardrails.js";
export const ACTION_LABELS: Record<string, string> = {
  scheduling: "Agendar citas",
  lifecycle: "Actualizar la etapa del lead",
  tags: "Etiquetar la conversación",
  contactFields: "Actualizar datos del contacto",
  note: "Dejar una nota interna para el equipo",
  close: "Cerrar la conversación",
  assign: "Asignar a un equipo o persona",
  transfer: "Derivar a otro agente de IA",
  escalate: "Escalar a un humano",
  workflow: "Disparar un flujo de automatización",
};

export interface ActionConfig {
  enabled: boolean;
  instructions?: string;
}

export function assembleSystemPrompt(basePrompt: string, actions?: Record<string, ActionConfig> | null): string {
  const lines: string[] = [];
  for (const [key, cfg] of Object.entries(actions ?? {})) {
    if (cfg?.enabled && cfg.instructions?.trim()) {
      lines.push(`- ${ACTION_LABELS[key] ?? key}: ${cfg.instructions.trim()}`);
    }
  }
  const body =
    lines.length === 0
      ? basePrompt
      : `${basePrompt}\n\n## Cuándo y cómo usar tus acciones\n` +
        `Tienes herramientas para ejecutar acciones. Sigue estas indicaciones del negocio para decidir cuándo usarlas:\n` +
        lines.join("\n");
  // Núcleo de límites de alcance SIEMPRE al frente e inmutable: aplica a todos los
  // agentes y plantillas, y el tenant no puede desactivarlo editando su prompt.
  return `${CORE_SCOPE_PREAMBLE}\n\n${body}`;
}
