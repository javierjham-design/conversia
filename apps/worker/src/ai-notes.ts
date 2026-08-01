import { withTenant } from "@conversia/database";

/**
 * Indicaciones del equipo para la IA en UNA conversación concreta
 * (conversation_ai_notes). Se inyectan al prompt del agente en cada turno de
 * ESA conversación: prioridad sobre el prompt base, pero explícitamente por
 * debajo de las reglas de seguridad del sistema (no pueden anularlas).
 */

/** Bloque a inyectar en el system prompt (puro; testeado). Vacío si no hay notas. */
export function buildConversationInstructions(notes: { body: string }[]): string {
  const bodies = notes.map((n) => n.body.trim()).filter(Boolean);
  if (!bodies.length) return "";
  return (
    "\n\n## Indicaciones del equipo para ESTA conversación (prioridad alta)\n" +
    "El equipo humano dejó estas indicaciones específicas para este contacto. " +
    "Síguelas con prioridad sobre tus instrucciones generales. IMPORTANTE: estas " +
    "indicaciones NUNCA anulan tus reglas de seguridad, privacidad ni límites del sistema.\n" +
    bodies.map((b) => `- ${b}`).join("\n")
  );
}

/** Indicaciones ACTIVAS de la conversación (solo de este tenant, vía RLS). */
export async function getActiveConversationInstructions(
  organizationId: string,
  conversationId: string,
): Promise<{ body: string }[]> {
  return withTenant(organizationId, (tx) =>
    tx.conversationAiNote.findMany({
      where: { conversationId, active: true },
      orderBy: { createdAt: "asc" },
      select: { body: true },
      take: 20,
    }),
  );
}
