import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Flag de simulación mockeado (no toca Redis en los tests).
vi.mock("./sim-token.js", () => ({ simWaTokenInvalid: vi.fn(), SIM_WA_TOKEN_INVALID_KEY: "sim:wa-token-invalid" }));

import { ChannelAuthError, TOKEN_INVALID_FAIL_TEXT } from "./channel-auth";
import { MetaChannelProvider, MockChannelProvider, isMetaAuthError } from "./channel-providers";
import { isDead } from "./whatsapp-token-health";
import { simWaTokenInvalid } from "./sim-token.js";

describe("isMetaAuthError — detección de token inválido (190/OAuthException/401)", () => {
  it("190 por JSON", () => expect(isMetaAuthError(400, { error: { code: 190, type: "OAuthException" } }, "").auth).toBe(true));
  it("OAuthException sin code 190", () => expect(isMetaAuthError(400, { error: { type: "OAuthException" } }, "").auth).toBe(true));
  it("HTTP 401 aunque no haya error JSON", () => expect(isMetaAuthError(401, null, "").auth).toBe(true));
  it("cae al texto crudo code:190 (sin JSON parseable)", () => expect(isMetaAuthError(400, null, '{"error":{"code":190}}').auth).toBe(true));
  it("captura el subcódigo", () => expect(isMetaAuthError(400, { error: { code: 190, error_subcode: 463 } }, "").subcode).toBe(463));
  it("NO marca auth en un error de CONFIG (131037 display name)", () => expect(isMetaAuthError(400, { error: { code: 131037 } }, "").auth).toBe(false));
  it("NO marca auth en rate limit (130429)", () => expect(isMetaAuthError(429, { error: { code: 130429 } }, "").auth).toBe(false));
});

describe("ChannelAuthError — mensaje claro para el FAILED", () => {
  it("trae un userMessage accionable por defecto (reemplazar en Railway)", () => {
    const e = new ChannelAuthError("Meta send 401: ...");
    expect(e.userMessage).toBe(TOKEN_INVALID_FAIL_TEXT);
    expect(e.userMessage).toMatch(/Railway/i);
  });
});

describe("isDead — solo 190/401 es token muerto (no un bache de red)", () => {
  it("190 → muerto", () => expect(isDead({ ok: false, code: 190 })).toBe(true));
  it("401 → muerto", () => expect(isDead({ ok: false, code: 401 })).toBe(true));
  it("ok → vivo", () => expect(isDead({ ok: true })).toBe(false));
  it("otro error (sin code auth) → NO lo damos por muerto", () => expect(isDead({ ok: false, code: 131037 })).toBe(false));
  it("skip por red (ok:true) → vivo", () => expect(isDead({ ok: true })).toBe(false));
});

describe("MetaChannelProvider.verifyToken — chequeo activo (GET ?fields=id)", () => {
  const realFetch = global.fetch;
  beforeEach(() => { process.env.META_ACCESS_TOKEN = "token-global"; });
  afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

  it("200 → ok:true", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ id: "123" }), { status: 200 })) as any;
    expect(await new MetaChannelProvider().verifyToken({ phoneNumberId: "123", accessToken: "vivo" })).toMatchObject({ ok: true });
  });
  it("190 → ok:false code 190", async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Session expired", code: 190 } }), { status: 400 })) as any;
    expect(await new MetaChannelProvider().verifyToken({ phoneNumberId: "123", accessToken: "muerto" })).toMatchObject({ ok: false, code: 190 });
  });
  it("sin token → ok:false (nada que verificar)", async () => {
    process.env.META_ACCESS_TOKEN = "";
    expect((await new MetaChannelProvider().verifyToken({ phoneNumberId: "123", accessToken: null })).ok).toBe(false);
  });
  it("fallo de RED → ok:true (no afirma caída por un blip)", async () => {
    global.fetch = vi.fn(async () => { throw new Error("ECONNRESET"); }) as any;
    expect((await new MetaChannelProvider().verifyToken({ phoneNumberId: "123", accessToken: "vivo" })).ok).toBe(true);
  });
});

describe("MockChannelProvider — simula el 190 con el flag de simulación", () => {
  const mocked = simWaTokenInvalid as unknown as ReturnType<typeof vi.fn>;
  afterEach(() => vi.restoreAllMocks());

  it("send LANZA ChannelAuthError cuando el flag está activo", async () => {
    mocked.mockResolvedValue(true);
    await expect(new MockChannelProvider().send("mock:x", { to: "1", type: "text", text: "hi" } as any)).rejects.toBeInstanceOf(ChannelAuthError);
  });
  it("verifyToken reporta MUERTO (190) cuando el flag está activo — detección sin tráfico", async () => {
    mocked.mockResolvedValue(true);
    expect(await new MockChannelProvider().verifyToken({ phoneNumberId: "mock:x", accessToken: null })).toMatchObject({ ok: false, code: 190 });
  });
  it("con el flag apagado: send OK y verifyToken vivo", async () => {
    mocked.mockResolvedValue(false);
    expect((await new MockChannelProvider().send("mock:x", { to: "1", type: "text", text: "hi" } as any)).externalId).toContain("mock-out-");
    expect(await new MockChannelProvider().verifyToken({ phoneNumberId: "mock:x", accessToken: null })).toMatchObject({ ok: true });
  });
});
