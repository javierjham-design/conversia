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
  /** Citas del contacto desde la PROYECCIÓN LOCAL (ya cruzada por el contacto), no vía el
   *  lookup por teléfono del proveedor externo (que falla con teléfonos malformados de Cláriva).
   *  Trae durationMin (end−start) para reagendar conservando la duración original. */
  listContactAppointments(): Promise<
    Array<{ id: string; start: string; end: string; status: string; professionalId: string | null; professionalName: string | null; serviceId: string | null; serviceName: string | null; durationMin: number }>
  >;
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
  updateContactFields(fields: { firstName?: string; lastName?: string; email?: string; phone?: string }): Promise<{ updated: string[]; error?: string; phone?: string }>;
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
  // Administración de agenda (F8) — SOLO modo dueño (tools ownerOnly).
  adminUpsertProfessional(input: { id?: string; name: string; specialty?: string; type?: "persona" | "servicio"; durationMin?: number; active?: boolean }): Promise<{ ok?: boolean; id?: string; error?: string }>;
  adminUpdateProfessionalSchedule(input: { professionalId: string; workingHours: Array<{ day: number; start: string; end: string }> }): Promise<{ ok?: boolean; error?: string }>;
  adminAddProfessionalTimeOff(input: { professionalId: string; from: string; to: string; reason?: string }): Promise<{ ok?: boolean; affected?: number; error?: string }>;
  adminUpdateBusinessHours(input: { businessHours: Record<string, string[]> }): Promise<{ ok?: boolean; error?: string }>;
  adminUpdateServiceConfig(input: { serviceId?: string; code?: string; name?: string; durationMin?: number; price?: number }): Promise<{ ok?: boolean; error?: string }>;
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

  /** Especificaciones para el modelo, filtradas por las tools habilitadas en la versión del
   *  agente. Las tools `ownerOnly` (F8) solo se exponen si opts.ownerContext es true: así el
   *  cliente final JAMÁS las ve (no-op para agentes que no las tengan en su lista). */
  specsFor(enabled: string[], opts?: { ownerContext?: boolean }): AIToolSpec[] {
    const specs: AIToolSpec[] = [];
    for (const name of enabled) {
      const def = this.tools.get(name);
      if (!def) continue;
      if (def.ownerOnly && !opts?.ownerContext) continue;
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
    // Cerrojo de runtime (F8): una tool de dueño nunca se ejecuta sin ownerContext, aunque
    // el modelo la invoque igual.
    if (def.ownerOnly && !ctx.ownerContext) return { content: "Esta acción solo la puede hacer el dueño del negocio desde su número verificado.", isError: true };
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
    // Padding MANUAL: Intl con "2-digit" a veces devuelve "9" sin cero (según ICU) →
    // los ids no calzaban con el formato documentado (hDDMM-HHMM) y el modelo los
    // "corregía" reconstruyéndolos mal (caso Juan Fuica: h99-1530 → mandó h0409-1530).
    const pad = (v?: string) => String(v ?? "").padStart(2, "0");
    return `h${pad(p.get("day"))}${pad(p.get("month"))}-${pad(p.get("hour"))}${pad(p.get("minute"))}`;
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
    const key = String(id).trim().toLowerCase();
    const direct = c.slots.get(key);
    if (direct) return direct;
    // TOLERANCIA: el modelo a veces RECONSTRUYE el id en vez de copiarlo (caso Juan
    // Fuica: la lista traía h99-1530 y mandó h0409-1530 imitando el ejemplo). Si la
    // HORA del id (tras el guión) identifica UN ÚNICO slot cacheado, se usa ese; si es
    // ambigua (misma hora en dos días de la lista), null → el modelo debe reconsultar.
    const m = key.match(/(\d{3,4})\s*$/);
    if (m) {
      const hhmm = m[1].padStart(4, "0");
      const hits = [...c.slots.entries()].filter(([k]) => k.endsWith(`-${hhmm}`));
      if (hits.length === 1) return hits[0][1];
    }
    return null;
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
        "Consulta disponibilidad REAL de horas. Úsala siempre antes de ofrecer horarios; nunca inventes. Si el paciente pide 'en la mañana' o 'en la tarde', pasa `franja` (manana = 09:00–13:59, tarde = desde las 14:00) — sin eso solo verías las horas más tempranas. Cada opción trae `id` (úsalo tal cual en createAppointment) y `cuando` (día+fecha+hora reales para mostrar al paciente).",
      inputSchema: z.object({
        serviceCode: z.string().optional(),
        professionalId: z.string().optional(),
        fromDate: isoDate.optional(),
        toDate: isoDate.optional(),
        diasSemana: z
          .array(z.enum(["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]))
          .optional()
          .describe("Si el paciente nombra DÍAS DE LA SEMANA (ej. 'jueves o viernes'), pásalos AQUÍ como lista (['jueves','viernes']) EN VEZ de calcular tú la fecha: el sistema resuelve las fechas reales correctas. No calcules fromDate para días de semana."),
        franja: z.enum(["manana", "tarde"]).optional().describe("Filtro horario: manana = 09:00–13:59, tarde = desde las 14:00. Úsalo SIEMPRE que el paciente pida mañana/tarde."),
        durationMin: z.number().int().positive().max(480).optional().describe("Duración de la cita en minutos. Al REAGENDAR, pasa la duracionMin que te dio getPatientAppointments para conservar la duración original."),
      }),
      async execute(ctx, input: { serviceCode?: string; professionalId?: string; fromDate?: string; toDate?: string; diasSemana?: string[]; franja?: "manana" | "tarde"; durationMin?: number }) {
        // Blindaje de fechas: el modelo a veces manda fechas pasadas (p.ej. "2023-…").
        // Se ancla el inicio desde HOY (Chile) y se RESPETA el rango que pidió el modelo
        // (si pide un día, se le dan las horas de ESE día, sin mezclar días lejanos).
        const todayChile = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        // DÍAS DE SEMANA: el modelo ERRA al convertir "jueves/viernes" → fecha aunque tenga la tabla
        // del calendario (caso Susan: pidió jueves/viernes y consultó martes 20 / miércoles 21).
        // Si vienen `diasSemana`, IGNORAMOS el fromDate del modelo y barremos la ventana completa,
        // filtrando por el día de semana REAL de cada cupo. Determinista, no depende del modelo.
        const WDMAP: Record<string, number> = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };
        // Preferimos los días que pasó el modelo; si NO pasó ninguno, los EXTRAEMOS del último
        // mensaje del paciente (ctx.lastUserText). gpt-4o-mini ignora el parámetro diasSemana y
        // además calcula MAL la fecha del día (caso Susan: pidió jueves/viernes y el modelo consultó
        // martes/miércoles). Extraer la palabra del texto es determinista y no depende del modelo.
        const wdFromModel = input.diasSemana?.length ? input.diasSemana.map((d) => WDMAP[d]).filter((n) => n != null) : [];
        const wdFromText = (): number[] => {
          const t = (ctx.lastUserText ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
          if (!t) return [];
          const out: number[] = [];
          for (const [name, n] of Object.entries(WDMAP)) if (new RegExp(`\\b${name}s?\\b`).test(t)) out.push(n);
          return out;
        };
        const wdList = wdFromModel.length ? wdFromModel : wdFromText();
        const wantWD = wdList.length ? new Set(wdList) : null;
        const from = wantWD ? todayChile : input.fromDate && input.fromDate >= todayChile ? input.fromDate : todayChile;
        const plus = (days: number) => new Date(new Date(`${from}T00:00:00Z`).getTime() + days * 24 * 3600 * 1000).toISOString().slice(0, 10);
        // Ventana por defecto de 28 días: si el profesional está copado las próximas 2 semanas, con
        // 14 devolvía vacío y el agente escalaba. Con 28 encuentra el cupo más próximo.
        const wide = plus(28);
        const to = wantWD ? wide : input.toDate && input.toDate >= from ? input.toDate : plus(28);
        const sched = services(ctx).scheduling;
        // RESOLUCIÓN DE PROFESIONAL: el modelo a veces manda el NOMBRE ("Javier Hernán Aedo Mella",
        // "Dr. Aedo") en professionalId en vez del id. Cláriva, al recibir un id que no reconoce,
        // devuelve VACÍO → `all` vacío → sinCupos → el bot escala "no hay hasta [fin de ventana]"
        // HABIENDO horas (caso real Daisy: a las 12:16 con el id salían 8 horas incl. jueves 29; a las
        // 12:17 con el NOMBRE, sinCupos). Resolvemos nombre→id contra la lista real; si no se reconoce,
        // NO mandamos basura al proveedor (mejor consultar todos los habilitados que forzar un id inexistente).
        let resolvedProfId = input.professionalId;
        if (input.professionalId) {
          const pros = await sched.getProfessionals(ctx.clinicId ?? undefined).catch(() => []);
          if (pros.length && !pros.some((p) => p.id === input.professionalId)) {
            const norm = (s: string) =>
              (s ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/\b(dr|dra|doc|doctor|doctora)\.?/g, "").replace(/\s+/g, " ").trim();
            const ni = norm(input.professionalId);
            let m = ni ? pros.filter((p) => { const np = norm(p.name); return np === ni || np.includes(ni) || ni.includes(np); }) : [];
            if (m.length !== 1 && ni) {
              const toks = ni.split(" ").filter((t) => t.length >= 4);
              m = pros.filter((p) => { const np = norm(p.name); return toks.some((t) => np.includes(t)); });
            }
            // match único por nombre → su id; ambiguo o sin match → undefined (consulta todos los habilitados).
            resolvedProfId = m.length === 1 ? m[0].id : undefined;
          }
        }
        const query = { serviceId: input.serviceCode, professionalId: resolvedProfId, clinicId: ctx.clinicId ?? undefined, durationMin: input.durationMin };
        // FRANJA (hora de Chile): sin este filtro, el tope de opciones dejaba solo las horas más
        // tempranas y el modelo concluía "no hay tarde" aunque sí había.
        const hourChile = (iso: string) => parseInt(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Santiago", hour: "2-digit", hour12: false }).format(new Date(iso)), 10);
        const enFranja = (iso: string) => !input.franja || (input.franja === "manana" ? hourChile(iso) < 14 : hourChile(iso) >= 14);
        // HORA LÍMITE pedida por el paciente ("después de las 18", "más tarde de las 10", "antes de las
        // 12"): la FRANJA (mañana<14/tarde>=14) es demasiado gruesa para esto y el modelo la pasa mal
        // (caso Sandra: pidió "más tarde de las 10" y el bot le dijo "solo las 09:15" habiendo muchas
        // después de las 10). Extraemos la hora del TEXTO del paciente — determinista — y MANDA sobre la
        // franja. Así "después de las 18" devuelve TODO lo de 18:00 en adelante, sin importar la franja.
        const htext = (ctx.lastUserText ?? "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
        // Ajuste 12h→24h: "las 6 de la tarde/noche" = 18:00 (no 6:00).
        const adjHora = (numStr: string, tail: string): number => {
          let h = parseInt(numStr, 10);
          if (h < 12 && /\b(tarde|noche)\b/.test(tail)) h += 12;
          return Math.max(0, Math.min(24, h));
        };
        let minHora: number | null = null;
        let maxHora: number | null = null;
        let mMin = htext.match(/(?:despues|mas tarde|a partir|desde|pasad[ao]s?|como|tipo|a eso)\s+(?:de\s+)?las?\s+(\d{1,2})(?:[:.]\d{2})?\s*(de la (?:tarde|noche|manana)|pm|am)?/);
        if (!mMin) mMin = htext.match(/las?\s+(\d{1,2})(?:[:.]\d{2})?\s*(de la (?:tarde|noche|manana))?\s+(?:hrs?\.?\s+)?en adelante/);
        if (mMin) minHora = adjHora(mMin[1], mMin[2] ?? "");
        const mMax = htext.match(/(?:antes|hasta)\s+(?:de\s+)?las?\s+(\d{1,2})(?:[:.]\d{2})?\s*(de la (?:tarde|noche|manana)|pm|am)?/);
        if (mMax) maxHora = adjHora(mMax[1], mMax[2] ?? "");
        const hasHora = minHora != null || maxHora != null;
        const enHora = (iso: string) => {
          const h = hourChile(iso);
          if (minHora != null && h < minHora) return false;
          if (maxHora != null && h >= maxHora) return false;
          return true;
        };
        // Predicado de "hora del día": si el paciente dio hora Y franja, deben cumplirse AMBAS
        // ("mañana después de las 10" = 10:00–13:59). Si solo dio hora, manda la hora; si solo franja,
        // la franja; si nada, todo pasa.
        const enTramo = (iso: string) => (!hasHora || enHora(iso)) && enFranja(iso);
        const WDSHORT: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const wdChile = (iso: string) => WDSHORT[new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", weekday: "short" }).format(new Date(iso))] ?? -1;
        const enDia = (iso: string) => !wantWD || wantWD.has(wdChile(iso));
        // Traemos la ventana ancha UNA vez y aplicamos filtros progresivamente más laxos (sin más
        // llamadas al proveedor). RESPALDOS para NO devolver "sinCupos" si hay horas reales cerca:
        // el modelo interpretaba el vacío como "no hay nada" y escalaba/negaba días que ni consultó.
        const all = (await sched.getAvailableSlots({ ...query, from, to: wide })) ?? [];
        let slots = all.filter((s) => enTramo(s.start) && enDia(s.start) && (wantWD || s.start.slice(0, 10) <= to));
        let ensanchado = false;
        let tramoRelajado = false;
        let diaRelajado = false;
        if (!slots.length) {
          // 1) ensanchar fechas (toda la ventana), manteniendo tramo horario + día.
          slots = all.filter((s) => enTramo(s.start) && enDia(s.start));
          ensanchado = slots.length > 0;
        }
        if (!slots.length && (hasHora || input.franja)) {
          // 2) soltar el tramo horario (franja/hora), mantener el día pedido.
          slots = all.filter((s) => enDia(s.start));
          tramoRelajado = slots.length > 0;
        }
        if (!slots.length && wantWD) {
          // 3) soltar el día pedido (no había NADA ese día): ofrecer otros días reales (con tramo si se pidió).
          slots = all.filter((s) => enTramo(s.start));
          diaRelajado = slots.length > 0;
        }
        if (!slots.length) {
          // 4) soltar todo: cualquier hora real del rango.
          slots = all;
        }
        if (!slots.length) {
          // Vacío de verdad: NO hay NINGUNA hora en ~28 días. Recién aquí el modelo puede afirmar que
          // no hay disponibilidad y derivar a una persona.
          return {
            sinCupos: true,
            rangoConsultado: { desde: from, hasta: wide, ...(input.franja ? { franja: input.franja } : {}) },
            nota: `No hay NINGUNA hora disponible entre ${from} y ${wide} (ya revisé todo el rango, horarios y días). Discúlpate con calidez y deriva a una persona con transferToHuman para coordinar.`,
          };
        }
        // Orden cronológico garantizado (ISO ordena por fecha/hora).
        slots.sort((a, b) => a.start.localeCompare(b.start));
        // ABANICO POR DÍA: si hay cupos en VARIOS días, mostramos hasta 2 por día (8 en total)
        // para que el paciente vea varias FECHAS. Antes tomábamos las 6 más cercanas y se
        // apelotonaban en 1-2 días: el modelo concluía "no hay el viernes" cuando el viernes SÍ
        // tenía cupos, solo que quedaban fuera de las 6 primeras (caso David: ofreció mié/jue y
        // negó el viernes aunque había 4 horas). Si todos los cupos son del MISMO día (consulta
        // de un día puntual), mostramos las 6 primeras de ese día.
        const dayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
        const distinctDays = new Set(slots.map((s) => dayOf(s.start)));
        let chosen: typeof slots;
        if (distinctDays.size > 1) {
          const perDay = new Map<string, number>();
          chosen = [];
          for (const s of slots) {
            const d = dayOf(s.start);
            const n = perDay.get(d) ?? 0;
            if (n >= 2) continue;
            perDay.set(d, n + 1);
            chosen.push(s);
            if (chosen.length >= 8) break;
          }
        } else {
          chosen = slots.slice(0, 6);
        }
        const top = chosen.map((s) => ({ start: s.start, end: s.end, professionalId: s.professionalId, clinicId: s.clinicId, serviceId: s.serviceId }));
        const byId = putSlots(cacheKey(ctx), top);
        // Ids AUTODESCRIPTIVOS (h0409-1015 = 04-09 a las 10:15) + `cuando` legible. Para
        // agendar, pasa el id EXACTO del horario que eligió el paciente (la hora del id
        // debe coincidir con la elegida). No se exponen fecha/profesional crudos.
        const horas = [...byId.entries()].map(([id, s]) => ({ id, cuando: slotWhen.format(new Date(s.start)) }));
        // Notas OBLIGATORIAS para el modelo: la franja la define la CLÍNICA (mañana llega
        // hasta las 13:59 — el modelo descartaba un 13:15 "porque no le parecía mañana"),
        // y si se ensanchó el rango, debe decir la fecha de cada hora y no presentarlas
        // como si fueran del día pedido.
        const notas: string[] = [];
        // POSITIVIDAD (obligatoria): estas horas son REALES y disponibles AHORA. Ofrécelas TODAS con
        // entusiasmo. PROHIBIDO decir "solo tengo las 09:15" o "no hay disponibilidad" si esta lista
        // trae horas — nombra todas las que trae. Tu objetivo es ayudar a reservar, nunca cerrar puertas.
        notas.push("Estas son horas REALES disponibles: ofrécelas TODAS al paciente de forma positiva. NUNCA digas 'solo tengo una' ni 'no hay disponibilidad' si esta lista tiene horas; nombra las que aparecen.");
        if (hasHora && !tramoRelajado) {
          const cond = minHora != null && maxHora != null ? `entre las ${minHora}:00 y las ${maxHora}:00` : minHora != null ? `desde las ${minHora}:00 en adelante` : `antes de las ${maxHora}:00`;
          notas.push(`Estas horas cumplen lo que pidió el paciente (${cond}): ofrécelas indicando la fecha y hora exactas.`);
        }
        if (diaRelajado) {
          notas.push("No había cupos en los días que pediste; estas son las próximas horas REALES disponibles (de OTROS días): di la FECHA y HORA exactas de cada una y ofrécelas.");
        } else if (tramoRelajado) {
          notas.push("No había cupos exactamente en el horario que pidió, así que estas son las próximas horas REALES disponibles (otro horario u otros días): di la FECHA y HORA exactas de cada una y ofrécelas con una alternativa positiva.");
        } else if (input.franja && !hasHora) {
          notas.push(
            input.franja === "manana"
              ? "TODOS estos horarios SON de la franja MAÑANA según la política de la clínica (09:00–13:59): ofrécelos como horarios de mañana aunque alguno te parezca tarde (ej. 13:15 ES mañana)."
              : "TODOS estos horarios SON de la franja TARDE según la política de la clínica (desde las 14:00): ofrécelos como horarios de tarde.",
          );
        }
        if (wantWD && !diaRelajado) {
          notas.push("Estas horas SON de los días de la semana que pidió el paciente (ya resueltos a su fecha real): ofrécelas indicando la fecha exacta de cada una.");
        }
        if (ensanchado && !tramoRelajado && !diaRelajado && !wantWD) {
          notas.push(`OJO: no había cupos entre ${from} y ${to}; estas horas son de DÍAS SIGUIENTES — di la fecha exacta de cada una.`);
        }
        return { nota: notas.join(" "), horas };
      },
    },
    {
      name: "createAppointment",
      description:
        "Agenda una cita. Pasa en `slotId` el `id` del horario que eligió el paciente en getAvailability. El id codifica día y hora (h0409-1015 = día 04-09 a las 10:15): VERIFICA que la hora del id coincida EXACTAMENTE con la hora que pidió el paciente. NO inventes ni reconstruyas fecha, hora ni profesional. NUNCA pidas el teléfono al paciente: ya se usa automáticamente el número del chat.",
      inputSchema: z.object({
        slotId: z.string().describe("El `id` del slot elegido tal como lo dio getAvailability (ej. h0409-1015; su hora DEBE coincidir con la que eligió el paciente)"),
        notes: z.string().optional(),
        telefono: z.string().min(7).max(20).optional().describe("SOLO si el contacto no tiene teléfono registrado (canales como Instagram): el número que dio el paciente; se guarda y se usa para la cita"),
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
        let phone = contact.phone;
        // Canales SIN número propio (Instagram/Messenger): si el modelo trae el teléfono
        // que dio el paciente, se guarda en el contacto y se usa para la cita (caso
        // Meibel: el número quedaba en el chat pero nadie podía persistirlo).
        if (!phone && input.telefono) {
          const saved = await s.updateContactFields({ phone: String(input.telefono) });
          if (saved.phone) phone = saved.phone;
          else if (saved.error) return { error: saved.error };
        }
        if (!phone) {
          return { error: "El contacto no tiene teléfono registrado. Pídele su número al paciente y vuelve a llamar createAppointment pasándolo en el campo `telefono` (o guárdalo antes con updateContactFields.phone)." };
        }
        // El id corto se resuelve al slot real cacheado → fecha/profesional exactos.
        const slot = getSlot(convId, String(input.slotId ?? ""));
        if (!slot) {
          return { error: "No encuentro ese horario (o la lista ya venció). Llama de nuevo a getAvailability y pasa el `id` exacto del horario que eligió el paciente (ej. h0409-1015)." };
        }
        const end = slot.end ?? new Date(new Date(slot.start).getTime() + 30 * 60000).toISOString();
        // Firma de origen en el comentario de la cita: siempre se sabe qué agente agendó.
        // Sin duplicar "Agente" si el nombre del agente ya lo incluye.
        const nombreAgente = ctx.agentName ?? "IA";
        const firma = `Agendado por ${ctx.brandName ?? "TuBot"} · ${/^agente\b/i.test(nombreAgente) ? nombreAgente : `Agente ${nombreAgente}`}`;
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
              phone,
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
      name: "confirmAppointment",
      description:
        "Deja CONFIRMADA en la agenda la próxima cita del paciente cuando confirma su asistencia ('sí voy', 'confirmo', 'ahí estaré'). Sin parámetros confirma su cita próxima (lo normal). Si NO confirma sino que quiere cambiarla, NO uses esto: usa getAvailability + createAppointment para reagendar.",
      inputSchema: z.object({
        appointmentId: z.string().optional().describe("Id externo de la cita. Normalmente NO hace falta: sin él se confirma la próxima cita del paciente."),
      }),
      async execute(ctx, input: { appointmentId?: string }) {
        const s = services(ctx);
        const contact = await s.contactInfo();
        if (!contact.phone) return { error: "No tengo el teléfono del paciente, no puedo ubicar su cita." };
        const now = Date.now();
        let targetId = input.appointmentId;
        if (!targetId) {
          // Sin id: la próxima cita ACTIVA desde la PROYECCIÓN LOCAL (incluye rescheduled).
          const appts = await s.listContactAppointments().catch(() => [] as Awaited<ReturnType<ToolServices["listContactAppointments"]>>);
          const upcoming = appts
            .filter((a) => ["pending", "confirmed", "rescheduled"].includes(String(a.status).toLowerCase()) && new Date(a.start).getTime() >= now)
            .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
          const target = upcoming[0] ?? null;
          if (!target) return { error: "No encuentro una cita próxima a nombre del paciente. Pregúntale si quiere que agenden una." };
          targetId = target.id;
          if (String(target.status).toLowerCase() === "confirmed") {
            return { ok: true, alreadyConfirmed: true, cuando: slotWhen.format(new Date(target.start)), message: `Su cita del ${slotWhen.format(new Date(target.start))} ya estaba confirmada. Agradécele y cierra con calidez.` };
          }
        }
        let appt: SchedAppointment;
        try {
          appt = await s.scheduling.confirmAppointment(String(targetId));
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { error: `No pude confirmar la cita en la agenda (${msg.slice(0, 80)}). Discúlpate y dile que el equipo lo confirmará a la brevedad.` };
        }
        await s.recordAppointment(appt).catch(() => undefined);
        const cuando = slotWhen.format(new Date(appt.start));
        return { ok: true, cuando, appointment: appt, message: `Cita CONFIRMADA para ${cuando}. Confírmaselo al paciente con esa fecha/hora exacta y cierra con calidez (p. ej. "¡listo, te esperamos!").` };
      },
    },
    {
      name: "getPatientAppointments",
      description:
        "Lista las citas del paciente (id, fecha, profesional, servicio, estado, duración) desde la agenda. Úsala SIEMPRE al REAGENDAR/confirmar/no-show/recaptura ANTES que nada: te dice con QUÉ profesional, servicio y duración tenía su hora, para reagendar con el MISMO profesional y la MISMA duración. No pide parámetros.",
      inputSchema: z.object({}),
      async execute(ctx) {
        const s = services(ctx);
        const appts = await s.listContactAppointments().catch(() => [] as Awaited<ReturnType<ToolServices["listContactAppointments"]>>);
        if (!appts.length) {
          return { citas: [], message: "El paciente no tiene citas en la agenda. Si pide confirmar o reagendar y no aparece ninguna cita, deriva a una persona con transferToHuman (nota breve)." };
        }
        const now = Date.now();
        // Más reciente primero: la cita de referencia para reagendar es la última.
        const ordered = [...appts].sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
        const citas = ordered.map((a) => ({
          id: a.id,
          cuando: slotWhen.format(new Date(a.start)),
          estado: a.status,
          profesional: a.professionalName ?? a.professionalId ?? null,
          profesionalId: a.professionalId ?? null,
          servicio: a.serviceName ?? a.serviceId ?? null,
          servicioId: a.serviceId ?? null,
          duracionMin: a.durationMin,
          proxima: new Date(a.start).getTime() >= now,
        }));
        return {
          citas,
          message:
            "Para REAGENDAR: usa SIEMPRE el MISMO profesionalId y la MISMA duracionMin de su cita al llamar getAvailability (nunca otro profesional). Si getAvailability no devuelve cupos con su profesional (p. ej. su doctor no agenda por este medio), NO ofrezcas otro: deriva a una persona con transferToHuman.",
        };
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
        "Actualiza datos del contacto (nombre, apellido, email, teléfono) cuando el cliente los proporciona explícitamente. No inventes datos. El teléfono importa en canales SIN número propio (Instagram/Messenger): guárdalo aquí apenas el paciente lo dé.",
      inputSchema: z.object({
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        // El modelo a veces manda "" — se tolera y se ignora (antes reventaba con "Invalid email").
        email: z.string().email().optional().or(z.literal("")),
        phone: z.string().min(7).max(20).optional().describe("Teléfono del paciente tal como lo dio (se normaliza solo, ej. 976829853 → +56976829853)"),
      }),
      async execute(ctx, input: { firstName?: string; lastName?: string; email?: string; phone?: string }) {
        return services(ctx).updateContactFields({ ...input, email: input.email || undefined });
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

    // ===== Administración de agenda (F8) — SOLO modo dueño (ownerOnly). Doble cerrojo:
    // no se exponen ni ejecutan si el contacto no es el dueño del negocio. Toda escritura
    // reusa la lógica del agenda.controller (la IA no escribe directo). Para cambios que
    // afectan citas, PRIMERO resume y pide confirmación al dueño (ver prompt). =====
    {
      name: "upsertProfessional",
      description: "DUEÑO: da de alta o edita a quien atiende (persona o recurso). Para alta: name (y opcional specialty, durationMin). Para editar: id + los campos a cambiar (active:false lo da de baja).",
      ownerOnly: true,
      inputSchema: z.object({ id: z.string().optional(), name: z.string().min(1), specialty: z.string().optional(), type: z.enum(["persona", "servicio"]).optional(), durationMin: z.number().int().min(5).max(1440).optional(), active: z.boolean().optional() }),
      async execute(ctx, input: { id?: string; name: string; specialty?: string; type?: "persona" | "servicio"; durationMin?: number; active?: boolean }) {
        return services(ctx).adminUpsertProfessional(input);
      },
    },
    {
      name: "updateProfessionalSchedule",
      description: "DUEÑO: fija el horario semanal de una persona. workingHours = bloques [{day:0-6 (0=domingo), start:'HH:MM', end:'HH:MM'}]. Reemplaza el horario actual de esa persona.",
      ownerOnly: true,
      inputSchema: z.object({ professionalId: z.string(), workingHours: z.array(z.object({ day: z.number().int().min(0).max(6), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })).max(60) }),
      async execute(ctx, input: { professionalId: string; workingHours: Array<{ day: number; start: string; end: string }> }) {
        return services(ctx).adminUpdateProfessionalSchedule(input);
      },
    },
    {
      name: "addProfessionalTimeOff",
      description: "DUEÑO: bloquea un rango (vacaciones/feriado/ausencia) de una persona. from/to en ISO. Devuelve cuántas citas quedan afectadas en el rango para que ofrezcas reagendar o cancelar avisando.",
      ownerOnly: true,
      inputSchema: z.object({ professionalId: z.string(), from: z.string(), to: z.string(), reason: z.string().max(200).optional() }),
      async execute(ctx, input: { professionalId: string; from: string; to: string; reason?: string }) {
        return services(ctx).adminAddProfessionalTimeOff(input);
      },
    },
    {
      name: "updateBusinessHours",
      description: "DUEÑO: fija el horario de atención del local. businessHours = { mon:['09:00-13:00','15:00-19:00'], tue:[...], ... , sun:[] }.",
      ownerOnly: true,
      inputSchema: z.object({ businessHours: z.record(z.array(z.string())) }),
      async execute(ctx, input: { businessHours: Record<string, string[]> }) {
        return services(ctx).adminUpdateBusinessHours(input);
      },
    },
    {
      name: "updateServiceConfig",
      description: "DUEÑO: cambia la duración o el precio de un servicio (por id o por code). name opcional para renombrar.",
      ownerOnly: true,
      inputSchema: z.object({ serviceId: z.string().optional(), code: z.string().optional(), name: z.string().optional(), durationMin: z.number().int().min(5).max(1440).optional(), price: z.number().int().min(0).optional() }),
      async execute(ctx, input: { serviceId?: string; code?: string; name?: string; durationMin?: number; price?: number }) {
        return services(ctx).adminUpdateServiceConfig(input);
      },
    },
  ];
}
