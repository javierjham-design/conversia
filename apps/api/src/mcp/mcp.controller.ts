import { BadRequestException, Body, Controller, HttpCode, HttpException, HttpStatus, Param, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import { getEnv } from "@conversia/config";
import { RateLimitService } from "../common/rate-limit";

/**
 * MCP REMOTO (HTTP) de TuBot — para conectar desde Claude por URL (conectores/Claude web),
 * a diferencia del MCP stdio (apps/mcp-tubot, para Claude Desktop). Mismas herramientas de
 * gestión de agentes. JSON-RPC sobre Streamable HTTP.
 *
 * El token se acepta por `Authorization: Bearer` (recomendado) o en la ruta
 * `POST /mcp/:token` (compatibilidad con los conectores ya configurados). §7.3: la ruta se
 * mantiene porque hay conectores vivos usándola, pero la cabecera es la buena — una URL
 * con el token se escribe en logs de acceso, proxys e historial, y éste es un JWT de 365
 * días con los permisos del tenant.
 *
 * Ruta PÚBLICA (excluida del middleware de tenant): se autentica reenviando el token a los
 * endpoints internos /agents/*, que sí validan el JWT y resuelven el tenant.
 */

/** Token del conector desde `Authorization: Bearer <token>`, o null si no vino. */
function tokenDeCabecera(req: Request): string | null {
  const h = req.headers?.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const t = h.slice(7).trim();
  return t || null;
}

const SERVER = { name: "tubot-agents", version: "1.0.0" };

type Caller = (method: string, path: string, body?: unknown) => Promise<unknown>;
type ToolDef = { name: string; description: string; inputSchema: unknown; run: (c: Caller, a: any) => Promise<unknown> | unknown };

const TOOLS: ToolDef[] = [
  {
    name: "list_agents",
    description: "Lista los agentes de IA del tenant (id, nombre, slug, tipo, versión publicada, modelo, si tiene borrador y si está activo).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (c: Caller) => c("GET", "/agents"),
  },
  {
    name: "get_agent",
    description: "Detalle de un agente: system prompt actual, config (modelo, tokens, acciones), tools habilitadas, versión publicada y borrador.",
    inputSchema: { type: "object", properties: { agentId: { type: "string", description: "ID del agente" } }, required: ["agentId"] },
    run: (c: Caller, a: any) => c("GET", `/agents/${a.agentId}`),
  },
  {
    name: "list_available_tools",
    description: "Lista las herramientas (tools) disponibles por nombre y descripción, para saber cuáles habilitar en un agente (campo tools).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (c: Caller) => c("GET", "/agents/meta/tools"),
  },
  {
    name: "list_knowledge_bases",
    description: "Lista las bases de conocimiento del tenant (id, nombre, docs publicados) para referenciarlas en la config (knowledgeSources).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: (c: Caller) => c("GET", "/agents/meta/knowledge"),
  },
  {
    name: "create_agent",
    description: "Crea un agente nuevo (vacío). Devuelve su id. Luego usa update_agent y publish_agent.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, kind: { type: "string", description: "custom | sales | support | scheduler (default custom)" } }, required: ["name"] },
    run: (c: Caller, a: any) => c("POST", "/agents", { name: a.name, kind: a.kind || "custom" }),
  },
  {
    name: "update_agent",
    description:
      "Edita el BORRADOR de un agente (merge sobre lo actual). Campos: systemPrompt, model, maxTokens, maxToolRounds, tools (array), actions ({clave:{enabled,instructions}}), knowledgeSources (array de ids), changelog. NO publica.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        systemPrompt: { type: "string" },
        model: { type: "string" },
        maxTokens: { type: "number" },
        maxToolRounds: { type: "number" },
        tools: { type: "array", items: { type: "string" } },
        actions: { type: "object" },
        knowledgeSources: { type: "array", items: { type: "string" } },
        changelog: { type: "string" },
      },
      required: ["agentId"],
    },
    run: async (c: Caller, a: any) => {
      const d: any = await c("GET", `/agents/${a.agentId}`);
      const cur = d.editing?.config || {};
      const config = {
        model: a.model ?? cur.model ?? "gpt-4o-mini",
        maxTokens: a.maxTokens ?? cur.maxTokens ?? 400,
        maxToolRounds: a.maxToolRounds ?? cur.maxToolRounds ?? 5,
        language: cur.language ?? "es",
        emoji: cur.emoji,
        actions: a.actions ?? cur.actions ?? {},
        knowledgeSources: a.knowledgeSources ?? cur.knowledgeSources ?? [],
      };
      return c("PUT", `/agents/${a.agentId}/draft`, {
        systemPrompt: a.systemPrompt ?? d.editing?.systemPrompt ?? "",
        config,
        tools: a.tools ?? d.editing?.tools ?? [],
        changelog: a.changelog ?? "Editado vía MCP",
      });
    },
  },
  {
    name: "publish_agent",
    description: "Publica el borrador del agente → pasa a PRODUCCIÓN de inmediato.",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
    run: (c: Caller, a: any) => c("POST", `/agents/${a.agentId}/publish`),
  },
  {
    name: "set_agent_active",
    description: "Activa o desactiva un agente. Un agente inactivo no responde.",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, active: { type: "boolean" } }, required: ["agentId", "active"] },
    run: (c: Caller, a: any) => c("POST", `/agents/${a.agentId}/active`, { active: a.active }),
  },
  {
    name: "test_agent",
    description: "Prueba el agente en el simulador (lecturas reales, escrituras simuladas). Devuelve la respuesta del bot + tools usadas.",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, message: { type: "string" } }, required: ["agentId", "message"] },
    run: async (c: Caller, a: any) => {
      const d: any = await c("GET", `/agents/${a.agentId}`);
      const cfg = d.editing?.config || {};
      const r: any = await c("POST", `/agents/${a.agentId}/test`, {
        systemPrompt: d.editing?.systemPrompt || "",
        config: { model: cfg.model || "gpt-4o-mini", maxTokens: cfg.maxTokens || 600, maxToolRounds: cfg.maxToolRounds || 5 },
        tools: d.editing?.tools || [],
        actions: cfg.actions || undefined,
        messages: [{ role: "user", content: String(a.message) }],
        contact: { firstName: "Prueba", lastName: null, email: null, phone: null },
      });
      return { reply: r.reply, toolEvents: r.toolEvents, transferToAgentSlug: r.transferToAgentSlug };
    },
  },
];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Llama a los endpoints internos de TuBot con el token (que valida tenant + permisos). */
function makeCaller(token: string): Caller {
  const base = getEnv().API_URL.replace(/\/$/, "");
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${String(text).slice(0, 400)}`);
    return data;
  };
}

/**
 * §7.3 — Tope de operaciones por lote.
 *
 * El cuerpo JSON-RPC puede ser un ARRAY, y se abría con `Promise.all` sin límite: un solo
 * POST con 10.000 entradas se convertía en 10.000 llamadas a la API interna, todas en
 * paralelo. Es amplificación: una petición barata para el atacante, carísima para nosotros.
 */
const MAX_LOTE = 10;

/** §7.3 — Intentos por token y minuto. El MCP proxea la API interna: no puede ser infinito. */
const MCP_MAX_POR_MINUTO = 120;

@Controller("mcp")
export class McpController {
  constructor(private rateLimit: RateLimitService) {}

  /**
   * §7.3 — El token también se acepta por `Authorization: Bearer`.
   *
   * Hasta ahora SOLO viajaba en la ruta (`POST /mcp/<token>`), y las URLs se escriben en
   * todos los registros del camino: logs de acceso, proxys, historial del cliente. Este
   * token es un JWT de 365 días con los permisos del tenant, así que dejarlo en un log es
   * dejarlo disponible. La cabecera no se registra.
   */
  @Post()
  @HttpCode(200)
  async rpcHeader(@Req() req: Request, @Body() body: unknown): Promise<unknown> {
    return this.rpc(tokenDeCabecera(req) ?? "", body, req);
  }

  @Post(":token")
  @HttpCode(200)
  async rpc(@Param("token") token: string, @Body() body: unknown, @Req() req?: Request): Promise<unknown> {
    // La cabecera manda sobre la ruta: si el cliente ya la usa, el token de la URL sobra.
    const efectivo = (req ? tokenDeCabecera(req) : null) ?? token;
    if (!efectivo) throw new UnauthorizedException("Falta el token del conector (cabecera Authorization: Bearer o /mcp/<token>)");

    // §7.3 — límite por TOKEN (no por IP: el cliente MCP sale por la IP de su proveedor).
    // La llave usa un prefijo del token, no el token entero, para no escribirlo en Redis.
    const rl = await this.rateLimit.custom(`rl:mcp:${efectivo.slice(0, 24)}`, MCP_MAX_POR_MINUTO, 60);
    if (!rl.allowed) {
      throw new HttpException("Demasiadas llamadas al conector. Espera un momento.", HttpStatus.TOO_MANY_REQUESTS);
    }

    const call = makeCaller(efectivo);
    const handleOne = async (msg: { id?: unknown; method?: string; params?: any }) => {
      const { id, method, params } = msg;
      if (method === "initialize") {
        return { jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: SERVER } };
      }
      if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (method === "notifications/initialized" || method === "initialized") return null; // notificación
      if (method === "tools/list") {
        return { jsonrpc: "2.0", id, result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } };
      }
      if (method === "tools/call") {
        const tool = TOOL_BY_NAME.get(params?.name);
        if (!tool) return { jsonrpc: "2.0", id, error: { code: -32602, message: `Herramienta desconocida: ${params?.name}` } };
        try {
          const out = await tool.run(call, params?.arguments || {});
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] } };
        } catch (e) {
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true } };
        }
      }
      if (typeof id !== "undefined") return { jsonrpc: "2.0", id, error: { code: -32601, message: `Método no soportado: ${method}` } };
      return null;
    };

    if (Array.isArray(body)) {
      // §7.3 — tope de lote (ver MAX_LOTE): sin esto un POST con miles de entradas se
      // abría en miles de llamadas internas simultáneas.
      if (body.length > MAX_LOTE) {
        throw new BadRequestException(`Demasiadas operaciones en un lote (${body.length}); el máximo es ${MAX_LOTE}.`);
      }
      const out = (await Promise.all(body.map(handleOne))).filter((x) => x !== null);
      return out;
    }
    const single = await handleOne((body ?? {}) as { id?: unknown; method?: string; params?: any });
    return single ?? {};
  }
}
