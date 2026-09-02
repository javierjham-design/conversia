import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { getEnv } from "@conversia/config";

/**
 * MCP REMOTO (HTTP) de TuBot — para conectar desde Claude por URL (conectores/Claude web),
 * a diferencia del MCP stdio (apps/mcp-tubot, para Claude Desktop). Mismas herramientas de
 * gestión de agentes. El token va en la URL: POST /mcp/:token (Streamable HTTP, JSON-RPC).
 *
 * Ruta PÚBLICA (excluida del middleware de tenant): se autentica reenviando el token a los
 * endpoints internos /agents/*, que sí validan el JWT y resuelven el tenant.
 */

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

@Controller("mcp")
export class McpController {
  @Post(":token")
  @HttpCode(200)
  async rpc(@Param("token") token: string, @Body() body: unknown): Promise<unknown> {
    const call = makeCaller(token);
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
      const out = (await Promise.all(body.map(handleOne))).filter((x) => x !== null);
      return out;
    }
    const single = await handleOne((body ?? {}) as { id?: unknown; method?: string; params?: any });
    return single ?? {};
  }
}
