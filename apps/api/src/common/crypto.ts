import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "@conversia/config";

/** AES-256-GCM: base64(iv[12] || tag[16] || ciphertext). Clave de plataforma versionada. */
export function encryptSecret(plain: string): string {
  const key = Buffer.from(getEnv().CREDENTIALS_ENCRYPTION_KEY, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decryptSecret(payload: string): string {
  const key = Buffer.from(getEnv().CREDENTIALS_ENCRYPTION_KEY, "hex");
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function maskSecret(s: string): string {
  if (!s) return "";
  return s.length <= 10 ? "••••••" : `${s.slice(0, 4)}••••••${s.slice(-4)}`;
}
