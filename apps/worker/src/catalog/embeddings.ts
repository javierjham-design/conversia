/**
 * Búsqueda SEMÁNTICA del catálogo (pgvector). El vector captura QUÉ es el producto
 * (nombre/categoría/marca/descripción), no su precio/stock —esos vienen frescos de la
 * fila—, así que embeber UNA vez (al aparecer) es lo correcto y barato. Gobernado por
 * EMBEDDINGS_PROVIDER=openai + OPENAI_API_KEY; si no, todo cae a búsqueda textual.
 */
import { createAIRouter } from "@conversia/agents";
import { getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";

const MODEL = "text-embedding-3-small";
const DIM = 1536;

export function embeddingsEnabled(): boolean {
  return getEnv().EMBEDDINGS_PROVIDER === "openai" && !!getEnv().OPENAI_API_KEY;
}

interface EmbedRow { id: string; name: string; bot_description: string | null; description: string | null; category: string | null; brand: string | null }

function buildText(it: EmbedRow): string {
  return [it.name, it.category, it.brand, it.bot_description || it.description].filter(Boolean).join(" · ").slice(0, 1000);
}

/** Serializa un vector al literal que entiende pgvector: [0.1,0.2,...] */
function vecLiteral(v: number[]): string {
  return "[" + v.map((n) => (Number.isFinite(n) ? n : 0)).join(",") + "]";
}

let router: ReturnType<typeof createAIRouter> | null = null;
function ai() {
  return (router ??= createAIRouter({ anthropicApiKey: getEnv().ANTHROPIC_API_KEY, openaiApiKey: getEnv().OPENAI_API_KEY }));
}

/** Embebe los ítems ACTIVOS del tenant que aún no tienen vector (nuevos). Batched, best-effort. */
export async function embedMissingCatalogItems(orgId: string, limit = 500): Promise<number> {
  if (!embeddingsEnabled()) return 0;
  let done = 0;
  await withTenant(orgId, async (tx) => {
    const rows = await tx.$queryRawUnsafe<EmbedRow[]>(
      `SELECT id, name, bot_description, description, category, brand FROM catalog_items
       WHERE organization_id = $1 AND embedding IS NULL AND active = true LIMIT $2`,
      orgId,
      limit,
    );
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const { vectors } = await ai().embed(batch.map(buildText), MODEL);
      for (let k = 0; k < batch.length; k++) {
        const v = vectors[k];
        if (!v || v.length !== DIM) continue;
        await tx.$executeRawUnsafe(`UPDATE catalog_items SET embedding = $1::vector WHERE id = $2`, vecLiteral(v), batch[k].id);
        done++;
      }
    }
  });
  return done;
}

/** IDs de ítems activos más cercanos semánticamente a la consulta. [] si no aplica o falla. */
export async function semanticCatalogSearch(
  orgId: string,
  query: string,
  opts: { category?: string; maxPrice?: number; onlyAvailable?: boolean; limit?: number } = {},
): Promise<string[]> {
  if (!embeddingsEnabled() || !query.trim()) return [];
  try {
    const { vectors } = await ai().embed([query], MODEL);
    const qv = vectors[0];
    if (!qv || qv.length !== DIM) return [];
    return await withTenant(orgId, async (tx) => {
      const where: string[] = ["organization_id = $1", "active = true", "embedding IS NOT NULL"];
      const params: unknown[] = [orgId];
      if (opts.onlyAvailable) where.push("available = true");
      if (opts.category) { params.push(opts.category); where.push(`category ILIKE $${params.length}`); }
      if (opts.maxPrice != null) { params.push(opts.maxPrice); where.push(`price <= $${params.length}`); }
      params.push(vecLiteral(qv));
      const vecParam = `$${params.length}::vector`;
      params.push(opts.limit ?? 8);
      const limitParam = `$${params.length}`;
      const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM catalog_items WHERE ${where.join(" AND ")} ORDER BY embedding <=> ${vecParam} LIMIT ${limitParam}`,
        ...params,
      );
      return rows.map((r) => r.id);
    });
  } catch {
    return []; // best-effort: si el proveedor falla, el caller usa la búsqueda textual
  }
}
