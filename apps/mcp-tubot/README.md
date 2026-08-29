# Conector MCP de TuBot (Claude Desktop)

Servidor MCP **por tenant** que expone la gestión de agentes de IA de TuBot como
herramientas para Claude Desktop. Con él, desde Claude puedes **listar, ver, crear,
editar el prompt, configurar acciones/tools, probar, publicar y activar** los agentes
de tu cuenta — hablando en lenguaje natural.

Es un único archivo `index.mjs` **sin dependencias**: corre con `node` a secas.

## Aislamiento por tenant
Cada tenant usa **su propio token** (`TUBOT_TOKEN`). Ese token lleva el `orgId` del
tenant, así que el servidor solo puede ver y tocar los agentes de **esa** cuenta. Para
varios tenants, se configura una entrada por cada uno (con su token) en Claude Desktop.

## Requisitos
- Node.js 18 o superior (trae `fetch` nativo).
- Un **token JWT de admin** del tenant (`TUBOT_TOKEN`). Hoy se obtiene desde el Super
  Admin (impersonación) o del panel; caduca (≈12 h) y hay que renovarlo. *(Mejora
  pendiente: emitir un token largo por-tenant desde Configuración → Conectar Claude.)*

## Configuración en Claude Desktop
Edita el archivo de configuración de Claude Desktop:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Agrega (ajusta la ruta a `index.mjs` y pega el token del tenant):

```json
{
  "mcpServers": {
    "tubot": {
      "command": "node",
      "args": ["C:/ruta/a/conversia-redesign/apps/mcp-tubot/index.mjs"],
      "env": {
        "TUBOT_TOKEN": "PEGA_AQUÍ_EL_JWT_DEL_TENANT",
        "TUBOT_API_URL": "https://api-production-cf8e.up.railway.app"
      }
    }
  }
}
```

`TUBOT_API_URL` es opcional (por defecto apunta a producción). Para varios tenants,
duplica el bloque con otro nombre (p. ej. `"tubot-salinas"`) y su token.

Reinicia Claude Desktop. Deberías ver las herramientas de `tubot` disponibles.

## Herramientas expuestas
- `list_agents` — lista los agentes del tenant.
- `get_agent` `{agentId}` — prompt, config, tools y versiones.
- `list_available_tools` — tools disponibles para habilitar en un agente.
- `list_knowledge_bases` — bases de conocimiento del tenant.
- `create_agent` `{name, kind?}` — crea un agente vacío.
- `update_agent` `{agentId, systemPrompt?, model?, maxTokens?, tools?, actions?, knowledgeSources?, changelog?}`
  — edita el borrador (preserva lo que no envíes).
- `publish_agent` `{agentId}` — publica el borrador a producción.
- `set_agent_active` `{agentId, active}` — activa/desactiva.
- `test_agent` `{agentId, message}` — prueba en el simulador (lecturas reales, escrituras simuladas).

## Ejemplo de uso en Claude
> "Lista mis agentes. En el de la lavandería, agrega la regla de ofrecer siempre el
> delivery con flyer a $1.000, pruébalo con 'cuánto sale lavar una frazada' y si queda
> bien, publícalo."

Claude encadenará `list_agents` → `get_agent` → `update_agent` → `test_agent` →
`publish_agent`.

## Notas
- Escrituras reales: `update_agent`/`publish_agent`/`set_agent_active` **modifican tu
  cuenta**. `test_agent` NO cobra ni persiste (simulado).
- Los logs del servidor van a *stderr* (stdout es solo para el protocolo MCP).
- Carga de documentos de conocimiento (subir archivos a una base) todavía no tiene
  endpoint público; el MCP permite **referenciar** bases existentes en la config del
  agente. Si lo necesitas, agrego el endpoint de carga.
