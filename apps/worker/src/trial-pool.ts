import IORedis from "ioredis";
import { getEnv } from "@conversia/config";
import { getAdminPrisma } from "@conversia/database";

/**
 * V2-4 — "Pruébalo en TU WhatsApp". Un pool de números de la plataforma (WABA nuestra, D3)
 * atiende a varias orgs; cada chat se enruta a su org por el vínculo teléfono↔org, que se crea
 * con un código corto `CV-PRUEBA-XXXX` (el QR abre wa.me/<nro>?text=ese-código). Multi-tenant
 * sobre el mismo número; colisión (teléfono sin vínculo) → se pide el código.
 *
 * P1 (punto de parada): el pool arranca VACÍO y `trialPool.enabled=false` hasta que el dueño
 * cargue número(s) reales. Con enabled=false, resolveTrialRouting devuelve disabled y el inbound
 * sigue su curso normal (no afecta nada en prod).
 */

let redis: IORedis | undefined;
function conn(): IORedis {
  if (!redis) redis = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return redis;
}

/** ¿Está encendido el pool de prueba? (platform_settings trialPool.enabled, default false). */
export async function isTrialPoolEnabled(): Promise<boolean> {
  try {
    const row = await getAdminPrisma().platformSetting.findUnique({ where: { key: "trialPool" } });
    if (!row) return false;
    const v = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
    return v?.enabled === true;
  } catch {
    return false;
  }
}

/** Extrae el código CV-PRUEBA-XXXX de un texto (case-insensitive). */
export function extractTrialCode(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = text.toUpperCase().match(/CV-PRUEBA-([A-Z0-9]{4,10})/);
  return m ? `CV-PRUEBA-${m[1]}` : null;
}

/** Registra un código→org (lo usa la API al generar el QR). TTL 7 días. */
export async function registerTrialCode(code: string, organizationId: string): Promise<void> {
  await conn().set(`trialcode:${code}`, organizationId, "EX", 7 * 24 * 3600);
}

export type TrialRouting =
  | { pool: false }
  | { pool: true; disabled: true }
  | { pool: true; orgId: string; linked: boolean }
  | { pool: true; needsCode: true };

/**
 * Resuelve a qué org enrutar un inbound que llegó a un número del pool.
 * - no es número del pool → { pool:false } (sigue el flujo normal).
 * - pool apagado → { pool:true, disabled:true }.
 * - trae código válido → vincula teléfono↔org (7d) y enruta.
 * - ya vinculado y vigente → enruta a esa org.
 * - sin vínculo ni código → { needsCode:true } (pedir el código).
 */
export async function resolveTrialRouting(phoneNumberId: string, contactPhone: string, text: string | null): Promise<TrialRouting> {
  const prisma = getAdminPrisma();
  const poolNum = await prisma.trialPoolNumber.findUnique({ where: { phoneNumberId } }).catch(() => null);
  if (!poolNum || !poolNum.active) return { pool: false };
  if (!(await isTrialPoolEnabled())) return { pool: true, disabled: true };

  const now = new Date();
  const code = extractTrialCode(text);
  if (code) {
    const orgId = await conn().get(`trialcode:${code}`).catch(() => null);
    if (orgId) {
      const expiresAt = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      await prisma.trialSession.upsert({
        where: { phoneNumberId_contactPhone: { phoneNumberId, contactPhone } },
        create: { phoneNumberId, contactPhone, orgIdRef: orgId, code, expiresAt },
        update: { orgIdRef: orgId, code, expiresAt },
      });
      return { pool: true, orgId, linked: true };
    }
  }
  const existing = await prisma.trialSession.findUnique({ where: { phoneNumberId_contactPhone: { phoneNumberId, contactPhone } } }).catch(() => null);
  if (existing && existing.expiresAt > now) return { pool: true, orgId: existing.orgIdRef, linked: false };
  return { pool: true, needsCode: true };
}
