import { createDecipheriv } from "node:crypto";
import { getEnv } from "@conversia/config";

/** Descifra credenciales AES-256-GCM (mismo formato que apps/api). */
export function decryptCredential(payload: string): string {
  const key = Buffer.from(getEnv().CREDENTIALS_ENCRYPTION_KEY, "hex");
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
