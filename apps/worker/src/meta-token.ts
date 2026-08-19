import { getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { decryptCredential } from "./credentials";

/**
 * Token para operaciones de LEADS y conversiones del CRM: prefiere la conexión
 * «Meta CRM» del tenant (app TuBot CRM, separada); cae a la conexión Meta
 * general y por último al token global de entorno. Así el CRM nunca pisa la
 * conexión Meta existente (ads/CAPI) y lo viejo sigue funcionando sin cambios.
 */
export async function resolveMetaLeadToken(organizationId: string): Promise<string | null> {
  return withTenant(organizationId, async (tx) => {
    const crm = await tx.metaCrmConnection.findUnique({ where: { organizationId } });
    if (crm?.status === "CONNECTED" && crm.credentialId) {
      const cred = await tx.integrationCredential.findUnique({ where: { id: crm.credentialId } });
      if (cred) return decryptCredential(cred.ciphertext);
    }
    const general = await tx.metaBusinessConnection.findUnique({ where: { organizationId } });
    if (general?.credentialId) {
      const cred = await tx.integrationCredential.findUnique({ where: { id: general.credentialId } });
      if (cred) return decryptCredential(cred.ciphertext);
    }
    return getEnv().META_ACCESS_TOKEN || null;
  });
}
