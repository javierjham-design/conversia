/**
 * Job de sincronización de catálogo (cola `sync`, kind `catalog_sync`). Lee la conexión del
 * tenant, descifra las credenciales, arma el adaptador y corre el motor. Actualiza el estado
 * de la conexión. Agregar un proveedor = un caso más en buildAdapter.
 */
import { getAdminPrisma, withTenant } from "@conversia/database";
import { decryptCredential } from "../credentials";
import { WooCommerceAdapter } from "./woocommerce";
import { createDbCatalogPort } from "./db-port";
import { runCatalogSync } from "./sync-engine";
import type { CatalogAdapter } from "./types";

/** Nombre del proveedor de catálogo en integration_connections (prefijo para no chocar). */
export function catalogProviderKey(source: string): string {
  return `catalog_${source}`;
}

function buildAdapter(source: string, config: Record<string, unknown>, creds: Record<string, string>, currency: string): CatalogAdapter {
  switch (source) {
    case "woocommerce":
      return new WooCommerceAdapter({ baseUrl: String(config.baseUrl ?? ""), auth: creds, currency });
    // TODO: shopify, jumpseller, bsale, fudo…
    default:
      throw new Error(`Proveedor de catálogo no soportado: ${source}`);
  }
}

export async function runCatalogSyncJob(orgId: string, payload: { source: string; mode?: "full" | "incremental" }): Promise<void> {
  const admin = getAdminPrisma();
  const source = payload.source;
  const provider = catalogProviderKey(source);
  const conn = await withTenant(orgId, (tx) => tx.integrationConnection.findFirst({ where: { provider } }));
  if (!conn) throw new Error(`No hay conexión de catálogo ${source} para el tenant`);
  const cred = conn.credentialId ? await withTenant(orgId, (tx) => tx.integrationCredential.findUnique({ where: { id: conn.credentialId! } })) : null;
  const creds = cred ? (JSON.parse(decryptCredential(cred.ciphertext)) as Record<string, string>) : {};
  const org = await admin.organization.findUnique({ where: { id: orgId }, select: { currency: true } });
  const adapter = buildAdapter(source, (conn.config ?? {}) as Record<string, unknown>, creds, org?.currency ?? "CLP");

  try {
    const r = await runCatalogSync(createDbCatalogPort(), adapter, orgId, { mode: payload.mode ?? "full", since: conn.lastSyncAt ?? undefined });
    await withTenant(orgId, (tx) =>
      tx.integrationConnection.update({ where: { id: conn.id }, data: { status: "active", lastError: null, lastSyncAt: new Date() } }),
    );
    await withTenant(orgId, (tx) =>
      tx.integrationEvent.create({ data: { organizationId: orgId, provider, type: "catalog.synced", status: "ok", message: `Sincronizados ${r.created + r.updated} productos (${r.created} nuevos, ${r.updated} actualizados, ${r.deactivated} sin stock, ${r.failed} con error).` } }).catch(() => undefined),
    );
  } catch (e) {
    await withTenant(orgId, (tx) => tx.integrationConnection.update({ where: { id: conn.id }, data: { status: "error", lastError: (e as Error).message.slice(0, 300) } }));
    throw e;
  }
}
