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

/**
 * Token para ENVIAR eventos CAPI al dataset: orden INVERSO al de leads —
 * prefiere la conexión Meta general (su token tiene los permisos del dataset,
 * p. ej. whatsapp_business_manage_events cuando el dataset nació con la WABA)
 * y cae a la conexión CRM / env. Con el orden anterior, el token del CRM
 * (sin esos permisos) tomaba prioridad y Meta rechazaba con «Object does not
 * exist / missing permissions».
 */
export async function resolveMetaCapiToken(organizationId: string): Promise<string | null> {
  return withTenant(organizationId, async (tx) => {
    const general = await tx.metaBusinessConnection.findUnique({ where: { organizationId } });
    if (general?.credentialId) {
      const cred = await tx.integrationCredential.findUnique({ where: { id: general.credentialId } });
      if (cred) return decryptCredential(cred.ciphertext);
    }
    const crm = await tx.metaCrmConnection.findUnique({ where: { organizationId } });
    if (crm?.status === "CONNECTED" && crm.credentialId) {
      const cred = await tx.integrationCredential.findUnique({ where: { id: crm.credentialId } });
      if (cred) return decryptCredential(cred.ciphertext);
    }
    return getEnv().META_ACCESS_TOKEN || null;
  });
}
