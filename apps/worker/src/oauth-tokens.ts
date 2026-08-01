import { getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { decryptCredential, encryptCredential } from "./credentials.js";

/**
 * Tokens OAuth por tenant (Google / HubSpot) con auto-refresh. Los tokens
 * viven cifrados en integration_credentials; si el refresh_token deja de
 * servir (invalid_grant) la conexión pasa a estado "reauthorize" y se avisa
 * por correo — la campana de Integraciones muestra el estado.
 */

interface StoredTokens {
  access_token: string;
  refresh_token: string | null;
  expiry: number; // epoch ms
}

type OAuthProvider = "google" | "hubspot";

function tokenEndpoint(provider: OAuthProvider): { url: string; clientId: string; clientSecret: string } {
  const env = getEnv();
  if (provider === "google") {
    return { url: "https://oauth2.googleapis.com/token", clientId: env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET };
  }
  return { url: "https://api.hubapi.com/oauth/v1/token", clientId: env.HUBSPOT_CLIENT_ID, clientSecret: env.HUBSPOT_CLIENT_SECRET };
}

/**
 * Devuelve un access_token vigente para el proveedor, refrescándolo si está
 * por vencer (margen 60 s). Lanza si no hay conexión o requiere reautorizar
 * (el job de BullMQ NO debe reintentar en ese caso: revisar antes de encolar).
 */
export async function getFreshOAuthToken(organizationId: string, provider: OAuthProvider): Promise<string> {
  const { conn, credId, tokens } = await withTenant(organizationId, async (tx) => {
    const conn = await tx.integrationConnection.findFirst({ where: { provider } });
    if (!conn?.credentialId) throw new NoConnectionError(provider);
    const cred = await tx.integrationCredential.findUnique({ where: { id: conn.credentialId } });
    if (!cred) throw new NoConnectionError(provider);
    return { conn, credId: cred.id, tokens: JSON.parse(decryptCredential(cred.ciphertext)) as StoredTokens };
  });
  if (conn.status === "reauthorize") throw new ReauthorizeError(provider);
  if (tokens.expiry - Date.now() > 60_000) return tokens.access_token;

  // Refrescar
  if (!tokens.refresh_token) {
    await markReauthorize(organizationId, provider, "Sin refresh_token: vuelve a conectar la cuenta");
    throw new ReauthorizeError(provider);
  }
  const ep = tokenEndpoint(provider);
  const res = await fetch(ep.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: ep.clientId,
      client_secret: ep.clientSecret,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const err = String(body.error ?? res.status);
    if (err === "invalid_grant" || res.status === 400 || res.status === 401) {
      await markReauthorize(organizationId, provider, `El acceso fue revocado (${err}): vuelve a conectar la cuenta`);
      throw new ReauthorizeError(provider);
    }
    throw new Error(`Refresh OAuth ${provider} falló: ${err}`);
  }
  const next: StoredTokens = {
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? tokens.refresh_token,
    expiry: Date.now() + Number(body.expires_in ?? 3600) * 1000,
  };
  await withTenant(organizationId, async (tx) => {
    await tx.integrationCredential.update({ where: { id: credId }, data: { ciphertext: encryptCredential(JSON.stringify(next)), rotatedAt: new Date() } });
    await tx.integrationConnection.update({ where: { id: conn.id }, data: { status: "active", lastError: null } });
  });
  return next.access_token;
}

async function markReauthorize(organizationId: string, provider: OAuthProvider, reason: string): Promise<void> {
  const label = provider === "google" ? "Google" : "HubSpot";
  await withTenant(organizationId, async (tx) => {
    await tx.integrationConnection.updateMany({ where: { provider }, data: { status: "reauthorize", lastError: reason } });
    await tx.integrationEvent.create({
      data: { organizationId, provider, type: `${provider}.reauthorize`, status: "error", message: `${label}: ${reason}` },
    });
  }).catch(() => undefined);
  try {
    const { enqueueIntegrationAlert } = await import("./mailer.js");
    await enqueueIntegrationAlert(organizationId, `Reconecta tu cuenta de ${label}`, `La conexión con ${label} dejó de funcionar (${reason}). Entra a Integraciones y vuelve a conectar la cuenta.`);
  } catch {
    /* sin correo no bloqueamos */
  }
}

/** No hay conexión activa del proveedor para el tenant. */
export class NoConnectionError extends Error {
  constructor(provider: string) {
    super(`La integración ${provider} no está conectada`);
  }
}

/** El tenant debe volver a autorizar la cuenta (token revocado/expirado). */
export class ReauthorizeError extends Error {
  constructor(provider: string) {
    super(`La integración ${provider} requiere reconectar la cuenta`);
  }
}
