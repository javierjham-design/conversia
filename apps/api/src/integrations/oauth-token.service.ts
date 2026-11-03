import { BadRequestException, Injectable } from "@nestjs/common";
import { getEnv, googleOAuthAppOfConnection, googleOAuthCredentials } from "@conversia/config";
import { PrismaService } from "../prisma.service";
import { decryptSecret, encryptSecret } from "../common/crypto";

/** Tokens OAuth cifrados de una conexión. */
export interface OAuthTokens {
  access_token: string;
  refresh_token: string | null;
  expiry: number; // epoch ms
}

/**
 * Access token vigente de una integración OAuth del tenant.
 *
 * Estaba como método de `OAuthController` y se extrajo acá SIN cambios de comportamiento
 * porque la Agenda también necesita un token (para leer las horas ocupadas de Google) y
 * un controlador no se puede inyectar. Duplicar el refresco en dos lugares sería peor: son
 * dos sitios donde equivocarse con el mismo token.
 */
@Injectable()
export class OAuthTokenService {
  constructor(private prisma: PrismaService) {}

  /** Refresca si vence en <60 s; marca "reauthorize" si el refresh falla. */
  async freshToken(orgId: string, provider: "google" | "hubspot"): Promise<string> {
    const env = getEnv();
    const stored = await this.prisma.withTenant(orgId, async (tx) => {
      const conn = await tx.integrationConnection.findFirst({ where: { organizationId: orgId, provider } });
      if (!conn?.credentialId) return null;
      const cred = await tx.integrationCredential.findFirst({ where: { id: conn.credentialId, organizationId: orgId } });
      if (!cred) return null;
      try {
        return { connId: conn.id, credId: cred.id, config: conn.config, tokens: JSON.parse(decryptSecret(cred.ciphertext)) as OAuthTokens };
      } catch {
        return null;
      }
    });
    if (!stored) throw new BadRequestException(`La integración ${provider} no está conectada`);
    if (stored.tokens.expiry - Date.now() > 60_000) return stored.tokens.access_token;
    if (!stored.tokens.refresh_token) throw new BadRequestException("La sesión expiró: vuelve a conectar la cuenta");

    // El refresh va con las credenciales que EMITIERON el token (lo dice la config de la
    // conexión), no con las que correspondan hoy a la marca: si no, al cargar la app de
    // Conversia se romperían las conexiones ya emitidas con la app de siempre.
    const google = googleOAuthCredentials(googleOAuthAppOfConnection(stored.config), env);
    const ep =
      provider === "google"
        ? { url: "https://oauth2.googleapis.com/token", clientId: google.clientId, clientSecret: google.clientSecret }
        : { url: "https://api.hubapi.com/oauth/v1/token", clientId: env.HUBSPOT_CLIENT_ID, clientSecret: env.HUBSPOT_CLIENT_SECRET };
    const res = await fetch(ep.url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: stored.tokens.refresh_token,
        client_id: ep.clientId,
        client_secret: ep.clientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      await this.prisma.withTenant(orgId, (tx) =>
        tx.integrationConnection.updateMany({ where: { organizationId: orgId, provider }, data: { status: "reauthorize", lastError: "El acceso fue revocado: vuelve a conectar la cuenta" } }),
      ).catch(() => undefined);
      throw new BadRequestException("El acceso fue revocado: vuelve a conectar la cuenta");
    }
    const next: OAuthTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? stored.tokens.refresh_token,
      expiry: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    };
    await this.prisma.withTenant(orgId, async (tx) => {
      await tx.integrationCredential.update({ where: { id: stored.credId }, data: { ciphertext: encryptSecret(JSON.stringify(next)), rotatedAt: new Date() } });
      await tx.integrationConnection.update({ where: { id: stored.connId }, data: { status: "active", lastError: null } });
    });
    return next.access_token;
  }
}
