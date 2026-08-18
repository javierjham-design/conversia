/**
 * Motor de SINCRONIZACIÓN del catálogo. Orquesta un adaptador contra la BD:
 *   - upsert idempotente por (org, source, externalId) — paginado, no carga todo en memoria.
 *   - lo que DESAPARECIÓ del origen (sync completo) se marca no disponible, NO se borra
 *     (para no romper referencias ni historial).
 *   - registro por sync (creados / actualizados / desactivados / fallidos) en catalog_sync_runs.
 * Habla por CatalogSyncPort (datos), así se prueba con un puerto en memoria + adaptador falso.
 */
import type { CatalogAdapter, NormalizedItem } from "./types";

export interface CatalogSyncPort {
  startRun(orgId: string, source: string, mode: string): Promise<string>; // → runId
  upsertItems(orgId: string, source: string, items: NormalizedItem[]): Promise<{ created: number; updated: number }>;
  /** Marca no disponible lo que NO vino en esta sync completa. Devuelve cuántos. */
  deactivateMissing(orgId: string, source: string, seenExternalIds: string[]): Promise<number>;
  finishRun(runId: string, status: "success" | "error", counts: { created: number; updated: number; deactivated: number; failed: number }, error?: string | null): Promise<void>;
}

export interface SyncResult {
  created: number;
  updated: number;
  deactivated: number;
  failed: number;
}

export async function runCatalogSync(
  port: CatalogSyncPort,
  adapter: CatalogAdapter,
  orgId: string,
  opts: { mode: "full" | "incremental"; since?: Date } = { mode: "full" },
): Promise<SyncResult> {
  const runId = await port.startRun(orgId, adapter.source, opts.mode);
  const seen: string[] = [];
  let created = 0;
  let updated = 0;
  let failed = 0;

  const onPage = async (items: NormalizedItem[]) => {
    const valid = items.filter((i) => i.externalId && i.name);
    failed += items.length - valid.length;
    for (const i of valid) seen.push(i.externalId);
    try {
      const r = await port.upsertItems(orgId, adapter.source, valid);
      created += r.created;
      updated += r.updated;
    } catch {
      failed += valid.length;
    }
  };

  try {
    if (opts.mode === "incremental") await adapter.fetchSince(opts.since ?? new Date(0), onPage);
    else await adapter.fetchAll(onPage);
    // Solo el sync COMPLETO desactiva lo que desapareció (el incremental no ve todo).
    const deactivated = opts.mode === "full" ? await port.deactivateMissing(orgId, adapter.source, seen) : 0;
    const counts = { created, updated, deactivated, failed };
    await port.finishRun(runId, "success", counts);
    return counts;
  } catch (e) {
    const counts = { created, updated, deactivated: 0, failed };
    await port.finishRun(runId, "error", counts, (e as Error).message);
    throw e;
  }
}
