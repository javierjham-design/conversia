import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifica la firma X-Hub-Signature-256 de Meta:
 * sha256=HMAC_SHA256(app_secret, raw_body)
 */
export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf-8") : rawBody)
    .digest("hex");
  const provided = header.slice("sha256=".length);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, "utf-8"), Buffer.from(expected, "utf-8"));
}
