import { describe, expect, it, vi } from "vitest";
import { MetaCrmController } from "../src/integrations/meta-crm.controller";
import { runWithContext, type RequestContext } from "../src/tenancy/context";
import {
  firmarEstado,
  rutaDeRetornoValida,
  urlDeVuelta,
  verificarEstado,
} from "../src/integrations/meta-oauth-state";

/**
 * C1 — INSTAGRAM Y MESSENGER PARA CLIENTES DE CONVERSIA.
 *
 * Lo que fijan estos tests:
 * - que el `return` del OAuth no pueda convertirse en un redirect abierto (es un dato de la
 *   URL que termina en un `Location:`);
 * - que la vuelta sea al panel de SU marca y no siempre al de TuBot;
 * - que conectar "para mensajería" no toque los formularios de leads del cliente y deje el
 *   canal ya atendido.
 */

// El entorno de la app se lee UNA vez y queda cacheado: hay que fijarlo antes del primer
// `getEnv()`, que ocurre dentro del primer handler que se llame.
process.env.META_CRM_APP_ID ||= "123456789";
process.env.JWT_SECRET ||= "dev-secret-cambiar";

const SECRETO = "secreto-de-prueba";

describe("la ruta de retorno no puede sacar a nadie del sitio", () => {
  it.each(["/canales", "/inicio", "/integrations/meta-crm", "/"])("acepta la ruta relativa %s", (r) => {
    expect(rutaDeRetornoValida(r)).toBe(r);
  });

  it.each([
    ["https://sitio-falso.cl", "un host completo"],
    ["//sitio-falso.cl", "protocolo relativo: para el navegador es OTRO host"],
    ["/canales?x=1", "query string"],
    ["/../admin", "subir de directorio"],
    ["/canales\\otro", "barra invertida (algunos navegadores la normalizan a /)"],
    ["javascript:alert(1)", "esquema javascript"],
    ["canales", "sin barra inicial"],
    ["", "vacía"],
  ])("rechaza %s (%s)", (r) => {
    expect(rutaDeRetornoValida(r)).toBeNull();
  });

  it("rechaza una ruta absurdamente larga", () => {
    expect(rutaDeRetornoValida("/" + "a".repeat(200))).toBeNull();
  });
});

describe("el estado del OAuth va firmado", () => {
  const estado = { orgId: "org1", purpose: "messaging" as const, retorno: "/canales" };

  it("ida y vuelta conserva organización, propósito y ruta", () => {
    expect(verificarEstado(firmarEstado(estado, SECRETO), SECRETO)).toEqual(estado);
  });

  it("tocar el estado lo invalida (no se puede cambiar la ruta a mitad del viaje)", () => {
    const bueno = firmarEstado(estado, SECRETO);
    const cuerpo = Buffer.from(JSON.stringify({ o: "org1", p: "messaging", r: "/panel-falso", t: Math.floor(Date.now() / 1000) })).toString("base64url");
    const falsificado = `${cuerpo}.${bueno.split(".")[1]}`;
    expect(verificarEstado(falsificado, SECRETO)).toBeNull();
  });

  it("con otro secreto no vale", () => {
    expect(verificarEstado(firmarEstado(estado, SECRETO), "otro-secreto")).toBeNull();
  });

  it("caduca a los 10 minutos", () => {
    const viejo = firmarEstado(estado, SECRETO, Math.floor(Date.now() / 1000) - 700);
    expect(verificarEstado(viejo, SECRETO)).toBeNull();
  });

  it("si la ruta firmada fuera maliciosa, se descarta AL ABRIR (cinturón y tirantes)", () => {
    // Nunca debería firmarse algo así —`oauthAuthorize` valida antes—, pero si pasara, el
    // estado se abre con la ruta vacía en vez de redirigir afuera.
    const cuerpo = { o: "org1", p: "messaging", r: "https://sitio-falso.cl", t: Math.floor(Date.now() / 1000) };
    const b64 = Buffer.from(JSON.stringify(cuerpo)).toString("base64url");
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const state = `${b64}.${createHmac("sha256", SECRETO).update(b64).digest("hex")}`;
    expect(verificarEstado(state, SECRETO)?.retorno).toBe("");
  });

  it("el formato viejo (solo orgId) se sigue aceptando: un viaje en curso no queda colgado", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const sig = createHmac("sha256", SECRETO).update(`org9.${ts}`).digest("hex");
    expect(verificarEstado(`org9.${ts}.${sig}`, SECRETO)).toEqual({ orgId: "org9", purpose: "leads", retorno: "" });
  });
});

describe("la vuelta es al panel de SU marca", () => {
  it("arma el sitio de la marca + la ruta pedida", () => {
    expect(urlDeVuelta("https://app.conversia.cl", "/canales", "ok")).toBe("https://app.conversia.cl/canales?meta=ok");
  });

  it("tolera la barra final del sitio", () => {
    expect(urlDeVuelta("https://app.conversia.cl/", "/canales", "permisos")).toBe("https://app.conversia.cl/canales?meta=permisos");
  });

  it("con una ruta inválida cae al destino de siempre, nunca afuera", () => {
    expect(urlDeVuelta("https://app.conversia.cl", "https://sitio-falso.cl", "error")).toBe("https://app.conversia.cl/integrations/meta-crm?meta=error");
  });
});

describe("autorizar con propósito de mensajería", () => {
  const ctx = (): RequestContext => ({ userId: "u1", organizationId: "org1", roleCode: "owner", permissions: ["integrations:write"] });
  const controlador = () => new MetaCrmController({ admin: {}, withTenant: async () => ({}) } as never, {} as never);

  it("pide los permisos de MENSAJERÍA y no los de leads", () => {
    const r = runWithContext(ctx(), () => controlador().oauthAuthorize("messaging", "/canales")) as { url: string; purpose: string };
    expect(r.purpose).toBe("messaging");
    const url = new URL(r.url);
    const scope = url.searchParams.get("scope") ?? "";
    const configId = url.searchParams.get("config_id");
    // O config_id de mensajería, o los scopes explícitos: nunca leads_retrieval.
    if (!configId) {
      expect(scope).toContain("pages_messaging");
      expect(scope).toContain("instagram_manage_messages");
      expect(scope).not.toContain("leads_retrieval");
    }
  });

  it("el `return` viaja FIRMADO y se puede volver a leer", () => {
    const r = runWithContext(ctx(), () => controlador().oauthAuthorize("messaging", "/canales")) as { url: string };
    const state = new URL(r.url).searchParams.get("state")!;
    const abierto = verificarEstado(state, process.env.JWT_SECRET || "dev-secret-cambiar");
    expect(abierto?.retorno).toBe("/canales");
    expect(abierto?.purpose).toBe("messaging");
  });

  it("un `return` malicioso NO viaja: se cae al destino de siempre", () => {
    const r = runWithContext(ctx(), () => controlador().oauthAuthorize("messaging", "https://sitio-falso.cl")) as { url: string };
    const state = new URL(r.url).searchParams.get("state")!;
    expect(verificarEstado(state, process.env.JWT_SECRET || "dev-secret-cambiar")?.retorno).toBe("");
    expect(r.url).not.toContain("sitio-falso");
  });

  it("sin propósito sigue siendo el flujo de leads de siempre", () => {
    const r = runWithContext(ctx(), () => controlador().oauthAuthorize()) as { url: string; purpose: string };
    expect(r.purpose).toBe("leads");
  });
});

describe("conectar una página PARA MENSAJERÍA", () => {
  const ctx = (): RequestContext => ({ userId: "u1", organizationId: "org1", roleCode: "owner", permissions: ["integrations:write"] });

  /** Prisma falso con lo justo que toca `connectPage`. */
  function fake() {
    const canales: Array<Record<string, unknown>> = [];
    const eventos: Array<Record<string, unknown>> = [];
    const tx = {
      metaCrmConnection: { findUnique: async () => ({ organizationId: "org1", status: "CONNECTED", credentialId: "cred1", businessName: "Negocio" }) },
      metaBusinessConnection: { findUnique: async () => ({ id: "gen1" }), create: async () => ({ id: "gen1" }) },
      metaAsset: { upsert: async () => ({}) },
      channelConnection: { findMany: async () => canales, create: async ({ data }: any) => { canales.push(data); return data; }, update: async () => ({}) },
      integrationEvent: { create: async ({ data }: any) => { eventos.push(data); return data; } },
      auditLog: { create: async () => ({}) },
      integrationCredential: { findUnique: async () => ({ ciphertext: "x" }) },
    };
    const prisma = {
      withTenant: (_o: string, fn: (t: unknown) => unknown) => fn(tx),
      admin: { organization: { findUnique: async () => ({ brand: "conversia" }) } },
    } as never;
    return { prisma, canales, eventos };
  }

  it("NO le pregunta a Meta por los formularios de leads del cliente", async () => {
    const pedidas: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      pedidas.push(u);
      const json = u.includes("subscribed_apps")
        ? { success: true }
        : u.includes("instagram_business_account") || u.includes("fields=id,name,access_token")
          ? { id: "123", name: "Barbería Centro", access_token: "page-token", instagram_business_account: { id: "ig1" } }
          : u.includes("fields=username")
            ? { username: "barberiacentro" }
            : {};
      return { ok: true, status: 200, json: async () => json } as unknown as Response;
    }) as never;
    try {
      const { prisma, canales, eventos } = fake();
      const c = new MetaCrmController(prisma, {} as never);
      // El token de la conexión se descifra: para el test basta con que no explote.
      (c as unknown as { crmToken: (o: string) => Promise<string> }).crmToken = async () => "crm-token";
      const r = (await runWithContext(ctx(), () => c.connectPage("123", { purpose: "messaging" }))) as { purpose: string; forms: unknown[] };

      expect(r.purpose).toBe("messaging");
      expect(r.forms).toEqual([]);
      expect(pedidas.some((u) => u.includes("leadgen_forms"))).toBe(false);
      // Se suscribe a los mensajes, no a leadgen.
      const sub = pedidas.find((u) => u.includes("subscribed_apps"))!;
      expect(sub).toContain("messages");
      expect(sub).not.toContain("leadgen");
      // Y deja los dos canales creados con el nombre que ve el cliente.
      expect(canales.map((x) => x.name)).toEqual(["Messenger · Barbería Centro", "Instagram · @barberiacentro"]);
      expect(String(eventos[0]?.message)).toMatch(/mensajería/i);
    } finally {
      globalThis.fetch = original;
    }
  });
});
