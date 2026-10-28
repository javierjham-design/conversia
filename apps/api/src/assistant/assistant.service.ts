import { Injectable } from "@nestjs/common";
import type { AIChatMessage, AIToolCall, AIToolResult, AIToolSpec, AssistantAction } from "@conversia/types";
import { getEnv } from "@conversia/config";
import { computeCostUsd, createAIProvider } from "@conversia/agents";
import { PrismaService } from "../prisma.service";
import { runQaBattery } from "../agents/agent-qa";
import { getSetupChecklist } from "../onboarding/setup-checklist";
import { sanitizeActions } from "./actions";
import { SETUP_TOOL_NAMES, isSetupWriteTool, runSetupTool, setupToolSpecs } from "./setup-tools";
import { packUnitForOrg } from "../billing/pack-unit";

/**
 * BLOQUE B — "Asistente Conversia": un chat in-app que LIDERA la implementación y da
 * asistencia. Corre el agente en el API (loop de herramientas propio, sin depender del
 * worker) con el CONTEXTO completo del cliente ya cargado. Las herramientas de ESCRITURA
 * solo se exponen con webOwnerContext (sesión web de owner/admin) — jamás a un viewer u
 * operador de soporte — y todo cambio queda auditado + dispara el auto-QA (V2-6).
 */

export type AssistantRole = string;
export interface AssistantCtx { organizationId: string; userId: string | null; role: AssistantRole }

/** webOwnerContext: el usuario autenticado es dueño/administrador de SU organización. */
export function isWebOwner(role: string): boolean {
  return role === "owner" || role === "admin";
}

/** Modo del asistente según el avance del checklist (pura, testeable). */
export function assistantMode(checklistPct: number): "implementacion" | "asistencia" {
  return checklistPct >= 100 ? "asistencia" : "implementacion";
}

/**
 * Elige un modelo COMPATIBLE con el proveedor configurado (pura, testeable). Hallazgo prod
 * 26-oct: `AI_DEFAULT_MODEL` trae un default de OpenAI ("gpt-4o-mini") en la config; si el
 * proveedor es Anthropic, mandar ESE modelo a Anthropic da 404 → el asistente caía al fallback.
 * Respetamos `AI_DEFAULT_MODEL` solo si pertenece a la familia del proveedor; si no, usamos el
 * default propio del proveedor. Así el asistente nunca manda un gpt-* a Anthropic (ni viceversa).
 */
export function resolveAssistantModel(provider: string, configuredModel: string): string {
  const isClaude = /^claude/i.test(configuredModel);
  const isOpenai = /^(gpt-|o[1-9]|chatgpt)/i.test(configuredModel);
  if (provider === "anthropic") return isClaude ? configuredModel : "claude-sonnet-4-6";
  if (provider === "openai") return isOpenai ? configuredModel : "gpt-4o-mini";
  return configuredModel; // mock u otro: el MockAIProvider ignora el modelo
}

type ThreadMsg = { author: "user" | "team" | "agent"; body: string; at: string };

@Injectable()
export class AssistantService {
  constructor(private prisma: PrismaService) {}

  /** Marca de la org (para gatear el asistente a conversia). Fail-safe a "tubot". */
  async orgBrand(organizationId: string): Promise<string> {
    const o = await this.prisma.admin.organization.findUnique({ where: { id: organizationId }, select: { brand: true } }).catch(() => null);
    return (o?.brand ?? "tubot").toLowerCase();
  }

  /**
   * Contexto server-side: checklist, saldo, último error de canal, datos del negocio.
   * `userId` (del JWT) solo decide de quién se mira el correo verificado — así el copiloto
   * y `GET /onboarding` ven EXACTAMENTE el mismo checklist, paso por paso.
   */
  async buildContext(organizationId: string, userId?: string | null) {
    const admin = this.prisma.admin;
    const org = await admin.organization.findUnique({ where: { id: organizationId }, select: { name: true, settings: true, currency: true } });

    // ETAPA 0 — CHECKLIST ÚNICO (apps/api/src/onboarding/setup-checklist.ts). Antes aquí
    // vivía un checklist PROPIO de 4 pasos que daba el asistente por listo con que EXISTIERA
    // y el WhatsApp por listo con que el canal estuviera conectado (hallazgos 1, 2 y 4 de la
    // auditoría): el copiloto cantaba 100% mientras el bot seguía en borrador y mudo. Ahora
    // lee lo MISMO que `/onboarding` y la UI: agente PUBLICADO, canal CON agente asignado,
    // prueba real respondida. El % cuenta solo los pasos bloqueantes.
    const checklist = await getSetupChecklist(this.prisma, organizationId, { userId, org });
    const { steps, percent: checklistPct, nextStep } = checklist;

    // Saldo (modelo por conversación) best-effort.
    let saldo: string | null = null;
    try {
      const sub = await admin.subscription.findFirst({ where: { organizationId, status: { in: ["ACTIVE", "TRIALING"] } }, orderBy: { createdAt: "desc" }, select: { planId: true } });
      const plan = sub?.planId ? await admin.plan.findUnique({ where: { id: sub.planId }, select: { features: true } }) : null;
      if ((plan?.features as any)?.conversationDebitsWallet === true) {
        const lots = await admin.conversationCreditLot.aggregate({ _sum: { remaining: true }, where: { organizationId, remaining: { gt: 0 }, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
        const w = await admin.conversationWallet.findUnique({ where: { organizationId }, select: { graceUsed: true } });
        saldo = `${(lots._sum.remaining ?? 0) - (w?.graceUsed ?? 0)} conversaciones disponibles`;
      }
    } catch { /* noop */ }

    // Último error de canal (para proactividad del Bloque A).
    const lastErr = await admin.integrationEvent.findFirst({
      where: { organizationId, provider: { in: ["whatsapp", "events", "funnel"] }, status: "error" },
      orderBy: { createdAt: "desc" }, select: { message: true, createdAt: true },
    }).catch(() => null);

    return {
      businessName: org?.name ?? "tu negocio",
      currency: org?.currency ?? "CLP",
      steps, checklistPct, nextStep, saldo,
      // "Paso 3 de 7": cuántos pasos BLOQUEANTES van (los opcionales no cuentan).
      blockingCompleted: checklist.blockingCompleted,
      blockingTotal: checklist.blockingTotal,
      lastChannelError: lastErr?.message ?? null,
      mode: assistantMode(checklistPct),
    };
  }

  /** Specs de herramientas; las de ESCRITURA solo con webOwnerContext. */
  private toolSpecs(owner: boolean): AIToolSpec[] {
    const read: AIToolSpec[] = [
      { name: "verEstado", description: "Devuelve el checklist de implementación, el siguiente paso pendiente y el saldo de conversaciones. Úsalo para liderar la implementación y responder '¿cuánto me queda?'.", inputJsonSchema: { type: "object", properties: {} } },
      { name: "listarServicios", description: "Lista los servicios del negocio con su precio y duración. Úsalo antes de crear o cambiar precios para no duplicar.", inputJsonSchema: { type: "object", properties: {} } },
      { name: "ofrecerRecarga", description: "Devuelve los packs de conversaciones y el link para comprarlos. El asistente NUNCA cobra; solo entrega el link.", inputJsonSchema: { type: "object", properties: {} } },
      { name: "escalarAHumano", description: "Crea un ticket de soporte para que una persona del equipo siga el caso. Úsalo cuando el usuario lo pida o no puedas resolver.", inputJsonSchema: { type: "object", properties: { motivo: { type: "string", description: "Resumen del caso" } }, required: ["motivo"] } },
    ];
    // COP 1 — el copiloto ACTÚA: a las de siempre se suman las herramientas de montaje
    // (datos del negocio, horario, agenda, armar/probar/publicar el asistente, diagnóstico
    // de WhatsApp, página del negocio) y las de acompañamiento, que navegan y resaltan.
    const setup = setupToolSpecs();
    if (!owner) return [...read, ...setup.read];
    const write: AIToolSpec[] = [
      { name: "crearServicio", description: "Crea un servicio nuevo del negocio (con precio y duración opcionales). Úsalo si el servicio no existe aún. CONFIRMA con el usuario antes de llamar.", inputJsonSchema: { type: "object", properties: { nombre: { type: "string" }, precio: { type: "number" }, duracionMin: { type: "number" } }, required: ["nombre"] } },
      { name: "configurarPrecioServicio", description: "Fija el PRECIO (y opcionalmente la duración en minutos) de un servicio EXISTENTE, buscándolo por nombre. Si no existe, usa crearServicio. CONFIRMA antes de llamar.", inputJsonSchema: { type: "object", properties: { servicio: { type: "string" }, precio: { type: "number" }, duracionMin: { type: "number" } }, required: ["servicio", "precio"] } },
    ];
    return [...read, ...setup.read, ...write, ...setup.write];
  }

  private async executeTool(
    ctx: AssistantCtx,
    name: string,
    input: any,
    route?: string,
  ): Promise<{ content: string; isError?: boolean; didWrite?: boolean; actions?: AssistantAction[] }> {
    const admin = this.prisma.admin;
    if (name === "verEstado") {
      const c = await this.buildContext(ctx.organizationId, ctx.userId);
      return {
        content: JSON.stringify({
          checklistPct: c.checklistPct,
          avance: `${c.blockingCompleted} de ${c.blockingTotal} pasos obligatorios`,
          siguientePaso: c.nextStep?.label ?? "todo listo",
          saldo: c.saldo ?? "no aplica",
          // Vista COMPACTA para el modelo (sin títulos/descripciones/CTA: gastan tokens).
          pasos: c.steps.map((s) => ({ paso: s.label, hecho: s.done, obligatorio: s.blocking, pantalla: s.href })),
        }),
      };
    }
    if (name === "listarServicios") {
      const list = await this.prisma.withTenant(ctx.organizationId, (tx) => tx.service.findMany({ where: { active: true }, orderBy: { name: "asc" }, take: 50, select: { name: true, price: true, durationMin: true } }));
      return { content: JSON.stringify({ servicios: list.map((s) => ({ nombre: s.name, precio: s.price != null ? `$${Number(s.price).toLocaleString("es-CL")}` : "sin precio", duracionMin: s.durationMin })) }) };
    }
    if (name === "ofrecerRecarga") {
      // CRE 2 — el asistente ofrece los packs de la unidad que cobra el plan del cliente, y
      // los nombra como son. Ofrecerle "conversaciones" a quien paga por Créditos IA sería
      // ofrecerle algo que no existe en su cuenta.
      const unit = await packUnitForOrg(ctx.organizationId);
      const [base, packs] = await Promise.all([
        admin.plan.findUnique({ where: { code: unit === "credit" ? "conversia_creditos_base" : "conversia_v2_base" }, select: { priceClp: true } }),
        admin.messagePackage.findMany({ where: { active: true, brand: "conversia", type: unit }, orderBy: { order: "asc" }, select: { name: true, credits: true, priceClp: true } }),
      ]);
      const ivaIncluido = unit === "credit";
      return {
        content: JSON.stringify({
          unidad: unit === "credit" ? "créditos de IA" : "conversaciones",
          base: base ? `Base $${Number(base.priceClp).toLocaleString("es-CL")}/mes${ivaIncluido ? " (IVA incluido)" : ""}` : null,
          packs: packs.map((p) => ({
            nombre: p.name,
            cantidad: p.credits,
            precio: `$${Number(p.priceClp).toLocaleString("es-CL")}${ivaIncluido ? " (IVA incluido)" : ""}`,
          })),
          link: "/cobros",
        }),
        // COP 1 — el copiloto NUNCA cobra: entrega el botón y el clic es del dueño. Antes
        // decía "anda a /cobros" y el cliente tenía que encontrarlo solo.
        actions: [{ type: "button", label: unit === "credit" ? "Recargar créditos" : "Recargar conversaciones", kind: "pago" }],
      };
    }
    if (name === "escalarAHumano") {
      const code = `CV-${Math.floor(1000 + Math.random() * 9000)}`;
      await this.prisma.withTenant(ctx.organizationId, async (tx) => {
        const open = await tx.supportTicket.findFirst({ where: { status: "open", ...(ctx.userId ? { userId: ctx.userId } : {}) }, orderBy: { createdAt: "desc" } });
        const msg = { author: "agent" as const, body: `Escalado por el asistente: ${String(input?.motivo ?? "")}`.slice(0, 1000), at: new Date().toISOString() };
        if (open) await tx.supportTicket.update({ where: { id: open.id }, data: { thread: [...((open.thread as unknown as ThreadMsg[]) ?? []), msg] as object } });
        else await tx.supportTicket.create({ data: { organizationId: ctx.organizationId, userId: ctx.userId ?? null, message: String(input?.motivo ?? "Soporte"), code, thread: [msg] as object } });
      });
      return { content: `Listo, dejé tu caso en manos del equipo. Puedes seguirlo por aquí o por WhatsApp.` };
    }
    // ---- COP 1 — herramientas de MONTAJE (módulo aparte, `setup-tools.ts`) ----
    // El gate de dueño se vuelve a comprobar ACÁ: el caller ya no ofrece las de escritura a
    // un viewer, pero una herramienta que escribe la configuración del negocio no puede
    // depender de que el filtro de specs esté bien puesto en el único sitio donde se arma.
    if (SETUP_TOOL_NAMES.has(name)) {
      if (isSetupWriteTool(name) && !isWebOwner(ctx.role)) {
        return { content: "Esta acción solo la puede hacer el dueño o un administrador.", isError: true };
      }
      const out = await runSetupTool(this.prisma, { organizationId: ctx.organizationId, userId: ctx.userId, route }, name, input);
      if (out) return out;
    }
    // ---- Escrituras (solo owner; el caller ya filtró specs, revalidamos por defensa) ----
    if (!isWebOwner(ctx.role)) return { content: "Esta acción solo la puede hacer el dueño o un administrador.", isError: true };
    if (name === "crearServicio") {
      const nombre = String(input?.nombre ?? "").trim().slice(0, 80);
      if (!nombre) return { content: "Dime el nombre del servicio a crear.", isError: true };
      const precio = input?.precio != null ? Math.round(Number(input.precio)) : null;
      const dur = input?.duracionMin != null ? Math.round(Number(input.duracionMin)) : 30;
      const slug = nombre.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "servicio";
      return this.prisma.withTenant(ctx.organizationId, async (tx) => {
        const dup = await tx.service.findFirst({ where: { name: { equals: nombre, mode: "insensitive" } }, select: { id: true } });
        if (dup) return { content: `Ya existe un servicio llamado "${nombre}". Si quieres cambiarle el precio, dímelo.`, isError: true };
        let code = slug;
        if (await tx.service.findUnique({ where: { organizationId_code: { organizationId: ctx.organizationId, code } }, select: { id: true } }).catch(() => null)) {
          code = `${slug}-${Math.random().toString(36).slice(2, 5)}`;
        }
        const s = await tx.service.create({ data: { organizationId: ctx.organizationId, code, name: nombre, durationMin: dur, ...(precio != null && precio >= 0 ? { price: precio } : {}) } });
        await tx.auditLog.create({ data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId ?? "assistant", action: "assistant.create_service", entityType: "service", entityId: s.id, after: { name: nombre, price: precio, durationMin: dur } as object } });
        return { content: `Creé el servicio "${nombre}"${precio != null ? ` a $${precio.toLocaleString("es-CL")}` : ""} · ${dur} min.`, didWrite: true };
      });
    }
    if (name === "configurarPrecioServicio") {
      const q = String(input?.servicio ?? "").trim();
      const precio = Math.round(Number(input?.precio));
      const dur = input?.duracionMin != null ? Math.round(Number(input.duracionMin)) : null;
      if (!q || !Number.isFinite(precio) || precio < 0) return { content: "Necesito el nombre del servicio y un precio válido.", isError: true };
      return this.prisma.withTenant(ctx.organizationId, async (tx) => {
        const matches = await tx.service.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true, name: true } });
        if (!matches.length) return { content: `No encontré un servicio llamado "${q}". ¿Lo creamos primero en Agenda → Servicios?`, isError: true };
        if (matches.length > 1) return { content: `Hay varios servicios que coinciden con "${q}": ${matches.map((m) => m.name).join(", ")}. ¿Cuál exactamente?`, isError: true };
        await tx.service.update({ where: { id: matches[0].id }, data: { price: precio, ...(dur ? { durationMin: dur } : {}) } });
        await tx.auditLog.create({ data: { organizationId: ctx.organizationId, actorType: "user", actorId: ctx.userId ?? "assistant", action: "assistant.config_service", entityType: "service", entityId: matches[0].id, after: { price: precio, durationMin: dur } as object } });
        return { content: `Listo: "${matches[0].name}" quedó en $${precio.toLocaleString("es-CL")}${dur ? ` · ${dur} min` : ""}.`, didWrite: true };
      });
    }
    // `configurarDatosNegocio` (un campo por llamada) la reemplazó `completarDatosNegocio`
    // de `setup-tools.ts`: acepta nombre, rubro, dirección y descripción en una sola pasada
    // y además mueve el checklist. Tener las dos haría que el modelo eligiera a la suerte.
    return { content: "No reconozco esa acción.", isError: true };
  }

  /** System prompt según el modo + contexto + si es dueño (webOwnerContext). */
  private systemPrompt(ctx: Awaited<ReturnType<AssistantService["buildContext"]>>, owner: boolean, route?: string): string {
    const base = `Eres el Asistente de Conversia, dentro del panel del cliente. Hablas español de Chile, cálido y BREVE (2-4 frases). Ayudas al dueño de un negocio a dejar su asistente de WhatsApp andando y a resolver dudas.

CONTEXTO ACTUAL (ya lo sabes, no lo preguntes):
- Negocio: ${ctx.businessName}
- Avance de implementación: ${ctx.checklistPct}%
- Siguiente paso pendiente: ${ctx.nextStep?.label ?? "ninguno, ya está todo"}
- Saldo: ${ctx.saldo ?? "no aplica"}
- Pantalla donde está: ${route ?? "panel"}
${ctx.lastChannelError ? `- Último error de canal: ${ctx.lastChannelError}` : ""}

REGLAS:
- Nunca inventes precios de planes/packs: usa la herramienta ofrecerRecarga o verEstado.
- Jamás cobras tú ni abres la conexión con Meta por tu cuenta: esas dos cosas necesitan un clic del dueño, y tus herramientas ya le entregan el botón.
- Si piden hablar con una persona, usa escalarAHumano.
- CONEXIÓN DE WHATSAPP: hay dos caminos en "Canales". (1) RECOMENDADO — "Conecta el WhatsApp que ya usas" (coexistencia): el dueño escanea/ingresa un código desde su app WhatsApp Business, mantiene su teléfono y sus chats, y NO necesita página web ni cuenta de Facebook; el asistente atiende en paralelo y lo que el dueño responda a mano también aparece en la Bandeja. (2) "Número nuevo dedicado" para quien no quiere tocar su número. Si el dueño dice que ya atiende por WhatsApp y quiere seguir con ese número, guíalo al camino (1). Toma ~3 minutos. Si al armar un número NUEVO Meta pide "verificación del negocio", explícalo simple (es un trámite único de Meta para confirmar que el negocio existe; no es culpa suya) y ofrécele que una persona del equipo lo acompañe HOY a dejarlo listo — usa escalarAHumano. Recuérdale que el camino (1), conectar el número que ya usa, normalmente NO necesita esa verificación.
- ACOMPAÑA, no dictes indicaciones: cuando propongas un paso o te pregunten dónde está algo, llama acompañarPaso con la clave del paso (negocio, servicios, agenda, asistente, whatsapp, prueba, pago, mini_sitio). Eso lo lleva a la pantalla y le resalta qué tocar, que es mucho mejor que explicarle la ruta.
- Antes de hablar de WhatsApp, llama diagnosticarWhatsapp: puede estar conectado pero sin asistente asignado, y entonces el número recibe y nadie contesta.`;
    const modeBlock = ctx.mode === "implementacion"
      ? `\n\nMODO IMPLEMENTACIÓN (avance < 100%): LIDERA. Saluda proponiendo el siguiente paso pendiente ("${ctx.nextStep?.label ?? ""}") y ofrécete a hacerlo juntos.`
      : `\n\nMODO ASISTENCIA (todo listo): resuelve dudas; si no puedes, escala a un humano.`;
    const ownerBlock = owner
      ? `\n\nPuedes MONTAR el negocio conversando, no solo explicar cómo: datos del negocio y rubro (completarDatosNegocio), horario de atención (configurarHorarioAtencion), servicios con precio (crearServicio, configurarPrecioServicio), quién atiende y su horario (crearProfesional), cómo se ofrecen las horas (configurarAgenda), y el asistente completo: armarlo desde una plantilla del rubro (listarPlantillasAsistente, crearAsistente), ajustarle tono/reglas/preguntas frecuentes (ajustarAsistente), PROBARLO con un mensaje de cliente (probarAsistente) y publicarlo (publicarAsistente). También la página del negocio (activarMiniSitio).

AUTONOMÍA:
- Leer, navegar y resaltar: hazlo sin preguntar.
- Cambiar configuración: propón el cambio CONCRETO y aplícalo con UN "sí" ("¿Dejo el corte en $12.000?" → sí → llamas la herramienta). No pidas permiso dos veces para lo mismo.
- Si el dueño dice "arma todo tú" o algo equivalente, puedes aplicar varios cambios seguidos y mostrarle un resumen al final.
- Pagar y conectar WhatsApp: SIEMPRE con su clic en el botón. Tú diagnosticas y le das el botón.
- NUNCA cambias el modelo de IA del asistente: eso lo fija Conversia.
- Después de crear el asistente, pruébalo con un mensaje realista de su rubro ANTES de ofrecer publicarlo: que el dueño vea cómo atiende.`
      : `\n\nEste usuario NO es dueño ni administrador: NO configures nada. Solo informa y, si hace falta, escala a un humano.`;
    return base + modeBlock + ownerBlock;
  }

  /**
   * Contexto MÍNIMO de degradado (Bloque 3): si `buildContext` falla (una consulta de BD caída,
   * una tabla no migrada), el asistente NO debe tirar un 500 ni mostrar el fallback genérico —
   * responde con un contexto seguro para que la IA igual conteste. Misma forma que buildContext.
   */
  private minimalContext(): Awaited<ReturnType<AssistantService["buildContext"]>> {
    return {
      businessName: "tu negocio",
      currency: "CLP",
      steps: [],
      checklistPct: 0,
      nextStep: null,
      saldo: null,
      blockingCompleted: 0,
      blockingTotal: 0,
      lastChannelError: null,
      mode: assistantMode(0),
    };
  }

  /** Corre un turno del asistente. Devuelve la respuesta, las acciones y si hubo cambios. */
  async run(
    ctx: AssistantCtx,
    userMessage: string,
    history: AIChatMessage[],
    route?: string,
  ): Promise<{ reply: string; mode: string; wrote: boolean; qa?: { passed: boolean } | null; actions: AssistantAction[] }> {
    const env = getEnv();
    const owner = isWebOwner(ctx.role);
    // ROBUSTEZ (Bloque 3): el contexto se arma FUERA del loop de IA, pero un fallo suyo no debe
    // tumbar el turno. Si falla, degradamos a un contexto mínimo y lo dejamos en el log (igual que
    // hacemos con el proveedor de IA más abajo) → la IA responde 200 con texto real, nunca un 500.
    let context: Awaited<ReturnType<AssistantService["buildContext"]>>;
    try {
      context = await this.buildContext(ctx.organizationId, ctx.userId);
    } catch (e) {
      console.error(`✖ Asistente: contexto no disponible (${(e as Error).message?.slice(0, 120)})`);
      context = this.minimalContext();
    }
    // Proveedor EXPLÍCITO por AI_PROVIDER (hallazgo prod 26-oct): el router por nombre de modelo
    // mandaba a OpenAI (key inválida → 401 → fallback) pese a AI_PROVIDER=anthropic con llave
    // válida. createAIProvider honra la configuración: anthropic→Anthropic, openai→OpenAI,
    // mock→Mock (sim). Así el asistente usa SIEMPRE el proveedor que el dueño configuró.
    const ai = createAIProvider({ provider: env.AI_PROVIDER, anthropicApiKey: env.ANTHROPIC_API_KEY, openaiApiKey: env.OPENAI_API_KEY });
    const specs = this.toolSpecs(owner);
    const messages: AIChatMessage[] = [...history.slice(-12), { role: "user", content: userMessage }];
    const toolTranscript: NonNullable<Parameters<typeof ai.chat>[0]["toolTranscript"]> = [];
    // Modelo COMPATIBLE con el proveedor (ver resolveAssistantModel). COP 1: el copiloto tiene
    // su PROPIO modelo (`ASSISTANT_MODEL`), separado del de los bots de los clientes, porque
    // encadena herramientas —lee el estado, crea, prueba, publica— y con un modelo barato deja
    // el montaje a medias. Si no está configurado, cae en el de siempre.
    const model = resolveAssistantModel(env.AI_PROVIDER, env.ASSISTANT_MODEL || env.AI_DEFAULT_MODEL);
    let reply = "";
    let wrote = false;
    let publicoAgente = false;
    const acciones: AssistantAction[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    // ROBUSTEZ (F4.4): si el proveedor de IA está caído/lento, el asistente NUNCA queda mudo
    // ni rompe la página — responde un fallback claro (CERO SILENCIOS), nunca un 500.
    try {
      // COP 1 — 8 rondas (antes 4): armar el asistente son varias herramientas seguidas
      // (ver el estado → listar plantillas → crearlo → probarlo → publicarlo) y con 4 el
      // copiloto se quedaba a mitad de camino sin decir por qué.
      for (let round = 0; round < 8; round++) {
        const resp = await ai.chat({ model, system: this.systemPrompt(context, owner, route), messages, tools: specs, maxTokens: 1200, toolTranscript });
        inputTokens += resp.usage?.inputTokens ?? 0;
        outputTokens += resp.usage?.outputTokens ?? 0;
        if (resp.stopReason !== "tool_use" || !resp.toolCalls.length) { reply = resp.text || reply; break; }
        const results: AIToolResult[] = [];
        for (const call of resp.toolCalls as AIToolCall[]) {
          const out = await this.executeTool(ctx, call.name, call.input, route).catch((e) => ({ content: `Error: ${(e as Error).message}`, isError: true, didWrite: false, actions: undefined }));
          if (out.didWrite) wrote = true;
          if (out.didWrite && call.name === "publicarAsistente") publicoAgente = true;
          if (out.actions?.length) acciones.push(...out.actions);
          results.push({ toolCallId: call.id, content: out.content, isError: out.isError });
        }
        if (resp.text?.trim()) reply = resp.text;
        toolTranscript.push({ kind: "assistant_tool_calls", text: resp.text ?? undefined, calls: resp.toolCalls });
        toolTranscript.push({ kind: "tool_results", results });
      }
    } catch (e) {
      console.error(`✖ Asistente: proveedor de IA no disponible (${(e as Error).message?.slice(0, 120)})`);
      if (!reply) {
        reply =
          "Estoy teniendo un problema para responder en este momento 🙏. Reintenta en unos segundos, por favor. " +
          (context.nextStep ? `Mientras tanto, tu siguiente paso es: ${context.nextStep.label}. ` : "") +
          "Si sigue sin funcionar, escríbele a soporte y lo vemos.";
      }
    }

    // COP 1 — COSTO DEL MONTAJE. Se registra para saber lo que cuesta de verdad llevar a un
    // cliente de la cuenta nueva al bot andando (CRE 4 lo usa para el margen por cliente).
    //
    // Va en `usage_events` y NO en `ai_requests` por dos razones: `AiPurpose` no tiene un
    // valor para el copiloto (agregarlo es una migración de enum) y, sobre todo, una fila de
    // `ai_requests` es la UNIDAD DE COBRO de los Créditos IA. Este costo lo paga Conversia,
    // no el cliente: dejarlo ahí sería invitar a que algún día se le debite al tenant el
    // copiloto que lo ayudó a montarse. Mismo patrón que el probador de agentes
    // (`meta.source`), así que los reportes de consumo ya lo saben leer.
    if (inputTokens + outputTokens > 0) {
      await this.prisma.admin.usageEvent
        .create({
          data: {
            organizationId: ctx.organizationId,
            type: "ai_tokens",
            quantity: inputTokens + outputTokens,
            costUsd: computeCostUsd(model, inputTokens, outputTokens),
            meta: { source: "copilot_setup", model, provider: env.AI_PROVIDER, inputTokens, outputTokens, mode: context.mode, wrote } as object,
          },
        })
        .catch(() => undefined);
    }

    // Tras un cambio de configuración, corre el auto-QA (V2-6) best-effort y cuéntalo.
    // Si lo que hizo fue PUBLICAR, la batería ya corrió dentro de `publicarAsistente`:
    // repetirla serían 4+ llamadas al proveedor por nada.
    let qa: { passed: boolean } | null = null;
    if (wrote && !publicoAgente) {
      try {
        const agent = await this.prisma.admin.agent.findFirst({ where: { organizationId: ctx.organizationId, deletedAt: null, active: true }, select: { id: true } });
        if (agent) { const r = await runQaBattery(this.prisma, ctx.organizationId, agent.id, { autoPublish: false }); qa = { passed: !!r.passed }; }
      } catch { /* noop */ }
    }
    return {
      reply: reply || "Estoy aquí para ayudarte con tu asistente. ¿Qué necesitas?",
      mode: context.mode,
      wrote,
      qa,
      // Lo que sale hacia la UI pasa SIEMPRE por la lista blanca (rutas que existen,
      // `data-copilot` conocidos, enlaces https): la UI no vuelve a validar nada.
      actions: sanitizeActions(acciones),
    };
  }
}
