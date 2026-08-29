"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Button, useToast } from "@/components/ui";

/** Esquema OpenAPI 3.1 de la gestión de agentes, para pegarlo como Action de un GPT. */
function buildOpenApi(apiUrl: string) {
  return {
    openapi: "3.1.0",
    info: { title: "TuBot — Agentes", version: "1.0.0", description: "Gestión de agentes de IA de TuBot (listar, ver, crear, editar, probar, publicar)." },
    servers: [{ url: apiUrl }],
    paths: {
      "/agents": {
        get: { operationId: "listAgents", summary: "Lista los agentes del tenant", responses: { "200": { description: "OK" } } },
        post: {
          operationId: "createAgent",
          summary: "Crea un agente",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, kind: { type: "string" } }, required: ["name"] } } } },
          responses: { "200": { description: "OK" } },
        },
      },
      "/agents/{id}": {
        get: { operationId: "getAgent", summary: "Detalle de un agente", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" } } },
      },
      "/agents/meta/tools": { get: { operationId: "listTools", summary: "Tools disponibles", responses: { "200": { description: "OK" } } } },
      "/agents/{id}/draft": {
        put: {
          operationId: "updateAgentDraft",
          summary: "Edita el borrador (prompt, config, tools)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    systemPrompt: { type: "string" },
                    config: { type: "object", properties: { model: { type: "string" }, maxTokens: { type: "number" }, maxToolRounds: { type: "number" }, language: { type: "string" }, actions: { type: "object" }, knowledgeSources: { type: "array", items: { type: "string" } } } },
                    tools: { type: "array", items: { type: "string" } },
                    changelog: { type: "string" },
                  },
                  required: ["systemPrompt", "config", "tools"],
                },
              },
            },
          },
          responses: { "200": { description: "OK" } },
        },
      },
      "/agents/{id}/publish": { post: { operationId: "publishAgent", summary: "Publica el borrador", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "OK" } } } },
      "/agents/{id}/active": {
        post: {
          operationId: "setAgentActive",
          summary: "Activa/desactiva",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { active: { type: "boolean" } }, required: ["active"] } } } },
          responses: { "200": { description: "OK" } },
        },
      },
      "/agents/{id}/test": {
        post: {
          operationId: "testAgent",
          summary: "Prueba el agente en el simulador",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    systemPrompt: { type: "string" },
                    config: { type: "object" },
                    tools: { type: "array", items: { type: "string" } },
                    messages: { type: "array", items: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } } } },
                  },
                  required: ["systemPrompt", "config", "tools", "messages"],
                },
              },
            },
          },
          responses: { "200": { description: "OK" } },
        },
      },
    },
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    security: [{ bearer: [] }],
  };
}

export default function ConectarChatgptPage() {
  const toast = useToast();
  const [data, setData] = useState<{ token: string; apiUrl: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function generate() {
    setLoading(true);
    try {
      setData(await api<{ token: string; apiUrl: string }>("/settings/mcp-token", { method: "POST" }));
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  const schema = data ? JSON.stringify(buildOpenApi(data.apiUrl), null, 2) : "";
  const copy = (t: string, l: string) => void navigator.clipboard.writeText(t).then(() => toast.push(`${l} copiado`, "ok"));

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Conectar con ChatGPT (GPT personalizado)</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Crea un <b>GPT personalizado</b> con una <b>Action</b> para montar y gestionar tus agentes de TuBot desde ChatGPT (mismo backend que el conector de Claude). El token es <b>de esta cuenta</b>.
        </p>
      </div>

      <section className="space-y-4 rounded-xl border border-line bg-panel p-4">
        <Button disabled={loading} onClick={() => void generate()}>{loading ? "Generando…" : data ? "Generar token nuevo" : "Generar token de conexión"}</Button>

        {data && (
          <>
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/5 dark:text-amber-300">
              ⚠ Guarda el token en un lugar seguro (válido 1 año, da acceso a gestionar tus agentes).
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between"><p className="text-xs font-medium text-ink-muted">Token (API Key del GPT)</p><button onClick={() => copy(data.token, "Token")} className="text-2xs text-brand-700 underline dark:text-brand-300">Copiar</button></div>
              <textarea readOnly value={data.token} rows={3} className="w-full rounded-control border border-line-strong bg-app px-3 py-2 font-mono text-2xs text-ink" />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between"><p className="text-xs font-medium text-ink-muted">Esquema OpenAPI (pégalo en el GPT)</p><button onClick={() => copy(schema, "Esquema")} className="text-2xs text-brand-700 underline dark:text-brand-300">Copiar</button></div>
              <pre className="max-h-64 overflow-auto rounded-control border border-line-strong bg-app p-3 text-2xs text-ink">{schema}</pre>
            </div>
            <div className="rounded-lg bg-app p-3 text-xs text-ink-muted">
              <p className="font-medium text-ink">Pasos en ChatGPT:</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                <li>ChatGPT → Explorar GPT → Crear → pestaña <b>Configurar</b> → <b>Crear nueva acción</b>.</li>
                <li>Pega el <b>Esquema</b> de arriba.</li>
                <li>En <b>Autenticación</b> elige <b>API Key</b>, tipo <b>Bearer</b>, y pega el <b>token</b>.</li>
                <li>Guarda. Ya puedes pedirle al GPT que liste, edite y publique tus agentes.</li>
              </ol>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
