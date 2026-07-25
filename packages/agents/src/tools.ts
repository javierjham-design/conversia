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
  ];
}
