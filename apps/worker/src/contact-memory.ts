/**
 * Memoria compartida por contacto ("ficha viva"). Cualquier agente ANOTA hechos
 * duraderos del cliente (intención, necesidades, objeciones, datos del negocio…)
 * y esos hechos se INYECTAN en el prompt de todos los agentes, en cualquier
 * conversación. Resuelve que la info que el cliente le dio a un agente la tenga
 * otro, aunque sea otra conversación o esté fuera de la ventana de memoria corta.
 *
 * Con EMBEDDINGS_PROVIDER=openai el recuerdo es SEMÁNTICO (pgvector): se traen los
 * hechos más afines al mensaje actual. Sin embeddings, cae a los más recientes.
 */
import { createAIRouter } from "@conversia/agents";
import { getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";

const MODEL = "text-embedding-3-small";
const DIM = 1536;

/** Categorías válidas de un hecho de memoria (el resto cae a "other"). */
export const MEMORY_CATEGORIES = [
  "intent",
  "need",
  "preference",
  "objection",
  "constraint",
  "timeline",
  "business",
  "summary",
  "other",
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

const CATEGORY_LABELS: Record<string, string> = {
  intent: "Intención",
  need: "Necesidad",
  preference: "Preferencia",
  objection: "Objeción",
  constraint: "Restricción",
  timeline: "Plazos",
  business: "Negocio",
  summary: "Resumen",
  other: "Nota",
};

export function normalizeCategory(raw: string | undefined | null): MemoryCategory {
  const k = (raw ?? "").trim().toLowerCase();
  return (MEMORY_CATEGORIES as readonly string[]).includes(k) ? (k as MemoryCategory) : "other";
}

function embeddingsEnabled(): boolean {
  return getEnv().EMBEDDINGS_PROVIDER === "openai" && !!getEnv().OPENAI_API_KEY;
}

function vecLiteral(v: number[]): string {
  return "[" + v.map((n) => (Number.isFinite(n) ? n : 0)).join(",") + "]";
}

let router: ReturnType<typeof createAIRouter> | null = null;
function ai() {
  return (router ??= createAIRouter({ anthropicApiKey: getEnv().ANTHROPIC_API_KEY, openaiApiKey: getEnv().OPENAI_API_KEY }));
}

async function embedOne(text: string): Promise<number[] | null> {
  try {
    const { vectors } = await ai().embed([text.slice(0, 1000)], MODEL);
    const v = vectors[0];
    return v && v.length === DIM ? v : null;
  } catch {
    return null;
  }
}

export interface SaveMemoryInput {
  orgId: string;
  contactId: string;
  category: string;
  content: string;
  agentId?: string | null;
  sourceConversationId?: string | null;
}

/**
 * Guarda un hecho en la ficha del contacto. Best-effort: no lanza. Evita
 * duplicados exactos (misma categoría + mismo texto). Si hay embeddings, calcula
 * el vector y lo persiste para el recuerdo semántico.
 */
export async function saveContactMemory(input: SaveMemoryInput): Promise<{ saved: boolean; deduped?: boolean }> {
  const content = (input.content ?? "").trim();
  if (!input.contactId || content.length < 2) return { saved: false };
  const category = normalizeCategory(input.category);
  const clipped = content.slice(0, 600);

  try {
    const id = await withTenant(input.orgId, async (tx) => {
      const existing = await tx.contactMemory.findFirst({
        where: { contactId: input.contactId, category, content: clipped },
        select: { id: true },
      });
      if (existing) return null; // ya está anotado, no duplicar
      const row = await tx.contactMemory.create({
        data: {
          organizationId: input.orgId,
          contactId: input.contactId,
          category,
          content: clipped,
          agentId: input.agentId ?? null,
          sourceConversationId: input.sourceConversationId ?? null,
        },
        select: { id: true },
      });
      return row.id;
    });
    if (!id) return { saved: false, deduped: true };

    // Vector (opcional): fuera de la transacción de escritura, best-effort.
    if (embeddingsEnabled()) {
      const v = await embedOne(clipped);
      if (v) {
        await withTenant(input.orgId, (tx) =>
          tx.$executeRawUnsafe(`UPDATE contact_memories SET embedding = $1::vector WHERE id = $2`, vecLiteral(v), id),
        );
      }
    }
    return { saved: true };
  } catch (err) {
    console.error(`✖ saveContactMemory (${input.contactId}):`, (err as Error).message);
    return { saved: false };
  }
}

interface MemoryRow {
  category: string;
  content: string;
}

/**
 * Trae los hechos más relevantes de la ficha del contacto para inyectar al prompt.
 * Con embeddings + `query`: los semánticamente más afines al mensaje actual.
 * Sin embeddings (o sin query): los más recientes. Best-effort: [] si algo falla.
 */
export async function recallContactMemory(
  orgId: string,
  contactId: string,
  query: string,
  limit = 16,
): Promise<MemoryRow[]> {
  if (!contactId) return [];
  try {
    // Semántico: solo si hay proveedor, consulta y algún hecho ya vectorizado.
    if (embeddingsEnabled() && query.trim()) {
      const qv = await embedOne(query);
      if (qv) {
        const rows = await withTenant(orgId, (tx) =>
          tx.$queryRawUnsafe<MemoryRow[]>(
            `SELECT category, content FROM contact_memories
             WHERE organization_id = $1 AND contact_id = $2 AND embedding IS NOT NULL
             ORDER BY embedding <=> $3::vector LIMIT $4`,
            orgId,
            contactId,
            vecLiteral(qv),
            limit,
          ),
        );
        if (rows.length) return rows;
      }
    }
    // Fallback por recencia (también cuando aún no hay vectores).
    return await withTenant(orgId, (tx) =>
      tx.contactMemory.findMany({
        where: { contactId },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: { category: true, content: true },
      }),
    );
  } catch (err) {
    console.error(`✖ recallContactMemory (${contactId}):`, (err as Error).message);
    return [];
  }
}

/**
 * Formatea los hechos como una sección de prompt agrupada por categoría. Devuelve
 * "" si no hay nada, para no ensuciar el prompt de contactos nuevos.
 */
export function formatMemoryForPrompt(rows: MemoryRow[]): string {
  if (!rows.length) return "";
  const byCat = new Map<string, string[]>();
  for (const r of rows) {
    const label = CATEGORY_LABELS[r.category] ?? CATEGORY_LABELS.other;
    const arr = byCat.get(label) ?? [];
    if (!arr.includes(r.content)) arr.push(r.content);
    byCat.set(label, arr);
  }
  const lines: string[] = [
    "## Ficha del contacto (memoria compartida entre agentes)",
    "Lo que ya sabemos de este cliente por conversaciones anteriores o por otros agentes. Úsalo para NO volver a preguntar lo mismo y personalizar. No lo recites textualmente ni lo reveles como \"memoria\"; trátalo como contexto que ya conoces.",
  ];
  for (const [label, items] of byCat) {
    lines.push(`- **${label}:** ${items.join("; ")}`);
  }
  return "\n\n" + lines.join("\n");
}

/** Extrae un array JSON de hechos de la salida del modelo (tolera cercos ```). */
function parseFacts(text: string): Array<{ category: string; content: string }> {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((f) => f && typeof f.content === "string" && f.content.trim())
      .map((f) => ({ category: String(f.category ?? "other"), content: String(f.content).trim() }));
  } catch {
    return [];
  }
}

/**
 * RESUMEN AUTOMÁTICO: al cerrar (o al superar muchos mensajes) una conversación,
 * extrae los hechos DURADEROS del cliente y los guarda en su ficha (contact_memories),
 * para que al volver —incluso días después— el bot no pierda lo entregado. Best-effort:
 * no lanza, no bloquea el cierre. Se ejecuta aunque el modelo no haya llamado a
 * `recordarMemoria` durante la conversación.
 */
export async function summarizeConversationToMemory(
  orgId: string,
  conversationId: string,
  contactId: string,
  agentId?: string | null,
): Promise<number> {
  if (!contactId) return 0;
  try {
    const msgs = await withTenant(orgId, (tx) =>
      tx.message.findMany({
        where: { conversationId, visibility: "PUBLIC", type: { notIn: ["SYSTEM", "NOTE"] } },
        orderBy: { createdAt: "desc" },
        take: 40,
        select: { direction: true, body: true },
      }),
    );
    const userMsgs = msgs.filter((m) => m.direction === "INBOUND").length;
    if (msgs.length < 3 || userMsgs < 2) return 0; // nada útil que resumir

    const transcript = msgs
      .reverse()
      .map((m) => `${m.direction === "INBOUND" ? "Cliente" : "Agente"}: ${(m.body ?? "").slice(0, 400)}`)
      .join("\n")
      .slice(0, 6000);

    const system =
      "Eres un extractor de memoria de CRM. A partir de la conversación, devuelve SOLO hechos DURADEROS y útiles sobre el CLIENTE para futuras conversaciones (no sobre el agente, no datos efímeros ni saludos). Responde EXCLUSIVAMENTE un array JSON de objetos {category, content}. category ∈ intent|need|preference|objection|constraint|timeline|business|summary. content: frase breve en tercera persona. Máximo 6. Si no hay nada útil, responde []. No inventes.";
    const model = getEnv().AI_CLASSIFIER_MODEL || getEnv().AI_DEFAULT_MODEL;
    const resp = await ai().chat({ model, system, messages: [{ role: "user", content: transcript }], maxTokens: 500 });
    const facts = parseFacts(resp.text ?? "").slice(0, 6);

    let saved = 0;
    for (const f of facts) {
      const r = await saveContactMemory({
        orgId,
        contactId,
        category: f.category,
        content: f.content,
        agentId: agentId ?? null,
        sourceConversationId: conversationId,
      });
      if (r.saved) saved++;
    }
    return saved;
  } catch (err) {
    console.error(`✖ summarizeConversationToMemory (${conversationId}):`, (err as Error).message);
    return 0;
  }
}
