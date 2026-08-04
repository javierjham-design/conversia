import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Parsea y VERIFICA un `signed_request` de Meta (deauthorize / data deletion).
 * Formato: `<firma_base64url>.<payload_base64url>`, donde
 * firma = HMAC-SHA256(payload_base64url, app_secret). Devuelve el payload
 * decodificado solo si la firma es válida; si no, `null` (no confiar en el dato).
 */
export function parseSignedRequest(signed: string, appSecret: string): Record<string, any> | null {
  if (!signed || !appSecret) return null;
  const [sigPart, payloadPart] = signed.split(".");
  if (!sigPart || !payloadPart) return null;
  const expected = createHmac("sha256", appSecret).update(payloadPart).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(base64UrlToBase64(sigPart), "base64");
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const json = Buffer.from(base64UrlToBase64(payloadPart), "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, any>;
  } catch {
    return null;
  }
}

function base64UrlToBase64(input: string): string {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return b64 + pad;
}
