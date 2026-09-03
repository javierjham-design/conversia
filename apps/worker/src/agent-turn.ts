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
import { getEnv } from "@conversia/config";
import { getPrisma, resolveAgentByNameOrSlug, withTenant } from "@conversia/database";
import type { AIChatMessage, ToolContext } from "@conversia/types";
import { ChannelAuthError, markChannelAuthError, resolveChannelAuth } from "./channel-auth";
import { getChannelProvider } from "./channel-providers";
import { emitPlatformEvent } from "./platform-events";
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

export async function runAgentTurn(opts: {
  organizationId: string;
  conversationId: string;
  agentSlug?: string;
  depth?: number;
  /** Objetivo puntual inyectado al prompt (nodo de workflow "Agente IA"). */
  objective?: string;
}): Promise<void> {
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
        : tx.clinic.findFirst({ where: { active: true } }),
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
    await withTenant(organizationId, (tx) =>
      tx.integrationEvent.create({
        data: {
          organizationId,
          provider: "ai",
          type: "ai.kill_switch",
          status: "warning",
          message: env.AI_GLOBAL_KILL_SWITCH ? "IA pausada globalmente" : "IA pausada por la organización",
        },
      }),
    );
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
      where: { status: { in: ["ACTIVE", "TRIALING"] } },
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
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const spent = await withTenant(organizationId, (tx) =>
      tx.usageEvent.aggregate({
        where: { type: "ai_tokens", occurredAt: { gte: startOfDay } },
        _sum: { quantity: true },
      }),
    );
    if (Number(spent._sum.quantity ?? 0) >= budget) {
      await withTenant(organizationId, (tx) =>
        tx.integrationEvent.create({
          data: {
            organizationId,
            provider: "ai",
            type: "ai.budget_exceeded",
            status: "warning",
            message: `Tope diario de tokens IA alcanzado (${env.AI_DAILY_TOKEN_BUDGET_PER_ORG})`,
          },
        }),
      );
      return;
    }
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
  const currentDateBlock =
    `\n\n## Fecha y hora actual (ÚSALA SIEMPRE)\nHoy es ${nowChile} (hora de Chile). ` +
    `Interpreta "hoy", "mañana", "pasado mañana", "el lunes", "esta semana" con ESTA fecha real. ` +
    `Al ofrecer o confirmar horarios, nombra el día de la semana y la fecha correctos. Nunca asumas otra fecha.` +
    `\n\n## Reglas ESTRICTAS de agendamiento (OBLIGATORIAS)\n` +
    `- Solo puedes ofrecer horarios que getAvailability devolvió EXACTAMENTE (copia su campo "cuando" tal cual). PROHIBIDO mencionar cualquier otra hora, extrapolar ("también a las 18:15") o suponer horarios de atención.\n` +
    `- Si el paciente pide una hora que no está en la lista, di que esa hora no está disponible y ofrece las reales de getAvailability.\n` +
    `- NO afirmes feriados, cierres ni horarios de la clínica que no te consten: consulta getAvailability y responde según lo que devuelva.\n` +
    `- NUNCA pidas el número de teléfono para agendar: ya se usa automáticamente el número de este chat.\n` +
    `- Agenda UNA sola cita por conversación: elige el horario con el paciente y llama a createAppointment UNA vez. Si responde alreadyBooked, la cita YA existe: confírmala, no crees otra.\n` +
    `- Tras agendar con éxito, SIEMPRE confirma al paciente día, fecha y hora exactos de la cita.`;

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
      assistedSetupBlock +
      chargingBlock +
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
    },
  );
  const toolCtx: ToolContext = {
    organizationId,
    clinicId: conversation.clinicId,
    conversationId,
    contactId: conversation.contactId,
    agentId: agent.id,
    agentName: agent.name,
    agentVersionId: version.id,
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

  // 4. Persistir trazabilidad + respuesta
  const persisted = await withTenant(organizationId, async (tx) => {
    const aiRequest = await tx.aiRequest.create({
      data: {
        organizationId,
        agentId: agent.id,
        agentVersionId: version.id,
        conversationId,
        provider: ai.kind,
        model: runtime.model,
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

    if (!result.reply) return null;
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

  // Bandeja en vivo: la respuesta del agente aparece al instante en el panel.
  if (persisted) {
    const { publishRealtime } = await import("./realtime.js");
    await publishRealtime(organizationId, { type: "message.created", conversationId });
  }

  // 5. Enviar por el canal. Contactos SIN teléfono (Messenger/IG) van por la
  // mensajería de página; si el canal no es de redes, no hay a dónde enviar.
  if (persisted && !conversation.contact.phone) {
    const { trySendMessagingReply } = await import("./messaging-send.js");
    await trySendMessagingReply(organizationId, conversationId, persisted.id, persisted.body ?? "").catch((err) =>
      console.error(`✖ Envío de mensajería (${conversationId}):`, (err as Error).message),
    );
  }
  // (token por-WABA del tenant; fallback al global)
  if (persisted && conversation.contact.phone) {
    const auth = await resolveChannelAuth(organizationId, { channelConnectionId: conversation.channelConnectionId });
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
    } else {
      if (sendErr instanceof ChannelAuthError) {
        await markChannelAuthError(organizationId, auth.channelConnectionId, sendErr.message);
      }
      await withTenant(organizationId, (tx) =>
        tx.message.update({
          where: { id: persisted.id },
          data: { status: "FAILED", error: (sendErr as Error).message.slice(0, 500) },
        }),
      );
      console.error(`✖ Envío WhatsApp falló tras ${MAX_SEND_ATTEMPTS} intentos (${conversationId}):`, (sendErr as Error).message);
    }
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
      const target = await resolveAgentByNameOrSlug(tx, rawTransferTarget);
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
