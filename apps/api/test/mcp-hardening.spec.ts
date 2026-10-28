import { describe, expect, it } from "vitest";
import { BadRequestException, HttpException, UnauthorizedException } from "@nestjs/common";
import { McpController } from "../src/mcp/mcp.controller";
import type { RateLimitService } from "../src/common/rate-limit";

/**
 * §7.3 — Endurecimiento del MCP remoto.
 *
 * Es una ruta PÚBLICA que proxea la API interna con el token del tenant (un JWT de 365
 * días). Tres cosas estaban abiertas: el token solo viajaba en la URL (y las URLs se
 * escriben en logs de acceso, proxys e historial), no había límite de ritmo, y un cuerpo
 * JSON-RPC en ARRAY se abría con `Promise.all` sin tope — un POST con miles de entradas se
 * convertía en miles de llamadas internas simultáneas.
 */

/**
 * Doble del limitador. Se usa un doble —y no el `RateLimitService` real— porque el real
 * abre su propia conexión a Redis y, sin Redis, falla ABIERTO: el test nunca vería un 429
 * y pasaría en verde sin probar nada. Con el doble se comprueba lo que de verdad escribí:
 * que se consulta el límite con una llave POR TOKEN y que una negativa produce 429.
 */
function limitadorFalso(opts: { permitir?: (llave: string, n: number) => boolean } = {}) {
  const porLlave = new Map<string, number>();
  const llamadas: string[] = [];
  const svc = {
    async custom(key: string, _max: number, _win: number) {
      llamadas.push(key);
      const n = (porLlave.get(key) ?? 0) + 1;
      porLlave.set(key, n);
      const allowed = opts.permitir ? opts.permitir(key, n) : true;
      return { allowed, count: n, retryAfterSeconds: 60 };
    },
  } as unknown as RateLimitService;
  return { svc, llamadas };
}

const limitador = () => limitadorFalso().svc;

const req = (headers: Record<string, string> = {}) => ({ headers }) as any;

describe("§7.3 — el token se acepta por cabecera", () => {
  it("sin token por ningún lado → 401", async () => {
    const c = new McpController(limitador());
    await expect(c.rpcHeader(req(), { method: "ping", id: 1 })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("con `Authorization: Bearer` funciona sin poner el token en la URL", async () => {
    const c = new McpController(limitador());
    const r: any = await c.rpcHeader(req({ authorization: "Bearer tok-del-tenant" }), { method: "ping", id: 7 });
    expect(r).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });

  it("la ruta vieja sigue sirviendo (hay conectores ya configurados)", async () => {
    const c = new McpController(limitador());
    const r: any = await c.rpc("tok-en-la-url", { method: "ping", id: 8 });
    expect(r).toEqual({ jsonrpc: "2.0", id: 8, result: {} });
  });

  it("la cabecera MANDA sobre la ruta", async () => {
    // Importa porque es lo que permite migrar los conectores sin romperlos: si el cliente
    // ya manda la cabecera, el token de la URL deja de usarse.
    const c = new McpController(limitador());
    const r: any = await c.rpc("tok-viejo", { method: "ping", id: 9 }, req({ authorization: "Bearer tok-nuevo" }));
    expect(r).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
  });
});

describe("§7.3 — tope de operaciones por lote", () => {
  it("un lote de 10 pasa", async () => {
    const c = new McpController(limitador());
    const lote = Array.from({ length: 10 }, (_, i) => ({ method: "ping", id: i }));
    const r: any = await c.rpc("tok", lote);
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBe(10);
  });

  it("un lote de 11 se rechaza (y no ejecuta NADA)", async () => {
    const c = new McpController(limitador());
    const lote = Array.from({ length: 11 }, (_, i) => ({ method: "ping", id: i }));
    await expect(c.rpc("tok", lote)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("el lote enorme que motivó el límite se corta", async () => {
    const c = new McpController(limitador());
    const lote = Array.from({ length: 10_000 }, (_, i) => ({ method: "ping", id: i }));
    await expect(c.rpc("tok", lote)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("§7.3 — límite de ritmo por token", () => {
  it("se consulta el límite, y la llave es POR TOKEN (no por IP)", async () => {
    // Por IP no serviría: el cliente MCP sale por la IP de su proveedor, compartida.
    const { svc, llamadas } = limitadorFalso();
    const c = new McpController(svc);
    await c.rpc("tok-de-un-cliente", { method: "ping", id: 1 });
    await c.rpc("tok-de-otro-cliente", { method: "ping", id: 1 });
    expect(llamadas.length).toBe(2);
    expect(llamadas[0]).not.toBe(llamadas[1]);
    expect(llamadas[0]).toMatch(/^rl:mcp:/);
  });

  it("la llave NO contiene el token completo (no se escribe en Redis)", async () => {
    const token = "tok-secreto-larguisimo-que-no-debe-quedar-en-redis-0123456789";
    const { svc, llamadas } = limitadorFalso();
    await new McpController(svc).rpc(token, { method: "ping", id: 1 });
    expect(llamadas[0]).not.toContain(token);
  });

  it("si el límite dice no, responde 429 y no ejecuta la operación", async () => {
    const { svc } = limitadorFalso({ permitir: () => false });
    const c = new McpController(svc);
    try {
      await c.rpc("tok", { method: "ping", id: 1 });
      expect.unreachable("debía cortar con 429");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(429);
    }
  });

  it("el límite se consulta ANTES del tope de lote (un lote grande igual cuenta)", async () => {
    const { svc, llamadas } = limitadorFalso();
    const c = new McpController(svc);
    await expect(c.rpc("tok", Array.from({ length: 50 }, () => ({ method: "ping" })))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    // Si no se contara, mandar lotes gigantes sería gratis para el atacante.
    expect(llamadas.length).toBe(1);
  });
});
