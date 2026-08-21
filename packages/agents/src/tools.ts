import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type {
  AIToolSpec,
  SchedAppointment,
  SchedulingProvider,
  ToolContext,
  ToolDefinition,
} from "@conversia/types";

/**
 * Servicios que el runtime (worker/api) inyecta en ToolContext.services.
 * Todos operan YA dentro del contexto del tenant (withTenant) — las tools
 * jamás reciben ni aceptan organizationId desde el modelo.
 */
/** Producto/plato del catálogo, en la forma que el bot necesita para vender. */
export interface CatalogHit {
  name: string;
  sku: string | null;
  price: number | null;
  compareAtPrice: number | null;
  currency: string;
  available: boolean;
  stock: number | null;
  category: string | null;
  description: string | null; // botDescription si existe, si no la del origen
  variants: unknown[];
  productUrl: string | null;
  buyUrl: string | null;
  syncedAt?: string | null; // cuándo se sincronizó por última vez desde la tienda (frescura)
}

export interface ToolServices {
  listServices(): Promise<
    Array<{ code: string; name: string; price: number | null; currency: string; durationMin: number; category: string | null }>
  >;
  getServiceByCode(code: string): Promise<
    { code: string; name: string; price: number | null; currency: string; durationMin: number; description: string | null } | null
  >;
  listProfessionals(serviceCode?: string): Promise<Array<{ id: string; name: string; specialty: string | null }>>;
  scheduling: SchedulingProvider;
  contactInfo(): Promise<{ firstName: string | null; lastName: string | null; phone: string | null }>;
  recordAppointment(appt: SchedAppointment): Promise<void>;
  updateLeadStatus(code: string): Promise<void>;
  addTag(name: string): Promise<void>;
  searchKnowledge(query: string): Promise<Array<{ title: string; content: string }>>;
  requestHumanHandoff(reason: string): Promise<void>;
  // Acciones adicionales (Fase 3)
  closeConversation(): Promise<void>;
  // Asigna a un EQUIPO/PERSONA (apaga la IA) o, si el destino es otro AGENTE de IA, devuelve
  // { handoffToAgentSlug } para que el runtime haga la transferencia. Lanza si no resuelve a nada.
  assignConversation(
    target: string,
    reason?: string,
  ): Promise<{ assignedTo: string } | { handoffToAgentSlug: string; message: string }>;
  updateContactFields(fields: { firstName?: string; lastName?: string; email?: string }): Promise<{ updated: string[] }>;
  triggerWorkflow(workflowName: string): Promise<{ ok: boolean; error?: string }>;
  addInternalNote(note: string): Promise<void>;
  listPlans(): Promise<Array<{ code: string; name: string; priceClp: number; priceUsd: number; priceClpYearly: number | null; priceUsdYearly: number | null; templateMessages: number | null }>>;
  // Catálogo comercial real del negocio (tienda o menú). Vender con datos vivos.
  searchCatalog(input: { query: string; category?: string; maxPrice?: number; onlyAvailable?: boolean }): Promise<Array<CatalogHit>>;
  getCatalogItem(idOrSku: string): Promise<CatalogHit | null>;
  // Leer una página web (p. ej. el sitio del prospecto) y devolver su texto legible.
  readWebPage(url: string): Promise<{ url: string; title: string | null; text: string } | { error: string }>;
  // Montaje asistido — SOLO para el agente de implementación de TuBot. Actúan sobre
  // el tenant del CLIENTE (previa autorización), acotado a su configuración.
  generateAssistedLink(): Promise<{ url: string }>;
  redeemAssistedCode(code: string): Promise<{ ok: boolean; orgName?: string | null; channelName?: string | null; error?: string }>;
  assistedSetupState(): Promise<{ authorized: boolean; state?: { agents: number; flows: number; services: number; knowledge: number } }>;
  assistedUpsertAgent(input: { slug: string; name: string; systemPrompt: string; kind?: string }): Promise<{ ok: boolean; agentId?: string; error?: string }>;
}

function services(ctx: ToolContext): ToolServices {
  return ctx.services as unknown as ToolServices;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<any, any>>();

  register(def: ToolDefinition<any, any>): void {
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  /** Especificaciones para el modelo, filtradas por las tools habilitadas en la versión del agente. */
  specsFor(enabled: string[]): AIToolSpec[] {
    const specs: AIToolSpec[] = [];
    for (const name of enabled) {
      const def = this.tools.get(name);
      if (!def) continue;
      const schema = zodToJsonSchema(def.inputSchema as z.ZodType, { target: "jsonSchema7" }) as Record<string, unknown>;
      delete schema["$schema"];
      specs.push({ name: def.name, description: def.description, inputJsonSchema: schema });
    }
    return specs;
  }

  /**
   * Ejecuta una tool con validación zod server-side. Los errores se devuelven
   * como resultado (is_error) para que el modelo pueda corregir, nunca como
   * excepción que rompa el turno.
   */
  async execute(name: string, rawInput: unknown, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
    const def = this.tools.get(name);
    if (!def) return { content: `Herramienta desconocida: ${name}`, isError: true };
    const parsed = (def.inputSchema as z.ZodType).safeParse(rawInput ?? {});
    if (!parsed.success) {
      return { content: `Entrada inválida: ${parsed.error.issues.map((i) => i.message).join("; ")}`, isError: true };
    }
    try {
      const result = await def.execute(ctx, parsed.data);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return { content: text.slice(0, 4000), isError: false };
    } catch (err) {
      return { content: `Error al ejecutar ${name}: ${(err as Error).message}`, isError: true };
    }
  }
}

/** Tools estándar de la plataforma (sección 29). */
export function buildCoreTools(): ToolDefinition<any, any>[] {
  const isoDate = z.string().describe("Fecha ISO YYYY-MM-DD");

  return [
    {
      name: "getServices",
      description:
        "Lista los servicios/tratamientos que ofrece la clínica con duración y precio reales. Úsala antes de hablar de servicios o valores.",
      inputSchema: z.object({}),
      async execute(ctx) {
        return services(ctx).listServices();
      },
    },
    {
      name: "getServicePrice",
      description: "Obtiene el precio y detalle REAL de un servicio por su código. Nunca inventes precios.",
      inputSchema: z.object({ serviceCode: z.string().describe("Código del servicio, p.ej. implante_unitario") }),
      async execute(ctx, input: { serviceCode: string }) {
        const svc = await services(ctx).getServiceByCode(input.serviceCode);
        return svc ?? { error: "Servicio no encontrado; usa getServices para ver los códigos válidos" };
      },
    },
    {
      name: "getProfessionals",
      description: "Lista los profesionales de la clínica, opcionalmente filtrados por servicio.",
      inputSchema: z.object({ serviceCode: z.string().optional() }),
      async execute(ctx, input: { serviceCode?: string }) {
        return services(ctx).listProfessionals(input.serviceCode);
      },
    },
    {
      name: "getAvailability",
      description:
        "Consulta disponibilidad REAL de horas en la agenda. Úsala siempre antes de ofrecer horarios; nunca inventes disponibilidad.",
      inputSchema: z.object({
        serviceCode: z.string().optional(),
        professionalId: z.string().optional(),
        fromDate: isoDate.optional(),
        toDate: isoDate.optional(),
      }),
      async execute(ctx, input: { serviceCode?: string; professionalId?: string; fromDate?: string; toDate?: string }) {
        const from = input.fromDate ?? new Date().toISOString().slice(0, 10);
        const to =
          input.toDate ?? new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const slots = await services(ctx).scheduling.getAvailableSlots({
          serviceId: input.serviceCode,
          professionalId: input.professionalId,
          clinicId: ctx.clinicId ?? undefined,
          from,
          to,
        });
        return slots.slice(0, 6);
      },
    },
    {
      name: "createAppointment",
      description:
        "Crea una cita en la agenda tras confirmar con el paciente servicio, profesional, fecha y hora exactos (obtenidos de getAvailability).",
      inputSchema: z.object({
        clinicId: z.string(),
        professionalId: z.string(),
        serviceCode: z.string().optional(),
        startIso: z.string().describe("Inicio ISO 8601 exacto de un slot devuelto por getAvailability"),
        endIso: z.string().optional(),
        notes: z.string().optional(),
      }),
      async execute(ctx, input: any) {
        const s = services(ctx);
        const contact = await s.contactInfo();
        if (!contact.phone) return { error: "El contacto no tiene teléfono registrado" };
        const end =
          input.endIso ?? new Date(new Date(input.startIso).getTime() + 30 * 60000).toISOString();
        const appt = await s.scheduling.createAppointment({
          clinicId: input.clinicId,
          professionalId: input.professionalId,
          serviceId: input.serviceCode,
          patient: {
            firstName: contact.firstName ?? "Paciente",
            lastName: contact.lastName ?? undefined,
            phone: contact.phone,
          },
          start: input.startIso,
          end,
          notes: input.notes,
        });
        await s.recordAppointment(appt);
        return { ok: true, appointment: appt };
      },
    },
    {
      name: "updateLeadStatus",
      description: "Actualiza el estado del lead de esta conversación (códigos configurados por la clínica, p.ej. hot_lead, agenda, cold_lead).",
      inputSchema: z.object({ statusCode: z.string() }),
      async execute(ctx, input: { statusCode: string }) {
        await services(ctx).updateLeadStatus(input.statusCode);
        return { ok: true };
      },
    },
    {
      name: "addTag",
      description: "Agrega una etiqueta a la conversación/contacto (p.ej. implantes, urgencia, financiamiento).",
      inputSchema: z.object({ tag: z.string() }),
      async execute(ctx, input: { tag: string }) {
        await services(ctx).addTag(input.tag);
        return { ok: true };
      },
    },
    {
      name: "searchKnowledgeBase",
      description:
        "Busca en la base de conocimiento de la clínica (FAQ, convenios, formas de pago, indicaciones). Úsala antes de responder dudas de información.",
      inputSchema: z.object({ query: z.string() }),
      async execute(ctx, input: { query: string }) {
        const results = await services(ctx).searchKnowledge(input.query);
        return results.length ? results : { info: "Sin resultados; reconoce que no tienes esa información y ofrece contacto humano" };
      },
    },
    {
      name: "transferToAgent",
      description:
        "Transfiere la conversación a otro agente especializado (por slug, p.ej. agendamiento, implantes). Úsala cuando el tema salga de tu ámbito.",
      inputSchema: z.object({ agentSlug: z.string(), reason: z.string().optional() }),
      async execute(_ctx, input: { agentSlug: string }) {
        // El orquestador captura esta llamada y ejecuta la transferencia real.
        return { ok: true, transferTo: input.agentSlug };
      },
    },
    {
      name: "transferToHuman",
      description:
        "Escala la conversación a una persona del equipo (urgencia, frustración, solicitud expresa o tema fuera de tu autorización). La IA deja de responder.",
      inputSchema: z.object({ reason: z.string() }),
      async execute(ctx, input: { reason: string }) {
        await services(ctx).requestHumanHandoff(input.reason);
        return { ok: true, message: "Conversación escalada al equipo humano" };
      },
    },
    {
      name: "closeConversation",
      description:
        "Cierra la conversación actual cuando el asunto quedó resuelto y no requiere más atención. Úsala solo cuando estés seguro.",
      inputSchema: z.object({}),
      async execute(ctx) {
        await services(ctx).closeConversation();
        return { ok: true, message: "Conversación cerrada" };
      },
    },
    {
      name: "assignConversation",
      description:
        "Asigna la conversación a un EQUIPO o una PERSONA del negocio (la IA deja de responder). Indica el nombre exacto del equipo o usuario.",
      inputSchema: z.object({
        target: z.string().describe("Nombre exacto del equipo o usuario al que asignar"),
        reason: z.string().optional(),
      }),
      async execute(ctx, input: { target: string; reason?: string }) {
        return services(ctx).assignConversation(input.target, input.reason);
      },
    },
    {
      name: "updateContactFields",
      description:
        "Actualiza datos del contacto (nombre, apellido, email) cuando el cliente los proporciona explícitamente. No inventes datos.",
      inputSchema: z.object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        email: z.string().email().optional(),
      }),
      async execute(ctx, input: { firstName?: string; lastName?: string; email?: string }) {
        return services(ctx).updateContactFields(input);
      },
    },
    {
      name: "triggerWorkflow",
      description:
        "Dispara un flujo de automatización del negocio por su nombre exacto (p. ej. una secuencia de seguimiento o recordatorio).",
      inputSchema: z.object({ workflowName: z.string().describe("Nombre exacto del workflow a disparar") }),
      async execute(ctx, input: { workflowName: string }) {
        return services(ctx).triggerWorkflow(input.workflowName);
      },
    },
    {
      name: "addInternalNote",
      description:
        "Agrega una NOTA INTERNA para el equipo humano en la conversación. El cliente NO la ve. Útil para dejar contexto o alertas.",
      inputSchema: z.object({ note: z.string() }),
      async execute(ctx, input: { note: string }) {
        await services(ctx).addInternalNote(input.note);
        return { ok: true, message: "Nota interna agregada" };
      },
    },
    {
      name: "buscarProductos",
      description:
        "Busca en el CATÁLOGO real del negocio (productos de la tienda o platos del menú) en lenguaje natural — encuentra aunque las palabras no estén literales. Devuelve nombre, precio, disponibilidad y enlace. Úsalo SIEMPRE para cotizar, recomendar y vender con datos vivos; nunca inventes productos ni precios. Si algo está agotado, ofrece alternativas de los resultados.",
      inputSchema: z.object({
        query: z.string().describe("lo que busca el cliente, p.ej. 'algo para el dolor de espalda' o 'pizza sin gluten'"),
        category: z.string().optional(),
        maxPrice: z.number().optional(),
        onlyAvailable: z.boolean().optional().describe("true = solo lo que está disponible ahora"),
      }),
      async execute(ctx, input: { query: string; category?: string; maxPrice?: number; onlyAvailable?: boolean }) {
        const items = await services(ctx).searchCatalog(input);
        return { items, count: items.length };
      },
    },
    {
      name: "verProducto",
      description:
        "Trae el detalle de un producto/plato por su nombre, SKU o código: precio, precio antes de descuento, descripción, variantes/modificadores, disponibilidad, stock y enlace de compra. Úsalo antes de confirmarle un precio o disponibilidad al cliente. El campo syncedAt indica cuándo se sincronizó desde la tienda: si es reciente, afirma con seguridad; si tiene varias horas, confírmalo con naturalidad ('según lo último que tengo…').",
      inputSchema: z.object({ idOrSku: z.string() }),
      async execute(ctx, input: { idOrSku: string }) {
        const item = await services(ctx).getCatalogItem(input.idOrSku);
        return item ?? { error: "No encontré ese producto en el catálogo." };
      },
    },
    {
      name: "leerWeb",
      description:
        "Lee una PÁGINA WEB por su URL y devuelve su texto legible, para ANALIZARLA — p. ej. el sitio del prospecto para entender su rubro, servicios, precios y tono, y responder/cotizar con datos reales. Úsala cuando te compartan o mencionen un sitio web. Solo LEE (no navega ni envía formularios). Si no carga, dilo y sigue sin inventar.",
      inputSchema: z.object({ url: z.string().describe("URL del sitio, p. ej. https://miclinica.cl") }),
      async execute(ctx, input: { url: string }) {
        return services(ctx).readWebPage(input.url);
      },
    },
    {
      name: "getPlanes",
      description:
        "Devuelve los planes y PRECIOS VIGENTES de TuBot desde el sistema (nombre, precio en CLP y USD, si es mensual o anual, y mensajes de plantilla incluidos). Úsalo SIEMPRE antes de cotizar un precio: nunca inventes ni memorices valores, pueden cambiar en cualquier momento.",
      inputSchema: z.object({}),
      async execute(ctx) {
        return { plans: await services(ctx).listPlans() };
      },
    },
    {
      name: "requestAssistedSetup",
      description:
        "Explica al CLIENTE cómo autorizarte a configurar su cuenta: debe entrar a su panel (Configuración → Datos → «Montaje asistido»), elegir el canal a configurar y darle Autorizar; ahí obtiene un CÓDIGO tipo TB-XXXX-XXXX que te debe dictar por el chat. Úsalo antes de dejarle algo configurado.",
      inputSchema: z.object({}),
      async execute() {
        return {
          ok: true,
          message:
            "Pídele al cliente que haga esto en su panel: 1) Configuración → Datos, 2) sección «Montaje asistido de TuBot», 3) elegir el canal que quiere configurar y presionar «Autorizar». Le aparecerá un código como TB-XXXX-XXXX (vence en 30 min). Pídele que te lo dicte por aquí y canjéalo con vincularMontajeCliente.",
        };
      },
    },
    {
      name: "vincularMontajeCliente",
      description:
        "Canjea el CÓDIGO que el cliente generó en su panel y te dictó (tipo TB-XXXX-XXXX). Vincula su cuenta a esta conversación y te autoriza a configurarle SOLO el canal que él eligió. Llámalo apenas te pase el código; luego confirma con él la empresa y el canal antes de crear nada.",
      inputSchema: z.object({ codigo: z.string().describe("el código que dictó el cliente, p.ej. TB-4K9M-2XQ7") }),
      async execute(ctx, input: { codigo: string }) {
        const r = await services(ctx).redeemAssistedCode(input.codigo);
        if (!r.ok) return { ok: false, message: r.error };
        const canal = r.channelName ? ` para el canal «${r.channelName}»` : "";
        return { ok: true, orgName: r.orgName, channelName: r.channelName, message: `Listo, quedé vinculado con «${r.orgName ?? "la cuenta del cliente"}»${canal}. Confírmale que vas a configurar esa cuenta antes de crear nada.` };
      },
    },
    {
      name: "getClientSetupState",
      description:
        "Consulta en qué paso va el montaje del cliente (cuántos agentes, flujos, servicios y documentos tiene) para saber qué falta. Requiere que el cliente haya autorizado el montaje asistido.",
      inputSchema: z.object({}),
      async execute(ctx) {
        return services(ctx).assistedSetupState();
      },
    },
    {
      name: "upsertClientAgent",
      description:
        "Crea o actualiza el AGENTE del cliente con las instrucciones que redactaste desde su entrevista de negocio, y lo deja publicado. Requiere autorización del cliente. Solo toca su configuración (nunca sus conversaciones ni contactos).",
      inputSchema: z.object({
        slug: z.string().describe("identificador corto, p.ej. recepcionista"),
        name: z.string(),
        systemPrompt: z.string().min(20).describe("las instrucciones COMPLETAS del agente del cliente"),
        kind: z.string().optional(),
      }),
      async execute(ctx, input: { slug: string; name: string; systemPrompt: string; kind?: string }) {
        return services(ctx).assistedUpsertAgent(input);
      },
    },
  ];
}
