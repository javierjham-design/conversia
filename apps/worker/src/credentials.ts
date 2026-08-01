import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "@conversia/config";

/** Cifra con AES-256-GCM (mismo formato que apps/api: base64(iv||tag||data)). */
export function encryptCredential(plain: string): string {
  const key = Buffer.from(getEnv().CREDENTIALS_ENCRYPTION_KEY, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

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
