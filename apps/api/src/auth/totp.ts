import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";

/**
 * TOTP (RFC 6238) implementado con node crypto — sin dependencias externas.
 * Paso de 30 s, SHA-1, 6 dígitos (compatible con Google Authenticator/Authy).
 * También genera y verifica los códigos de recuperación (hasheados con SHA-256).
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Secreto TOTP nuevo en base32 (160 bits). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** URI otpauth:// para el QR de enrolamiento. */
export function otpauthUri(secret: string, account: string, issuer = "TuBot"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Código TOTP para un contador (interno/testeable). */
export function totpForCounter(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Verifica un código TOTP con ventana ±`window` pasos (tolerancia de reloj).
 * Comparación en tiempo constante. `now` inyectable para tests.
 */
export function verifyTotp(secret: string, code: string, window = 1, now: number = Date.now()): boolean {
  const clean = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  for (let w = -window; w <= window; w++) {
    const expected = totpForCounter(secret, counter + w);
    if (clean.length === expected.length && timingSafeEqual(Buffer.from(clean), Buffer.from(expected))) return true;
  }
  return false;
}

// --------------------------- Códigos de recuperación ---------------------------

/** Genera `count` códigos de recuperación legibles (se muestran UNA vez). */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const raw = randomBytes(5).toString("hex").toUpperCase(); // 10 hex
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Hash SHA-256 de un código de recuperación (para guardar; alta entropía). */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");
}

/**
 * Verifica un código de recuperación contra la lista de hashes; si coincide,
 * devuelve la lista SIN ese hash (consumo de un solo uso). Si no, `null`.
 */
export function consumeRecoveryCode(code: string, hashes: string[]): string[] | null {
  const h = hashRecoveryCode(code);
  const idx = hashes.indexOf(h);
  if (idx === -1) return null;
  return hashes.filter((_, i) => i !== idx);
}

// --------------------------- base32 (RFC 4648) ---------------------------

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
