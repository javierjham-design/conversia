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
  listLeadStatuses(): Promise<Array<{ code: string; name: string }>>;
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
  listPlans(): Promise<Array<{ code: string; name: string; priceClp: number; priceUsd: number; priceClpYearly: number | null; priceUsdYearly: number | null; templateMessages: number | null; contactsMonthly: number | null; aiTokensDaily: number | null; trialDays: number; isTrial: boolean }>>;
  // Catálogo comercial real del negocio (tienda o menú). Vender con datos vivos.
  searchCatalog(input: { query: string; category?: string; maxPrice?: number; onlyAvailable?: boolean }): Promise<Array<CatalogHit>>;
  getCatalogItem(idOrSku: string): Promise<CatalogHit | null>;
  // Cobro: genera un LINK DE PAGO (Flow, con la cuenta del propio tenant) por el monto
  // EXACTO acordado con el cliente. Devuelve la URL para enviársela en el mensaje.
  enviarLinkDePago(input: { monto: number; concepto: string }): Promise<{ ok: boolean; url?: string; error?: string }>;
  // Leer una página web (p. ej. el sitio del prospecto) y devolver su texto legible.
  readWebPage(url: string): Promise<{ url: string; title: string | null; text: string } | { error: string }>;
  // Anotar un hecho duradero del cliente en su "ficha" (memoria compartida entre agentes).
  recordContactMemory(input: { category: string; content: string }): Promise<{ saved: boolean; deduped?: boolean }>;
  // Montaje asistido — SOLO para el agente de implementación de TuBot. Actúan sobre
  // el tenant del CLIENTE (previa autorización), acotado a su configuración.
  generateAssistedLink(): Promise<{ url: string }>;
  redeemAssistedCode(code: string): Promise<{ ok: boolean; orgName?: string | null; channelName?: string | null; error?: string }>;
  assistedSetupState(): Promise<{ authorized: boolean; state?: { agents: number; flows: number; services: number; knowledge: number; journeyStep?: number | null; journeyLabel?: string | null } }>;
  // Marca el PASO del viaje de implementación (1-10) — persistido, para no perder dónde va el cliente.
  setSetupStep(step: number, label: string): Promise<{ ok: boolean; step?: number; error?: string }>;
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

  const slotWhen = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false });

  // Caché de horarios por conversación. getAvailability guarda los slots reales y devuelve
  // ids CORTOS AUTODESCRIPTIVOS con día y hora (h0409-1015 = día 04-09 a las 10:15).
  // Con ids opacos (h1, h2…) el modelo renumeraba la lista al paciente y luego mapeaba
  // MAL la elección (caso Macarena: eligió 10:15 y agendó h1=09:15). Con el día y la
  // hora EN el id, la elección del paciente coincide textualmente con el id correcto.
  // buildCoreTools se ejecuta 1 vez → la Map es de proceso; se limpia por antigüedad.
  type CachedSlot = { start: string; end: string; professionalId: string; clinicId: string; serviceId?: string };
  // Clave por org+conversación: nunca compartir estado entre tenants (el probador
  // u otro runtime podría reutilizar ids de conversación).
  const cacheKey = (ctx: ToolContext) => `${ctx.organizationId}:${ctx.conversationId ?? "default"}`;
  const slotCache = new Map<string, { slots: Map<string, CachedSlot>; at: number }>();
  const slotIdFmt = new Intl.DateTimeFormat("es-CL", { timeZone: "America/Santiago", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const slotId = (startIso: string): string => {
    const p = new Map(slotIdFmt.formatToParts(new Date(startIso)).map((x) => [x.type, x.value]));
    return `h${p.get("day")}${p.get("month")}-${p.get("hour")}${p.get("minute")}`;
  };
  const putSlots = (convId: string, slots: CachedSlot[]): Map<string, CachedSlot> => {
    const byId = new Map(slots.map((s) => [slotId(s.start), s]));
    slotCache.set(convId, { slots: byId, at: Date.now() });
    if (slotCache.size > 1000) for (const [k, v] of slotCache) if (Date.now() - v.at > 30 * 60000) slotCache.delete(k);
    return byId;
  };
  const SLOTS_TTL_MS = 10 * 60000;
  const getSlot = (convId: string, id: string): CachedSlot | null => {
    const c = slotCache.get(convId);
    if (!c) return null;
    // Lista vencida: obliga a reconsultar getAvailability (evita agendar de una lista
    // vieja cuando el paciente ya cambió de día/semana — caso "viernes 10" de Julio).
    if (Date.now() - c.at > SLOTS_TTL_MS) return null;
    return c.slots.get(String(id).trim().toLowerCase()) ?? null;
  };

  // GUARDIA anti doble-agendamiento: el modelo a veces llama createAppointment varias
  // veces en el mismo turno (dos slots distintos + reintentos) → creaba 2-3 citas reales
  // y luego chocaba (409) contra su propia cita. Una vez agendada una cita en la
  // conversación, no se crea otra dentro de la ventana; se devuelve la ya creada.
  const BOOKING_LOCK_MS = 3 * 60000;
  const bookedCache = new Map<string, { appt: SchedAppointment; cuando: string; at: number }>();

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
        "Consulta disponibilidad REAL de horas. Úsala siempre antes de ofrecer horarios; nunca inventes. Cada opción trae `id` (úsalo tal cual en createAppointment) y `cuando` (día+fecha+hora reales para mostrar al paciente).",
      inputSchema: z.object({
        serviceCode: z.string().optional(),
        professionalId: z.string().optional(),
        fromDate: isoDate.optional(),
        toDate: isoDate.optional(),
      }),
      async execute(ctx, input: { serviceCode?: string; professionalId?: string; fromDate?: string; toDate?: string }) {
        // Blindaje de fechas: el modelo a veces manda fechas pasadas (p.ej. "2023-…").
        // Se ancla el inicio desde HOY (Chile) y se RESPETA el rango que pidió el modelo
        // (si pide un día, se le dan las horas de ESE día, sin mezclar días lejanos).
        const todayChile = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        const from = input.fromDate && input.fromDate >= todayChile ? input.fromDate : todayChile;
        const plus = (days: number) => new Date(new Date(`${from}T00:00:00Z`).getTime() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const to = input.toDate && input.toDate >= from ? input.toDate : plus(14);
        const sched = services(ctx).scheduling;
        const query = { serviceId: input.serviceCode, professionalId: input.professionalId, clinicId: ctx.clinicId ?? undefined };
        let slots = await sched.getAvailableSlots({ ...query, from, to });
        // Si el rango pedido era angosto y no hay horas, se ensancha a 14 días (para
        // no responder "no hay" cuando sí hay más adelante) — pero solo como respaldo.
        if (!slots.length) {
          const wide = plus(14);
          if (wide > to) slots = await sched.getAvailableSlots({ ...query, from, to: wide });
        }
        const top = slots.slice(0, 6).map((s) => ({ start: s.start, end: s.end, professionalId: s.professionalId, clinicId: s.clinicId, serviceId: s.serviceId }));
        const byId = putSlots(cacheKey(ctx), top);
        // Ids AUTODESCRIPTIVOS (h0409-1015 = 04-09 a las 10:15) + `cuando` legible. Para
        // agendar, pasa el id EXACTO del horario que eligió el paciente (la hora del id
        // debe coincidir con la elegida). No se exponen fecha/profesional crudos.
        return [...byId.entries()].map(([id, s]) => ({ id, cuando: slotWhen.format(new Date(s.start)) }));
      },
    },
    {
      name: "createAppointment",
      description:
        "Agenda una cita. Pasa en `slotId` el `id` del horario que eligió el paciente en getAvailability. El id codifica día y hora (h0409-1015 = día 04-09 a las 10:15): VERIFICA que la hora del id coincida EXACTAMENTE con la hora que pidió el paciente. NO inventes ni reconstruyas fecha, hora ni profesional. NUNCA pidas el teléfono al paciente: ya se usa automáticamente el número del chat.",
      inputSchema: z.object({
        slotId: z.string().describe("El `id` del slot elegido tal como lo dio getAvailability (ej. h0409-1015; su hora DEBE coincidir con la que eligió el paciente)"),
        notes: z.string().optional(),
      }),
      async execute(ctx, input: any) {
        const s = services(ctx);
        const convId = cacheKey(ctx);
        // GUARDIA: si ya se agendó una cita en esta conversación hace poco, NO crear otra
        // (el modelo a veces reintenta/agenda dos slots) → se devuelve la ya creada.
        const prior = bookedCache.get(convId);
        if (prior && Date.now() - prior.at < BOOKING_LOCK_MS) {
          return {
            ok: true,
            alreadyBooked: true,
            appointment: prior.appt,
            message: `Ya quedó agendada la cita para ${prior.cuando}. No se creó otra. Confírmasela al paciente; si pide una hora DISTINTA, avísale que ya tiene una reservada.`,
          };
        }
        const contact = await s.contactInfo();
        if (!contact.phone) return { error: "El contacto no tiene teléfono registrado" };
        // El id corto se resuelve al slot real cacheado → fecha/profesional exactos.
        const slot = getSlot(convId, String(input.slotId ?? ""));
        if (!slot) {
          return { error: "No encuentro ese horario (o la lista ya venció). Llama de nuevo a getAvailability y pasa el `id` exacto del horario que eligió el paciente (ej. h0409-1015)." };
        }
        const end = slot.end ?? new Date(new Date(slot.start).getTime() + 30 * 60000).toISOString();
        // Firma de origen en el comentario de la cita: siempre se sabe qué agente agendó.
        // Sin duplicar "Agente" si el nombre del agente ya lo incluye.
        const nombreAgente = ctx.agentName ?? "IA";
        const firma = `Agendado por TuBot · ${/^agente\b/i.test(nombreAgente) ? nombreAgente : `Agente ${nombreAgente}`}`;
        const notes = input.notes ? `${firma}. ${input.notes}` : firma;
        let appt: SchedAppointment;
        try {
          appt = await s.scheduling.createAppointment({
            clinicId: slot.clinicId,
            professionalId: slot.professionalId,
            serviceId: slot.serviceId,
            patient: {
              firstName: contact.firstName ?? "Paciente",
              lastName: contact.lastName ?? undefined,
              phone: contact.phone,
            },
            start: slot.start,
            end,
            notes,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // 409 slot_taken: la hora se ocupó (por otro canal o por una reserva previa).
          if (/409|slot_taken|ya tiene una cita/i.test(msg)) {
            return { error: "Esa hora ya está ocupada. Llama de nuevo a getAvailability y ofrécele al paciente otro horario disponible; no repitas el mismo." };
          }
          throw e;
        }
        const cuando = slotWhen.format(new Date(slot.start));
        bookedCache.set(convId, { appt, cuando, at: Date.now() });
        if (bookedCache.size > 1000) for (const [k, v] of bookedCache) if (Date.now() - v.at > BOOKING_LOCK_MS) bookedCache.delete(k);
        await s.recordAppointment(appt);
        // `cuando` legible de la cita REAL: el modelo debe confirmar ESTA fecha/hora
        // textual (hubo casos donde anunciaba una fecha distinta a la agendada).
        return { ok: true, cuando, message: `Cita creada para ${cuando}. Confirma al paciente EXACTAMENTE esta fecha y hora (copia "${cuando}" tal cual); si no coincide con lo que pidió, discúlpate y corrige.`, appointment: appt };
      },
    },
    {
      name: "getLeadStatuses",
      description: "Lista las ETAPAS válidas del lead configuradas por la cuenta (code + nombre). Úsala antes de updateLeadStatus para usar el code exacto; nunca inventes códigos.",
      inputSchema: z.object({}),
      async execute(ctx) {
        return services(ctx).listLeadStatuses();
      },
    },
    {
      name: "updateLeadStatus",
      description: "Actualiza la ETAPA del lead de esta conversación. Usa un code EXACTO de getLeadStatuses (no inventes). Cambia la etapa según el avance real (interés, agendó, cerró, se enfrió).",
      inputSchema: z.object({ statusCode: z.string() }),
      async execute(ctx, input: { statusCode: string }) {
        try {
          await services(ctx).updateLeadStatus(input.statusCode);
          return { ok: true };
        } catch (e) {
          // El modelo suele inventar el código ("interes"): se le devuelven los
          // válidos para que se corrija solo en vez de fallar en silencio.
          const valid = await services(ctx).listLeadStatuses().catch(() => []);
          const codes = Array.isArray(valid) ? valid.map((s: any) => s?.code).filter(Boolean).join(", ") : "";
          return { error: `Código "${input.statusCode}" inválido. Usa EXACTAMENTE uno de estos: ${codes || "(llama a getLeadStatuses)"}` };
        }
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
      name: "recordarMemoria",
      description:
        "Anota un HECHO DURADERO del cliente en su ficha (memoria compartida entre TODOS los agentes y conversaciones). Úsalo cuando el cliente aporte información que valga la pena recordar a futuro: su intención, necesidades, presupuesto, objeciones, plazos, datos de su negocio, o cualquier preferencia. NO lo uses para charla trivial ni para repetir lo que ya está en la ficha. Escribe cada hecho breve y en tercera persona (p. ej. 'Tiene 4 profesionales y una sucursal en Temuco'). Así otro agente (p. ej. implementación) tendrá lo que te contó a ti sin volver a preguntarlo.",
      inputSchema: z.object({
        category: z
          .enum(["intent", "need", "preference", "objection", "constraint", "timeline", "business", "other"])
          .describe("Tipo de hecho: intent, need, preference, objection, constraint, timeline, business u other"),
        content: z.string().describe("El hecho, breve y concreto, en tercera persona"),
      }),
      async execute(ctx, input: { category: string; content: string }) {
        return services(ctx).recordContactMemory(input);
      },
    },
    {
      name: "getPlanes",
      description:
        "Devuelve los planes y PRECIOS VIGENTES de TuBot: nombre, precio CLP/USD (mensual y anual), mensajes de plantilla (templateMessages), límites (contactsMonthly, aiTokensDaily), y si es prueba (isTrial + trialDays). 0 = ilimitado. Úsalo SIEMPRE antes de cotizar. " +
        "REGLA CRÍTICA — EL PLAN FREE / PRECIO 0 NO ES GRATIS PARA SIEMPRE: es una PRUEBA/DEMO de {trialDays} días (isTrial=true). SIEMPRE preséntalo como 'prueba gratuita de 7 días para que lo veas funcionando', y deja EXPLÍCITO que al terminar la prueba el cliente DEBE pasar a un plan de PAGO para seguir usándolo (no se queda gratis). Nunca lo vendas como un plan de uso permanente ni digas 'es gratis' a secas. Empujá desde el inicio hacia un plan de pago (Starter en adelante) como el destino real. " +
        "LOS CONTACTOS/MES (contactsMonthly) SON EL DATO MÁS IMPORTANTE DE CADA PLAN — más que las plantillas (no todos usan plantillas). Al presentar un plan, informá SIEMPRE y PRIMERO su cupo de contactos/mes ('incluye N contactos/mes'), luego el precio, y las plantillas solo como dato secundario. Vendé y comparás los planes por contactos/mes. aiTokensDaily es un límite TÉCNICO INTERNO — NO lo cites JAMÁS al cliente (los 'tokens' confunden). Reglas: NUNCA 'ilimitado' ni 'no lo vas a tocar' si hay cupo; si contactsMonthly viene vacío/0 NO inventes un número (decí que incluye un uso justo y ofrecé confirmarlo, y para volumen alto recomendá un plan mayor); si el volumen estimado supera el cupo, recomendá el plan que lo cubre. Excedente: pasarse del cupo NO corta el servicio, se cobran packs de +100 contactos en la próxima factura.",
      inputSchema: z.object({}),
      async execute(ctx) {
        return { plans: await services(ctx).listPlans() };
      },
    },
    {
      name: "enviarLinkDePago",
      description:
        "Genera un LINK DE PAGO por el monto EXACTO acordado con el cliente y devuelve la URL para que se la envíes en tu mensaje. Úsalo SOLO cuando el cliente confirmó lo que va a pagar y el monto. `monto` es un entero en pesos chilenos (CLP, sin decimales ni puntos). `concepto` describe el pedido (p. ej. 'Lavado frazada 2P + delivery'). Muestra SIEMPRE el monto y el concepto al enviar el link. Si devuelve un error (cobros no configurados), dile con honestidad que en un momento le confirmas el medio de pago y NO inventes un link.",
      inputSchema: z.object({
        monto: z.number().int().positive().describe("Monto EXACTO a cobrar, entero en CLP (ej: 12700)"),
        concepto: z.string().min(2).max(120).describe("Descripción del pedido/cobro"),
      }),
      async execute(ctx, input: { monto: number; concepto: string }) {
        return services(ctx).enviarLinkDePago(input);
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
        "Consulta en qué paso va el montaje del cliente: el PASO guardado del viaje (journeyStep/journeyLabel) y cuántos agentes, flujos, servicios y documentos tiene. Úsalo al retomar para saber exactamente dónde quedaron y no repetir pasos. Requiere que el cliente haya autorizado el montaje asistido.",
      inputSchema: z.object({}),
      async execute(ctx) {
        return services(ctx).assistedSetupState();
      },
    },
    {
      name: "marcarPasoMontaje",
      description:
        "Guarda el PASO del viaje de implementación en el que va el cliente (1=activó prueba, 2=WhatsApp escritorio, 3=autorización, 4=plantillas, 5=entrevista, 6=agente creado, 7=conocimiento, 8=prueba en simulador, 9=conectar WhatsApp, 10=activar y cobrar). Márcalo CADA vez que completen un paso, para que al retomar sepas dónde quedaron sin re-preguntar.",
      inputSchema: z.object({
        step: z.number().int().min(1).max(10).describe("número de paso 1-10"),
        label: z.string().describe("breve descripción del paso, p. ej. 'entrevista completa'"),
      }),
      async execute(ctx, input: { step: number; label: string }) {
        return services(ctx).setSetupStep(input.step, input.label);
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
