import { describe, expect, it } from "vitest";
import { metaAppSecretProof, withAppSecretProof } from "@conversia/config";

// appsecret_proof = HMAC-SHA256(access_token) firmado con el App Secret de Meta.
// Estos tests fijan el cálculo para que activar "Require app secret proof" en el
// dashboard no rompa nada (el backend ya lo manda en todas las llamadas a Graph).
describe("appsecret_proof (Meta)", () => {
  const secret = "app-secret-123";
  const token = "EAAG-token-abc";
  // Vector conocido, calculado con node crypto de forma independiente.
  const expected = "04e9d9c93c98e483e65956da31ce48a0f2c18c560e24ccd9eeb8ab0f8fd8f70d";

  it("calcula el HMAC-SHA256 hex esperado", () => {
    expect(metaAppSecretProof(token, secret)).toBe(expected);
  });

  it("es determinista y de 64 hex (256 bits)", () => {
    const a = metaAppSecretProof(token, secret);
    expect(a).toBe(metaAppSecretProof(token, secret));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sin secret o sin token devuelve '' (no rompe en desarrollo)", () => {
    expect(metaAppSecretProof(token, "")).toBe("");
    expect(metaAppSecretProof("", secret)).toBe("");
  });

  it("withAppSecretProof añade el parámetro respetando la query existente", () => {
    expect(withAppSecretProof("https://graph.facebook.com/v25.0/me", token, secret)).toBe(
      `https://graph.facebook.com/v25.0/me?appsecret_proof=${expected}`,
    );
    expect(withAppSecretProof("https://graph.facebook.com/v25.0/me?fields=name", token, secret)).toBe(
      `https://graph.facebook.com/v25.0/me?fields=name&appsecret_proof=${expected}`,
    );
  });

  it("withAppSecretProof es idempotente y no toca la URL sin secret", () => {
    const once = withAppSecretProof("https://graph.facebook.com/v25.0/me", token, secret);
    expect(withAppSecretProof(once, token, secret)).toBe(once);
    expect(withAppSecretProof("https://graph.facebook.com/v25.0/me", token, "")).toBe("https://graph.facebook.com/v25.0/me");
  });
});
