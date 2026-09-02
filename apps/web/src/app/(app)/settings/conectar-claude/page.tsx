"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Button, useToast } from "@/components/ui";

export default function ConectarClaudePage() {
  const toast = useToast();
  const [data, setData] = useState<{ token: string; apiUrl: string; expiresInDays: number } | null>(null);
  const [loading, setLoading] = useState(false);

  async function generate() {
    if (data && !window.confirm("¿Generar un token nuevo? El anterior seguirá funcionando hasta que caduque; usa el nuevo en Claude.")) return;
    setLoading(true);
    try {
      setData(await api<{ token: string; apiUrl: string; expiresInDays: number }>("/settings/mcp-token", { method: "POST" }));
    } catch (e) {
      toast.push((e as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }

  const configJson = data
    ? JSON.stringify(
        {
          mcpServers: {
            tubot: {
              command: "node",
              args: ["C:/ruta/a/apps/mcp-tubot/index.mjs"],
              env: { TUBOT_TOKEN: data.token, TUBOT_API_URL: data.apiUrl },
            },
          },
        },
        null,
        2,
      )
    : "";

  function copy(text: string, label: string) {
    void navigator.clipboard.writeText(text).then(() => toast.push(`${label} copiado`, "ok"));
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Conectar con Claude (MCP)</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Genera un token de <b>larga duración</b> (1 año) para montar y gestionar tus agentes de IA desde{" "}
          <b>Claude</b> en lenguaje natural (listar, crear, editar el prompt, probar, publicar): por <b>URL</b> (Claude web / conectores) o en{" "}
          <b>Claude Desktop</b>. El token es <b>de esta cuenta</b>: Claude solo verá tus agentes.
        </p>
      </div>

      <section className="space-y-4 rounded-xl border border-line bg-panel p-4">
        <Button disabled={loading} onClick={() => void generate()}>
          {loading ? "Generando…" : data ? "Generar un token nuevo" : "Generar token de conexión"}
        </Button>

        {data && (
          <>
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/5 dark:text-amber-300">
              ⚠ Guarda este token en un lugar seguro. Da acceso a gestionar tus agentes por 1 año. No lo compartas ni lo subas a ningún repositorio.
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs font-medium text-ink-muted">Token</p>
                <button onClick={() => copy(data.token, "Token")} className="text-2xs text-brand-700 underline dark:text-brand-300">Copiar token</button>
              </div>
              <textarea readOnly value={data.token} rows={3} className="w-full rounded-control border border-line-strong bg-app px-3 py-2 font-mono text-2xs text-ink" />
            </div>

            {/* Opción A: por URL (Claude web / conectores). El token va en la URL. */}
            <div className="rounded-lg border border-brand-200 bg-brand-soft p-3 dark:border-brand-500/30">
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs font-semibold text-brand-700 dark:text-brand-300">🔗 Conectar por URL (Claude web / conectores)</p>
                <button onClick={() => copy(`${data.apiUrl.replace(/\/$/, "")}/mcp/${data.token}`, "URL")} className="text-2xs text-brand-700 underline dark:text-brand-300">Copiar URL</button>
              </div>
              <textarea readOnly value={`${data.apiUrl.replace(/\/$/, "")}/mcp/${data.token}`} rows={3} className="w-full rounded-control border border-line-strong bg-app px-3 py-2 font-mono text-2xs text-ink" />
              <p className="mt-1 text-[11px] text-ink-subtle">
                En Claude → <b>Configuración → Conectores → Agregar conector personalizado</b>, pega esta URL. El token ya va incluido, así que no pide nada más.
              </p>
            </div>

            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-xs font-medium text-ink-muted">Opción B — Configuración para Claude Desktop (local)</p>
                <button onClick={() => copy(configJson, "Config")} className="text-2xs text-brand-700 underline dark:text-brand-300">Copiar config</button>
              </div>
              <pre className="max-h-64 overflow-auto rounded-control border border-line-strong bg-app p-3 text-2xs text-ink">{configJson}</pre>
              <p className="mt-1 text-[11px] text-ink-subtle">
                Pégalo en <code>claude_desktop_config.json</code> (macOS: <code>~/Library/Application Support/Claude/</code>, Windows:{" "}
                <code>%APPDATA%\Claude\</code>) y ajusta la ruta a <code>apps/mcp-tubot/index.mjs</code>. Reinicia Claude Desktop.
              </p>
            </div>
          </>
        )}
      </section>

      <section className="rounded-xl border border-line bg-panel p-4 text-sm text-ink-muted">
        <p className="font-medium text-ink">¿Qué puede hacer Claude con esto?</p>
        <p className="mt-1">
          Listar tus agentes, ver y editar sus instrucciones, configurar sus acciones, probarlos en el simulador y publicarlos —
          todo hablándole en español. Ej: <i>«en el bot de la lavandería agrega la regla del flyer, pruébalo y publícalo»</i>.
        </p>
      </section>
    </div>
  );
}
