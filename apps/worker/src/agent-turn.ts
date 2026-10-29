import {
  ResilientAIProvider,
  ToolRegistry,
  assembleSystemPrompt,
  buildCoreTools,
  createAIRouter,
  orchestrate,
  type AgentRuntime,
  type OrchestrateResult,
} from "@conversia/agents";
import { getEnv, brandOf } from "@conversia/config";
import { getAdminPrisma, getPrisma, raiseException, resolveAgentByNameOrSlug, withTenant } from "@conversia/database";
import { acquireConversationLock, newLockToken, releaseConversationLock } from "./conversation-lock";
import { requeueAgentTurn } from "./agent-turn-queue";
import { pauseAiWithFallback } from "./ai-paused-fallback";
import type { AIChatMessage, ToolContext } from "@conversia/types";
import { ChannelAuthError, markChannelAuthError, resolveChannelAuth } from "./channel-auth";
import { recordServiceSend } from "./service-metering";
import { readMaxAgentMessagesPerTurn } from "./agent-turn-guard";
import { chargeServiceSend, outOfConversationCreditsPhrase } from "./messaging-guard";
import { planDebitsConversation } from "./conversation-credits";
import { aiCreditsGate, aiCreditsNotifyDecision, debitAiCreditsForTurn, getAiCreditsMeter } from "./ai-credits";
import { informarHitoCapi } from "./funnel-capi";
import { guardrailInstruction, bumpResponseGuardrail } from "./response-guardrail";
import { refundForMessage } from "./wallet";
import { getChannelProvider } from "./channel-providers";
import { emitPlatformEvent } from "./platform-events";
import { observeTurnModel } from "./ai-health";
import { buildAssistedSetupStatusBlock, buildToolServices } from "./tool-services";

const registry = new ToolRegistry();
for (const tool of buildCoreTools()) registry.register(tool);

/** Si el modelo llamó `assignConversation` y la tool detectó que el destino era un AGENTE
 * de IA (no equipo/persona), devuelve el slug del agente a transferir; si no, undefined. */
function extractHandoffSlug(
  events: ReadonlyArray<{ name: string; output?: unknown; isError?: boolean }> | undefined,
): string | undefined {
  const ev = events?.find((e) => e.name === "assignConversation" && !e.isError);
  if (!ev || typeof ev.output !== "string") return undefined;
  try {
    const parsed = JSON.parse(ev.output) as { handoffToAgentSlug?: unknown };
    return typeof parsed.handoffToAgentSlug === "string" ? parsed.handoffToAgentSlug : undefined;
  } catch {
    return undefined;
  }
}

// Router por modelo: gpt-* → OpenAI, claude-* → Anthropic (según las llaves),
// envuelto en resiliencia: timeout + reintentos con backoff + fallback de modelo.
// Un fallo transitorio del proveedor NO puede dejar al cliente en silencio.
const ai = new ResilientAIProvider(
  createAIRouter({
    anthropicApiKey: getEnv().ANTHROPIC_API_KEY,
    openaiApiKey: getEnv().OPENAI_API_KEY,
  }),
  {
    maxAttempts: getEnv().AI_MAX_ATTEMPTS,
    timeoutMs: getEnv().AI_CALL_TIMEOUT_MS,
    fallbackModel: getEnv().AI_FALLBACK_MODEL,
    onRetry: ({ model, attempt, error }) =>
      console.warn(`↻ IA reintento (${model}, intento ${attempt}): ${error}`),
  },
);

/**
 * Ejecuta un turno del agente activo de una conversación y envía la
 * respuesta por el canal. Registra trazabilidad completa (agente, versión,
 * tools, tokens, costo) en messages + ai_requests + usage_events.
 */
/** Limpia un valor para inyectarlo en el prompt: sin saltos ni llaves de plantilla, acotado. */
function sanitizeField(v: unknown): string {
  return String(v ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[{}]/g, "")
    .trim()
    .slice(0, 200);
}

/**
 * Bloque "datos que YA conoces del contacto" a partir de lo guardado (nombre,
 * email y el perfil de negocio en contact.attributes.profile). Se reinyecta
 * SIEMPRE para que el bot no vuelva a preguntar lo ya respondido. "" si no hay nada.
 */
function buildKnownContactBlock(contact: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  attributes?: unknown;
}): string {
  const known: string[] = [];
  const name = [contact.firstName, contact.lastName].filter(Boolean).map(sanitizeField).join(" ");
  if (name) known.push(`Nombre: ${name}`);
  if (contact.email) known.push(`Email: ${sanitizeField(contact.email)}`);
  const profile = (contact.attributes as Record<string, unknown> | null | undefined)?.profile;
  if (profile && typeof profile === "object") {
    for (const [k, v] of Object.entries(profile as Record<string, unknown>)) {
      const val = sanitizeField(v);
      if (val) known.push(`${sanitizeField(k)}: ${val}`);
    }
  }
  if (!known.length) return "";
  return (
    "\n\n## Datos que YA conoces de este contacto (NO los vuelvas a preguntar)\n" +
    known.map((k) => `- ${k}`).join("\n")
  );
}

/**
 * Medianoche de HOY en la zona horaria de la ORGANIZACIÓN, como instante absoluto (§8.6).
 * El tope diario de tokens se contaba con la medianoche del SERVIDOR (UTC en Railway), así
 * que a un tenant chileno el día se le reiniciaba a las 21:00. Zona inválida → se cae al
 * comportamiento anterior (medianoche local) para no romper nada.
 */
export function startOfDayInTimezone(timezone: string, now: Date = new Date()): Date {
  try {
    const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(now); // YYYY-MM-DD
    const medianocheUtc = new Date(`${ymd}T00:00:00Z`).getTime();
    const offsetMs =
      new Date(now.toLocaleString("en-US", { timeZone: timezone })).getTime() -
      new Date(now.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
    return new Date(medianocheUtc - offsetMs);
  } catch {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }
}

/** Normaliza un teléfono a solo dígitos para comparar ("+56 9 1234" == "5691234"). */
export function phoneDigits(v: string | null | undefined): string {
  return (v ?? "").replace(/\D/g, "");
}

/** Vista mínima del cliente de BD que necesita `resolveOwnerContext` (permite mockearlo en tests). */
export type OwnerCtxTx = {
  channelConnection: { findFirst: (args: any) => Promise<{ type: string } | null> };
  contactIdentity: { findFirst: (args: any) => Promise<{ externalId: string } | null> };
  role: { findMany: (args: any) => Promise<Array<{ id: string }>> };
  organizationUser: { findMany: (args: any) => Promise<Array<{ user: { phone: string | null } | null }>> };
};

/**
 * MODO DUEÑO (F8, corregido en auditoría §2.1 y §7.5). El contacto es "dueño" solo si el
 * número con el que escribe por **WhatsApp** coincide con el de un usuario owner/admin
 * ACTIVO de ESTA organización.
 *
 * Dos cosas que antes fallaban:
 * - La identidad se tomaba de `contact.phone`, que una tool puede escribir
 *   (`updateContactFields`): por Instagram/Messenger alguien podía fijarse el teléfono del
 *   dueño y heredar sus tools. Ahora sale de `contact_identities.externalId` del canal
 *   WHATSAPP_CLOUD, que lo pone Meta. Fuera de WhatsApp siempre es `false`.
 * - Las consultas de roles/membresías no filtraban por organización: un teléfono podía
 *   matchear al admin de OTRO cliente. Ahora todas llevan `organizationId` explícito
 *   (defensa en profundidad por encima de la RLS).
 */
export async function resolveOwnerContext(
  tx: OwnerCtxTx,
  args: { organizationId: string; contactId: string; channelConnectionId: string | null },
): Promise<boolean> {
  const { organizationId, contactId, channelConnectionId } = args;
  if (!channelConnectionId) return false;
  const channel = await tx.channelConnection.findFirst({
    where: { id: channelConnectionId, organizationId },
    select: { type: true },
  });
  if (channel?.type !== "WHATSAPP_CLOUD") return false;

  const identity = await tx.contactIdentity.findFirst({
    where: { organizationId, contactId, channelType: "WHATSAPP_CLOUD" },
    select: { externalId: true },
  });
  const waPhone = phoneDigits(identity?.externalId);
  if (!waPhone) return false;

  const roles = await tx.role.findMany({
    where: { organizationId, code: { in: ["owner", "admin"] } },
    select: { id: true },
  });
  if (!roles.length) return false;
  const members = await tx.organizationUser.findMany({
    where: { organizationId, active: true, roleId: { in: roles.map((r) => r.id) } },
    select: { user: { select: { phone: true } } },
  });
  return members.some((m) => {
    const p = phoneDigits(m.user?.phone);
    return p.length > 0 && p === waPhone;
  });
}

export type AgentTurnOpts = {
  organizationId: string;
  conversationId: string;
  agentSlug?: string;
  depth?: number;
  /** Objetivo puntual inyectado al prompt (nodo de workflow "Agente IA"). */
  objective?: string;
};

/** ¿El agente YA respondió después del último mensaje entrante? (§8.1) */
export async function alreadyAnsweredAfterLastInbound(
  organizationId: string,
  conversationId: string,
): Promise<boolean> {
  try {
    return await withTenant(organizationId, async (tx) => {
      const ultimoEntrante = await tx.message.findFirst({
        where: { organizationId, conversationId, direction: "INBOUND" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (!ultimoEntrante) return false;
      const respuesta = await tx.message.findFirst({
        where: {
          organizationId,
          conversationId,
          direction: "OUTBOUND",
          authorType: "AGENT",
          createdAt: { gte: ultimoEntrante.createdAt },
        },
        select: { id: true },
      });
      return !!respuesta;
    });
  } catch {
    return false; // ante la duda, responder: la regla de oro es CERO SILENCIOS
  }
}

/**
 * CERROJO POR CONVERSACIÓN (§8.1). Dos turnos simultáneos sobre la misma conversación
 * producían respuestas duplicadas o entremezcladas (el segundo lee el historial sin la
 * respuesta que el primero aún no escribió). Si la conversación está tomada, el turno se
 * reencola a los 3 s en vez de responder en paralelo.
 *
 * Alcance DELIBERADAMENTE acotado al turno "normal" del ingreso, que es donde ocurría el
 * problema:
 * - Los turnos ANIDADOS (derivación entre agentes, `depth > 0`) ya corren dentro del cerrojo
 *   del turno padre: aplicarlo otra vez los bloquearía contra sí mismos.
 * - Los turnos con `objective`/`agentSlug` vienen de un flujo y NO se pueden reencolar sin
 *   perder ese contexto (`AgentTurnJob` solo lleva organizationId + conversationId).
 * Esos dos casos se comportan exactamente como hasta ahora.
 */
export async function runAgentTurn(opts: AgentTurnOpts): Promise<void> {
  const { organizationId, conversationId } = opts;
  const serializable = !opts.objective && !opts.agentSlug && (opts.depth ?? 0) === 0;
  if (!serializable) return runAgentTurnLocked(opts);

  const token = newLockToken();
  if (!(await acquireConversationLock(conversationId, token))) {
    await requeueAgentTurn({ organizationId, conversationId }, 3000).catch((err) =>
      console.error(`✖ No se pudo reencolar el turno tomado (${conversationId}):`, (err as Error).message),
    );
    return;
  }
  try {
    // Si el bot ya contestó el último entrante (reintento, ráfaga ya atendida o un flujo que
    // respondió primero), este turno sobra: responder de nuevo sería duplicar.
    if (await alreadyAnsweredAfterLastInbound(organizationId, conversationId)) return;
    await runAgentTurnLocked(opts);
  } finally {
    await releaseConversationLock(conversationId, token);
  }
}

async function runAgentTurnLocked(opts: AgentTurnOpts): Promise<void> {
  const { organizationId, conversationId } = opts;
  const depth = opts.depth ?? 0;

  // 1. Cargar contexto (transacción corta; la llamada al modelo va fuera)
  const loaded = await withTenant(organizationId, async (tx) => {
    const conversation = await tx.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true },
    });
    if (!conversation || !conversation.aiEnabled) return null;

    let agent = null;
    if (opts.agentSlug) {
      agent = await tx.agent.findUnique({
        where: { organizationId_slug: { organizationId, slug: opts.agentSlug } },
      });
    } else if (conversation.activeAgentId) {
      agent = await tx.agent.findUnique({ where: { id: conversation.activeAgentId } });
    }
    if (!agent && conversation.channelConnectionId) {
      const channel = await tx.channelConnection.findUnique({ where: { id: conversation.channelConnectionId } });
      if (channel?.defaultAgentId) {
        agent = await tx.agent.findUnique({ where: { id: channel.defaultAgentId } });
      }
    }
    if (!agent || !agent.active) return null;

    const version = await tx.agentVersion.findFirst({
      where: { agentId: agent.id, status: "PUBLISHED" },
      orderBy: { version: "desc" },
    });
    if (!version) return null;

    const [org, clinic, rawMessages] = await Promise.all([
      tx.organization.findUnique({ where: { id: organizationId } }),
      conversation.clinicId
        ? tx.clinic.findUnique({ where: { id: conversation.clinicId } })
        : tx.clinic.findFirst({ where: { organizationId, active: true } }),
      tx.message.findMany({
        where: { conversationId, visibility: "PUBLIC", type: { notIn: ["SYSTEM", "NOTE"] } },
        orderBy: { createdAt: "desc" },
        // Se traen hasta 50; la VENTANA real se decide luego de forma adaptativa
        // (20 en un chat normal; hasta 50 si un humano tomó el control, para no
        // perder la conversación manual ni los acuerdos al devolver a la IA).
        take: 50,
      }),
    ]);

    return { conversation, agent, version, org, clinic, rawMessages: rawMessages.reverse() };
  });

  if (!loaded) return;
  const { conversation, agent, version, org, clinic, rawMessages } = loaded;

  // Controles de consumo de IA (LLM10 — Unbounded Consumption):
  // 1. Kill switch global (env) o por tenant (org.settings.aiKillSwitch).
  // 2. Tope diario de tokens por organización.
  const env = getEnv();
  const orgSettings = (org?.settings ?? {}) as Record<string, any>;
  if (env.AI_GLOBAL_KILL_SWITCH || orgSettings.aiKillSwitch === true) {
    const motivo = env.AI_GLOBAL_KILL_SWITCH ? "IA pausada globalmente" : "IA pausada por la organización";
    await withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: { organizationId, provider: "ai", type: "ai.kill_switch", status: "warning", message: motivo },
      }),
    );
    // §8.6 — antes se hacía `return` a secas y el bot quedaba MUDO sin que nadie se enterara.
    await pauseAiWithFallback(organizationId, conversationId, motivo);
    return;
  }
  // Suspensión real: si la organización está SUSPENDED/CANCELLED, la IA deja de
  // operar (deja de gastar). El Super Admin la fija con /platform/organizations/:id/status.
  if (org?.status === "SUSPENDED" || org?.status === "CANCELLED") {
    await withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: {
          organizationId,
          provider: "ai",
          type: "ai.org_suspended",
          status: "warning",
          message: `IA detenida: organización ${org.status}`,
        },
      }),
    );
    return;
  }
  // Vigencia vencida: el servicio del tenant expiró → la IA deja de operar.
  const validUntil = orgSettings.validUntil;
  if (typeof validUntil === "string" && new Date(validUntil).getTime() < Date.now()) {
    await withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: { organizationId, provider: "ai", type: "ai.expired", status: "warning", message: "IA detenida: vigencia del servicio vencida" },
      }),
    );
    return;
  }
  // Tope diario efectivo: override por-tenant (settings.limits.aiTokensDaily) manda;
  // si no, el del plan; si no, el default de la plataforma. 0 = ilimitado.
  const budget = await withTenant(organizationId, async (tx) => {
    const override = (orgSettings.limits as Record<string, number> | undefined)?.aiTokensDaily;
    if (typeof override === "number") return override;
    const sub = await tx.subscription.findFirst({
      where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } },
      orderBy: { createdAt: "desc" },
    });
    if (sub) {
      const plan = await tx.plan.findUnique({ where: { id: sub.planId } });
      const planLimit = (plan?.limits as Record<string, number> | undefined)?.aiTokensDaily;
      if (typeof planLimit === "number") return planLimit;
    }
    return env.AI_DAILY_TOKEN_BUDGET_PER_ORG;
  });
  if (budget > 0) {
    // §8.6 — el día se corta en la zona horaria DE LA ORGANIZACIÓN, no en la del servidor:
    // con el servidor en UTC, un tenant chileno veía reiniciarse el tope a las 21:00.
    const startOfDay = startOfDayInTimezone(org?.timezone ?? "America/Santiago");
    const spent = await withTenant(organizationId, (tx) =>
      tx.usageEvent.aggregate({
        where: { organizationId, type: "ai_tokens", occurredAt: { gte: startOfDay } },
        _sum: { quantity: true },
      }),
    );
    if (Number(spent._sum.quantity ?? 0) >= budget) {
      // El mensaje lleva el tope EFECTIVO (override del tenant → plan → default), no el
      // default de la plataforma: antes decía un número que muchas veces no era el que aplicaba.
      const motivo = `Tope diario de tokens IA alcanzado (${budget})`;
      await withTenant(organizationId, (tx) =>
        tx.integrationEvent.create({
          data: { organizationId, provider: "ai", type: "ai.budget_exceeded", status: "warning", message: motivo },
        }),
      );
      // §8.6 — antes se hacía `return` a secas y el bot quedaba MUDO el resto del día.
      await pauseAiWithFallback(organizationId, conversationId, motivo);
      return;
    }
  }

  // CRE 1 — CRÉDITOS IA: ¿puede pagar una respuesta más? Se mira ANTES de llamar al
  // modelo para no gastar tokens que no vamos a poder cobrar. El débito real va al final
  // del turno, con los tokens que realmente usó. Si se agotaron saldo Y gracia, el bot NO
  // queda mudo: manda la frase de respaldo del tenant y la conversación pasa a una persona.
  // La marca ya viene cargada con la organización: se usa para NO hacerle ni una consulta
  // extra al turno de TuBot, que atiende clientes reales 24/7.
  const esConversia = brandOf(org).key === "conversia";
  const creditGate = esConversia
    ? await aiCreditsGate(organizationId).catch(() => ({ charges: false }) as const)
    : ({ charges: false } as const);
  if (creditGate.charges && creditGate.blocked) {
    const frase = await outOfConversationCreditsPhrase(organizationId);
    await withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: {
          organizationId,
          provider: "ai",
          type: "ai.no_credits",
          status: "warning",
          message: `Créditos IA agotados (gracia incluida): saldo ${creditGate.remaining}`,
        },
      }),
    ).catch(() => undefined);
    await raiseException(getAdminPrisma(), {
      organizationId,
      type: "saldo_gracia_sin_recarga",
      severity: "critical",
      title: "Créditos IA en 0 y gracia agotada",
      detail: "El cliente consumió sus Créditos IA y la gracia sin recargar; el bot está derivando a humano.",
      dedupeKey: new Date().toISOString().slice(0, 7),
    }).catch(() => undefined);
    await pauseAiWithFallback(organizationId, conversationId, "Créditos IA agotados (recarga para reanudar la IA)", { text: frase });
    return;
  }

  // 2. Historial ventaneado (el primer mensaje debe ser del usuario)
  // Ventana ADAPTATIVA: normalmente 20 mensajes; pero si un HUMANO del equipo intervino
  // (tomó el control y conversó con el cliente), la ampliamos hasta 50. Así, al devolver
  // el control a la IA, el agente VE esa conversación manual y —sobre todo— los ACUERDOS
  // que el humano cerró con el cliente. Sin esto, el bot quedaba ciego a lo pactado a mano
  // (se salía de la ventana de 20) y proponía cosas contradictorias que el humano tenía
  // que corregir una y otra vez.
  const humanIntervened = rawMessages.some((m) => m.direction === "OUTBOUND" && m.authorType === "USER");
  const windowMessages = humanIntervened ? rawMessages.slice(-50) : rawMessages.slice(-20);

  // Nombres de los compañeros humanos que escribieron: se usan para ATRIBUIR sus mensajes
  // en el historial ("[Javier (humano del equipo): ...]"), de modo que el modelo sepa que
  // eso lo dijo una persona del equipo (un acuerdo), no el propio bot.
  const humanNames = new Map<string, string>();
  const humanAuthorIds = [
    ...new Set(
      windowMessages
        .filter((m) => m.direction === "OUTBOUND" && m.authorType === "USER" && m.authorUserId)
        .map((m) => m.authorUserId as string),
    ),
  ];
  if (humanAuthorIds.length) {
    const users = await withTenant(organizationId, (tx) =>
      tx.user.findMany({ where: { id: { in: humanAuthorIds } }, select: { id: true, name: true } }),
    );
    for (const u of users) humanNames.set(u.id, u.name);
  }

  // Visión: el agente "ve" las imágenes recientes que envió el contacto. Se
  // descargan de Meta y se adjuntan al mensaje (modelos multimodales). Toggle por
  // tenant (org.settings.vision.enabled, activado por defecto).
  const visionOn = orgSettings.vision !== false; // activada por defecto
  let visionToken: string | null = null;
  if (visionOn && windowMessages.some((m) => m.type === "IMAGE" && m.direction === "INBOUND")) {
    try {
      const auth = await resolveChannelAuth(organizationId, { channelConnectionId: conversation.channelConnectionId });
      visionToken = auth.accessToken ?? null;
    } catch {
      /* sin token → sin visión */
    }
  }

  const IMAGE_WINDOW = 6; // solo imágenes de los últimos N mensajes
  const MAX_IMAGES = 3;
  let imagesUsed = 0;
  const history: AIChatMessage[] = [];
  for (let i = 0; i < windowMessages.length; i++) {
    const m = windowMessages[i];
    // Un OUTBOUND escrito por un HUMANO del equipo se marca con su nombre para que el
    // modelo lo distinga de sus propias respuestas y respete lo que ese humano pactó.
    const isHuman = m.direction === "OUTBOUND" && m.authorType === "USER";
    let content = m.body ?? `[${m.type.toLowerCase()}]`;
    // Documento con TEXTO extraído (PDF, etc.): se lo damos al agente para que lo LEA.
    // El texto va en el payload (no en el body, para no ensuciar el hilo del humano).
    if (m.type === "DOCUMENT") {
      const docText = (m.payload as any)?.documentText;
      if (docText) {
        const fname = (m.payload as any)?.document?.filename ?? "documento";
        content = `[El cliente envió un documento llamado "${fname}". Su contenido en texto es:\n${docText}]`;
      }
    }
    if (isHuman) {
      const who = (m.authorUserId && humanNames.get(m.authorUserId)) || "un compañero del equipo";
      content = `[${who} (humano del equipo, escribiéndole al cliente): ${content}]`;
    }
    const msg: AIChatMessage = {
      role: m.direction === "INBOUND" ? "user" : "assistant",
      content,
    };
    const recent = i >= windowMessages.length - IMAGE_WINDOW;
    if (visionToken && m.type === "IMAGE" && m.direction === "INBOUND" && recent && imagesUsed < MAX_IMAGES) {
      const mediaId = (m.payload as any)?.image?.id ?? (m.payload as any)?.id;
      if (mediaId) {
        const { downloadWhatsappImage } = await import("./media.js");
        const img = await downloadWhatsappImage(String(mediaId), visionToken);
        if (img) {
          msg.images = [{ mimeType: img.mimeType, dataBase64: img.dataBase64 }];
          if (!m.body) msg.content = "[el contacto envió una imagen]";
          imagesUsed++;
        }
      }
    }
    history.push(msg);
  }
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length) return;
  // En una DERIVACIÓN (re-ejecución del agente destino, depth>0) el historial termina en los
  // mensajes del agente que derivó (assistant): el destino no tendría a qué responder y
  // devolvería vacío → se quedaría MUDO. Recortamos los assistant finales para que responda
  // al ÚLTIMO mensaje del cliente y tome la conversación de inmediato.
  if (depth > 0) {
    while (history.length && history[history.length - 1].role !== "user") history.pop();
    if (!history.length) return;
  }

  // Indicaciones del equipo para ESTA conversación: las del panel derecho de la Bandeja
  // + los comentarios internos dirigidos al bot (los que empiezan con @bot / @ia). Así el
  // equipo puede darle feedback inline en el hilo y el agente lo sigue con prioridad.
  const { buildConversationInstructions, getActiveConversationInstructions, getMarkedInternalNotes } = await import("./ai-notes.js");
  const [panelNotes, markedNotes] = await Promise.all([
    getActiveConversationInstructions(organizationId, conversationId),
    getMarkedInternalNotes(organizationId, conversationId),
  ]);
  const aiNotes = [...panelNotes, ...markedNotes];

  // Ficha viva del contacto: memoria compartida entre agentes/conversaciones. Se
  // recuerda semánticamente respecto del último mensaje del cliente (o por recencia).
  const { recallContactMemory, formatMemoryForPrompt } = await import("./contact-memory.js");
  const lastUserText = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const contactMemoryBlock = formatMemoryForPrompt(
    await recallContactMemory(organizationId, conversation.contactId, lastUserText),
  );

  // Datos YA guardados del contacto: se reinyectan SIEMPRE para que el bot no
  // vuelva a preguntar lo que ya sabe (email, apellido, y el perfil de negocio
  // que se guarda en contact.attributes.profile). Saneado (sin saltos/llaves).
  const knownContactBlock = buildKnownContactBlock(conversation.contact);

  // Cita próxima del contacto: si YA tiene hora, CUALQUIER agente (incluidos los de ventas)
  // debe reconocerla y NO tratarlo como paciente nuevo (no pedir nombre, no mandar link de
  // agendar). Caso Marcia/Pamela: pacientes CON hora que escribieron y el agente comercial las
  // trató como leads nuevos ("necesito tu nombre" + link), generando confusión y reclamos.
  const cidForAppt = conversation.contactId;
  const upcomingAppointmentBlock = cidForAppt
    ? await withTenant(organizationId, async (tx) => {
        const appt = await tx.appointment.findFirst({
          where: { contactId: cidForAppt, startsAt: { gte: new Date() }, status: { in: ["PENDING", "CONFIRMED", "RESCHEDULED"] } },
          orderBy: { startsAt: "asc" },
        });
        if (!appt) return "";
        const m = (appt.meta as Record<string, unknown> | null) ?? {};
        const tz = appt.timezone || "America/Santiago";
        const cuando = appt.startsAt.toLocaleString("es-CL", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: tz });
        const prof = typeof m.professionalName === "string" ? ` con ${m.professionalName}` : "";
        return (
          `\n\n## ⚠️ Este paciente YA tiene una hora agendada\n` +
          `Tiene una cita el ${cuando}${prof} (estado: ${String(appt.status).toLowerCase()}). ` +
          `NO lo trates como paciente nuevo: no le pidas nombre ni datos ni le mandes un link para agendar. ` +
          `Si escribe sobre su hora (confirmarla, cambiarla, reagendar o dice que no puede asistir), ayúdalo con ESA cita ` +
          `(confírmala, o reagéndala con su MISMO profesional) o, si no manejas agenda, deriva al agente de Agendamiento. ` +
          `Solo si pide EXPLÍCITAMENTE una cita ADICIONAL y distinta, procede a agendar una nueva.`
        );
      })
    : "";

  // Montaje asistido: si este contacto YA vinculó su cuenta (grant activo 14 días), se
  // inyecta un bloque que le dice al agente que NO vuelva a pedir el código. Sin esto el
  // vínculo solo se veía dentro de una tool y el agente re-pedía el código en cada turno.
  const assistedSetupBlock = await buildAssistedSetupStatusBlock(organizationId, conversation.contactId);

  // Instrucciones de COBRO del tenant (settings.charging.instructions): se inyectan si el
  // agente tiene habilitado el link de pago, para guiar el momento del cobro.
  const agentTools = Array.isArray(version.tools) ? (version.tools as string[]) : [];
  const chargingCfg = (orgSettings.charging ?? {}) as { instructions?: string };
  const chargingBlock =
    agentTools.includes("enviarLinkDePago") && chargingCfg.instructions?.trim()
      ? `\n\n## Cobros (link de pago) — indicaciones del negocio\n${chargingCfg.instructions.trim()}`
      : "";

  // Fecha/hora REALES (zona de Chile). Sin esto el modelo usa la fecha de su entrenamiento
  // (equivocada) y falla al interpretar "hoy/mañana/esta semana" o al nombrar los días.
  const nowChile = new Intl.DateTimeFormat("es-CL", {
    timeZone: "America/Santiago",
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
  // Los agentes SIN herramientas de agenda no pueden saber la disponibilidad: se les
  // PROHÍBE hablar de horas/feriados (caso Yarilda: RESP IMPLANTES inventó "no hay el
  // 16", "el 18 es feriado" sin poder consultar). Con tools, las reglas estrictas.
  // version.tools es Json de Prisma (no string[]): normalizar antes de consultar.
  const hasAgenda = Array.isArray(version.tools) && (version.tools as unknown[]).map(String).includes("getAvailability");
  const schedulingRules = hasAgenda
    ? `\n\n## Reglas ESTRICTAS de agendamiento (OBLIGATORIAS)\n` +
    `- Solo puedes ofrecer horarios que getAvailability devolvió EXACTAMENTE (copia su campo "cuando" tal cual). PROHIBIDO mencionar cualquier otra hora, extrapolar ("también a las 18:15") o suponer horarios de atención.\n` +
    `- Si el paciente pide una hora que no está en la lista, di que esa hora no está disponible y ofrece las reales de getAvailability.\n` +
    `- NO afirmes feriados, cierres ni horarios de la clínica que no te consten: consulta getAvailability y responde según lo que devuelva.\n` +
    `- TELÉFONO: en WhatsApp NUNCA lo pidas (ya se usa el número del chat). En Instagram/Messenger el contacto puede NO tener número: si createAppointment responde que falta, pídeselo UNA sola vez y vuelve a llamar createAppointment pasándolo en el campo telefono (se guarda solo).\n` +
    `- FRANJAS: para la clínica "mañana" = 09:00–13:59 (SÍ: 12:45 y 13:15 SON mañana) y "tarde" = desde las 14:00. Si el paciente pide mañana o tarde, pasa el parámetro franja a getAvailability. NUNCA contradigas la franja de la tool: si pediste franja=manana y devolvió horas, esas horas SON de mañana — ofrécelas como tal, aunque a ti te parezcan de otra franja. Si la tool responde sinCupos, eso aplica SOLO al rango consultado: ofrece la otra franja u otro rango; JAMÁS afirmes que no hay cupos "hasta" una fecha que no consultaste. Si la respuesta trae "nota", síguela al pie de la letra.\n` +
    `- Si el paciente pide un día o semana DISTINTOS a los de la última lista, vuelve a llamar getAvailability con fromDate/toDate de ESE día antes de ofrecer o agendar. Los ids solo sirven para la ÚLTIMA lista mostrada.\n` +
    `- INSISTE antes de derivar (tu objetivo es dejar UNA hora cerrada, no pasar el caso a recepción): si al paciente no le acomodan las horas o pide otro día/semana, NO escales todavía — vuelve a llamar getAvailability con fromDate de ese período y, si hace falta, de las semanas siguientes (prueba hasta ~4 semanas hacia adelante) y ofrécele siempre las opciones REALES más cercanas a lo que pide. Varias rondas de búsqueda están bien.\n` +
    `- Deriva a una persona (transferToHuman/assignConversation) SOLO como ÚLTIMO recurso: cuando getAvailability no devuelva NINGÚN cupo con su profesional en las próximas ~4 semanas, o el paciente pida expresamente hablar con alguien, o esté molesto, o sea un tema fuera de agenda. NO escales solo porque la primera lista no le acomodó o porque pidió una fecha que aún no consultaste.\n` +
    `- Si el paciente da una fecha confusa, ambigua o ya pasada (p. ej. "después del 30 de septiembre" cuando esa fecha ya pasó), NO escales: pregúntale brevemente para qué día o semana quiere y consulta getAvailability para ese período.\n` +
    `- NUNCA afirmes que un día concreto NO tiene horas sin haber llamado getAvailability con fromDate=ESE día. Si el paciente nombra un día (p. ej. "el viernes", "el 16"), tu PRIMERA acción es consultar getAvailability para ese día; la lista general solo trae algunas opciones cercanas y puede no incluir el día que pide aunque sí tenga cupos.\n` +
    `- DÍAS DE LA SEMANA: si el paciente nombra uno o varios días de la semana (p. ej. "jueves o viernes", "el lunes"), NO calcules tú la fecha (te equivocas): pásalos en el parámetro diasSemana de getAvailability como lista en minúsculas sin tildes (ej. ["jueves","viernes"], ["lunes"]). El sistema resuelve las fechas reales correctas y te devuelve solo esos días.\n` +
    `- HORA PEDIDA ("después de las 18", "más tarde de las 10", "antes de las 12"): llama getAvailability igual (no hace falta que calcules nada; el sistema lee la condición del mensaje del paciente y te devuelve SOLO las horas que la cumplen). Luego OFRÉCELAS TODAS. PROHIBIDO responder "solo tengo las 09:15" o "no hay disponibilidad a esa hora" si la lista trae horas que cumplen — nómbralas.\n` +
    `- SIEMPRE EN POSITIVO Y VENDIENDO: tu meta es que el paciente reserve. Nunca cierres puertas ni le lleves la contra. Si lo que pidió exacto no está, ofrécele de inmediato la alternativa real más cercana ("para ese día tengo a las 13:15 y 14:15, ¿te sirve alguna?") en vez de un "no". Ofrece TODAS las horas que getAvailability devolvió; jamás inventes un "no hay" cuando sí hay.\n` +
    `- CANCELA / NO PUEDE / QUIERE REAGENDAR SIN DECIR CUÁNDO: si el paciente dice que no puede, no asistirá, o quiere cambiar su hora pero NO te dice para cuándo, tu PRIMERA respuesta es PREGUNTARLE con calidez para qué día u horario le gustaría reagendar (ej. "¡claro! ¿para qué día te acomoda?"). NO busques disponibilidad ni ofrezcas/niegues fechas antes de saber qué quiere. Recién cuando te diga el período, consulta getAvailability para eso.\n` +
    `- Si la hora más próxima que hay está LEJOS de hoy, NO respondas "no hay disponibilidad hasta [fecha]" y derives: ofrécela igual en positivo ("la más cercana que tengo con el Dr. X es el ..., ¿te sirve o prefieres que recepción te busque algo antes?"). Deriva a una persona SOLO si no hay NINGÚN cupo con su profesional en varias semanas, o si el paciente lo pide.\n` +
    `- El id de cada horario codifica día y hora (h0409-1015 = día 04-09 a las 10:15). Al agendar, usa el id cuya hora coincide EXACTAMENTE con la que eligió el paciente; jamás uses otro.\n` +
    `- Al ofrecer horarios, muestra las horas tal cual ("09:15", "10:15"), NUNCA numeres las opciones (1, 2, 3) — numerar causa confusiones al elegir.\n` +
    `- Agenda UNA sola cita por conversación: elige el horario con el paciente y llama a createAppointment UNA vez. Si responde alreadyBooked, la cita YA existe: confírmala, no crees otra.\n` +
    `- Al confirmar la cita, usa EXACTAMENTE el campo "cuando" que devolvió createAppointment (esa es la fecha/hora real agendada). Si no coincide con lo que pidió el paciente, discúlpate y corrige; jamás anuncies otra fecha.`
    : `\n\n## SIN ACCESO A LA AGENDA (OBLIGATORIO)\n` +
      `Este agente NO tiene herramientas de agenda: NO puedes saber qué horas hay disponibles, qué días se atiende, ni si un día es feriado. ` +
      `PROHIBIDO afirmar O NEGAR disponibilidad ("no hay horas el 16", "el 18 atendemos/no atendemos", "te ofrezco el lunes 21") — todo eso sería inventado. ` +
      `Si el paciente quiere agendar, reagendar o pregunta por horarios: deriva la conversación (assignConversation al agente/equipo que agenda) o dile que el equipo le confirmará el horario a la brevedad. Nada más.`;
  // Calendario de los próximos 14 días: el modelo se equivocaba mapeando día de
  // semana → fecha ("el martes" → consultó el sábado 12). Con la tabla no calcula nada.
  const dayFmt = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", weekday: "long", day: "numeric", month: "long" });
  const calendario14 = Array.from({ length: 14 }, (_, i) => dayFmt.format(new Date(Date.now() + i * 86_400_000))).join(" · ");
  const currentDateBlock =
    `\n\n## Fecha y hora actual (ÚSALA SIEMPRE)\nHoy es ${nowChile} (hora de Chile). ` +
    `Interpreta "hoy", "mañana", "pasado mañana", "el lunes", "esta semana" con ESTA fecha real. ` +
    `Al ofrecer o confirmar horarios, nombra el día de la semana y la fecha correctos. Nunca asumas otra fecha.\n` +
    `CALENDARIO de los próximos 14 días — USA ESTA TABLA para convertir día de semana → fecha (JAMÁS lo calcules tú): ${calendario14}.` +
    schedulingRules;

  // Si hubo intervención humana, se le explica al modelo cómo tratar esos mensajes:
  // son acuerdos ya cerrados con el cliente, hay que respetarlos y continuar desde ahí.
  const humanHandoffNote = humanIntervened
    ? "\n\n## Intervención del equipo humano en este chat (IMPORTANTE)\n" +
      "Algunos mensajes del historial los envió un COMPAÑERO HUMANO del equipo (van prefijados con su nombre, p. ej. «[Javier (humano del equipo...): ...]»). " +
      "Trátalos como decisiones y ACUERDOS ya tomados con el cliente: respétalos, NO los contradigas ni vuelvas a proponer algo distinto, y CONTINÚA desde lo que quedó acordado. " +
      "Si el cliente dice «esto lo vimos con Javier» o similar, es real: guíate por esos mensajes humanos. Nunca copies ese prefijo en tus propias respuestas."
    : "";

  const cfg = (version.config ?? {}) as Record<string, any>;
  // El modelo, el tope de tokens y las rondas de tools son de TODA la plataforma
  // del tenant y los fija el Super Admin (org.settings.ai). El tenant no los toca.
  const aiCfg = (orgSettings.ai ?? {}) as Record<string, any>;
  // V2-1 — guardrail económico: solo en planes V2 (conversationDebitsWallet). Tras 12
  // respuestas/conversación/día, inyecta modo conciso (no cambia TuBot/V1).
  const isV2Credit = await planDebitsConversation(organizationId).catch(() => false);
  const guardrailBlock = isV2Credit ? await guardrailInstruction(conversationId).catch(() => "") : "";
  const runtime: AgentRuntime = {
    agentId: agent.id,
    agentVersionId: version.id,
    slug: agent.slug,
    name: agent.name,
    // Prompt base + instrucciones NL de cada acción + objetivo puntual del flujo.
    systemPrompt:
      assembleSystemPrompt(version.systemPrompt, cfg.actions) +
      currentDateBlock +
      buildConversationInstructions(aiNotes) +
      humanHandoffNote +
      contactMemoryBlock +
      knownContactBlock +
      upcomingAppointmentBlock +
      assistedSetupBlock +
      chargingBlock +
      guardrailBlock +
      (opts.objective ? `\n\n## Objetivo inmediato para esta conversación\n${opts.objective}` : ""),
    // Modelo: override POR-AGENTE (config de la versión, lo fija el Super Admin
    // por agente) → modelo del tenant (org.settings.ai) → default de plataforma
    // (gpt-4o-mini). Así se pone Opus solo en los agentes que lo valen (p. ej.
    // implementación) y los económicos (ventas/soporte) no gastan de más.
    model: (typeof cfg.model === "string" && cfg.model) || aiCfg.model || getEnv().AI_DEFAULT_MODEL,
    maxTokens: aiCfg.maxTokens ?? 400,
    maxToolRounds: aiCfg.maxToolRounds ?? 5,
    tools: Array.isArray(version.tools) ? (version.tools as string[]) : [],
  };

  const services = await buildToolServices(
    organizationId,
    {
      conversationId,
      contactId: conversation.contactId,
      clinicId: conversation.clinicId,
      agentId: agent.id,
    },
    {
      knowledgeSources: Array.isArray(cfg.knowledgeSources) ? (cfg.knowledgeSources as string[]) : null,
      allowedProfessionalIds: Array.isArray(cfg.scheduling?.professionalIds) ? (cfg.scheduling.professionalIds as string[]) : null,
      appointmentDurationMin: typeof cfg.scheduling?.appointmentDurationMin === "number" ? (cfg.scheduling.appointmentDurationMin as number) : null,
    },
  );
  // MODO DUEÑO (F8): habilita las tools de administración (ownerOnly). La identidad sale
  // del canal de WhatsApp y de ESTA organización — ver `resolveOwnerContext` (§2.1, §7.5).
  // Si no se puede resolver, queda en false (cliente final) — nunca abre por defecto.
  let ownerContext = false;
  try {
    ownerContext = await withTenant(organizationId, (tx) =>
      resolveOwnerContext(tx as unknown as OwnerCtxTx, {
        organizationId,
        contactId: conversation.contactId,
        channelConnectionId: conversation.channelConnectionId,
      }),
    );
  } catch {
    ownerContext = false;
  }

  const toolCtx: ToolContext = {
    organizationId,
    clinicId: conversation.clinicId,
    conversationId,
    contactId: conversation.contactId,
    agentId: agent.id,
    agentName: agent.name,
    brandName: brandOf(org).name,
    agentVersionId: version.id,
    ownerContext,
    lastUserText,
    services: services as unknown as Record<string, unknown>,
  };

  const vars: Record<string, string> = {
    "organization.name": org?.name ?? "",
    "clinic.name": clinic?.name ?? "",
    "clinic.city": clinic?.city ?? "",
    "clinic.address": clinic?.address ?? "",
    "contact.firstName": conversation.contact.firstName ?? "",
    "agent.name": agent.name,
  };

  // 3. Orquestar (modelo + loop de tools). MODO DEGRADADO: si el proveedor de IA
  // falla incluso tras los reintentos+fallback de la capa resiliente, el cliente
  // NO queda en silencio — recibe un mensaje humano honesto y se avisa al equipo.
  let result: OrchestrateResult;
  try {
    result = await orchestrate(ai, registry, { ctx: toolCtx, agent: runtime, history, vars });
  } catch (err) {
    console.error(`✖ IA no disponible tras reintentos (${conversationId}):`, (err as Error).message);
    result = {
      reply:
        "Perdona, estoy teniendo un problema técnico para procesarte bien en este momento 🙏. Ya avisé al equipo para que te ayude enseguida. Si es urgente, cuéntame y lo derivo de inmediato.",
      toolEvents: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      latencyMs: 0,
      stopReason: "error",
    };
    // Alerta al equipo (best-effort). La IA sigue habilitada: si el fallo era
    // transitorio, el próximo turno se recupera solo; el aviso permite intervenir.
    try {
      const contactName =
        [conversation.contact.firstName].filter(Boolean).join(" ") || conversation.contact.phone || "Un contacto";
      const { enqueueNotification } = await import("./notifications/queue.js");
      await enqueueNotification({
        eventKey: "ai.escalation",
        organizationId,
        conversationId,
        context: { conversationId },
        data: { contactName, reason: "IA no disponible (fallo del proveedor)", conversationId },
      });
    } catch (e) {
      console.error(`✖ Aviso de degradación (${conversationId}):`, (e as Error).message);
    }
  }

  // Vigilancia de salud del router: ¿el proveedor que respondió es el del modelo
  // configurado, o el router cayó en silencio a otro (llave muerta)? Si degradó, marca
  // Redis (→ /health/status 503 → alerta) y avisa una vez. Best-effort, no bloquea el
  // turno (en el camino de error la respuesta no trae provider → se ignora sola).
  void observeTurnModel({
    organizationId,
    configuredModel: runtime.model,
    respondedModel: result.model,
    respondedProvider: result.provider,
  });

  // 4. Persistir trazabilidad + respuesta.
  // Guarda E4 (una respuesta por turno): tope configurable por invocación de turno.
  // La transferencia entre agentes es OTRA invocación (depth 1), así que no se ve
  // afectada. Hoy el orquestador devuelve UN reply y aquí se crea UN message; el
  // contador es el cinturón que delata cualquier 2.º message del agente en el futuro.
  const maxAgentMessagesPerTurn = await readMaxAgentMessagesPerTurn();
  let agentTextCreated = 0;
  // CRE 1 — sella el débito de Créditos IA: es el id del ai_requests de ESTE turno, así
  // un reintento del job no vuelve a cobrar la misma respuesta.
  let turnId: string | null = null;
  const persisted = await withTenant(organizationId, async (tx) => {
    const aiRequest = await tx.aiRequest.create({
      data: {
        organizationId,
        agentId: agent.id,
        agentVersionId: version.id,
        conversationId,
        // Modelo/proveedor que REALMENTE respondió (no la etiqueta configurada): si el router
        // cae a un modelo compatible del proveedor disponible —p. ej. gpt-* → claude-haiku-4-5
        // cuando OpenAI no está— la fila debe reflejar ESE, o el costo no calza con el modelo.
        provider: result.provider ?? ai.kind,
        model: result.model ?? runtime.model,
        // Y el que estaba CONFIGURADO, que es con el que se cobra cuando es más barato (§6):
        // el respaldo lo pagamos nosotros. Sin guardarlo acá, un turno recuperado por la
        // reconciliación se cobraría con el peso del respaldo.
        configuredModel: runtime.model,
        purpose: "CHAT",
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        costUsd: result.usage.costUsd,
        latencyMs: result.latencyMs,
        status: result.stopReason === "refusal" ? "refusal" : result.stopReason === "error" ? "error" : "ok",
      },
    });
    await tx.usageEvent.create({
      data: {
        organizationId,
        type: "ai_tokens",
        quantity: result.usage.inputTokens + result.usage.outputTokens,
        costUsd: result.usage.costUsd,
        meta: { conversationId, agentSlug: agent.slug, toolCalls: result.toolEvents.map((e) => e.name) },
      },
    });
    turnId = aiRequest.id;

    if (!result.reply) return null;
    // ÚNICO punto de creación del message de texto del agente (una respuesta por
    // turno, E4). Un texto adicional del agente en el mismo turno debe FUSIONARSE al
    // body con mergeAgentTextParts (ver agent-turn-guard.ts), nunca crear un 2.º message.
    const message = await tx.message.create({
      data: {
        organizationId,
        conversationId,
        direction: "OUTBOUND",
        type: "TEXT",
        body: result.reply,
        authorType: "AGENT",
        agentId: agent.id,
        agentVersionId: version.id,
        aiRequestId: aiRequest.id,
        status: "PENDING",
        payload: { toolEvents: result.toolEvents as object[] },
      },
    });
    agentTextCreated++;
    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: result.reply.slice(0, 120),
        activeAgentId: agent.id,
      },
    });
    return message;
  });

  // CRE 1 — DÉBITO REAL de Créditos IA, con los tokens que de verdad usó el turno (todas
  // las llamadas: respuesta, rondas de herramientas y clasificación) y el modelo que
  // efectivamente respondió. Va después de persistir porque necesita el id del turno para
  // ser idempotente, y nunca frena la respuesta: si el cobro falla, el cliente igual
  // recibe su mensaje y el próximo turno vuelve a intentar el gate.
  if (creditGate.charges && turnId) {
    await debitAiCreditsForTurn(organizationId, {
      conversationId,
      turnId,
      // El modelo que RESPONDIÓ (ver TurnUsage.model): la excepción "modelo sin peso" se
      // calcula con el modelo real, no con la etiqueta configurada.
      model: result.model ?? runtime.model,
      // Y el configurado, para cobrar el peso MENOR de los dos (§6): si el router cayó al
      // respaldo porque el proveedor configurado no está, el sobrecosto es nuestro.
      configuredModel: runtime.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: result.usage.costUsd,
      agentId: agent.id,
    }).catch((err) => {
      console.error(`✖ Débito de Créditos IA (${conversationId}):`, (err as Error).message);
      return undefined;
    });

    // CRE 3 — AVISOS de saldo (75%, 90% y gracia), una vez por umbral y período.
    //
    // Antes de esto un cliente de Créditos IA no recibía NINGÚN aviso: los avisos vivían
    // solo en el camino del cobro por conversación, y CRE 1 desactivó ese camino para los
    // planes de créditos (correcto, para no cobrar dos veces). Resultado: el bot se le
    // paraba sin una sola advertencia previa. El aviso lleva el ESTIMADO —"te quedan ≈ N
    // conversaciones"— porque "te queda el 10% de tus créditos" no le dice nada a nadie.
    const aviso = await aiCreditsNotifyDecision(organizationId).catch(() => null);
    if (aviso?.fire) {
      const medidor = await getAiCreditsMeter(organizationId).catch(() => null);
      const pct = aviso.included > 0 ? Math.round((aviso.used / aviso.included) * 100) : 0;
      const { enqueueNotification } = await import("./notifications/queue.js");
      await enqueueNotification({
        eventKey: aviso.fire === "grace" ? "credits.grace" : "credits.low",
        organizationId,
        data:
          aviso.fire === "grace"
            ? { grace: aviso.graceUsed, restantes: aviso.remaining, estimado: medidor?.frase ?? "" }
            : { pct, used: aviso.used, included: aviso.included, restantes: aviso.remaining, estimado: medidor?.frase ?? "" },
      }).catch(() => undefined);
    }
  }

  // COP 4 — SEÑAL "BOT ACTIVO" hacia Meta Ads. Se dispara cuando el bot respondió de
  // verdad, que es el momento en que el producto sirve (no cuando se creó la cuenta ni
  // cuando se conectó el número). Idempotente por organización y APAGADA por bandera:
  // `FUNNEL_CAPI_ENABLED` nace en false porque mandarle eventos a Meta es irreversible.
  // Nunca lanza: una señal de marketing no puede tumbar la respuesta de un cliente.
  if (agentTextCreated > 0) {
    await informarHitoCapi(organizationId, "bot_activo", { contactId: conversation?.contactId ?? null }).catch(() => undefined);
  }

  // Cinturón E4: si alguna vez se creara más de un message de texto del agente en el
  // turno (hoy imposible: punto único), delátalo en vez de gastar envíos en silencio.
  if (agentTextCreated > maxAgentMessagesPerTurn) {
    console.warn(
      `⚠ agent-turn: ${agentTextCreated} mensajes del agente en un turno supera el tope ${maxAgentMessagesPerTurn} (${conversationId}) — deberían fusionarse en uno`,
    );
  }

  // Bandeja en vivo: la respuesta del agente aparece al instante en el panel.
  if (persisted) {
    const { publishRealtime } = await import("./realtime.js");
    await publishRealtime(organizationId, { type: "message.created", conversationId });
  }

  // V2-5 COPILOTO: en modo "suggest" el bot NO envía — deja la respuesta como BORRADOR
  // (status SUGGESTED) para que el dueño la apruebe/edite/descarte en la bandeja. Default "auto"
  // (envía, como siempre): ni TuBot ni las orgs existentes cambian salvo que activen suggest.
  const suggestMode = persisted && ((orgSettings?.conversia as Record<string, any> | undefined)?.aiMode === "suggest");
  if (suggestMode && persisted) {
    await withTenant(organizationId, (tx) => tx.message.update({ where: { id: persisted.id }, data: { status: "SUGGESTED" } }));
    await emitPlatformEvent(organizationId, "message.suggested", { conversationId, text: (persisted.body ?? "").slice(0, 200) }).catch(() => undefined);
  }

  // 5. Enviar por el canal. Contactos SIN teléfono (Messenger/IG) van por la
  // mensajería de página; si el canal no es de redes, no hay a dónde enviar.
  if (persisted && !suggestMode && !conversation.contact.phone) {
    const { trySendMessagingReply } = await import("./messaging-send.js");
    await trySendMessagingReply(organizationId, conversationId, persisted.id, persisted.body ?? "").catch((err) =>
      console.error(`✖ Envío de mensajería (${conversationId}):`, (err as Error).message),
    );
  }
  // (token por-WABA del tenant; fallback al global)
  if (persisted && !suggestMode && conversation.contact.phone) {
    const auth = await resolveChannelAuth(organizationId, { channelConnectionId: conversation.channelConnectionId });
    // Gate de servicio (E3): cuenta la conversación en su período y aplica cupo/topes/
    // fusible ANTES de enviar. Si bloquea (tope duro o fusible), el mensaje queda FAILED
    // y NO se llama a Graph ni se mide service_send.
    const svcGate = await chargeServiceSend(organizationId, conversationId, { messageId: persisted.id, phoneNumberId: auth.phoneNumberId });
    // V2-1: si se agotó la gracia de conversaciones, el bot NO queda mudo: envía la frase de
    // respaldo (en lugar de la respuesta de IA) y deriva a un humano (abajo). Otros bloqueos
    // (tope duro, fusible) sí dejan el mensaje FAILED como antes.
    const graceFallback = svcGate.blocked && svcGate.reason === "no_conversation_credits";
    if (svcGate.blocked && !graceFallback) {
      await withTenant(organizationId, (tx) =>
        tx.message.update({ where: { id: persisted.id }, data: { status: "FAILED", error: svcGate.userMessage } }),
      );
    } else {
      if (graceFallback && svcGate.blocked) {
        await withTenant(organizationId, (tx) => tx.message.update({ where: { id: persisted.id }, data: { body: svcGate.userMessage } }));
        persisted.body = svcGate.userMessage;
      }
    // Envío con REINTENTO ante fallos transitorios de Meta (red/5xx/429): un blip no
    // puede perder la respuesta ya generada. Los errores de config (auth) NO se
    // reintentan (no se arreglan solos). Antes: 1 intento → mensaje perdido.
    const MAX_SEND_ATTEMPTS = 3;
    let sent: Awaited<ReturnType<ReturnType<typeof getChannelProvider>["send"]>> | undefined;
    let sendErr: unknown;
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
      try {
        sent = await getChannelProvider().send(
          auth.phoneNumberId,
          { to: conversation.contact.phone, type: "text", text: persisted.body ?? "" },
          { accessToken: auth.accessToken },
        );
        sendErr = undefined;
        break;
      } catch (err) {
        sendErr = err;
        if (err instanceof ChannelAuthError) break; // config: no reintentar
        if (attempt < MAX_SEND_ATTEMPTS) await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
    if (sent) {
      await withTenant(organizationId, (tx) =>
        tx.message.update({
          where: { id: persisted.id },
          data: { status: "SENT", externalId: sent!.externalId, sentAt: new Date() },
        }),
      );
      await emitPlatformEvent(organizationId, "message.sent", {
        conversationId,
        agentSlug: agent.slug,
        text: (persisted.body ?? "").slice(0, 200),
      });
      // Medición del mensaje de servicio (E2): rastro + costo estimado. No frena nada.
      await recordServiceSend(organizationId, persisted.id, conversationId, conversation.contact.phone, auth.phoneNumberId);
      // V2-1 — guardrail económico: cuenta esta respuesta del bot (día local) para el tope blando.
      if (isV2Credit && !graceFallback) await bumpResponseGuardrail(conversationId).catch(() => undefined);
    } else {
      if (sendErr instanceof ChannelAuthError) {
        await markChannelAuthError(organizationId, auth.channelConnectionId, sendErr.message, { phone: auth.phoneNumberId, source: "send" });
      }
      const failText = sendErr instanceof ChannelAuthError ? sendErr.userMessage : (sendErr as Error).message.slice(0, 500);
      await withTenant(organizationId, (tx) =>
        tx.message.update({
          where: { id: persisted.id },
          data: { status: "FAILED", error: failText },
        }),
      );
      console.error(`✖ Envío WhatsApp falló tras ${MAX_SEND_ATTEMPTS} intentos (${conversationId}):`, (sendErr as Error).message);
      // W-2 (F5-B): si el plan debitó un crédito de servicio por este mensaje, devuélvelo
      // (idempotente; no-op si no hubo débito, p. ej. TuBot).
      await refundForMessage(organizationId, persisted.id).catch(() => undefined);
    }
    // V2-1: gracia agotada → deriva a un humano (apaga la IA de la conversación + alerta),
    // tras enviar la frase de respaldo. "El bot sugiere, el humano toma" hasta recargar.
    if (graceFallback) {
      await withTenant(organizationId, (tx) =>
        tx.conversation.update({ where: { id: conversationId }, data: { aiEnabled: false } }),
      ).catch(() => undefined);
      const { enqueueNotification } = await import("./notifications/queue.js");
      await enqueueNotification({
        eventKey: "ai.escalation",
        organizationId,
        data: { conversationId, contactName: conversation.contact.phone ?? "cliente", reason: "Sin créditos de conversación (recarga para reanudar la IA)" },
      }).catch(() => undefined);
    }
    } // fin del envío (gate de servicio no bloqueó)
  }

  // 6. Transferencia entre agentes (conserva contexto, registra evento).
  //    El destino puede venir por dos caminos: la tool `transferToAgent` (el orquestador
  //    setea transferToAgentSlug) o `assignConversation` con un destino que resultó ser un
  //    AGENTE (la tool devuelve el marcador handoffToAgentSlug sin tocar la conversación).
  //    En ambos, resolvemos por NOMBRE o SLUG (insensible a mayúsculas/acentos/guiones): los
  //    prompts usan el nombre visible ("@RESP IMPLANTES") y el registro es por slug.
  const rawTransferTarget = result.transferToAgentSlug ?? extractHandoffSlug(result.toolEvents);
  if (rawTransferTarget && depth < 1) {
    const outcome = await withTenant(organizationId, async (tx) => {
      const target = await resolveAgentByNameOrSlug(tx, rawTransferTarget, organizationId);
      if (!target || !target.active) return { kind: "notfound" as const };
      if (target.slug === agent.slug) return { kind: "self" as const };
      // Transferencia a otro agente de IA: la IA SIGUE respondiendo (no apagar aiEnabled).
      await tx.conversation.update({ where: { id: conversationId }, data: { activeAgentId: target.id, aiEnabled: true } });
      await tx.agentHandoff.create({
        data: {
          organizationId,
          conversationId,
          fromAgentId: agent.id,
          toAgentId: target.id,
          reason: "transferToAgent",
          contextSummary: result.reply?.slice(0, 500) ?? null,
        },
      });
      return { kind: "ok" as const, slug: target.slug };
    });

    if (outcome.kind === "ok") {
      // El agente NUEVO toma el turno DE INMEDIATO y continúa la conversación
      // (antes quedaba mudo esperando el próximo mensaje del contacto, y el
      // cliente —que ya fue anunciado con la derivación— no recibía nada).
      // depth+1 acota a un salto por turno (sin cadenas A→B→C en el mismo ciclo).
      await runAgentTurn({
        organizationId,
        conversationId,
        agentSlug: outcome.slug,
        depth: depth + 1,
        objective:
          "Acabas de RECIBIR esta conversación derivada desde otro agente. Preséntate en una sola línea breve y CONTINÚA de inmediato ayudando al cliente con lo último que pidió (su último mensaje). No repitas el saludo inicial ni digas que la conversación fue derivada.",
      }).catch((err) => console.error(`✖ Turno del agente derivado (${outcome.slug}) falló:`, (err as Error).message));
    } else if (outcome.kind === "notfound") {
      // El modelo intentó derivar a un agente que no existe (ya no puede pasar por nombre/slug,
      // pero por si inventa uno): deja un incidente VISIBLE en la Bandeja para que un humano
      // atienda al cliente que quedó a la espera.
      await withTenant(organizationId, (tx) =>
        tx.message.create({
          data: {
            organizationId,
            conversationId,
            direction: "OUTBOUND",
            type: "NOTE",
            visibility: "INTERNAL",
            body: `⚠ El bot intentó derivar a un agente llamado «${rawTransferTarget}» que no existe o está inactivo. El cliente NO fue derivado y quedó a la espera — requiere atención.`,
            authorType: "AGENT",
            status: "DELIVERED",
          },
        }).catch(() => undefined),
      );
    }
  }
}

export function getGlobalPrisma() {
  return getPrisma();
}
