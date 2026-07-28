import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) + HOTP (RFC 4226) sin dependencias — MFA del Super Admin.
 * Compatible con Google Authenticator / Authy / 1Password (SHA1, 6 dígitos, 30s).
 * El secreto se guarda cifrado-en-reposo por Postgres; las sesiones (revocables)
 * viven en Redis. Ver SUPER_ADMIN_SECURITY.md.
 */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str: string): Buffer {
  const clean = str.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
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

/** Secreto TOTP nuevo en base32 (160 bits, recomendado por RFC 4226). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  // counter de 64 bits big-endian (los 53 bits seguros de JS bastan hasta el año ~285616)
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (code % 10 ** digits).toString().padStart(digits, "0");
}

/** Código TOTP para un instante dado (default: ahora). */
export function totp(secretBase32: string, forTime: number = Date.now(), step = 30): string {
  const counter = Math.floor(forTime / 1000 / step);
  return hotp(base32Decode(secretBase32), counter);
}

/**
 * Verifica un código con tolerancia de ±`window` pasos (default ±1 = ±30s) para
 * absorber el desfase de reloj. Comparación en tiempo constante.
 */
export function verifyTotp(secretBase32: string, token: string, window = 1, forTime: number = Date.now()): boolean {
  const clean = (token ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(forTime / 1000 / 30);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secret, counter + i);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) return true;
  }
  return false;
}

/** URI otpauth:// para el QR de enrolamiento. */
export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
