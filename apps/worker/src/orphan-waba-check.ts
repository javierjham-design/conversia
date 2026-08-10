import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";

/**
 * Chequeo periódico del "agujero silencioso": una WABA que sigue en nuestra
 * plataforma (y potencialmente asociada a nuestra línea de crédito de Meta)
 * cuando su tenant ya está SUSPENDIDO o ELIMINADO. No podemos consultar la
 * relación de crédito del lado de Meta desde aquí, pero SÍ podemos delatar el
 * caso local, que es la señal de que falta desvincular. Alerta 1 vez al día.
 * Ver docs/SECURITY_AUDIT.md H2.
 */

let redis: IORedis | undefined;
function conn(): IORedis {
  if (!redis) redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redis;
}

async function run(): Promise<void> {
  const prisma = getAdminPrisma();
  try {
    // Orgs suspendidas/canceladas o eliminadas...
    const badOrgs = await prisma.organization.findMany({
      where: { OR: [{ status: { in: ["SUSPENDED", "CANCELLED"] } }, { deletedAt: { not: null } }] },
      select: { id: true, name: true, status: true, deletedAt: true },
    });
    if (badOrgs.length === 0) return;
    // ...que TODAVÍA tienen una WABA registrada.
    const accounts = await prisma.whatsappAccount.findMany({
      where: { organizationId: { in: badOrgs.map((o) => o.id) } },
      select: { id: true, wabaId: true, organizationId: true, name: true },
    });
    if (accounts.length === 0) return;

    const byOrg = new Map(badOrgs.map((o) => [o.id, o]));
    const lines = accounts.map((a) => {
      const o = byOrg.get(a.organizationId);
      const estado = o?.deletedAt ? "ELIMINADA" : o?.status;
      return `• WABA ${a.wabaId} (${a.name}) — tenant "${o?.name ?? a.organizationId}" ${estado}`;
    });
    console.error(`🚨 WABA(s) HUÉRFANA(S) sobre nuestra infraestructura tras baja del tenant (${accounts.length}):\n${lines.join("\n")}\n→ Revisar desvinculación de línea de crédito en Meta (docs/SECURITY_AUDIT.md H2).`);

    // Alerta externa 1 vez al día (para no spamear).
    const day = new Date().toISOString().slice(0, 10);
    const first = await conn().set(`orphan-waba-alerted:${day}`, "1", "EX", 172_800, "NX").catch(() => null);
    const url = getEnv().OPS_ALERT_WEBHOOK_URL;
    if (first && url) {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          summary: `TuBot: ${accounts.length} WABA(s) huérfana(s) tras baja de tenant`,
          description: lines.join("\n"),
          severity: "warning",
        }),
      }).catch(() => undefined);
    }
  } catch (err) {
    console.error("✖ orphan-waba-check:", (err as Error).message);
  }
}

/** Arranca el chequeo: al minuto 2 y luego cada 6 h. Devuelve el limpiador. */
export function startOrphanWabaCheck(): () => void {
  const boot = setTimeout(() => void run(), 120_000);
  const interval = setInterval(() => void run(), 6 * 60 * 60 * 1000);
  interval.unref?.();
  console.log("✔ Chequeo de WABA huérfana activo (cada 6 h)");
  return () => {
    clearTimeout(boot);
    clearInterval(interval);
  };
}
