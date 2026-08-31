import { createHash, createHmac } from "node:crypto";
import { getEnv } from "@conversia/config";
import { getAdminPrisma, resolveAgentByNameOrSlug, withTenant } from "@conversia/database";
import { openAssistedSetup } from "./assisted-setup";

/** Firma un JWT HS256 estándar (sin dependencias) — lo verifica el API con jsonwebtoken. */
function signHs256(payload: Record<string, unknown>, secret: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/** Hash del código de vinculación — DEBE coincidir con el del API (mayúsculas, sin separadores). */
function hashRedeemCode(raw: string): string {
  return createHash("sha256").update(raw.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
}
import { enqueueEscalationEmail } from "./mailer";
import { enqueueCalendarSync } from "./google-calendar";
import { emitPlatformEvent } from "./platform-events";
import { dispatchEvent, scheduleAppointmentReminders, startWorkflowByName } from "./workflow-runtime";
import { fetchWebPageText, type ToolServices } from "@conversia/agents";
import { ClarivaSchedulingProvider, CustomSchedulingProvider, DentalinkSchedulingProvider, NativeSchedulingProvider } from "@conversia/scheduling";
import { decryptCredential } from "./credentials";
import type { SchedAppointment, SchedulingProvider } from "@conversia/types";

export async function getSchedulingProviderFor(orgId: string): Promise<SchedulingProvider> {
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

  // Agenda PERSONALIZADA: el sistema del tenant implementa el contrato estándar
  // (mismos endpoints que Cláriva) firmado con HMAC. Secreto cifrado.
  if (kind === "CUSTOM" && connection) {
    const cfg = (connection.config ?? {}) as Record<string, string>;
    let secret = "";
    if (connection.credentialId) {
      const cred = await withTenant(orgId, (tx) =>
        tx.integrationCredential.findUnique({ where: { id: connection.credentialId! } }),
      );
      if (cred) {
        try {
          secret = decryptCredential(cred.ciphertext);
        } catch {
          /* secreto ilegible → las llamadas fallarán con firma inválida */
        }
      }
    }
    return new CustomSchedulingProvider({ baseUrl: cfg.baseUrl ?? "", secret });
  }

  // Dentalink (Healthatom): token por tenant cifrado + ventana laboral configurable.
  if (kind === "DENTALINK" && connection) {
    const cfg = (connection.config ?? {}) as Record<string, unknown>;
    let token = "";
    if (connection.credentialId) {
      const cred = await withTenant(orgId, (tx) =>
        tx.integrationCredential.findUnique({ where: { id: connection.credentialId! } }),
      );
      if (cred) {
        try {
          token = decryptCredential(cred.ciphertext);
        } catch {
          /* token ilegible → las llamadas fallarán con 401 */
        }
      }
    }
    return new DentalinkSchedulingProvider({
      token,
      workStartHour: cfg.workStartHour ? Number(cfg.workStartHour) : undefined,
      workEndHour: cfg.workEndHour ? Number(cfg.workEndHour) : undefined,
      slotMinutes: cfg.slotMinutes ? Number(cfg.slotMinutes) : undefined,
      utcOffset: typeof cfg.utcOffset === "string" ? cfg.utcOffset : undefined,
    });
  }

  // AGENDA NATIVA de TuBot (default cuando no hay proveedor externo conectado):
  // disponibilidad REAL desde los horarios de cada persona + las citas ya tomadas.
  // Se reconstruye en cada llamada (sin caché) para reflejar las citas actuales.
  const data = await withTenant(orgId, async (tx) => {
    const now = new Date();
    const [org, clinics, professionals, services, appts] = await Promise.all([
      tx.organization.findUnique({ where: { id: orgId }, select: { settings: true, timezone: true } }),
      tx.clinic.findMany({ where: { active: true, deletedAt: null } }),
      tx.professional.findMany({ where: { active: true } }),
      tx.service.findMany({ where: { active: true } }),
      tx.appointment.findMany({
        where: { startsAt: { gte: now }, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
        select: { professionalId: true, startsAt: true, endsAt: true },
      }),
    ]);
    return { org, clinics, professionals, services, appts };
  });
  const agenda = ((data.org?.settings as Record<string, unknown> | null)?.agenda ?? {}) as {
    slotStepMin?: number; bufferMin?: number; minAdvanceMin?: number; offset?: string;
  };
  return new NativeSchedulingProvider({
    clinics: data.clinics.map((c) => ({ id: c.id, name: c.name, address: c.address ?? undefined, timezone: c.timezone })),
    professionals: data.professionals.map((p) => {
      const m = (p.meta as any) ?? {};
      const wh = m.workingHours;
      return {
        id: p.id,
        name: p.name,
        specialty: p.specialty ?? undefined,
        workingHours: Array.isArray(wh) ? (wh as { day: number; start: string; end: string }[]) : [],
        defaultDurationMin: typeof m.durationMin === "number" ? m.durationMin : undefined,
      };
    }),
    services: data.services.map((s) => ({ id: s.code, name: s.name, durationMin: s.durationMin, price: s.price ? Number(s.price) : undefined, currency: s.currency })),
    busy: data.appts
      .filter((a) => a.professionalId)
      .map((a) => ({ professionalId: a.professionalId as string, start: a.startsAt.toISOString(), end: a.endsAt.toISOString() })),
    config: { slotStepMin: agenda.slotStepMin, bufferMin: agenda.bufferMin, minAdvanceMin: agenda.minAdvanceMin, offset: agenda.offset ?? "-04:00" },
  });
}

export interface ToolTargets {
  conversationId: string;
  contactId: string;
  clinicId?: string | null;
  /** Agente activo del turno (trazabilidad de quién anota en la memoria del contacto). */
  agentId?: string | null;
}

export interface ToolOptions {
  /** Bases de conocimiento habilitadas para el agente. undefined = todas. */
  knowledgeSources?: string[] | null;
  /** Profesionales/recursos con los que ESTE agente puede agendar. Vacío/undefined = todos. */
  allowedProfessionalIds?: string[] | null;
}

/**
 * Construye los servicios que las tools de IA pueden usar. Cada método abre
 * su propia transacción withTenant: las tools se ejecutan FUERA de la
 * transacción que cargó la conversación (la llamada al modelo es lenta).
 */
/**
 * Resuelve el org del CLIENTE al que corresponde el montaje asistido de ESTA
 * conversación: solo si el agente corre en el tenant de TuBot (proveedor) y existe
 * un grant ACTIVO y vigente ligado al contacto de la conversación. Lectura admin
 * (cross-tenant por diseño, como la resolución de tenant); si no hay grant → null.
 */
async function resolveAssistedClientOrg(
  agentOrgId: string,
  contactId: string | null | undefined,
): Promise<{ id: string; orgId: string; scopeChannelId: string | null; journeyStep: number | null; journeyLabel: string | null } | null> {
  const providerOrgId = getEnv().ASSISTED_SETUP_PROVIDER_ORG_ID;
  if (!contactId || agentOrgId !== providerOrgId) return null;
  const admin = getAdminPrisma();
  const grant = await admin.assistedSetupGrant.findFirst({
    where: {
      grantedByOrganizationId: providerOrgId,
      linkedProviderContactId: contactId,
      status: "active",
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, organizationId: true, scopeChannelId: true, journeyStep: true, journeyLabel: true },
  });
  return grant
    ? { id: grant.id, orgId: grant.organizationId, scopeChannelId: grant.scopeChannelId, journeyStep: grant.journeyStep, journeyLabel: grant.journeyLabel }
    : null;
}

/**
 * Bloque para el system prompt del agente de implementación: si el contacto YA vinculó
 * su cuenta (grant activo, válido 14 días), le dice al agente que NO vuelva a pedir el
 * código y desde qué paso continuar. Sin esto el agente re-pedía el código en cada turno
 * porque el vínculo solo se resolvía dentro de una tool, no al armar el prompt. Devuelve
 * "" si no hay vínculo (o el agente no es el de montaje del proveedor).
 */
export async function buildAssistedSetupStatusBlock(
  agentOrgId: string,
  contactId: string | null | undefined,
): Promise<string> {
  const linked = await resolveAssistedClientOrg(agentOrgId, contactId);
  if (!linked) return "";
  const admin = getAdminPrisma();
  const [org, ch] = await Promise.all([
    admin.organization.findUnique({ where: { id: linked.orgId }, select: { name: true, status: true, settings: true, createdAt: true } }),
    linked.scopeChannelId ? admin.channelConnection.findUnique({ where: { id: linked.scopeChannelId }, select: { name: true } }) : Promise.resolve(null),
  ]);
  const empresa = org?.name ?? "la empresa del cliente";
  const canal = ch?.name ? ` (canal «${ch.name}»)` : "";
  const paso = linked.journeyLabel ?? (linked.journeyStep ? `paso ${linked.journeyStep} del montaje` : "donde quedaron");
  return (
    `\n\n## MONTAJE ASISTIDO — YA VINCULADO (NO vuelvas a pedir el código)\n` +
    `Este cliente YA autorizó y vinculó su cuenta: «${empresa}»${canal}. El vínculo está ACTIVO (válido 14 días). ` +
    `NO pidas otro código ni repitas el flujo de autorización: ya tienes acceso. Usa directamente tus herramientas ` +
    `de montaje (getClientSetupState, upsertClientAgent, etc.) y continúa desde ${paso}. ` +
    `Solo si una herramienta te responde que el vínculo venció o fue revocado, recién ahí pídele un código nuevo.` +
    buildTrialPhaseBlock(org)
  );
}

/**
 * Fase de la cuenta del CLIENTE (prueba vs activa) + días/horas de prueba restantes, para
 * que el agente de implementación dé urgencia real y empuje la activación en el momento
 * justo. Replica el cálculo de la prueba de 7 días de la API (billing): si aún no se fijó
 * settings.trial, cae a createdAt+7d. Muestra HORAS cuando queda menos de un día.
 */
function buildTrialPhaseBlock(
  org: { status: string; settings: unknown; createdAt: Date } | null,
): string {
  if (!org) return "";
  if (org.status === "TRIAL") {
    const trial = (org.settings as Record<string, any> | null)?.trial as { endsAt?: string } | undefined;
    const endsAt = new Date(trial?.endsAt ?? new Date(org.createdAt).getTime() + 7 * 86_400_000);
    const ms = endsAt.getTime() - Date.now();
    let restante: string;
    if (ms <= 0) {
      restante = "su prueba está por terminar (hoy mismo)";
    } else {
      const horas = Math.ceil(ms / 3_600_000);
      restante = horas <= 24 ? `le queda${horas === 1 ? "" : "n"} ${horas} hora${horas === 1 ? "" : "s"} de prueba` : `le quedan ${Math.ceil(horas / 24)} días de prueba`;
    }
    return (
      `\n\n## FASE DE LA CUENTA DEL CLIENTE — EN PRUEBA\n` +
      `El cliente está en FASE DE PRUEBA: ${restante} antes de que su prueba termine y su asistente se pause. ` +
      `Tenlo presente y recuérdaselo con naturalidad cuando calce, empujándolo a activar un plan ANTES de que venza ` +
      `(sin agobiar); mientras menos tiempo quede, más directo. Al activar NO pierde nada de lo que montaron juntos.`
    );
  }
  if (org.status === "ACTIVE") {
    return (
      `\n\n## FASE DE LA CUENTA DEL CLIENTE — ACTIVA\n` +
      `El cliente YA activó su plan (no está en prueba). No lo empujes a activar; enfócate en dejar su montaje impecable.`
    );
  }
  return "";
}

/** Mapea una fila de catalog_items a lo que el bot necesita (usa botDescription si existe). */
function toCatalogHit(c: {
  name: string; sku: string | null; price: unknown; compareAtPrice: unknown; currency: string;
  available: boolean; stock: number | null; category: string | null; description: string | null;
  botDescription: string | null; variants: unknown; productUrl: string | null; buyUrl: string | null;
  syncedAt?: Date | null;
}) {
  return {
    name: c.name,
    sku: c.sku ?? null,
    price: c.price != null ? Number(c.price) : null,
    compareAtPrice: c.compareAtPrice != null ? Number(c.compareAtPrice) : null,
    currency: c.currency,
    available: c.available,
    stock: c.stock ?? null,
    category: c.category ?? null,
    description: c.botDescription || c.description || null,
    variants: Array.isArray(c.variants) ? c.variants : [],
    productUrl: c.productUrl ?? null,
    buyUrl: c.buyUrl ?? null,
    syncedAt: c.syncedAt ? c.syncedAt.toISOString() : null,
  };
}

/** Fuentes con proveedor en vivo (se pueden re-sincronizar). Manual/CSV no. */
const LIVE_CATALOG_SOURCES = new Set(["woocommerce", "jumpseller", "shopify", "bsale", "fudo"]);
const CATALOG_FRESHNESS_MS = 20 * 60 * 1000; // 20 min

/** Tiempo real capa 3 (self-heal): si un producto leído está viejo y viene de un proveedor
 * en vivo, dispara un sync incremental debounced para refrescarlo (no bloquea la respuesta). */
async function refreshIfStale(orgId: string, source: string, syncedAt: Date | null): Promise<void> {
  if (!LIVE_CATALOG_SOURCES.has(source)) return;
  if (syncedAt && Date.now() - syncedAt.getTime() < CATALOG_FRESHNESS_MS) return;
  try {
    const { getSyncQueue } = await import("./ga4.js");
    await getSyncQueue().add(
      "catalog",
      { organizationId: orgId, kind: "catalog_sync", payload: { source, mode: "incremental" } },
      { jobId: `catalog_livecheck:${orgId}:${source}`, delay: 3000, removeOnComplete: true, removeOnFail: 200 },
    );
  } catch {
    /* refresco best-effort: nunca romper la respuesta del agente */
  }
}

export async function buildToolServices(orgId: string, t: ToolTargets, opts: ToolOptions = {}): Promise<ToolServices> {
  const rawScheduling = await getSchedulingProviderFor(orgId);
  const knowledgeSources = opts.knowledgeSources;

  // Segmentación POR AGENTE: si el agente tiene una lista de profesionales/recursos
  // habilitados, el bot solo ve disponibilidad de esos y no puede reservar con otro.
  const allowed = Array.isArray(opts.allowedProfessionalIds) && opts.allowedProfessionalIds.length ? new Set(opts.allowedProfessionalIds) : null;
  let scheduling = rawScheduling;
  if (allowed) {
    const scoped = Object.create(rawScheduling) as SchedulingProvider;
    scoped.getAvailableSlots = async (q) => {
      const wanted = q.professionalId && !allowed.has(q.professionalId) ? [] : await rawScheduling.getAvailableSlots(q);
      return wanted.filter((s) => !s.professionalId || allowed.has(s.professionalId));
    };
    scoped.createAppointment = async (input) => {
      if (input.professionalId && !allowed.has(input.professionalId)) {
        throw new Error("Ese profesional no está habilitado para agendar con este agente");
      }
      return rawScheduling.createAppointment(input);
    };
    scheduling = scoped;
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
        const ids = serviceCode
          ? await tx.service
              .findUnique({ where: { organizationId_code: { organizationId: orgId, code: serviceCode } } })
              .then(async (svc) => (svc ? (await tx.professionalService.findMany({ where: { serviceId: svc.id } })).map((l) => l.professionalId) : null))
          : undefined;
        if (ids === null) return []; // servicio no encontrado
        const pros = await tx.professional.findMany({ where: { active: true, ...(ids ? { id: { in: ids } } : {}) } });
        return pros.filter((p) => !allowed || allowed.has(p.id)).map((p) => ({ id: p.id, name: p.name, specialty: p.specialty }));
      });
    },

    async contactInfo() {
      return withTenant(orgId, async (tx) => {
        const c = await tx.contact.findUnique({ where: { id: t.contactId } });
        return { firstName: c?.firstName ?? null, lastName: c?.lastName ?? null, phone: c?.phone ?? null };
      });
    },

    async recordAppointment(appt: SchedAppointment) {
      const created = await withTenant(orgId, async (tx) => {
        const row = await tx.appointment.create({
          data: {
            organizationId: orgId,
            clinicId: t.clinicId ?? null,
            contactId: t.contactId,
            serviceId: null,
            provider:
              scheduling.kind === "clariva" ? "CLARIVA" : scheduling.kind === "custom" ? "CUSTOM" : scheduling.kind === "dentalink" ? "DENTALINK" : "MOCK",
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
        return row;
      });
      await enqueueCalendarSync(orgId, created.id, "upsert");
      await emitPlatformEvent(orgId, "appointment.created", {
        externalId: appt.id,
        start: appt.start,
        conversationId: t.conversationId,
      });
      // Dispara workflows "Cita creada" y programa los recordatorios configurados.
      await dispatchEvent({
        organizationId: orgId,
        type: "appointment_created",
        conversationId: t.conversationId,
        contactId: t.contactId,
        data: { externalId: appt.id, startsAt: appt.start },
        occurredAt: new Date().toISOString(),
      });
      await scheduleAppointmentReminders(orgId, { id: appt.id, start: appt.start }, { conversationId: t.conversationId, contactId: t.contactId });
    },

    async listLeadStatuses() {
      return withTenant(orgId, async (tx) => {
        const rows = await tx.leadStatus.findMany({ where: { active: true }, orderBy: { order: "asc" }, select: { code: true, name: true } });
        return rows.map((r) => ({ code: r.code, name: r.name }));
      });
    },

    async updateLeadStatus(code: string) {
      const fromCode = await withTenant(orgId, async (tx) => {
        const status = await tx.leadStatus.findUnique({
          where: { organizationId_code: { organizationId: orgId, code } },
        });
        if (!status) throw new Error(`Estado de lead desconocido: ${code}`);
        let lead = await tx.lead.findFirst({
          where: { contactId: t.contactId },
          orderBy: { createdAt: "desc" },
          include: { status: true },
        });
        const prev = lead?.status?.code ?? null;
        const prevName = lead?.status?.name ?? null;
        if (!lead) {
          lead = await tx.lead.create({
            data: { organizationId: orgId, contactId: t.contactId, statusId: status.id },
            include: { status: true },
          });
        } else {
          await tx.lead.update({ where: { id: lead.id }, data: { statusId: status.id } });
        }
        await tx.leadEvent.create({
          data: {
            organizationId: orgId,
            leadId: lead.id,
            type: "status_changed",
            data: { from: prev, to: code },
            actorType: "agent",
          },
        });
        // Nota interna en la conversación (trazabilidad para el equipo) cuando cambia de verdad.
        if (prev !== code && t.conversationId) {
          await tx.message.create({
            data: {
              organizationId: orgId,
              conversationId: t.conversationId,
              direction: "OUTBOUND",
              type: "NOTE",
              visibility: "INTERNAL",
              body: `🔀 Etapa del lead: ${prevName ?? "—"} → ${status.name} (cambiada por el bot)`,
              authorType: "AGENT",
              status: "DELIVERED",
            },
          });
        }
        return prev;
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
      await dispatchEvent({
        organizationId: orgId,
        type: "lead_status_changed",
        conversationId: t.conversationId,
        contactId: t.contactId,
        data: { statusCode: code, fromCode },
        occurredAt: new Date().toISOString(),
      });
    },

    async addTag(name: string) {
      const created = await withTenant(orgId, async (tx) => {
        const tag = await tx.tag.upsert({
          where: { organizationId_name: { organizationId: orgId, name } },
          update: {},
          create: { organizationId: orgId, name },
        });
        const existing = await tx.tagAssignment.findUnique({
          where: {
            organizationId_tagId_entityType_entityId: {
              organizationId: orgId,
              tagId: tag.id,
              entityType: "conversation",
              entityId: t.conversationId,
            },
          },
        });
        if (existing) return false;
        await tx.tagAssignment.create({
          data: {
            organizationId: orgId,
            tagId: tag.id,
            entityType: "conversation",
            entityId: t.conversationId,
          },
        });
        return true;
      });
      // Solo la asignación nueva dispara tag_added (evita re-disparos al re-etiquetar).
      if (created) {
        await emitPlatformEvent(orgId, "tag.added", { tag: name, conversationId: t.conversationId, contactId: t.contactId });
        await dispatchEvent({
          organizationId: orgId,
          type: "tag_added",
          conversationId: t.conversationId,
          contactId: t.contactId,
          data: { tag: name },
          occurredAt: new Date().toISOString(),
        });
      }
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
      const handoff = await withTenant(orgId, async (tx) => {
        await tx.conversation.update({ where: { id: t.conversationId }, data: { aiEnabled: false } });
        const h = await tx.humanHandoff.create({
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
        return h;
      });
      await emitPlatformEvent(orgId, "human_handoff.requested", {
        conversationId: t.conversationId,
        reason,
      });
      // Push/campana al equipo: la IA escaló a un humano (evento crítico del catálogo).
      try {
        const conv = await withTenant(orgId, (tx) =>
          tx.conversation.findUnique({
            where: { id: t.conversationId },
            select: { assignedUserId: true, assignedTeamId: true, contact: { select: { firstName: true, lastName: true, profileName: true, phone: true } } },
          }),
        );
        const c = conv?.contact;
        const contactName = [c?.firstName, c?.lastName].filter(Boolean).join(" ") || c?.profileName || c?.phone || "Un contacto";
        const { enqueueNotification } = await import("./notifications/queue.js");
        await enqueueNotification({
          eventKey: "ai.escalation",
          organizationId: orgId,
          context: { assignedUserId: conv?.assignedUserId ?? null, teamId: conv?.assignedTeamId ?? null, conversationId: t.conversationId },
          conversationId: t.conversationId,
          data: { contactName, reason: reason.slice(0, 120), conversationId: t.conversationId },
        });
      } catch (err) {
        console.error(`✖ Aviso de escalamiento (${t.conversationId}):`, (err as Error).message);
      }
      // Aviso por correo si nadie la toma en X min (config de correo del tenant).
      await enqueueEscalationEmail(orgId, handoff.id, t.conversationId);
    },

    async closeConversation() {
      await withTenant(orgId, async (tx) => {
        await tx.conversation.update({ where: { id: t.conversationId }, data: { status: "CLOSED" } });
        await tx.auditLog.create({
          data: { organizationId: orgId, actorType: "agent", action: "conversation.closed", entityType: "conversation", entityId: t.conversationId },
        });
      });
      await emitPlatformEvent(orgId, "conversation.closed", { conversationId: t.conversationId });
      // Resumen automático a la ficha del contacto (best-effort, en segundo plano):
      // al cerrar, guardamos los hechos duraderos para no perder contexto si vuelve.
      void (async () => {
        const { summarizeConversationToMemory } = await import("./contact-memory.js");
        await summarizeConversationToMemory(orgId, t.conversationId, t.contactId, t.agentId ?? null);
      })().catch((err) => console.error(`✖ Resumen al cerrar (${t.conversationId}):`, (err as Error).message));
    },

    async assignConversation(target: string, reason?: string) {
      // Resuelve el destino: equipo → persona → AGENTE de IA. Los dos primeros ASIGNAN a un
      // humano y apagan la IA. El tercero NO toca la conversación: devuelve un marcador para
      // que agent-turn haga la TRANSFERENCIA real (activeAgentId + handoff) manteniendo la IA
      // encendida y respondiendo el agente destino en el mismo turno.
      const outcome = await withTenant(orgId, async (tx) => {
        const team = await tx.team.findFirst({ where: { name: { equals: target, mode: "insensitive" } } });
        if (team) {
          await tx.conversation.update({ where: { id: t.conversationId }, data: { assignedTeamId: team.id, aiEnabled: false } });
          await tx.auditLog.create({
            data: { organizationId: orgId, actorType: "agent", action: "conversation.assigned_team", entityType: "conversation", entityId: t.conversationId, after: { team: team.name, reason } },
          });
          return { kind: "assigned" as const, label: `equipo ${team.name}` };
        }
        const members = await tx.organizationUser.findMany({ where: { active: true }, include: { user: true } });
        const m = members.find((mm) => mm.user.name.toLowerCase() === target.toLowerCase());
        if (m) {
          await tx.conversation.update({ where: { id: t.conversationId }, data: { assignedUserId: m.userId, aiEnabled: false } });
          await tx.auditLog.create({
            data: { organizationId: orgId, actorType: "agent", action: "conversation.assigned_user", entityType: "conversation", entityId: t.conversationId, after: { user: m.user.name, reason } },
          });
          return { kind: "assigned" as const, label: m.user.name };
        }
        const agent = await resolveAgentByNameOrSlug(tx, target);
        if (agent && agent.active) {
          return { kind: "agent" as const, slug: agent.slug, name: agent.name };
        }
        return { kind: "none" as const };
      });

      if (outcome.kind === "assigned") return { assignedTo: outcome.label };
      // Destino = otro agente de IA: agent-turn ejecuta la transferencia con este slug.
      if (outcome.kind === "agent") return { handoffToAgentSlug: outcome.slug, message: `Derivando a ${outcome.name}` };

      // No es equipo, ni persona, ni agente: NO se derivó a nadie. Deja un incidente VISIBLE
      // en la Bandeja (nota interna) y lanza un error DURO para que el modelo no pueda tapar
      // el fallo diciéndole al cliente que lo derivó.
      await withTenant(orgId, (tx) =>
        tx.message.create({
          data: {
            organizationId: orgId,
            conversationId: t.conversationId,
            direction: "OUTBOUND",
            type: "NOTE",
            visibility: "INTERNAL",
            body: `⚠ El bot intentó derivar/asignar a «${target}» pero no existe ningún equipo, persona ni agente con ese nombre. El cliente NO fue derivado y quedó a la espera — requiere atención.`,
            authorType: "AGENT",
            status: "DELIVERED",
          },
        }).catch(() => undefined),
      );
      throw new Error(
        `No existe ningún equipo, persona ni agente llamado "${target}". La conversación NO se derivó: NO le confirmes al cliente que lo derivaste. Discúlpate brevemente y dile que en un momento lo atienden, o intenta con otro destino válido.`,
      );
    },

    async updateContactFields(fields: { firstName?: string; lastName?: string; email?: string }) {
      const data: Record<string, string> = {};
      if (fields.firstName) data.firstName = fields.firstName;
      if (fields.lastName) data.lastName = fields.lastName;
      if (fields.email) data.email = fields.email;
      const updated = Object.keys(data);
      if (updated.length) {
        await withTenant(orgId, (tx) => tx.contact.update({ where: { id: t.contactId }, data }));
        const { enqueueHubspotContact } = await import("./hubspot.js");
        await enqueueHubspotContact(orgId, t.contactId);
      }
      return { updated };
    },

    async triggerWorkflow(workflowName: string) {
      return startWorkflowByName(orgId, workflowName, { conversationId: t.conversationId, contactId: t.contactId });
    },

    async listPlans() {
      // Catálogo GLOBAL de planes (tabla plans, sin organización) — precios vigentes
      // que fija el Super Admin. Lectura admin: es catálogo público, no dato de tenant.
      const admin = getAdminPrisma();
      const plans = await admin.plan.findMany({ where: { isPublic: true, active: true }, orderBy: { order: "asc" } });
      return plans.map((p) => {
        const tm = (p.features as Record<string, unknown> | null)?.templateMessages;
        const lim = (p.limits as Record<string, unknown> | null) ?? {};
        const num = (v: unknown) => (typeof v === "number" ? v : null);
        return {
          code: p.code,
          name: p.name,
          priceClp: Number(p.priceClp),
          priceUsd: Number(p.priceUsd),
          priceClpYearly: p.priceClpYearly != null ? Number(p.priceClpYearly) : null,
          priceUsdYearly: p.priceUsdYearly != null ? Number(p.priceUsdYearly) : null,
          templateMessages: typeof tm === "number" ? tm : null,
          // Límites que el bot DEBE conocer para vender con la verdad (0 = ilimitado).
          contactsMonthly: num(lim.contactsMonthly),
          aiTokensDaily: num(lim.aiTokensDaily),
          // Un plan de precio 0 NO es "gratis para siempre": es la PRUEBA/DEMO temporal.
          trialDays: p.trialDays || 7,
          isTrial: Number(p.priceClp) === 0 && Number(p.priceUsd) === 0,
        };
      });
    },

    async searchCatalog(input: { query: string; category?: string; maxPrice?: number; onlyAvailable?: boolean }) {
      // 1) Búsqueda SEMÁNTICA (si hay embeddings): encuentra por significado. Maneja su
      //    propia conexión, así que no anidamos withTenant. Si no trae nada, cae a textual.
      try {
        const { semanticCatalogSearch } = await import("./catalog/embeddings.js");
        const ids = await semanticCatalogSearch(orgId, input.query, { category: input.category, maxPrice: input.maxPrice, onlyAvailable: input.onlyAvailable, limit: 8 });
        if (ids.length) {
          return await withTenant(orgId, async (tx) => {
            const found = await tx.catalogItem.findMany({ where: { id: { in: ids }, active: true } });
            const byId = new Map(found.map((f) => [f.id, f]));
            return ids.map((id) => byId.get(id)).filter((x): x is (typeof found)[number] => !!x).map(toCatalogHit);
          });
        }
      } catch {
        /* proveedor de embeddings no disponible → búsqueda textual */
      }
      // 2) Búsqueda TEXTUAL (respaldo siempre disponible).
      return withTenant(orgId, async (tx) => {
        const words = input.query.split(/\s+/).filter((w) => w.length > 2).slice(0, 6);
        const items = await tx.catalogItem.findMany({
          where: {
            active: true, // solo lo que el tenant dejó ofrecer
            ...(input.onlyAvailable ? { available: true } : {}),
            ...(input.category ? { category: { equals: input.category, mode: "insensitive" as const } } : {}),
            ...(input.maxPrice ? { price: { lte: input.maxPrice } } : {}),
            ...(words.length
              ? {
                  OR: words.flatMap((w) => [
                    { name: { contains: w, mode: "insensitive" as const } },
                    { description: { contains: w, mode: "insensitive" as const } },
                    { botDescription: { contains: w, mode: "insensitive" as const } },
                    { category: { contains: w, mode: "insensitive" as const } },
                    { brand: { contains: w, mode: "insensitive" as const } },
                  ]),
                }
              : {}),
          },
          take: 8,
          orderBy: [{ available: "desc" }, { updatedAt: "desc" }],
        });
        return items.map(toCatalogHit);
      });
    },

    async getCatalogItem(idOrSku: string) {
      return withTenant(orgId, async (tx) => {
        const item = await tx.catalogItem.findFirst({
          where: { active: true, OR: [{ id: idOrSku }, { sku: { equals: idOrSku, mode: "insensitive" } }, { name: { equals: idOrSku, mode: "insensitive" } }, { name: { contains: idOrSku, mode: "insensitive" } }] },
          orderBy: { available: "desc" },
        });
        if (!item) return null;
        // Capa 3: refresca en segundo plano si el dato quedó viejo (proveedor en vivo).
        await refreshIfStale(orgId, item.source, item.syncedAt);
        return toCatalogHit(item);
      });
    },

    async readWebPage(url: string) {
      const r = await fetchWebPageText(url);
      return r.ok ? { url: r.url, title: r.title, text: r.text } : { error: r.error };
    },

    async recordContactMemory(input: { category: string; content: string }) {
      const { saveContactMemory } = await import("./contact-memory.js");
      return saveContactMemory({
        orgId,
        contactId: t.contactId,
        category: input.category,
        content: input.content,
        agentId: t.agentId ?? null,
        sourceConversationId: t.conversationId,
      });
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

    // ---------------- Cobro a clientes (Flow, cuenta del tenant) ----------------
    async enviarLinkDePago(input: { monto: number; concepto: string }) {
      const env = getEnv();
      const monto = Math.round(Number(input.monto) || 0);
      if (monto <= 0) return { ok: false, error: "El monto debe ser mayor a 0." };
      // Config + credenciales del tenant (RLS).
      const setup = await withTenant(orgId, async (tx) => {
        const [org, cred, contact] = await Promise.all([
          tx.organization.findUnique({ where: { id: orgId }, select: { settings: true, currency: true } }),
          tx.integrationCredential.findFirst({ where: { organizationId: orgId, provider: "flow_charge" } }),
          t.contactId ? tx.contact.findUnique({ where: { id: t.contactId }, select: { email: true } }) : Promise.resolve(null),
        ]);
        const charging = ((org?.settings as Record<string, unknown> | null)?.charging as { enabled?: boolean; sandbox?: boolean }) ?? {};
        return { charging, cred, currency: org?.currency ?? "CLP", email: contact?.email ?? null };
      });
      if (!setup.charging.enabled || !setup.cred) {
        return { ok: false, error: "El cobro no está configurado para esta cuenta. Avísale al cliente que en un momento le confirmas el medio de pago (NO inventes un link)." };
      }
      let creds: { apiKey: string; secretKey: string };
      try {
        creds = JSON.parse(decryptCredential(setup.cred.ciphertext));
      } catch {
        return { ok: false, error: "Las credenciales de cobro no son legibles. Avisa al equipo." };
      }
      const baseUrl = setup.charging.sandbox ? "https://sandbox.flow.cl/api" : "https://www.flow.cl/api";
      const commerceOrder = `cp-${orgId.slice(-6)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const { createFlowPaymentLink } = await import("./customer-charge.js");
      const link = await createFlowPaymentLink(
        { apiKey: creds.apiKey, secretKey: creds.secretKey, baseUrl },
        {
          commerceOrder,
          subject: input.concepto,
          amount: monto,
          currency: setup.currency,
          email: setup.email || `pagos+${commerceOrder}@tubot.cl`,
          urlConfirmation: `${env.API_URL}/webhooks/flow-charge`,
          urlReturn: `${env.WEB_URL}`,
        },
      );
      if (!link.ok || !link.url) {
        return { ok: false, error: `No se pudo generar el link de pago (${link.error ?? "error de Flow"}). No inventes un link; ofrece confirmar el pago en un momento.` };
      }
      await withTenant(orgId, (tx) =>
        tx.customerPayment.create({
          data: {
            organizationId: orgId,
            contactId: t.contactId ?? null,
            conversationId: t.conversationId ?? null,
            amount: monto,
            currency: setup.currency,
            subject: input.concepto.slice(0, 120),
            status: "pending",
            flowToken: link.token ?? null,
            commerceOrder,
          },
        }),
      );
      return { ok: true, url: link.url };
    },

    // ---------------- Montaje asistido (agente de implementación de TuBot) ----------------
    async generateAssistedLink() {
      const env = getEnv();
      const now = Math.floor(Date.now() / 1000);
      const token = signHs256(
        { providerOrgId: env.ASSISTED_SETUP_PROVIDER_ORG_ID, contactId: t.contactId, conversationId: t.conversationId, aud: "assisted-setup-link", iat: now, exp: now + 2 * 3600 },
        env.JWT_SECRET,
      );
      return { url: `${env.WEB_URL}/montaje-asistido?t=${encodeURIComponent(token)}` };
    },
    /**
     * Canjea el CÓDIGO CORTO que el cliente generó en su panel y le dictó al bot.
     * Solo el tenant de TuBot puede canjear. Verifica hash + vigencia del código, y
     * LIGA el grant a este contacto (recién ahí el bot queda autorizado, y solo sobre
     * el canal que el cliente eligió). El código es de un solo uso.
     */
    async redeemAssistedCode(rawCode: string) {
      const providerOrgId = getEnv().ASSISTED_SETUP_PROVIDER_ORG_ID;
      if (orgId !== providerOrgId) return { ok: false, error: "El canje de códigos solo lo hace el asistente de implementación." };
      const clean = (rawCode ?? "").trim();
      if (clean.replace(/[^A-Za-z0-9]/g, "").length < 8) {
        return { ok: false, error: "Ese código no parece válido. Debe verse como TB-XXXX-XXXX." };
      }
      const admin = getAdminPrisma();
      const grant = await admin.assistedSetupGrant.findFirst({
        where: {
          grantedByOrganizationId: providerOrgId,
          redeemCodeHash: hashRedeemCode(clean),
          status: "active",
          redeemedAt: null,
          redeemCodeExpiresAt: { gt: new Date() },
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, organizationId: true, scopeChannelId: true },
      });
      if (!grant) return { ok: false, error: "El código no es válido o ya venció. Pídele al cliente que lo genere de nuevo en su panel." };
      // Liga el grant a ESTE contacto y marca el código como usado (un solo uso).
      await admin.assistedSetupGrant.update({
        where: { id: grant.id },
        data: { linkedProviderContactId: t.contactId, redeemedAt: new Date(), redeemCodeHash: null },
      });
      const org = await admin.organization.findUnique({ where: { id: grant.organizationId }, select: { name: true } });
      let channelName: string | null = null;
      if (grant.scopeChannelId) {
        const ch = await admin.channelConnection.findUnique({ where: { id: grant.scopeChannelId }, select: { name: true } });
        channelName = ch?.name ?? null;
      }
      return { ok: true, orgName: org?.name ?? null, channelName };
    },
    async assistedSetupState() {
      const client = await resolveAssistedClientOrg(orgId, t.contactId);
      if (!client) return { authorized: false };
      try {
        const svc = await openAssistedSetup(client.orgId, getEnv().ASSISTED_SETUP_PROVIDER_ORG_ID);
        const state = await svc.getSetupState();
        // Paso del viaje PERSISTIDO (no inferido): el agente sabe siempre dónde va.
        return { authorized: true, state: { ...state, journeyStep: client.journeyStep, journeyLabel: client.journeyLabel } };
      } catch {
        return { authorized: false };
      }
    },
    async setSetupStep(step: number, label: string) {
      const client = await resolveAssistedClientOrg(orgId, t.contactId);
      if (!client) return { ok: false, error: "El cliente no ha vinculado su cuenta (montaje no autorizado)" };
      const s = Math.max(1, Math.min(10, Math.round(step)));
      await getAdminPrisma().assistedSetupGrant.update({
        where: { id: client.id },
        data: { journeyStep: s, journeyLabel: label.slice(0, 120), journeyUpdatedAt: new Date() },
      });
      return { ok: true, step: s };
    },
    async assistedUpsertAgent(input: { slug: string; name: string; systemPrompt: string; kind?: string }) {
      const client = await resolveAssistedClientOrg(orgId, t.contactId);
      if (!client) {
        return { ok: false, error: "El cliente aún no vinculó su cuenta. Pídele que autorice en su panel y te dicte el código; luego canjéalo con vincularMontajeCliente." };
      }
      try {
        const svc = await openAssistedSetup(client.orgId, getEnv().ASSISTED_SETUP_PROVIDER_ORG_ID, undefined, {
          scopeChannelId: client.scopeChannelId,
        });
        const r = await svc.upsertClientAgent({ slug: input.slug, name: input.name, systemPrompt: input.systemPrompt, kind: input.kind });
        return { ok: true, agentId: r.agentId };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
  };
}
