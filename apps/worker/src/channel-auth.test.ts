import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelAuthError } from "./channel-auth";
import { MetaChannelProvider } from "./channel-providers";

// El proveedor Meta debe distinguir un token inválido/vencido (→ ChannelAuthError,
// que marca el canal y NO se reintenta) de cualquier otro fallo (→ Error normal,
// que BullMQ reintenta). También debe usar el token por-canal cuando se le pasa.

const provider = new MetaChannelProvider();
const message = { to: "56911112222", type: "text" as const, text: "hola" };

describe("MetaChannelProvider — auth por canal", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.META_ACCESS_TOKEN = "token-global";
  });
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("usa el token por-canal cuando se entrega en options", async () => {
    let authHeader = "";
    global.fetch = vi.fn(async (_url: any, init: any) => {
      authHeader = init.headers.authorization;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
    }) as any;
    const r = await provider.send("123", message, { accessToken: "token-del-canal" });
    expect(authHeader).toBe("Bearer token-del-canal");
    expect(r.externalId).toBe("wamid.1");
  });

  it("sin options usa el token global", async () => {
    let authHeader = "";
    global.fetch = vi.fn(async (_url: any, init: any) => {
      authHeader = init.headers.authorization;
      return new Response(JSON.stringify({ messages: [{ id: "wamid.2" }] }), { status: 200 });
    }) as any;
    await provider.send("123", message);
    expect(authHeader).toBe("Bearer token-global");
  });

  it("token vencido (code 190) lanza ChannelAuthError", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "Session has expired", code: 190 } }), { status: 400 }),
    ) as any;
    await expect(provider.send("123", message, { accessToken: "vencido" })).rejects.toBeInstanceOf(ChannelAuthError);
  });

  it("401 lanza ChannelAuthError", async () => {
    global.fetch = vi.fn(async () => new Response("{}", { status: 401 })) as any;
    await expect(provider.send("123", message)).rejects.toBeInstanceOf(ChannelAuthError);
  });

  it("otros errores lanzan Error normal (reintenable)", async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "rate limited", code: 130429 } }), { status: 429 }),
    ) as any;
    const err = await provider.send("123", message).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ChannelAuthError);
  });
});
