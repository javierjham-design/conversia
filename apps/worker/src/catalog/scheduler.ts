/**
 * Sincronización INCREMENTAL programada del catálogo (capa 2 del tiempo real: red de
 * seguridad por si se pierde un webhook). Cada 6 h abanica un catalog_sync incremental por
 * cada catálogo conectado. El sync completo se dispara al conectar y con "Sincronizar ahora".
 */
import { getAdminPrisma } from "@conversia/database";
import { getSyncQueue } from "../ga4";

const SIX_HOURS = 6 * 60 * 60 * 1000;

export function startCatalogSync(): () => void {
  const run = async () => {
    try {
      const conns = await getAdminPrisma().integrationConnection.findMany({
        where: { provider: { startsWith: "catalog_" }, status: "active" },
        select: { organizationId: true, provider: true },
      });
      for (const c of conns) {
        const source = c.provider.replace("catalog_", "");
        await getSyncQueue()
          .add(
            "catalog_inc",
            { organizationId: c.organizationId, kind: "catalog_sync", payload: { source, mode: "incremental" } },
            { removeOnComplete: true, removeOnFail: 20 },
          )
          .catch(() => undefined);
      }
    } catch (err) {
      console.error("✖ catalog-sync scheduler:", (err as Error).message);
    }
  };
  const interval = setInterval(run, SIX_HOURS);
  interval.unref?.();
  return () => clearInterval(interval);
}
