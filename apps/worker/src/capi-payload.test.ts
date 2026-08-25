import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { actionSourceFor, buildUserData, hashEmail, hashPhone } from "./capi-payload";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

describe("capi-payload", () => {
  it("hashea teléfono solo con dígitos (spec Meta)", () => {
    expect(hashPhone("+56 9 1234-5678")).toBe(sha("56912345678"));
  });

  it("hashea email normalizado (trim + minúsculas)", () => {
    expect(hashEmail("  Persona@Mail.COM ")).toBe(sha("persona@mail.com"));
  });

  it("user_data incluye todos los identificadores disponibles (lead_id numérico, guía Meta)", () => {
    const ud = buildUserData({ phone: "+56912345678", email: "a@b.cl", leadgenId: "987", ctwaClid: "clid1" });
    expect(ud).toEqual({ ph: [sha("56912345678")], em: [sha("a@b.cl")], lead_id: 987, ctwa_clid: "clid1" });
  });

  it("lead_id de 17+ dígitos que excede el entero seguro queda como string", () => {
    const big = "123456789012345678"; // > Number.MAX_SAFE_INTEGER
    expect(buildUserData({ leadgenId: big })).toEqual({ lead_id: big });
  });

  it("user_data omite lo que falta (sin claves vacías)", () => {
    expect(buildUserData({ phone: "+56911111111" })).toEqual({ ph: [sha("56911111111")] });
    expect(buildUserData({})).toEqual({});
  });

  it("action_source: system_generated con lead_id (CRM), chat sin él", () => {
    expect(actionSourceFor({ leadgenId: "987" })).toBe("system_generated");
    expect(actionSourceFor({ phone: "+569", ctwaClid: "x" })).toBe("chat");
  });
});
