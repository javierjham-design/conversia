import { resolveAgentByNameOrSlug, withTenant } from "@conversia/database";
import { ClarivaSchedulingProvider, DentalinkSchedulingProvider, MockSchedulingProvider } from "@conversia/scheduling";
import { fetchWebPageText, type ToolServices } from "@conversia/agents";
import type { CreateAppointmentInput, SchedAppointment, SchedulingProvider } from "@conversia/types";
import { decryptSecret } from "../common/crypto";

export interface SandboxContact {
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
}

export interface SimulatedAction {
  action: string;
  detail: string;
}

export interface SandboxState {
  contact: SandboxContact;
  /** Escrituras que el agente intentó — no se persisten, se muestran en la UI. */
  simulated: SimulatedAction[];
}

/**
 * ToolServices para el PROBADOR del editor de agentes.
 *
 * - Lecturas REALES: servicios, precios, profesionales, disponibilidad de
 *   agenda y base de conocimiento — los mismos datos que vería el agente en
 *   producción, para que la prueba sea fiel.
 * - Escrituras SIMULADAS: no se persiste NADA en la BD del tenant. Cada intento
 *   de escritura se registra en `state.simulated` (para mostrarlo) y el contacto
 *   se muta solo en memoria. Así el operador prueba el comportamiento del agente
 *   sin ensuciar conversaciones, leads ni la agenda reales.
 */
/** Mapea una fila de catalog_items a lo que el bot necesita (botDescription si existe). */
function sandboxCatalogHit(c: any) {
  return {
    name: c.name, sku: c.sku ?? null,
    price: c.price != null ? Number(c.price) : null,
    compareAtPrice: c.compareAtPrice != null ? Number(c.compareAtPrice) : null,
    currency: c.currency, available: c.available, stock: c.stock ?? null, category: c.category ?? null,
    description: c.botDescription || c.description || null,
    variants: Array.isArray(c.variants) ? c.variants : [], productUrl: c.productUrl ?? null, buyUrl: c.buyUrl ?? null,
    syncedAt: c.syncedAt ? new Date(c.syncedAt).toISOString() : null,
  };
}

export async function buildSandboxServices(
  orgId: string,
  state: SandboxState,
  opts: { knowledgeSources?: string[] | null; allowedProfessionalIds?: string[] | null } = {},
): Promise<ToolServices> {
  const knowledgeSources = opts.knowledgeSources;
  const track = (action: string, detail: string) => state.simulated.push({ action, detail });

  // Agenda del PROBADOR: se LEE disponibilidad REAL (Cláriva/Dentalink si está conectado;
  // si no, agenda nativa con los datos del tenant) y se SIMULA el agendar (no toca nada).
  const allowed = Array.isArray(opts.allowedProfessionalIds) && opts.allowedProfessionalIds.length ? new Set(opts.allowedProfessionalIds) : null;
  const simulateCreate = (input: CreateAppointmentInput): SchedAppointment =>
    // No registra aquí: recordAppointment (que llama la tool tras crear) ya marca la simulación.
    ({ id: `sim-${Date.now()}`, clinicId: input.clinicId, professionalId: input.professionalId, serviceId: input.serviceId, patient: input.patient, start: input.start, end: input.end, status: "pending", notes: input.notes });
  // Envuelve un proveedor: filtra disponibilidad por los profesionales habilitados del
  // agente y simula createAppointment (lecturas reales, escrituras simuladas).
  const scoped = (base: SchedulingProvider): SchedulingProvider => {
    const s = Object.create(base) as SchedulingProvider;
    const rawGet = base.getAvailableSlots.bind(base);
    s.getAvailableSlots = async (q) => {
      const slots = await rawGet(q);
      return allowed ? slots.filter((x) => !x.professionalId || allowed.has(x.professionalId)) : slots;
    };
    s.createAppointment = async (input) => simulateCreate(input);
    return s;
  };

  const conn = await withTenant(orgId, (tx) => tx.schedulingConnection.findFirst({ where: { status: "active" } }));
  let scheduling: SchedulingProvider;
  if (conn && (conn.provider === "CLARIVA" || conn.provider === "DENTALINK")) {
    const cred = conn.credentialId ? await withTenant(orgId, (tx) => tx.integrationCredential.findUnique({ where: { id: conn.credentialId! } })) : null;
    let apiKey = "";
    if (cred) { try { apiKey = decryptSecret(cred.ciphertext); } catch { /* ilegible */ } }
    const baseUrl = ((conn.config as Record<string, unknown> | null)?.baseUrl as string | undefined) ?? "";
    scheduling = scoped(conn.provider === "CLARIVA" ? new ClarivaSchedulingProvider({ baseUrl, apiKey }) : new DentalinkSchedulingProvider({ baseUrl, token: apiKey }));
  } else {
    const data = await withTenant(orgId, async (tx) => {
      const [clinics, professionals, services] = await Promise.all([
        tx.clinic.findMany({ where: { active: true, deletedAt: null } }),
        tx.professional.findMany({ where: { active: true } }),
        tx.service.findMany({ where: { active: true } }),
      ]);
      return { clinics, professionals, services };
    });
    scheduling = scoped(new MockSchedulingProvider({
      clinics: data.clinics.map((c) => ({ id: c.id, name: c.name, address: c.address ?? undefined, timezone: c.timezone })),
      professionals: data.professionals.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty ?? undefined })),
      services: data.services.map((s) => ({ id: s.code, name: s.name, durationMin: s.durationMin, price: s.price ? Number(s.price) : undefined, currency: s.currency })),
      utcOffset: "-04:00",
    }));
  }

  return {
    scheduling,

    async listServices() {
      return withTenant(orgId, async (tx) => {
        const services = await tx.service.findMany({ where: { active: true }, orderBy: { name: "asc" } });
        return services.map((s) => ({
          code: s.code,
          name: s.name,
          price: s.price ? Number(s.price) : null,
          currency: s.currency,
          durationMin: s.durationMin,
          category: s.category,
        }));
      });
    },

    async getServiceByCode(code: string) {
      return withTenant(orgId, async (tx) => {
        const s = await tx.service.findUnique({ where: { organizationId_code: { organizationId: orgId, code } } });
        if (!s || !s.active) return null;
        return {
          code: s.code,
          name: s.name,
          price: s.price ? Number(s.price) : null,
          currency: s.currency,
          durationMin: s.durationMin,
          description: s.description,
        };
      });
    },

    async listProfessionals(serviceCode?: string) {
      return withTenant(orgId, async (tx) => {
        if (serviceCode) {
          const svc = await tx.service.findUnique({ where: { organizationId_code: { organizationId: orgId, code: serviceCode } } });
          if (!svc) return [];
          const links = await tx.professionalService.findMany({ where: { serviceId: svc.id } });
          const pros = await tx.professional.findMany({ where: { id: { in: links.map((l) => l.professionalId) }, active: true } });
          return pros.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty }));
        }
        const pros = await tx.professional.findMany({ where: { active: true } });
        return pros.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty }));
      });
    },

    async contactInfo() {
      return { firstName: state.contact.firstName, lastName: state.contact.lastName, phone: state.contact.phone };
    },

    async searchKnowledge(query: string) {
      return withTenant(orgId, async (tx) => {
        const words = query.split(/\s+/).filter((w) => w.length > 3).slice(0, 4);
        const now = new Date();
        const docs = await tx.knowledgeDocument.findMany({
          where: {
            status: "PUBLISHED",
            ...(Array.isArray(knowledgeSources) ? { baseId: { in: knowledgeSources } } : {}),
            AND: [
              { OR: [{ validFrom: null }, { validFrom: { lte: now } }] },
              { OR: [{ validTo: null }, { validTo: { gte: now } }] },
            ],
            ...(words.length
              ? { OR: words.map((w) => ({ content: { contains: w, mode: "insensitive" as const } })) }
              : {}),
          },
          take: 3,
        });
        return docs.map((d) => ({ title: d.title, content: (d.content ?? "").slice(0, 1000) }));
      });
    },

    // ---------- Escrituras SIMULADAS (no tocan la BD) ----------

    async recordAppointment(appt: SchedAppointment) {
      track("Agendar cita", `${new Date(appt.start).toLocaleString("es-CL")} (simulada)`);
    },

    async listLeadStatuses() {
      const rows = await withTenant(orgId, (tx) =>
        tx.leadStatus.findMany({ where: { active: true }, orderBy: { order: "asc" }, select: { code: true, name: true } }),
      );
      return rows.map((r) => ({ code: r.code, name: r.name }));
    },

    async updateLeadStatus(code: string) {
      // Lectura real para validar que el estado existe; sin persistir el cambio.
      const status = await withTenant(orgId, (tx) =>
        tx.leadStatus.findUnique({ where: { organizationId_code: { organizationId: orgId, code } } }),
      );
      if (!status) throw new Error(`Estado de lead desconocido: ${code}`);
      track("Cambiar etapa del lead", status.name ?? code);
    },

    async addTag(name: string) {
      track("Etiquetar conversación", name);
    },

    async requestHumanHandoff(reason: string) {
      track("Escalar a un humano", reason);
    },

    async closeConversation() {
      track("Cerrar la conversación", "—");
    },

    async assignConversation(target: string, reason?: string) {
      // Lectura real para resolver el destino igual que producción (equipo → persona → AGENTE);
      // sin persistir. Si el destino es un agente, devuelve el marcador de transferencia; si no
      // resuelve a nada, LANZA (isError) tal como el runtime real, para que el probador no mienta.
      const outcome = await withTenant(orgId, async (tx) => {
        const team = await tx.team.findFirst({ where: { name: { equals: target, mode: "insensitive" } } });
        if (team) return { kind: "assigned" as const, label: `equipo ${team.name}` };
        const members = await tx.organizationUser.findMany({ where: { active: true }, include: { user: true } });
        const m = members.find((mm) => mm.user.name.toLowerCase() === target.toLowerCase());
        if (m) return { kind: "assigned" as const, label: m.user.name };
        const agent = await resolveAgentByNameOrSlug(tx, target);
        if (agent && agent.active) return { kind: "agent" as const, slug: agent.slug, name: agent.name };
        return { kind: "none" as const };
      });
      if (outcome.kind === "assigned") {
        track("Asignar / escalar", `${outcome.label}${reason ? ` — ${reason}` : ""}`);
        return { assignedTo: outcome.label };
      }
      if (outcome.kind === "agent") {
        track("Derivar a otro agente", outcome.name);
        return { handoffToAgentSlug: outcome.slug, message: `Derivando a ${outcome.name}` };
      }
      throw new Error(
        `No existe ningún equipo, persona ni agente llamado "${target}". La conversación NO se derivó: NO le confirmes al cliente que lo derivaste.`,
      );
    },

    async updateContactFields(fields: { firstName?: string; lastName?: string; email?: string }) {
      const updated: string[] = [];
      if (fields.firstName) { state.contact.firstName = fields.firstName; updated.push("nombre"); }
      if (fields.lastName) { state.contact.lastName = fields.lastName; updated.push("apellido"); }
      if (fields.email) { state.contact.email = fields.email; updated.push("email"); }
      if (updated.length) track("Actualizar datos del contacto", updated.join(", "));
      return { updated };
    },

    async triggerWorkflow(workflowName: string) {
      // Lectura real para validar que el flujo existe; sin dispararlo.
      const wf = await withTenant(orgId, (tx) =>
        tx.workflow.findFirst({ where: { name: { equals: workflowName, mode: "insensitive" } } }),
      );
      if (!wf) return { ok: false, error: `No existe un flujo llamado "${workflowName}"` };
      track("Disparar un flujo", wf.name);
      return { ok: true };
    },

    async addInternalNote(note: string) {
      track("Nota interna", note.length > 120 ? `${note.slice(0, 120)}…` : note);
    },
    async listPlans() {
      // Lectura REAL del catálogo global de planes (precios vigentes del Super Admin).
      const plans = await withTenant(orgId, (tx) => tx.plan.findMany({ where: { isPublic: true, active: true }, orderBy: { order: "asc" } }));
      return plans.map((p) => {
        const tm = (p.features as Record<string, unknown> | null)?.templateMessages;
        const lim = (p.limits as Record<string, unknown> | null) ?? {};
        const num = (v: unknown) => (typeof v === "number" ? v : null);
        return { code: p.code, name: p.name, priceClp: Number(p.priceClp), priceUsd: Number(p.priceUsd), priceClpYearly: p.priceClpYearly != null ? Number(p.priceClpYearly) : null, priceUsdYearly: p.priceUsdYearly != null ? Number(p.priceUsdYearly) : null, templateMessages: typeof tm === "number" ? tm : null, contactsMonthly: num(lim.contactsMonthly), aiTokensDaily: num(lim.aiTokensDaily), trialDays: p.trialDays || 7, isTrial: Number(p.priceClp) === 0 && Number(p.priceUsd) === 0 };
      });
    },
    async searchCatalog(input: { query: string; category?: string; maxPrice?: number; onlyAvailable?: boolean }) {
      // Lectura REAL del catálogo del tenant (búsqueda textual, igual que en producción).
      return withTenant(orgId, async (tx) => {
        const words = input.query.split(/\s+/).filter((w) => w.length > 2).slice(0, 6);
        const items = await tx.catalogItem.findMany({
          where: {
            active: true,
            ...(input.onlyAvailable ? { available: true } : {}),
            ...(input.category ? { category: { equals: input.category, mode: "insensitive" as const } } : {}),
            ...(input.maxPrice ? { price: { lte: input.maxPrice } } : {}),
            ...(words.length ? { OR: words.flatMap((w) => [{ name: { contains: w, mode: "insensitive" as const } }, { description: { contains: w, mode: "insensitive" as const } }, { botDescription: { contains: w, mode: "insensitive" as const } }, { category: { contains: w, mode: "insensitive" as const } }, { brand: { contains: w, mode: "insensitive" as const } }]) } : {}),
          },
          take: 8,
          orderBy: [{ available: "desc" }],
        });
        return items.map(sandboxCatalogHit);
      });
    },
    async getCatalogItem(idOrSku: string) {
      return withTenant(orgId, async (tx) => {
        const item = await tx.catalogItem.findFirst({ where: { active: true, OR: [{ id: idOrSku }, { sku: { equals: idOrSku, mode: "insensitive" } }, { name: { contains: idOrSku, mode: "insensitive" } }] }, orderBy: { available: "desc" } });
        return item ? sandboxCatalogHit(item) : null;
      });
    },
    async enviarLinkDePago(input: { monto: number; concepto: string }) {
      // Probador: NO genera un cobro real; registra la acción y devuelve un link simulado.
      track("Enviar link de pago", `$${input.monto} — ${input.concepto} (simulado, sin cobro real)`);
      return { ok: true, url: "https://www.flow.cl/app/web/pay.php?token=SIMULADO_EN_PRUEBA" };
    },
    async readWebPage(url: string) {
      // Lectura REAL (misma que producción): el probador debe reflejar lo que verá el agente.
      const r = await fetchWebPageText(url);
      return r.ok ? { url: r.url, title: r.title, text: r.text } : { error: r.error };
    },
    async recordContactMemory(input: { category: string; content: string }) {
      // En el PROBADOR no hay contacto real: se registra la acción para verla en la
      // traza, sin persistir en la ficha (evita ensuciar datos de un contacto real).
      const content = (input.content ?? "").trim();
      if (content.length < 2) return { saved: false };
      track("Anotar en la ficha del contacto", `[${input.category}] ${content.length > 120 ? `${content.slice(0, 120)}…` : content}`);
      return { saved: true };
    },
    // Montaje asistido: en el PROBADOR se simula (no toca ningún tenant real).
    async generateAssistedLink() {
      track("Enlace de montaje asistido", "(simulado)");
      return { url: "https://tubot.cl/montaje-asistido?t=SIMULADO" };
    },
    async redeemAssistedCode(code: string) {
      track("Vinculación por código", `${code} — simulado`);
      return { ok: true, orgName: "Cliente de prueba", channelName: "Canal de prueba" };
    },
    async assistedSetupState() {
      track("Estado del montaje del cliente", "(simulado)");
      return { authorized: true, state: { agents: 0, flows: 0, services: 0, knowledge: 0, journeyStep: null, journeyLabel: null } };
    },
    async setSetupStep(step: number, label: string) {
      track("Paso del montaje", `${step} — ${label} (simulado)`);
      return { ok: true, step };
    },
    async assistedUpsertAgent(input: { slug: string; name: string; systemPrompt: string }) {
      track("Agente del cliente configurado", `${input.name} (${input.systemPrompt.length} chars) — simulado`);
      return { ok: true, agentId: "sandbox" };
    },
  };
}
