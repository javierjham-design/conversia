/**
 * Monitoreo de confiabilidad del bot (para enterarnos ANTES que un prospecto):
 *
 * 1. CANARIO SINTÉTICO (cada 15 min): mantiene una mini-conversación real contra
 *    el agente comercial de TuBot (saludo + pregunta de precio) usando el MISMO
 *    orquestador de producción, y verifica que responde, completo y con sentido.
 *    El resultado se escribe en Redis; /health/status lo lee y BetterStack alerta.
 *    Costo mínimo (sin tools, respuesta corta) y contabilizado como usage.
 *
 * 2. SCAN DE SIN-RESPONDER (cada 3 min): busca conversaciones de CUALQUIER tenant
 *    donde entró un mensaje del cliente y el bot no respondió en X minutos, y
 *    dispara la alerta `conversation.unanswered` (medición directa del problema).
 */
import type IORedis from "ioredis";
import {
  ResilientAIProvider,
  ToolRegistry,
  assembleSystemPrompt,
  createAIRouter,
  orchestrate,
  type AgentRuntime,
} from "@conversia/agents";
import { getEnv } from "@conversia/config";
import { getAdminPrisma, recordUsage, withTenant } from "@conversia/database";
import type { AIChatMessage, ToolContext } from "@conversia/types";

export const CANARY_KEY = "conversia:health:canary";
const UNANSWERED_MINUTES = 3; // umbral de "sin responder"
const emptyRegistry = new ToolRegistry(); // el canario no ejecuta tools (sin efectos)

function ai() {
  const env = getEnv();
  return new ResilientAIProvider(
    createAIRouter({ anthropicApiKey: env.ANTHROPIC_API_KEY, openaiApiKey: env.OPENAI_API_KEY }),
    { maxAttempts: env.AI_MAX_ATTEMPTS, timeoutMs: env.AI_CALL_TIMEOUT_MS, fallbackModel: env.AI_FALLBACK_MODEL },
  );
}

interface CanaryResult {
  ok: boolean;
  ts: number;
  detail: string;
}

/** Corre el canario: mini-conversación real contra el comercial de TuBot. */
export async function runCanary(connection: IORedis): Promise<CanaryResult> {
  const env = getEnv();
  const orgId = env.ASSISTED_SETUP_PROVIDER_ORG_ID;
  let result: CanaryResult;
  try {
    const loaded = await withTenant(orgId, async (tx) => {
      const agent = await tx.agent.findFirst({ where: { slug: "comercial", active: true, deletedAt: null } });
      if (!agent) return null;
      const version = await tx.agentVersion.findFirst({
        where: { agentId: agent.id, status: "PUBLISHED" },
        orderBy: { version: "desc" },
      });
      if (!version) return null;
      const org = await tx.organization.findUnique({ where: { id: orgId } });
      return { agent, version, orgSettings: (org?.settings ?? {}) as Record<string, any> };
    });
    if (!loaded) throw new Error("No hay agente comercial publicado en TuBot");

    const cfg = (loaded.version.config ?? {}) as Record<string, any>;
    const aiCfg = (loaded.orgSettings.ai ?? {}) as Record<string, any>;
    const runtime: AgentRuntime = {
      agentId: loaded.agent.id,
      agentVersionId: loaded.version.id,
      slug: loaded.agent.slug,
      name: loaded.agent.name,
      systemPrompt: assembleSystemPrompt(loaded.version.systemPrompt, cfg.actions),
      model: (typeof cfg.model === "string" && cfg.model) || aiCfg.model || env.AI_DEFAULT_MODEL,
      maxTokens: aiCfg.maxTokens ?? 1500,
      maxToolRounds: 0, // sin tools: solo verificamos la conversación
      tools: [],
    };
    const ctx = { organizationId: orgId, services: {} } as unknown as ToolContext;

    // Dos turnos: saludo y pregunta de precio.
    const history: AIChatMessage[] = [{ role: "user", content: "Hola, ¿qué es TuBot?" }];
    const r1 = await orchestrate(ai(), emptyRegistry, { ctx, agent: runtime, history, vars: {} });
    const reply1 = (r1.reply ?? "").trim();
    history.push({ role: "assistant", content: reply1 });
    history.push({ role: "user", content: "¿Cuánto cuesta?" });
    const r2 = await orchestrate(ai(), emptyRegistry, { ctx, agent: runtime, history, vars: {} });
    const reply2 = (r2.reply ?? "").trim();

    // Contabiliza el costo del canario.
    await withTenant(orgId, (tx) =>
      recordUsage(tx, orgId, "ai_tokens", r1.usage.inputTokens + r1.usage.outputTokens + r2.usage.inputTokens + r2.usage.outputTokens, { canary: true }, r1.usage.costUsd + r2.usage.costUsd),
    ).catch(() => undefined);

    // Verificaciones: responde, completo (no cortado), y con sentido (largo mínimo).
    const problems: string[] = [];
    if (reply1.length < 15) problems.push("saludo vacío/corto");
    if (reply2.length < 15) problems.push("respuesta de precio vacía/corta");
    if (r1.stopReason === "error" || r2.stopReason === "error") problems.push("stopReason=error");
    if (/problema técnico|no disponible/i.test(reply1 + reply2)) problems.push("respondió en modo degradado");

    result = problems.length
      ? { ok: false, ts: Date.now(), detail: problems.join("; ") }
      : { ok: true, ts: Date.now(), detail: `ok (${reply1.length}+${reply2.length} chars)` };
  } catch (err) {
    result = { ok: false, ts: Date.now(), detail: (err as Error).message.slice(0, 200) };
  }

  await connection.set(CANARY_KEY, JSON.stringify(result), "EX", 3600).catch(() => undefined);
  if (!result.ok) console.error(`‼ CANARIO TuBot FALLÓ: ${result.detail}`);
  return result;
}

/** Busca conversaciones sin responder (cross-tenant) y dispara la alerta. */
export async function scanUnanswered(): Promise<number> {
  const admin = getAdminPrisma();
  const now = Date.now();
  // Ventana: mensajes cuyo último movimiento fue hace [UMBRAL, UMBRAL+3min) para
  // alertar UNA vez por conversación (el scan corre cada 3 min).
  const upper = new Date(now - UNANSWERED_MINUTES * 60_000);
  const lower = new Date(now - (UNANSWERED_MINUTES + 3) * 60_000);
  const convs = await admin.conversation.findMany({
    where: {
      status: "OPEN",
      aiEnabled: true,
      assignedUserId: null,
      assignedTeamId: null,
      lastMessageAt: { gte: lower, lt: upper },
    },
    select: { id: true, organizationId: true, contactId: true, lastMessageAt: true },
    take: 200,
  });
  let alerted = 0;
  for (const c of convs) {
    try {
      // Confirma que el ÚLTIMO mensaje es entrante del cliente y sin respuesta posterior.
      const last = await admin.message.findFirst({
        where: { conversationId: c.id },
        orderBy: { createdAt: "desc" },
        select: { direction: true, authorType: true, createdAt: true },
      });
      if (!last || last.direction !== "INBOUND") continue;
      const contact = await admin.contact.findUnique({
        where: { id: c.contactId },
        select: { firstName: true, lastName: true, profileName: true, phone: true },
      });
      const contactName =
        [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || contact?.profileName || contact?.phone || "Un contacto";
      const minutes = Math.round((now - new Date(c.lastMessageAt ?? now).getTime()) / 60_000);
      const { enqueueNotification } = await import("./notifications/queue.js");
      await enqueueNotification({
        eventKey: "conversation.unanswered",
        organizationId: c.organizationId,
        conversationId: c.id,
        context: { conversationId: c.id },
        data: { contactName, minutes, conversationId: c.id },
      });
      alerted++;
    } catch (err) {
      console.error(`✖ scanUnanswered (${c.id}):`, (err as Error).message);
    }
  }
  if (alerted) console.log(`⚠ ${alerted} conversación(es) sin responder → alerta enviada`);
  return alerted;
}

/** Arranca los dos monitores (canario 15 min, sin-responder 3 min). Devuelve stop(). */
export function startReliabilityMonitor(connection: IORedis): () => void {
  const canary = setInterval(() => void runCanary(connection).catch((e) => console.error("canary:", e)), 15 * 60_000);
  const unanswered = setInterval(() => void scanUnanswered().catch((e) => console.error("unanswered:", e)), 3 * 60_000);
  canary.unref?.();
  unanswered.unref?.();
  // Primera corrida del canario poco después del arranque.
  const first = setTimeout(() => void runCanary(connection).catch(() => undefined), 30_000);
  first.unref?.();
  console.log("✔ Monitor de confiabilidad activo (canario 15 min · sin-responder 3 min)");
  return () => {
    clearInterval(canary);
    clearInterval(unanswered);
    clearTimeout(first);
  };
}
