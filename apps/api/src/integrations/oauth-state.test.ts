import { describe, expect, it } from "vitest";
import { signState, verifyState } from "./oauth.controller";

describe("state OAuth firmado (anti-CSRF)", () => {
  it("ida y vuelta: un state recién firmado devuelve el orgId", () => {
    expect(verifyState(signState("org-123"))).toBe("org-123");
  });

  it("rechaza un state manipulado (orgId cambiado sin refirmar)", () => {
    const [, ts, sig] = Buffer.from(signState("org-123"), "base64url").toString("utf8").split(".");
    const forged = Buffer.from(`org-OTRA.${ts}.${sig}`).toString("base64url");
    expect(verifyState(forged)).toBeNull();
  });

  it("rechaza un state vencido (>10 minutos)", () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 601);
    expect(verifyState(signState("org-123", oldTs))).toBeNull();
  });

  it("rechaza basura y vacíos sin lanzar", () => {
    expect(verifyState("")).toBeNull();
    expect(verifyState("no-es-base64url!!!")).toBeNull();
    expect(verifyState(Buffer.from("sin.puntos").toString("base64url"))).toBeNull();
  });
});
