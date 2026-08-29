#!/usr/bin/env node
/**
 * Servidor MCP de TuBot (stdio) — SIN dependencias. Expone la gestión de agentes de IA
 * de TuBot como herramientas MCP para usarlas desde Claude Desktop: listar, ver, crear,
 * editar el prompt/config, publicar, activar y probar agentes.
 *
 * Config (variables de entorno):
 *   TUBOT_API_URL  — base del API de TuBot (ej: https://api-production-cf8e.up.railway.app)
 *   TUBOT_TOKEN    — token JWT de admin del tenant (Bearer) para autenticar las llamadas
 *
 * Protocolo: JSON-RPC 2.0 sobre stdio, mensajes delimitados por \n (MCP stdio).
 */

const API = (process.env.TUBOT_API_URL || "https://api-production-cf8e.up.railway.app").replace(/\/$/, "");
const TOKEN = process.env.TUBOT_TOKEN || "";
const SERVER = { name: "tubot-agents", version: "1.0.0" };

function log(...a) {
  // Los logs van a stderr (stdout es SOLO para el protocolo JSON-RPC).
  process.stderr.write(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n");
}

async function api(method, path, body) {
  if (!API || !TOKEN) throw new Error("Faltan TUBOT_API_URL o TUBOT_TOKEN en el entorno del servidor MCP.");
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${String(text).slice(0, 400)}`);
  return data;
}

/** Herramienta: nombre, descripción, schema JSON de entrada, y ejecución. */
const TOOLS = [
  {
    name: "list_agents",
    description: "Lista los agentes de IA del tenant (id, nombre, slug, tipo, versión publicada, modelo, si tiene borrador y si está activo).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => api("GET", "/agents"),
  },
  {
    name: "get_agent",
    description: "Detalle de un agente: su system prompt actual, config (modelo, tokens, acciones), tools habilitadas, versión publicada y borrador.",
    inputSchema: { type: "object", properties: { agentId: { type: "string", description: "ID del agente" } }, required: ["agentId"] },
    run: async ({ agentId }) => api("GET", `/agents/${agentId}`),
  },
  {
    name: "list_available_tools",
    description: "Lista las herramientas (tools) disponibles por nombre y descripción, para saber cuáles habilitar en un agente (campo tools).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => api("GET", "/agents/meta/tools"),
  },
  {
    name: "list_knowledge_bases",
    description: "Lista las bases de conocimiento del tenant (id, nombre, docs publicados) para referenciarlas en la config del agente (knowledgeSources).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () => api("GET", "/agents/meta/knowledge"),
  },
  {
    name: "create_agent",
    description: "Crea un agente nuevo (vacío). Devuelve su id. Luego usa update_agent para redactar su prompt y config, y publish_agent para dejarlo en producción.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nombre del agente" },
        kind: { type: "string", description: "Tipo: custom | sales | support | scheduler … (default custom)" },
      },
      required: ["name"],
    },
    run: async ({ name, kind }) => api("POST", "/agents", { name, kind: kind || "custom" }),
  },
  {
    name: "update_agent",
    description:
      "Edita el BORRADOR de un agente. Preserva lo que no envíes (lee la config actual y hace merge). Campos: systemPrompt (el prompt completo), model, maxTokens, maxToolRounds, tools (array de nombres de tools, ver list_available_tools), actions (objeto {clave:{enabled,instructions}}), knowledgeSources (array de ids de bases), changelog. NO publica: usa publish_agent después.",
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
    run: async (a) => {
      const d = await api("GET", `/agents/${a.agentId}`);
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
      const body = {
        systemPrompt: a.systemPrompt ?? d.editing?.systemPrompt ?? "",
        config,
        tools: a.tools ?? d.editing?.tools ?? [],
        changelog: a.changelog ?? "Editado vía MCP",
      };
      return api("PUT", `/agents/${a.agentId}/draft`, body);
    },
  },
  {
    name: "publish_agent",
    description: "Publica el borrador del agente → pasa a PRODUCCIÓN de inmediato (responde a los clientes con la versión nueva).",
    inputSchema: { type: "object", properties: { agentId: { type: "string" } }, required: ["agentId"] },
    run: async ({ agentId }) => api("POST", `/agents/${agentId}/publish`),
  },
  {
    name: "set_agent_active",
    description: "Activa o desactiva un agente. Un agente inactivo no responde.",
    inputSchema: { type: "object", properties: { agentId: { type: "string" }, active: { type: "boolean" } }, required: ["agentId", "active"] },
    run: async ({ agentId, active }) => api("POST", `/agents/${agentId}/active`, { active }),
  },
  {
    name: "test_agent",
    description:
      "Prueba el agente en el simulador (lecturas reales, escrituras simuladas). Envía un mensaje como si fueras el cliente y devuelve la respuesta del bot + las herramientas que usó. Usa la config PUBLICADA/borrador actual del agente.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        message: { type: "string", description: "Mensaje del cliente para probar" },
      },
      required: ["agentId", "message"],
    },
    run: async ({ agentId, message }) => {
      const d = await api("GET", `/agents/${agentId}`);
      const cfg = d.editing?.config || {};
      const r = await api("POST", `/agents/${agentId}/test`, {
        systemPrompt: d.editing?.systemPrompt || "",
        config: { model: cfg.model || "gpt-4o-mini", maxTokens: cfg.maxTokens || 600, maxToolRounds: cfg.maxToolRounds || 5 },
        tools: d.editing?.tools || [],
        actions: cfg.actions || undefined,
        messages: [{ role: "user", content: String(message) }],
        contact: { firstName: "Prueba", lastName: null, email: null, phone: null },
      });
      return { reply: r.reply, toolEvents: r.toolEvents, transferToAgentSlug: r.transferToAgentSlug };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// --------------------------- Transporte JSON-RPC (stdio) ---------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function replyError(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return; // notificación, sin respuesta
  if (method === "ping") { reply(id, {}); return; }
  if (method === "tools/list") {
    reply(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    return;
  }
  if (method === "tools/call") {
    const tool = TOOL_BY_NAME.get(params?.name);
    if (!tool) { replyError(id, -32602, `Herramienta desconocida: ${params?.name}`); return; }
    try {
      const out = await tool.run(params?.arguments || {});
      reply(id, { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] });
    } catch (e) {
      reply(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
    }
    return;
  }
  if (typeof id !== "undefined") replyError(id, -32601, `Método no soportado: ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log("JSON inválido:", line.slice(0, 200)); continue; }
    void handle(msg).catch((e) => log("handle error:", e.message));
  }
});
process.stdin.on("end", () => process.exit(0));
log(`TuBot MCP listo (API=${API || "(sin definir)"}). Herramientas: ${TOOLS.map((t) => t.name).join(", ")}`);
