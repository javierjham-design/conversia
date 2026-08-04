/**
 * Sincronización del catálogo de anuncios de Meta (Marketing API) por tenant.
 *
 * Jerarquía campaña → conjunto → anuncio, aplanada en `meta_ads`. Reusa el token
 * de la conexión Meta unificada (MetaBusinessConnection.credentialId) y las
 * cuentas publicitarias habilitadas (MetaAsset kind=ad_account, enabled).
 *
 * Rate limits: paginación con backoff exponencial; NO se sincroniza en cada carga
 * de página (se dispara a diario por BullMQ + botón "Sincronizar ahora"). Los
 * anuncios que ya no vuelven de Meta se marcan available=false (no se borran).
 */
import { getEnv, withAppSecretProof } from "@conversia/config";
import { getAdminPrisma, withTenant } from "@conversia/database";
import { decryptCredential } from "./credentials";
import { getSyncQueue } from "./ga4";

// ----------------------------- Helpers PUROS -----------------------------

export interface RawAd {
  id: string;
  name?: string;
  status?: string;
  adset?: { id?: string; name?: string } | null;
  campaign?: { id?: string; name?: string; objective?: string } | null;
  creative?: { object_story_spec?: any } | null;
}

export interface MappedAd {
  adAccountId: string;
  campaignId: string;
  campaignName: string;
  adsetId: string;
  adsetName: string;
  adExternalId: string;
  adName: string;
  status: string;
  objective: string | null;
  isCtwa: boolean;
}

/** ¿El anuncio lleva a WhatsApp (Click-to-WhatsApp)? Heurística sobre el creative. */
export function detectCtwa(ad: RawAd): boolean {
  const spec = ad.creative?.object_story_spec;
  if (!spec) return false;
  const linkDatas = [spec.link_data, spec.video_data, spec.template_data].filter(Boolean);
  for (const ld of linkDatas) {
    const cta = String(ld?.call_to_action?.type ?? "").toUpperCase();
    if (cta.includes("WHATSAPP")) return true;
    const dest = String(ld?.call_to_action?.value?.app_destination ?? "").toUpperCase();
    if (dest.includes("WHATSAPP")) return true;
    const link = String(ld?.link ?? ld?.call_to_action?.value?.link ?? "");
    if (/wa\.me|api\.whatsapp|whatsapp\.com/i.test(link)) return true;
  }
  return false;
}

/** Transforma un anuncio crudo de Graph a la fila del catálogo. Puro. */
export function mapAdRow(ad: RawAd, adAccountId: string): MappedAd {
  return {
    adAccountId,
    campaignId: ad.campaign?.id ?? "",
    campaignName: ad.campaign?.name ?? "(campaña sin nombre)",
    adsetId: ad.adset?.id ?? "",
    adsetName: ad.adset?.name ?? "(conjunto sin nombre)",
    adExternalId: ad.id,
    adName: ad.name ?? "(anuncio sin nombre)",
    status: (ad.status ?? "UNKNOWN").toUpperCase(),
    objective: ad.campaign?.objective ?? null,
    isCtwa: detectCtwa(ad),
  };
}

/** Códigos de error de Graph que indican límite de tasa → conviene backoff. */
export function isRateLimited(status: number, errorCode?: number): boolean {
  if (status === 429) return true;
  return [4, 17, 32, 613, 80000, 80004].includes(Number(errorCode));
}

// --------------------------- Acceso a datos / I/O ---------------------------

async function getMetaToken(organizationId: string): Promise<string | null> {
  const env = getEnv();
  return withTenant(organizationId, async (tx) => {
    const connection = await tx.metaBusinessConnection.findUnique({ where: { organizationId } });
    if (connection?.credentialId) {
      const cred = await tx.integrationCredential.findUnique({ where: { id: connection.credentialId } });
      if (cred) return decryptCredential(cred.ciphertext);
    }
    return env.META_ACCESS_TOKEN || null;
  });
}

/** GET a Graph con reintentos por rate limit (backoff exponencial). */
async function graphGet(url: string): Promise<any> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(url);
    const json: any = await res.json().catch(() => ({}));
    if (res.ok) return json;
    const code = json?.error?.code;
    if (isRateLimited(res.status, code) && attempt < 5) {
      const waitMs = Math.min(2 ** attempt * 1000, 30_000);
      await new Promise((r) => setTimeout(r, waitMs));
      attempt++;
      continue;
    }
    throw new Error(`Graph ${res.status}: ${json?.error?.message ?? "error"}`);
  }
}

export interface SyncResult {
  ok: boolean;
  reason?: "not_connected" | "no_accounts" | "permission" | "error";
  synced?: number;
  accounts?: number;
  message?: string;
}

/** Sincroniza el catálogo de anuncios del tenant. Idempotente (upsert por ad). */
export async function syncMetaAds(organizationId: string): Promise<SyncResult> {
  const env = getEnv();
  const token = await getMetaToken(organizationId);
  if (!token) return await fail(organizationId, "not_connected", "Conecta Meta y autoriza anuncios (ads_read).");

  const accounts = await withTenant(organizationId, (tx) =>
    tx.metaAsset.findMany({ where: { kind: "ad_account", enabled: true }, select: { externalId: true } }),
  );
  if (accounts.length === 0) return await fail(organizationId, "no_accounts", "Sin cuentas publicitarias habilitadas.");

  const fields =
    "id,name,status,adset{id,name},campaign{id,name,objective},creative{object_story_spec}";
  let synced = 0;

  for (const acc of accounts) {
    const seen = new Set<string>();
    let url = `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${acc.externalId}/ads?fields=${encodeURIComponent(fields)}&limit=100&access_token=${encodeURIComponent(token)}`;
    try {
      // Paginación con tope defensivo (evita bucles infinitos).
      for (let page = 0; page < 100 && url; page++) {
        const json = await graphGet(withAppSecretProof(url, token));
        const rows: RawAd[] = Array.isArray(json?.data) ? json.data : [];
        for (const raw of rows) {
          const m = mapAdRow(raw, acc.externalId);
          if (!m.adExternalId) continue;
          seen.add(m.adExternalId);
          await withTenant(organizationId, (tx) =>
            tx.metaAd.upsert({
              where: { organizationId_adExternalId: { organizationId, adExternalId: m.adExternalId } },
              update: { ...m, available: true, lastSyncedAt: new Date() },
              create: { organizationId, ...m, available: true },
            }),
          );
          synced++;
        }
        url = json?.paging?.next ?? "";
      }
      // Anuncios de ESTA cuenta que ya no vinieron → no disponibles (no se borran).
      if (seen.size > 0) {
        await withTenant(organizationId, (tx) =>
          tx.metaAd.updateMany({
            where: { adAccountId: acc.externalId, adExternalId: { notIn: [...seen] }, available: true },
            data: { available: false },
          }),
        );
      }
    } catch (err) {
      const message = (err as Error).message;
      const isPerm = /permission|\(#10\)|\(#200\)|ads_read/i.test(message);
      await logSync(organizationId, "error", `Sync anuncios (${acc.externalId}): ${message}`);
      if (isPerm) return { ok: false, reason: "permission", message };
    }
  }

  await logSync(organizationId, "ok", `Catálogo de anuncios sincronizado: ${synced} anuncios en ${accounts.length} cuenta(s).`);
  return { ok: true, synced, accounts: accounts.length };
}

async function fail(orgId: string, reason: SyncResult["reason"], message: string): Promise<SyncResult> {
  await logSync(orgId, "warning", message);
  return { ok: false, reason, message };
}

async function logSync(organizationId: string, status: "ok" | "warning" | "error", message: string): Promise<void> {
  await withTenant(organizationId, (tx) =>
    tx.integrationEvent.create({
      data: { organizationId, provider: "meta", type: status === "ok" ? "ads.sync_ok" : "ads.sync_error", status, message: message.slice(0, 300) },
    }),
  );
}

/** Sincroniza UN solo anuncio (catálogo desactualizado / anuncio recién creado). */
export async function syncSingleAd(organizationId: string, adId: string): Promise<void> {
  const env = getEnv();
  const token = await getMetaToken(organizationId);
  if (!token || !adId) return;
  const fields = "id,name,status,account_id,adset{id,name},campaign{id,name,objective},creative{object_story_spec}";
  const json = await graphGet(
    withAppSecretProof(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${adId}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(token)}`, token),
  ).catch(() => null);
  if (!json?.id) return;
  const acctId = json.account_id ? `act_${String(json.account_id).replace(/^act_/, "")}` : "";
  const m = mapAdRow(json as RawAd, acctId);
  await withTenant(organizationId, (tx) =>
    tx.metaAd.upsert({
      where: { organizationId_adExternalId: { organizationId, adExternalId: m.adExternalId } },
      update: { ...m, available: true, lastSyncedAt: new Date() },
      create: { organizationId, ...m, available: true },
    }),
  );
}

/**
 * Resuelve la campaña (y nombres) de un ad_id usando el catálogo cacheado. Si el
 * anuncio no está (recién creado), hace una sincronización PUNTUAL antes de
 * rendirse — así no se pierde el disparo por catálogo desactualizado.
 */
export async function resolveAdContext(
  organizationId: string,
  adId: string,
): Promise<{ campaignId: string; campaignName: string; adName: string } | null> {
  if (!adId) return null;
  const find = () =>
    withTenant(organizationId, (tx) => tx.metaAd.findUnique({ where: { organizationId_adExternalId: { organizationId, adExternalId: adId } } }));
  let row = await find();
  if (!row) {
    await syncSingleAd(organizationId, adId).catch(() => undefined);
    row = await find();
  }
  if (!row) return null;
  return { campaignId: row.campaignId, campaignName: row.campaignName, adName: row.adName };
}

/** Encola un sync del catálogo para un tenant (botón "Sincronizar ahora"). */
export async function enqueueMetaAdsSync(organizationId: string): Promise<void> {
  await getSyncQueue().add(
    "meta_ads_sync",
    { organizationId, kind: "meta_ads_sync", payload: {} },
    { attempts: 2, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: 200, removeOnFail: 500 },
  );
}

/** Diario: abanica un sync por cada tenant con conexión Meta CONNECTED. */
export async function fanOutMetaAdsSync(): Promise<void> {
  const prisma = getAdminPrisma();
  const conns = await prisma.metaBusinessConnection.findMany({ where: { status: "CONNECTED" }, select: { organizationId: true } });
  for (const c of conns) await enqueueMetaAdsSync(c.organizationId);
}
