import type { AIToolSpec, AssistantAction } from "@conversia/types";
import type { PrismaService } from "../prisma.service";
import { INDUSTRIES } from "../common/industries";
import { RUBROS_VALIDOS, businessDataSchema, guardarDatosNegocio } from "../organizations/business-data";
import { runAgentTest, DEFAULT_PROMPT, slugify } from "../agents/agent-test";
import { runQaBattery, type QaResult } from "../agents/agent-qa";
import { defaultAgentModel } from "../agents/model-policy";
import {
  accionesParaPaso,
  construirHorario,
  diagnosticarCanal,
  explicarCamino,
  pasoConocido,
  pasoNecesitaClic,
  resumirHorario,
  type TramoEntrada,
} from "./setup-logic";

/**
 * COP ETAPA 1 — HERRAMIENTAS DE MONTAJE del copiloto.
 *
 * Hasta aquí el copiloto sabía CONTAR el montaje y podía tocar tres cosas (crear un
 * servicio, ponerle precio, cambiar el nombre del negocio). Todo lo demás lo tenía que
 * hacer el dueño a mano siguiendo indicaciones: completar los datos del negocio, cargar su
 * horario, sumar un profesional, armar el asistente, probarlo, publicarlo. Con estas
 * herramientas lo hace él, confirmando antes de cada cambio.
 *
 * Reglas que valen para TODAS (y que el caller no puede olvidar, porque se revalidan acá):
 *  - Solo dueño/administrador (`webOwnerContext`). El caller ya no expone las specs de
 *    escritura a un viewer, y aun así cada ejecución lo vuelve a comprobar.
 *  - El `organizationId` SIEMPRE viene del JWT: el modelo nunca ve ni elige una org.
 *  - Toda escritura deja asiento en `audit_log` con `actorId` del usuario (no "assistant"
 *    anónimo): si el copiloto cambió un precio, tiene que poder saberse quién lo pidió.
 *  - PAGAR y CONECTAR WHATSAPP no son herramientas: son botones. El copiloto diagnostica y
 *    entrega el botón; el clic es del dueño.
 *  - El copiloto NUNCA toca el modelo de IA del agente (CRE 1 §4: en Conversia lo fija la
 *    plataforma). Crea agentes con el estándar vigente y nada más.
 */

export interface SetupToolCtx {
  organizationId: string;
  userId: string | null;
  /** Ruta donde está el cliente, para no navegarlo a donde ya está. */
  route?: string;
}

export interface SetupToolResult {
  content: string;
  isError?: boolean;
  didWrite?: boolean;
  /** Acciones que la UI debe ejecutar (se validan en `actions.ts` antes de salir). */
  actions?: AssistantAction[];
}

/** Specs de las herramientas de montaje. Todas son de ESCRITURA salvo las de diagnóstico. */
export function setupToolSpecs(): { read: AIToolSpec[]; write: AIToolSpec[] } {
  const rubros = INDUSTRIES.map((i) => i.code).join(", ");
  return {
    read: [
      {
        name: "diagnosticarWhatsapp",
        description:
          "Revisa el estado del WhatsApp del cliente: si hay número conectado, si tiene asistente asignado y cuál fue el último error. Devuelve el camino recomendado. Úsalo SIEMPRE antes de hablar de conectar WhatsApp.",
        inputJsonSchema: {
          type: "object",
          properties: {
            yaAtiendePorWhatsapp: { type: "boolean", description: "true si el dueño dijo que ya atiende clientes por WhatsApp con su número actual" },
          },
        },
      },
      {
        name: "listarPlantillasAsistente",
        description: "Lista las plantillas de asistente disponibles para el rubro del negocio, con su nombre y para qué sirven. Úsalo antes de crear un asistente.",
        inputJsonSchema: { type: "object", properties: {} },
      },
      {
        name: "verAsistentes",
        description: "Lista los asistentes del negocio con su estado (borrador o publicado). Un asistente en borrador NO atiende a nadie.",
        inputJsonSchema: { type: "object", properties: {} },
      },
      {
        name: "acompañarPaso",
        description:
          "Lleva al cliente a la pantalla del paso que están haciendo y le resalta qué tocar. Úsalo cuando le propongas un paso del montaje o cuando pregunte dónde está algo. Claves: negocio, servicios, agenda, asistente, whatsapp, prueba, pago, mini_sitio.",
        inputJsonSchema: {
          type: "object",
          properties: { paso: { type: "string", description: "Clave del paso del montaje" } },
          required: ["paso"],
        },
      },
    ],
    write: [
      {
        name: "completarDatosNegocio",
        description: `Completa los datos del negocio que el asistente usa al atender: nombre, rubro, dirección y descripción. Manda solo los campos que tengas. Rubros válidos: ${rubros}. CONFIRMA con el dueño antes de llamar.`,
        inputJsonSchema: {
          type: "object",
          properties: {
            nombre: { type: "string" },
            rubro: { type: "string", description: "Código de rubro del catálogo" },
            direccion: { type: "string" },
            descripcion: { type: "string" },
          },
        },
      },
      {
        name: "configurarHorarioAtencion",
        description:
          "Guarda el horario de atención del negocio. Pásale un tramo por día y rango; acepta horas como '9', '09:00' o '6pm'. Si el negocio cierra a mediodía, manda dos tramos del mismo día. CONFIRMA el horario completo antes de llamar.",
        inputJsonSchema: {
          type: "object",
          properties: {
            tramos: {
              type: "array",
              items: {
                type: "object",
                properties: { dia: { type: "string" }, desde: { type: "string" }, hasta: { type: "string" } },
                required: ["dia", "desde", "hasta"],
              },
            },
          },
          required: ["tramos"],
        },
      },
      {
        name: "crearProfesional",
        description:
          "Agrega una persona (o recurso) que atiende, con su horario semanal, para que el asistente pueda ofrecer horas reales. CONFIRMA nombre y horario antes de llamar.",
        inputJsonSchema: {
          type: "object",
          properties: {
            nombre: { type: "string" },
            especialidad: { type: "string" },
            tramos: {
              type: "array",
              items: {
                type: "object",
                properties: { dia: { type: "string" }, desde: { type: "string" }, hasta: { type: "string" } },
                required: ["dia", "desde", "hasta"],
              },
            },
          },
          required: ["nombre", "tramos"],
        },
      },
      {
        name: "configurarAgenda",
        description:
          "Ajusta cómo se ofrecen las horas: bloque entre horas (minutos) y cuánta anticipación mínima pedir para reservar. CONFIRMA antes de llamar.",
        inputJsonSchema: {
          type: "object",
          properties: {
            bloqueMin: { type: "number", description: "Minutos entre horas ofrecidas (5 a 240)" },
            anticipacionMin: { type: "number", description: "Anticipación mínima en minutos para poder reservar" },
          },
        },
      },
      {
        name: "crearAsistente",
        description:
          "Crea el asistente del negocio desde una plantilla del rubro (o desde lo que cuente el dueño si no hay plantilla). Queda en BORRADOR: después hay que probarlo y publicarlo. CONFIRMA antes de llamar.",
        inputJsonSchema: {
          type: "object",
          properties: {
            nombre: { type: "string", description: "Cómo se llama el asistente de cara al cliente" },
            plantilla: { type: "string", description: "Clave de plantilla devuelta por listarPlantillasAsistente" },
            comoAtiende: { type: "string", description: "Lo que el dueño contó sobre cómo quiere que atienda" },
          },
          required: ["nombre"],
        },
      },
      {
        name: "ajustarAsistente",
        description:
          "Ajusta el tono, las reglas o las preguntas frecuentes del asistente (sobre su borrador). NUNCA cambia el modelo de IA. CONFIRMA el cambio antes de llamar.",
        inputJsonSchema: {
          type: "object",
          properties: {
            tono: { type: "string", description: "Cómo debe hablar (cercano, formal, breve…)" },
            reglas: { type: "string", description: "Qué debe y no debe hacer" },
            preguntasFrecuentes: { type: "string", description: "Preguntas y respuestas que debe saber" },
          },
        },
      },
      {
        name: "probarAsistente",
        description:
          "Prueba el asistente con un mensaje de cliente y devuelve lo que responde, SIN publicarlo. Úsalo antes de publicar para que el dueño vea cómo atiende.",
        inputJsonSchema: {
          type: "object",
          properties: { mensaje: { type: "string", description: "Lo que escribiría un cliente" } },
          required: ["mensaje"],
        },
      },
      {
        name: "publicarAsistente",
        description:
          "Publica el asistente para que empiece a atender de verdad. Antes corre la batería de prueba; si algo falla, NO publica y explica qué revisar. Pide confirmación al dueño antes de llamar.",
        inputJsonSchema: { type: "object", properties: {} },
      },
      {
        name: "activarMiniSitio",
        description: "Publica la página del negocio con los datos y servicios ya cargados. CONFIRMA antes de llamar.",
        inputJsonSchema: { type: "object", properties: {} },
      },
    ],
  };
}

export const SETUP_TOOL_NAMES = new Set(
  [...setupToolSpecs().read, ...setupToolSpecs().write].map((s) => s.name),
);
const SETUP_WRITE_TOOL_NAMES = new Set(setupToolSpecs().write.map((s) => s.name));

export function isSetupWriteTool(name: string): boolean {
  return SETUP_WRITE_TOOL_NAMES.has(name);
}

/** Asiento de auditoría de una escritura del copiloto. */
async function audit(
  prisma: Pick<PrismaService, "admin">,
  ctx: SetupToolCtx,
  action: string,
  entityType: string,
  entityId: string,
  after: Record<string, unknown>,
) {
  await prisma.admin.auditLog
    .create({
      data: {
        organizationId: ctx.organizationId,
        actorType: "user",
        actorId: ctx.userId ?? "assistant",
        action,
        entityType,
        entityId,
        after: after as object,
      },
    })
    .catch(() => undefined);
}

/** Lee `organization.settings` fresco (el copiloto escribe claves distintas en un mismo turno). */
async function readSettings(prisma: PrismaService, organizationId: string): Promise<Record<string, any>> {
  const org = await prisma.admin.organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  return ((org?.settings ?? {}) as Record<string, any>) ?? {};
}

/**
 * Plantillas de asistente del RUBRO del negocio. Viven dentro del paquete vertical
 * (`vertical_templates.definition.agents[]`), que es la misma fuente que usa el instalador
 * de rubros y que expone `/public/verticals`: así el copiloto ofrece exactamente los
 * asistentes que el equipo de Conversia escribió para ese rubro, y no una lista inventada.
 */
async function plantillasDelRubro(
  prisma: PrismaService,
  organizationId: string,
): Promise<{ rubro: string | null; agentes: { slug: string; name: string; description?: string; kind?: string; systemPrompt?: string; config?: Record<string, unknown>; tools?: string[] }[] }> {
  const settings = await readSettings(prisma, organizationId);
  const general = (settings.general ?? {}) as Record<string, any>;
  const vertical = (settings.vertical ?? {}) as Record<string, any>;
  const key = String(vertical.key ?? general.industry ?? "").trim();
  if (!key) return { rubro: null, agentes: [] };
  const tpl = await prisma.admin.verticalTemplate
    .findFirst({ where: { key, active: true }, orderBy: { version: "desc" }, select: { definition: true } })
    .catch(() => null);
  const agentes = ((tpl?.definition ?? {}) as Record<string, any>).agents;
  return { rubro: key, agentes: Array.isArray(agentes) ? agentes.filter((a) => a && typeof a.slug === "string") : [] };
}

/** El agente sobre el que trabaja el copiloto: el activo más reciente del tenant. */
async function agenteDelNegocio(prisma: PrismaService, organizationId: string) {
  return prisma.admin.agent.findFirst({
    where: { organizationId, deletedAt: null, active: true },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, slug: true },
  });
}

/**
 * Ejecuta una herramienta de montaje. Devuelve `null` si el nombre no es de este módulo,
 * para que el caller siga con sus propias herramientas (no se traga nombres ajenos).
 */
export async function runSetupTool(
  prisma: PrismaService,
  ctx: SetupToolCtx,
  name: string,
  input: any,
): Promise<SetupToolResult | null> {
  if (!SETUP_TOOL_NAMES.has(name)) return null;

  // ---------------------------------- Diagnóstico ----------------------------------
  if (name === "diagnosticarWhatsapp") {
    const [activos, sinAgente, ultimoError] = await Promise.all([
      prisma.admin.channelConnection.count({ where: { organizationId: ctx.organizationId, status: "active" } }).catch(() => 0),
      prisma.admin.channelConnection
        .count({ where: { organizationId: ctx.organizationId, status: "active", defaultAgentId: null } })
        .catch(() => 0),
      prisma.admin.integrationEvent
        .findFirst({
          where: { organizationId: ctx.organizationId, provider: "whatsapp", status: "error" },
          orderBy: { createdAt: "desc" },
          select: { message: true },
        })
        .then((r) => r?.message ?? null)
        .catch(() => null),
    ]);
    const camino = diagnosticarCanal({
      activos,
      sinAgente,
      yaAtiendePorWhatsapp: input?.yaAtiendePorWhatsapp === true,
      ultimoError,
    });
    const actions: AssistantAction[] = [];
    if (camino === "coexistencia" || camino === "numero_nuevo") {
      actions.push({ type: "button", label: "Conectar mi WhatsApp", kind: "whatsapp", payload: camino });
    }
    return {
      content: JSON.stringify({ camino, explicacion: explicarCamino(camino), numerosConectados: activos, sinAsistenteAsignado: sinAgente, ultimoError }),
      actions,
    };
  }

  if (name === "listarPlantillasAsistente") {
    const plantillas = await plantillasDelRubro(prisma, ctx.organizationId);
    if (!plantillas.rubro) {
      return {
        content: JSON.stringify({
          rubro: null,
          plantillas: [],
          nota: "El negocio todavía no tiene rubro cargado, así que no sé qué plantillas ofrecerle. Pregúntale a qué se dedica y guárdalo con completarDatosNegocio antes de crear el asistente.",
        }),
      };
    }
    return {
      content: JSON.stringify({
        rubro: plantillas.rubro,
        plantillas: plantillas.agentes.map((a) => ({ clave: a.slug, nombre: a.name, para: a.description ?? a.kind ?? "atención general" })),
      }),
    };
  }

  if (name === "verAsistentes") {
    const agents = await prisma.admin.agent
      .findMany({
        where: { organizationId: ctx.organizationId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        take: 10,
        select: { id: true, name: true, active: true, versions: { select: { status: true }, orderBy: { version: "desc" }, take: 3 } },
      })
      .catch(() => []);
    return {
      content: JSON.stringify({
        asistentes: agents.map((a) => ({
          nombre: a.name,
          activo: a.active,
          publicado: a.versions.some((v) => v.status === "PUBLISHED"),
          estado: a.versions.some((v) => v.status === "PUBLISHED") ? "publicado (atiende)" : "borrador (NO atiende a nadie)",
        })),
      }),
    };
  }

  if (name === "acompañarPaso") {
    const paso = String(input?.paso ?? "");
    // Se comprueba el PASO, no si salieron acciones: estando ya en la pantalla de un paso
    // sin elemento que resaltar la lista queda vacía, y eso no es un error.
    if (!pasoConocido(paso)) return { content: `No conozco el paso "${paso}".`, isError: true };
    const actions = accionesParaPaso(paso, ctx.route);
    const clic = pasoNecesitaClic(paso);
    if (clic === "whatsapp") actions.push({ type: "button", label: "Conectar mi WhatsApp", kind: "whatsapp" });
    if (clic === "pago") actions.push({ type: "button", label: "Activar mi plan", kind: "pago" });
    return { content: `Listo, lo llevé a la pantalla del paso "${paso}" y le resalté qué tocar.`, actions };
  }

  // ---------------------------------- Escrituras ----------------------------------
  if (name === "completarDatosNegocio") {
    // Mismo escritor que `PUT /settings/business` (ver `organizations/business-data.ts`):
    // lo que el dueño guarda conversando y lo que guarda a mano van al mismo sitio.
    const parsed = businessDataSchema.safeParse({
      nombre: typeof input?.nombre === "string" ? input.nombre : undefined,
      rubro: typeof input?.rubro === "string" ? input.rubro : undefined,
      direccion: typeof input?.direccion === "string" ? input.direccion : undefined,
      descripcion: typeof input?.descripcion === "string" ? input.descripcion : undefined,
    });
    if (!parsed.success) {
      return { content: "Dime al menos un dato del negocio para guardar (nombre, rubro, dirección o descripción).", isError: true };
    }
    const r = await guardarDatosNegocio(prisma, ctx, parsed.data);
    if (!r.ok) {
      const opciones = r.error?.includes("rubro") ? ` Opciones: ${RUBROS_VALIDOS.join(", ")}.` : "";
      return { content: `${r.error ?? "No pude guardarlo."}${opciones}`, isError: true };
    }
    return {
      content: `Guardé ${r.guardado.join(", ")} de tu negocio.`,
      didWrite: true,
      actions: [{ type: "checklist_refresh" }],
    };
  }

  if (name === "configurarHorarioAtencion") {
    const tramos: TramoEntrada[] = Array.isArray(input?.tramos) ? input.tramos.slice(0, 40) : [];
    if (!tramos.length) return { content: "Dime el horario: qué días abre y entre qué horas.", isError: true };
    const { hours, descartados } = construirHorario(tramos);
    if (!Object.keys(hours).length) {
      return { content: `No entendí el horario (${descartados.join("; ")}). Dímelo como "lunes a viernes de 9 a 18".`, isError: true };
    }
    const settings = await readSettings(prisma, ctx.organizationId);
    const prevBh = (settings.businessHours ?? {}) as Record<string, any>;
    await prisma.admin.organization.update({
      where: { id: ctx.organizationId },
      data: { settings: { ...settings, businessHours: { ...prevBh, hours } } as object },
    });
    await audit(prisma, ctx, "assistant.config_hours", "organization", ctx.organizationId, { hours });
    const aviso = descartados.length ? ` No pude usar: ${descartados.join("; ")}.` : "";
    return {
      content: `Tu horario quedó así: ${resumirHorario(hours)}.${aviso}`,
      didWrite: true,
      actions: [{ type: "checklist_refresh" }],
    };
  }

  if (name === "crearProfesional") {
    const nombre = String(input?.nombre ?? "").trim().slice(0, 120);
    if (!nombre) return { content: "Dime el nombre de la persona que atiende.", isError: true };
    const tramos: TramoEntrada[] = Array.isArray(input?.tramos) ? input.tramos.slice(0, 40) : [];
    const { hours, descartados } = construirHorario(tramos);
    // El horario es el punto del paso: un profesional sin horario no genera NINGUNA hora
    // ofrecible, y el checklist lo seguiría contando como pendiente sin decir por qué.
    const workingHours = Object.entries(hours).flatMap(([dia, lista]) => lista.map((t) => ({ day: dia, start: t.from, end: t.to })));
    if (!workingHours.length) {
      return { content: `Necesito el horario de ${nombre} para que el asistente pueda ofrecer sus horas${descartados.length ? ` (no entendí: ${descartados.join("; ")})` : ""}.`, isError: true };
    }
    const especialidad = typeof input?.especialidad === "string" ? input.especialidad.trim().slice(0, 120) : "";
    const created = await prisma.withTenant(ctx.organizationId, async (tx) => {
      const dup = await tx.professional.findFirst({ where: { name: { equals: nombre, mode: "insensitive" }, active: true }, select: { id: true } });
      if (dup) return null;
      return tx.professional.create({
        data: {
          organizationId: ctx.organizationId,
          name: nombre,
          specialty: especialidad || null,
          active: true,
          meta: { workingHours, type: "persona" } as object,
        },
        select: { id: true },
      });
    });
    if (!created) return { content: `Ya tienes a "${nombre}" cargado. Si quieres cambiarle el horario, dímelo.`, isError: true };
    await audit(prisma, ctx, "assistant.create_professional", "professional", created.id, { nombre, workingHours });
    return {
      content: `Agregué a ${nombre} con horario ${resumirHorario(hours)}.`,
      didWrite: true,
      actions: [{ type: "checklist_refresh" }],
    };
  }

  if (name === "configurarAgenda") {
    const bloque = input?.bloqueMin != null ? Math.round(Number(input.bloqueMin)) : null;
    const antic = input?.anticipacionMin != null ? Math.round(Number(input.anticipacionMin)) : null;
    if (bloque == null && antic == null) return { content: "Dime el bloque entre horas o la anticipación mínima que quieres.", isError: true };
    if (bloque != null && (!Number.isFinite(bloque) || bloque < 5 || bloque > 240)) {
      return { content: "El bloque entre horas tiene que estar entre 5 y 240 minutos.", isError: true };
    }
    if (antic != null && (!Number.isFinite(antic) || antic < 0 || antic > 20160)) {
      return { content: "La anticipación mínima tiene que estar entre 0 minutos y 14 días.", isError: true };
    }
    const settings = await readSettings(prisma, ctx.organizationId);
    const prev = (settings.agenda ?? {}) as Record<string, any>;
    const agenda = {
      slotStepMin: bloque ?? prev.slotStepMin ?? 30,
      bufferMin: prev.bufferMin ?? 0,
      minAdvanceMin: antic ?? prev.minAdvanceMin ?? 60,
    };
    await prisma.admin.organization.update({
      where: { id: ctx.organizationId },
      data: { settings: { ...settings, agenda } as object },
    });
    await audit(prisma, ctx, "assistant.config_agenda", "organization", ctx.organizationId, agenda);
    return {
      content: `Listo: horas cada ${agenda.slotStepMin} min y se puede reservar con ${agenda.minAdvanceMin} min de anticipación.`,
      didWrite: true,
    };
  }

  if (name === "crearAsistente") {
    const nombre = String(input?.nombre ?? "").trim().slice(0, 80);
    if (!nombre) return { content: "Dime cómo quieres que se llame tu asistente.", isError: true };
    const plantillaId = typeof input?.plantilla === "string" ? input.plantilla : "";
    const comoAtiende = typeof input?.comoAtiende === "string" ? input.comoAtiende.trim().slice(0, 2000) : "";
    const plantilla = plantillaId
      ? (await plantillasDelRubro(prisma, ctx.organizationId)).agentes.find((a) => a.slug === plantillaId) ?? null
      : null;
    if (plantillaId && !plantilla) {
      return { content: `No encontré la plantilla "${plantillaId}" en el rubro del negocio. Vuelve a mirarlas con listarPlantillasAsistente.`, isError: true };
    }
    // CRE 1 §4 — el modelo lo decide la plataforma (platform_settings), JAMÁS el copiloto ni
    // la plantilla: una plantilla vieja con un modelo caro le cambiaría el costo al cliente.
    const model = await defaultAgentModel();
    const basePrompt = plantilla?.systemPrompt?.trim() || DEFAULT_PROMPT;
    const systemPrompt = comoAtiende ? `${basePrompt}\n\nINDICACIONES DEL NEGOCIO:\n${comoAtiende}` : basePrompt;
    const created = await prisma.withTenant(ctx.organizationId, async (tx) => {
      let slug = slugify(nombre) || "asistente";
      if (await tx.agent.findUnique({ where: { organizationId_slug: { organizationId: ctx.organizationId, slug } }, select: { id: true } })) {
        slug = `${slug}-${Math.random().toString(36).slice(2, 5)}`;
      }
      const agent = await tx.agent.create({
        data: { organizationId: ctx.organizationId, slug, name: nombre, kind: plantilla?.kind ?? "custom", active: true },
        select: { id: true },
      });
      const prevConfig = (plantilla?.config ?? {}) as Record<string, unknown>;
      await tx.agentVersion.create({
        data: {
          organizationId: ctx.organizationId,
          agentId: agent.id,
          version: 1,
          status: "DRAFT",
          systemPrompt,
          config: { ...prevConfig, model, maxTokens: 400, maxToolRounds: 5, language: "es" } as object,
          tools: (Array.isArray(plantilla?.tools) ? plantilla.tools : ["getServices", "getServicePrice", "searchKnowledgeBase", "transferToHuman"]) as object,
          changelog: "Creado por el copiloto de montaje",
          createdById: ctx.userId,
        },
      });
      return agent;
    });
    await audit(prisma, ctx, "assistant.create_agent", "agent", created.id, { nombre, plantilla: plantillaId || null });
    return {
      content: `Creé tu asistente "${nombre}" en borrador. Probémoslo antes de publicarlo: dime qué te escribiría un cliente típico.`,
      didWrite: true,
    };
  }

  if (name === "ajustarAsistente") {
    const agent = await agenteDelNegocio(prisma, ctx.organizationId);
    if (!agent) return { content: "Todavía no tienes un asistente. ¿Lo creamos?", isError: true };
    const tono = typeof input?.tono === "string" ? input.tono.trim().slice(0, 600) : "";
    const reglas = typeof input?.reglas === "string" ? input.reglas.trim().slice(0, 1500) : "";
    const faq = typeof input?.preguntasFrecuentes === "string" ? input.preguntasFrecuentes.trim().slice(0, 2000) : "";
    if (!tono && !reglas && !faq) return { content: "Dime qué quieres ajustar: el tono, las reglas o las preguntas frecuentes.", isError: true };
    const bloques = [
      tono && `TONO:\n${tono}`,
      reglas && `REGLAS:\n${reglas}`,
      faq && `PREGUNTAS FRECUENTES:\n${faq}`,
    ].filter(Boolean) as string[];
    const result = await prisma.withTenant(ctx.organizationId, async (tx) => {
      const last = await tx.agentVersion.findFirst({
        where: { agentId: agent.id },
        orderBy: { version: "desc" },
        select: { id: true, version: true, status: true, systemPrompt: true, config: true, tools: true },
      });
      if (!last) return null;
      const prompt = `${last.systemPrompt}\n\n${bloques.join("\n\n")}`.slice(0, 20000);
      if (last.status === "DRAFT") {
        await tx.agentVersion.update({ where: { id: last.id }, data: { systemPrompt: prompt, changelog: "Ajustado por el copiloto" } });
        return { version: last.version, nueva: false };
      }
      // La publicada no se toca: el bot que está atendiendo sigue igual hasta que se publique.
      await tx.agentVersion.create({
        data: {
          organizationId: ctx.organizationId,
          agentId: agent.id,
          version: last.version + 1,
          status: "DRAFT",
          systemPrompt: prompt,
          config: (last.config ?? {}) as object,
          tools: (last.tools ?? []) as object,
          changelog: "Ajustado por el copiloto",
          createdById: ctx.userId,
        },
      });
      return { version: last.version + 1, nueva: true };
    });
    if (!result) return { content: "Tu asistente no tiene ninguna versión guardada. ¿Lo creamos de nuevo?", isError: true };
    await audit(prisma, ctx, "assistant.adjust_agent", "agent", agent.id, { tono, reglas, faq, version: result.version });
    return {
      content: `Ajusté el borrador de "${agent.name}"${result.nueva ? " (tu asistente publicado sigue atendiendo igual hasta que publiquemos el cambio)" : ""}. ¿Lo probamos?`,
      didWrite: true,
    };
  }

  if (name === "probarAsistente") {
    const agent = await agenteDelNegocio(prisma, ctx.organizationId);
    if (!agent) return { content: "Todavía no tienes un asistente que probar. ¿Lo creamos?", isError: true };
    const mensaje = String(input?.mensaje ?? "").trim().slice(0, 500);
    if (!mensaje) return { content: "Dime qué te escribiría un cliente y lo pruebo.", isError: true };
    const version = await prisma.admin.agentVersion.findFirst({
      where: { agentId: agent.id, organizationId: ctx.organizationId },
      orderBy: { version: "desc" },
      select: { systemPrompt: true, config: true, tools: true },
    });
    if (!version) return { content: "Tu asistente no tiene una versión guardada todavía.", isError: true };
    const out = await runAgentTest(prisma, ctx.organizationId, agent.id, {
      systemPrompt: version.systemPrompt,
      config: (version.config ?? {}) as Record<string, unknown> as any,
      tools: Array.isArray(version.tools) ? (version.tools as string[]) : [],
      messages: [{ role: "user", content: mensaje }],
    }).catch((e) => ({ ok: false as const, error: String((e as Error).message).slice(0, 200) }));
    if (!out.ok) return { content: `No pude probarlo ahora (${(out as { error?: string }).error ?? "error"}). Reintentemos en un momento.`, isError: true };
    return { content: JSON.stringify({ leEscribi: mensaje, respondio: (out as { reply?: string }).reply ?? "" }) };
  }

  if (name === "publicarAsistente") {
    const agent = await agenteDelNegocio(prisma, ctx.organizationId);
    if (!agent) return { content: "Todavía no tienes un asistente que publicar. ¿Lo creamos?", isError: true };
    const qa: QaResult = await runQaBattery(prisma, ctx.organizationId, agent.id, { autoPublish: true }).catch((e) => ({
      ok: false,
      passed: false,
      published: false,
      corrected: false,
      results: [],
      error: String((e as Error).message).slice(0, 200),
    }));
    await audit(prisma, ctx, "assistant.publish_agent", "agent", agent.id, { passed: !!qa.passed, ok: !!qa.ok });
    if (!qa.ok || !qa.passed) {
      const fallas = (qa.results ?? []).filter((r) => !r.pass).map((r) => r.name).join(", ");
      return {
        content: `Lo probé antes de publicar y quedó algo por revisar${fallas ? ` (${fallas})` : ""}, así que NO lo publiqué: prefiero que no salga a atender mal. Ajustemos eso y volvemos a intentar.`,
        isError: true,
      };
    }
    return {
      content: `¡Publicado! "${agent.name}" ya está atendiendo. Ahora falta que tu WhatsApp quede conectado con él.`,
      didWrite: true,
      actions: [{ type: "celebrate", step: "asistente" }, { type: "checklist_refresh" }],
    };
  }

  if (name === "activarMiniSitio") {
    const settings = await readSettings(prisma, ctx.organizationId);
    const miniSite = { ...((settings.miniSite ?? {}) as Record<string, any>), enabled: true };
    await prisma.admin.organization.update({
      where: { id: ctx.organizationId },
      data: { settings: { ...settings, miniSite } as object },
    });
    await audit(prisma, ctx, "assistant.enable_mini_site", "organization", ctx.organizationId, { enabled: true });
    return {
      content: "Publiqué tu página con los datos y servicios que ya tienes cargados.",
      didWrite: true,
      actions: [{ type: "navigate", to: "/mini-sitio" }, { type: "checklist_refresh" }],
    };
  }

  return { content: "No reconozco esa acción.", isError: true };
}
