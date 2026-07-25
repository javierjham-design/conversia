import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaSignature } from "../src/channels/signature";

describe("verifyMetaSignature", () => {
  const secret = "test-app-secret";
  const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account" }));
  const valid = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("acepta firmas válidas", () => {
    expect(verifyMetaSignature(body, valid, secret)).toBe(true);
  });

  it("rechaza firmas incorrectas", () => {
    expect(verifyMetaSignature(body, "sha256=" + "0".repeat(64), secret)).toBe(false);
  });

  it("rechaza cabeceras malformadas o ausentes", () => {
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(body, "md5=abc", secret)).toBe(false);
  });

  it("rechaza cuerpo alterado (integridad)", () => {
    expect(verifyMetaSignature(Buffer.from("{}"), valid, secret)).toBe(false);
  });
});
