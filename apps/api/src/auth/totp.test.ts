import { describe, expect, it } from "vitest";
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUri,
  totpForCounter,
  verifyTotp,
} from "./totp";

describe("TOTP (RFC 6238)", () => {
  it("genera un secreto base32 válido", () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]+$/);
    expect(s.length).toBeGreaterThanOrEqual(32);
  });

  it("verifica el código del contador actual (now inyectado)", () => {
    const secret = generateTotpSecret();
    const now = 1_785_000_000_000; // fijo
    const counter = Math.floor(now / 1000 / 30);
    const code = totpForCounter(secret, counter);
    expect(verifyTotp(secret, code, 1, now)).toBe(true);
  });

  it("acepta ±1 paso (tolerancia de reloj) y rechaza fuera de ventana", () => {
    const secret = generateTotpSecret();
    const now = 1_785_000_000_000;
    const counter = Math.floor(now / 1000 / 30);
    expect(verifyTotp(secret, totpForCounter(secret, counter - 1), 1, now)).toBe(true);
    expect(verifyTotp(secret, totpForCounter(secret, counter + 1), 1, now)).toBe(true);
    expect(verifyTotp(secret, totpForCounter(secret, counter + 5), 1, now)).toBe(false);
  });

  it("rechaza formatos inválidos y códigos equivocados", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "12345")).toBe(false);
    expect(verifyTotp(secret, "abcdef")).toBe(false);
    expect(verifyTotp(secret, "000000", 1, 1_785_000_000_000)).toBe(
      totpForCounter(secret, Math.floor(1_785_000_000_000 / 1000 / 30)) === "000000",
    );
  });

  it("el otpauth URI incluye secreto, emisor y parámetros", () => {
    const uri = otpauthUri("ABC234", "user@tubot.cl", "TuBot");
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("secret=ABC234");
    expect(uri).toContain("issuer=TuBot");
    expect(uri).toContain("digits=6");
  });

  it("códigos de recuperación: hash estable y consumo de un solo uso", () => {
    const codes = generateRecoveryCodes(8);
    expect(codes).toHaveLength(8);
    const hashes = codes.map(hashRecoveryCode);
    // Insensible a guiones/espacios/mayúsculas.
    const messy = codes[2].toLowerCase().replace("-", " ");
    const remaining = consumeRecoveryCode(messy, hashes);
    expect(remaining).not.toBeNull();
    expect(remaining).toHaveLength(7);
    // Ya consumido → no vuelve a servir.
    expect(consumeRecoveryCode(codes[2], remaining!)).toBeNull();
    // Código inexistente.
    expect(consumeRecoveryCode("ZZZZZ-ZZZZZ", hashes)).toBeNull();
  });
});
