import { getEnv, withAppSecretProof } from "@conversia/config";
import { getAdminPrisma, withTenant } from "@conversia/database";
import { decryptCredential } from "./credentials";

/**
 * Sincroniza las plantillas HSM de cada WABA conectada hacia whatsapp_templates.
 * La verdad vive en Meta; acá se proyecta por tenant para que la bandeja y los
 * workflows elijan plantillas APROBADAS sin golpear Graph en cada render.
 * `body` guarda { components, variableFields, rejectedReason, syncedAt }.
 */

const SYNC_EVERY_MS = 6 * 60 * 60 * 1000; // 6 h
const BOOT_DELAY_MS = 60 * 1000;

export async function syncOrgTemplates(organizationId: string): Promise<number> {
  const env = getEnv();
  let synced = 0;

  const accounts = await withTenant(organizationId, (tx) =>
    tx.whatsappAccount.findMany({ include: { phoneNumbers: true } }),
  );

  for (const account of accounts) {
    // Token por-WABA (fallback global) — mismo criterio que el envío.
    let token = env.META_ACCESS_TOKEN || "";
    if (account.credentialId) {
      const credential = await withTenant(organizationId, (tx) =>
        tx.integrationCredential.findUnique({ where: { id: account.credentialId! } }),
      );
      if (credential) {
        try {
          token = decryptCredential(credential.ciphertext);
        } catch {
          /* fallback al global */
        }
      }
    }
    if (!token) continue;

    let json: any;
    try {
      const res = await fetch(
        withAppSecretProof(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(account.wabaId)}/message_templates?fields=name,status,category,language,components,rejected_reason&limit=200`, token),
        { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) },
      );
      json = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Anti-spam: no repetir el MISMO error de sync más de una vez al día por
        // tenant (un token vencido dispararía uno cada 6 h si no).
        await withTenant(organizationId, async (tx) => {
          const recent = await tx.integrationEvent.findFirst({
            where: { provider: "whatsapp", type: "templates.sync_error", createdAt: { gt: new Date(Date.now() - 20 * 60 * 60 * 1000) } },
            select: { id: true },
          });
          if (recent) return;
          await tx.integrationEvent.create({
            data: {
              organizationId,
              provider: "whatsapp",
              type: "templates.sync_error",
              status: "error",
              message: `Sync de plantillas (${account.name}): ${json?.error?.message ?? res.status}`,
            },
          });
        });
        continue;
      }
    } catch (err) {
      console.error(`✖ template-sync ${account.wabaId}:`, (err as Error).message);
      continue;
    }

    // Mapeo posición→campo guardado en el config del canal al crear cada plantilla.
    const channelIds = account.phoneNumbers.map((n) => n.channelConnectionId).filter(Boolean) as string[];
    const mappings: Record<string, { fields?: string[] }> = {};
    if (channelIds.length) {
      const channels = await withTenant(organizationId, (tx) =>
        tx.channelConnection.findMany({ where: { id: { in: channelIds } }, select: { config: true } }),
      );
      for (const ch of channels) {
        Object.assign(mappings, ((ch.config as any)?.templateMappings ?? {}) as object);
      }
    }

    const templates = (json?.data as any[]) ?? [];
    const seen = new Set<string>();
    await withTenant(organizationId, async (tx) => {
      for (const t of templates) {
        const language = String(t.language ?? "es");
        seen.add(`${t.name}::${language}`);
        await tx.whatsappTemplate.upsert({
          where: {
            organizationId_accountId_name_language: {
              organizationId,
              accountId: account.id,
              name: String(t.name),
              language,
            },
          },
          update: {
            status: String(t.status ?? "PENDING"),
            category: String(t.category ?? "UTILITY"),
            body: {
              components: t.components ?? [],
              rejectedReason: t.rejected_reason ?? null,
              variableFields: mappings[t.name]?.fields ?? null,
              syncedAt: new Date().toISOString(),
            } as object,
          },
          create: {
            organizationId,
            accountId: account.id,
            name: String(t.name),
            language,
            category: String(t.category ?? "UTILITY"),
            status: String(t.status ?? "PENDING"),
            body: {
              components: t.components ?? [],
              rejectedReason: t.rejected_reason ?? null,
              variableFields: mappings[t.name]?.fields ?? null,
              syncedAt: new Date().toISOString(),
            } as object,
          },
        });
        synced++;
      }
      // Plantillas borradas en Meta → fuera de la proyección local.
      const existing = await tx.whatsappTemplate.findMany({ where: { accountId: account.id }, select: { id: true, name: true, language: true } });
      const stale = existing.filter((e) => !seen.has(`${e.name}::${e.language}`));
      if (stale.length) await tx.whatsappTemplate.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    });
  }
  return synced;
}

/** Sync periódica de todas las organizaciones con WABAs conectadas. */
export function startTemplateSync(): () => void {
  const prisma = getAdminPrisma();
  const run = async () => {
    const orgs = await prisma.whatsappAccount.findMany({ select: { organizationId: true }, distinct: ["organizationId"] });
    for (const { organizationId } of orgs) {
      try {
        await syncOrgTemplates(organizationId);
      } catch (err) {
        console.error(`✖ template-sync org ${organizationId}:`, (err as Error).message);
      }
    }
  };
  const boot = setTimeout(() => void run(), BOOT_DELAY_MS);
  const interval = setInterval(() => void run(), SYNC_EVERY_MS);
  console.log("✔ Sync de plantillas WhatsApp activo (al arrancar + cada 6 h)");
  return () => {
    clearTimeout(boot);
    clearInterval(interval);
  };
}
