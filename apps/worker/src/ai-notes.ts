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

/**
 * Un comentario interno dirigido al BOT empieza con `@bot` / `@ia` / `bot:` / `ia:`
 * (sin distinguir mayúsculas). Devuelve la indicación SIN el marcador, o null si el
 * comentario NO va dirigido al bot (queda privado del equipo). Puro y testeable.
 */
const BOT_MARKER = /^\s*[@#]?(bot|ia)\b[\s:.,;–-]*/i;
export function extractBotIndication(body: string | null | undefined): string | null {
  const b = (body ?? "").trim();
  if (!BOT_MARKER.test(b)) return null;
  const rest = b.replace(BOT_MARKER, "").trim();
  return rest.length ? rest : null;
}

/**
 * Comentarios internos DIRIGIDOS al bot (empiezan con @bot/@ia): el equipo puede dejar
 * feedback inline en el hilo y el agente lo lee como indicación (prioridad alta). Los
 * comentarios internos SIN marcador siguen siendo solo del equipo (no los ve el bot).
 * Devuelve las últimas ~15 en orden cronológico.
 */
export async function getMarkedInternalNotes(
  organizationId: string,
  conversationId: string,
): Promise<{ body: string }[]> {
  const rows = await withTenant(organizationId, (tx) =>
    tx.message.findMany({
      where: { conversationId, visibility: "INTERNAL", type: "NOTE" },
      orderBy: { createdAt: "desc" },
      select: { body: true },
      take: 40,
    }),
  );
  const marked: { body: string }[] = [];
  for (const r of rows) {
    const ind = extractBotIndication(r.body);
    if (ind) marked.push({ body: ind });
  }
  return marked.reverse().slice(-15); // cronológico, tope defensivo
}
