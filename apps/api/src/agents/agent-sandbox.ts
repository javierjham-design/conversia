import { withTenant } from "@conversia/database";
import { MockSchedulingProvider } from "@conversia/scheduling";
import type { ToolServices } from "@conversia/agents";
import type { SchedAppointment } from "@conversia/types";

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
export async function buildSandboxServices(
  orgId: string,
  state: SandboxState,
  opts: { knowledgeSources?: string[] | null } = {},
): Promise<ToolServices> {
  const knowledgeSources = opts.knowledgeSources;
  // Agenda mock alimentada con datos REALES del tenant (idéntica a la de
  // producción cuando no hay proveedor externo). createAppointment queda en
  // memoria del mock; recordAppointment (que sí escribiría en BD) es no-op.
  const data = await withTenant(orgId, async (tx) => {
    const [clinics, professionals, services] = await Promise.all([
      tx.clinic.findMany({ where: { active: true, deletedAt: null } }),
      tx.professional.findMany({ where: { active: true } }),
      tx.service.findMany({ where: { active: true } }),
    ]);
    return { clinics, professionals, services };
  });
  const scheduling = new MockSchedulingProvider({
    clinics: data.clinics.map((c) => ({ id: c.id, name: c.name, address: c.address ?? undefined, timezone: c.timezone })),
    professionals: data.professionals.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty ?? undefined })),
    services: data.services.map((s) => ({
      id: s.code,
      name: s.name,
      durationMin: s.durationMin,
      price: s.price ? Number(s.price) : undefined,
      currency: s.currency,
    })),
    utcOffset: "-04:00",
  });

  const track = (action: string, detail: string) => state.simulated.push({ action, detail });

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
      // Lectura real para resolver el destino; sin persistir la asignación.
      const found = await withTenant(orgId, async (tx) => {
        const team = await tx.team.findFirst({ where: { name: { equals: target, mode: "insensitive" } } });
        if (team) return `equipo ${team.name}`;
        const members = await tx.organizationUser.findMany({ where: { active: true }, include: { user: true } });
        const m = members.find((mm) => mm.user.name.toLowerCase() === target.toLowerCase());
        return m ? m.user.name : null;
      });
      if (!found) return { error: `No encontré un equipo o persona llamada "${target}"` };
      track("Asignar / derivar", `${found}${reason ? ` — ${reason}` : ""}`);
      return { assignedTo: found };
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
    // Montaje asistido: en el PROBADOR se simula (no toca ningún tenant real).
    async generateAssistedLink() {
      track("Enlace de montaje asistido", "(simulado)");
      return { url: "https://tubot.cl/montaje-asistido?t=SIMULADO" };
    },
    async assistedSetupState() {
      track("Estado del montaje del cliente", "(simulado)");
      return { authorized: true, state: { agents: 0, flows: 0, services: 0, knowledge: 0 } };
    },
    async assistedUpsertAgent(input: { slug: string; name: string; systemPrompt: string }) {
      track("Agente del cliente configurado", `${input.name} (${input.systemPrompt.length} chars) — simulado`);
      return { ok: true, agentId: "sandbox" };
    },
  };
}
