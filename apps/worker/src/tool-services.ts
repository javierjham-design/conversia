import { getEnv } from "@conversia/config";
import { withTenant } from "@conversia/database";
import { emitPlatformEvent } from "./platform-events";
import { startWorkflowByName } from "./workflow-runtime";
import type { ToolServices } from "@conversia/agents";
import { ClarivaSchedulingProvider, MockSchedulingProvider } from "@conversia/scheduling";
import type { SchedAppointment, SchedulingProvider } from "@conversia/types";

/**
 * Mock de agenda por tenant, persistente durante la vida del proceso para
 * que la validación de doble reserva funcione entre mensajes.
 */
const mockProviders = new Map<string, MockSchedulingProvider>();

async function getSchedulingProviderFor(orgId: string): Promise<SchedulingProvider> {
  const env = getEnv();
  const connection = await withTenant(orgId, (tx) =>
    tx.schedulingConnection.findFirst({ where: { status: "active" } }),
  );
  const kind = connection?.provider ?? (env.SCHEDULING_PROVIDER === "clariva" ? "CLARIVA" : "MOCK");

  if (kind === "CLARIVA") {
    const cfg = (connection?.config ?? {}) as Record<string, string>;
    return new ClarivaSchedulingProvider({
      baseUrl: cfg.baseUrl ?? env.CLARIVA_BASE_URL,
      apiKey: cfg.apiKey ?? env.CLARIVA_API_KEY,
    });
  }

  let mock = mockProviders.get(orgId);
  if (!mock) {
    // El mock se alimenta con los datos REALES del tenant (sedes,
    // profesionales, servicios) — misma información que vería Cláriva.
    const data = await withTenant(orgId, async (tx) => {
      const [clinics, professionals, services] = await Promise.all([
        tx.clinic.findMany({ where: { active: true, deletedAt: null } }),
        tx.professional.findMany({ where: { active: true } }),
        tx.service.findMany({ where: { active: true } }),
      ]);
      return { clinics, professionals, services };
    });
    mock = new MockSchedulingProvider({
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
    mockProviders.set(orgId, mock);
  }
  return mock;
}

export interface ToolTargets {
  conversationId: string;
  contactId: string;
  clinicId?: string | null;
}

export interface ToolOptions {
  /** Bases de conocimiento habilitadas para el agente. undefined = todas. */
  knowledgeSources?: string[] | null;
}

/**
 * Construye los servicios que las tools de IA pueden usar. Cada método abre
 * su propia transacción withTenant: las tools se ejecutan FUERA de la
 * transacción que cargó la conversación (la llamada al modelo es lenta).
 */
export async function buildToolServices(orgId: string, t: ToolTargets, opts: ToolOptions = {}): Promise<ToolServices> {
  const scheduling = await getSchedulingProviderFor(orgId);
  const knowledgeSources = opts.knowledgeSources;

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
        const s = await tx.service.findUnique({
          where: { organizationId_code: { organizationId: orgId, code } },
        });
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
          const svc = await tx.service.findUnique({
            where: { organizationId_code: { organizationId: orgId, code: serviceCode } },
          });
          if (!svc) return [];
          const links = await tx.professionalService.findMany({ where: { serviceId: svc.id } });
          const pros = await tx.professional.findMany({
            where: { id: { in: links.map((l) => l.professionalId) }, active: true },
          });
          return pros.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty }));
        }
        const pros = await tx.professional.findMany({ where: { active: true } });
        return pros.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty }));
      });
    },

    async contactInfo() {
      return withTenant(orgId, async (tx) => {
        const c = await tx.contact.findUnique({ where: { id: t.contactId } });
        return { firstName: c?.firstName ?? null, lastName: c?.lastName ?? null, phone: c?.phone ?? null };
      });
    },

    async recordAppointment(appt: SchedAppointment) {
      await withTenant(orgId, async (tx) => {
        await tx.appointment.create({
          data: {
            organizationId: orgId,
            clinicId: t.clinicId ?? null,
            contactId: t.contactId,
            serviceId: null,
            provider: scheduling.kind === "clariva" ? "CLARIVA" : "MOCK",
            externalId: appt.id,
            status: "PENDING",
            startsAt: new Date(appt.start),
            endsAt: new Date(appt.end),
            conversationId: t.conversationId,
            meta: { professionalExternalId: appt.professionalId, serviceExternalId: appt.serviceId ?? null },
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: orgId,
            actorType: "agent",
            action: "appointment.create",
            entityType: "appointment",
            entityId: appt.id,
            after: appt as object,
          },
        });
      });
      await emitPlatformEvent(orgId, "appointment.created", {
        externalId: appt.id,
        start: appt.start,
        conversationId: t.conversationId,
      });
    },

    async updateLeadStatus(code: string) {
      await withTenant(orgId, async (tx) => {
        const status = await tx.leadStatus.findUnique({
          where: { organizationId_code: { organizationId: orgId, code } },
        });
        if (!status) throw new Error(`Estado de lead desconocido: ${code}`);
        let lead = await tx.lead.findFirst({
          where: { contactId: t.contactId },
          orderBy: { createdAt: "desc" },
        });
        if (!lead) {
          lead = await tx.lead.create({
            data: { organizationId: orgId, contactId: t.contactId, statusId: status.id },
          });
        } else {
          await tx.lead.update({ where: { id: lead.id }, data: { statusId: status.id } });
        }
        await tx.leadEvent.create({
          data: {
            organizationId: orgId,
            leadId: lead.id,
            type: "status_changed",
            data: { to: code },
            actorType: "agent",
          },
        });
        return lead.id;
      });
      const contact = await withTenant(orgId, (tx) =>
        tx.contact.findUnique({ where: { id: t.contactId }, select: { phone: true } }),
      );
      await emitPlatformEvent(
        orgId,
        "lead.status_changed",
        { statusCode: code, contactId: t.contactId, conversationId: t.conversationId },
        { contactPhone: contact?.phone ?? null },
      );
    },

    async addTag(name: string) {
      await withTenant(orgId, async (tx) => {
        const tag = await tx.tag.upsert({
          where: { organizationId_name: { organizationId: orgId, name } },
          update: {},
          create: { organizationId: orgId, name },
        });
        await tx.tagAssignment.upsert({
          where: {
            organizationId_tagId_entityType_entityId: {
              organizationId: orgId,
              tagId: tag.id,
              entityType: "conversation",
              entityId: t.conversationId,
            },
          },
          update: {},
          create: {
            organizationId: orgId,
            tagId: tag.id,
            entityType: "conversation",
            entityId: t.conversationId,
          },
        });
      });
    },

    async searchKnowledge(query: string) {
      // RAG v0: búsqueda textual sobre documentos publicados y vigentes.
      // (Búsqueda vectorial pgvector pendiente — requiere EMBEDDINGS_PROVIDER.)
      return withTenant(orgId, async (tx) => {
        const words = query.split(/\s+/).filter((w) => w.length > 3).slice(0, 4);
        const now = new Date();
        const docs = await tx.knowledgeDocument.findMany({
          where: {
            status: "PUBLISHED",
            // Fuentes habilitadas del agente. undefined = todas; [] = ninguna.
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

    async requestHumanHandoff(reason: string) {
      await withTenant(orgId, async (tx) => {
        await tx.conversation.update({ where: { id: t.conversationId }, data: { aiEnabled: false } });
        await tx.humanHandoff.create({
          data: {
            organizationId: orgId,
            conversationId: t.conversationId,
            requestedBy: "agent",
            reason,
            status: "PENDING",
          },
        });
        await tx.auditLog.create({
          data: {
            organizationId: orgId,
            actorType: "agent",
            action: "conversation.human_handoff",
            entityType: "conversation",
            entityId: t.conversationId,
            after: { reason },
          },
        });
      });
      await emitPlatformEvent(orgId, "human_handoff.requested", {
        conversationId: t.conversationId,
        reason,
      });
    },

    async closeConversation() {
      await withTenant(orgId, async (tx) => {
        await tx.conversation.update({ where: { id: t.conversationId }, data: { status: "CLOSED" } });
        await tx.auditLog.create({
          data: { organizationId: orgId, actorType: "agent", action: "conversation.closed", entityType: "conversation", entityId: t.conversationId },
        });
      });
      await emitPlatformEvent(orgId, "conversation.closed", { conversationId: t.conversationId });
    },

    async assignConversation(target: string, reason?: string) {
      return withTenant(orgId, async (tx) => {
        const team = await tx.team.findFirst({ where: { name: { equals: target, mode: "insensitive" } } });
        if (team) {
          await tx.conversation.update({ where: { id: t.conversationId }, data: { assignedTeamId: team.id, aiEnabled: false } });
          await tx.auditLog.create({
            data: { organizationId: orgId, actorType: "agent", action: "conversation.assigned_team", entityType: "conversation", entityId: t.conversationId, after: { team: team.name, reason } },
          });
          return { assignedTo: `equipo ${team.name}` };
        }
        const members = await tx.organizationUser.findMany({ where: { active: true }, include: { user: true } });
        const m = members.find((mm) => mm.user.name.toLowerCase() === target.toLowerCase());
        if (m) {
          await tx.conversation.update({ where: { id: t.conversationId }, data: { assignedUserId: m.userId, aiEnabled: false } });
          await tx.auditLog.create({
            data: { organizationId: orgId, actorType: "agent", action: "conversation.assigned_user", entityType: "conversation", entityId: t.conversationId, after: { user: m.user.name, reason } },
          });
          return { assignedTo: m.user.name };
        }
        return { error: `No encontré un equipo o persona llamada "${target}"` };
      });
    },

    async updateContactFields(fields: { firstName?: string; lastName?: string; email?: string }) {
      const data: Record<string, string> = {};
      if (fields.firstName) data.firstName = fields.firstName;
      if (fields.lastName) data.lastName = fields.lastName;
      if (fields.email) data.email = fields.email;
      const updated = Object.keys(data);
      if (updated.length) {
        await withTenant(orgId, (tx) => tx.contact.update({ where: { id: t.contactId }, data }));
      }
      return { updated };
    },

    async triggerWorkflow(workflowName: string) {
      return startWorkflowByName(orgId, workflowName, { conversationId: t.conversationId, contactId: t.contactId });
    },

    async addInternalNote(note: string) {
      await withTenant(orgId, (tx) =>
        tx.message.create({
          data: {
            organizationId: orgId,
            conversationId: t.conversationId,
            direction: "OUTBOUND",
            type: "NOTE",
            visibility: "INTERNAL",
            body: note,
            authorType: "AGENT",
            status: "DELIVERED",
          },
        }),
      );
    },
  };
}
