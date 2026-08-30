import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import type { SchedAppointment, SchedulingProvider } from "@conversia/types";
import { ClarivaSchedulingProvider, DentalinkSchedulingProvider } from "@conversia/scheduling";
import { PrismaService } from "../prisma.service";
import { decryptSecret } from "../common/crypto";
import { requireContext } from "../tenancy/context";
import { requirePermission } from "../tenancy/permissions";

const STATUS_MAP: Record<string, string> = { pending: "PENDING", confirmed: "CONFIRMED", cancelled: "CANCELLED", rescheduled: "RESCHEDULED", completed: "COMPLETED", no_show: "NO_SHOW" };

const workBlock = z.object({
  day: z.number().int().min(0).max(6),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});
const workingHours = z.array(workBlock).max(60);

function slug(s: string): string {
  return (s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "svc") + "-" + Math.random().toString(36).slice(2, 6);
}

/**
 * AGENDA NATIVA de TuBot — gestión: config (granularidad/buffer/anticipación), personas
 * (con horarios), servicios y citas. Todo por-tenant (RLS). La disponibilidad la calcula
 * el proveedor nativo (worker) con estos datos. Coexiste con Cláriva/Dentalink: `status`
 * dice qué proveedor está activo para que la UI muestre solo lo que corresponde.
 */
@Controller("agenda")
export class AgendaController {
  constructor(private prisma: PrismaService) {}

  /** Qué proveedor de agenda está activo (nativo por defecto; externo si hay conexión). */
  @Get("status")
  async status() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const conn = await tx.schedulingConnection.findFirst({ where: { status: "active" } });
      const provider = conn?.provider ?? "NATIVE";
      const isNative = !conn || provider === "MOCK" || provider === "NATIVE";
      return { provider: isNative ? "NATIVE" : provider, external: !isNative, connectionId: conn?.id ?? null };
    });
  }

  /**
   * Recursos AGENDABLES del proveedor activo (profesionales de Cláriva/Dentalink en vivo,
   * o recursos nativos). Se usa para elegir, por AGENTE, con quién puede agendar
   * (p.ej. campaña de implantes = solo algunos). Devuelve ids que luego el bot respeta.
   */
  @Get("resources")
  async resources() {
    const ctx = requireContext();
    const provider = await this.externalProvider(ctx.organizationId);
    if (provider) {
      try {
        const pros = await provider.getProfessionals();
        return { source: provider.kind, resources: pros.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty ?? null })) };
      } catch {
        // cae a nativo
      }
    }
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const pros = await tx.professional.findMany({ where: { active: true }, orderBy: { name: "asc" } });
      return { source: "native", resources: pros.map((p) => ({ id: p.id, name: p.name, specialty: p.specialty ?? null })) };
    });
  }

  // ------------------------------ Config ------------------------------
  @Get("config")
  async getConfig() {
    const ctx = requireContext();
    const org = await this.prisma.admin.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
    const a = ((org?.settings as Record<string, unknown> | null)?.agenda ?? {}) as Record<string, number>;
    return { slotStepMin: a.slotStepMin ?? 30, bufferMin: a.bufferMin ?? 0, minAdvanceMin: a.minAdvanceMin ?? 60 };
  }

  @Put("config")
  async saveConfig(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const parsed = z
      .object({ slotStepMin: z.number().int().min(5).max(240), bufferMin: z.number().int().min(0).max(240), minAdvanceMin: z.number().int().min(0).max(20160) })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException("Config de agenda inválida (bloque mínimo 5 min)");
    const org = await this.prisma.admin.organization.findUnique({ where: { id: ctx.organizationId }, select: { settings: true } });
    const prev = (org?.settings as Record<string, unknown> | null) ?? {};
    await this.prisma.admin.organization.update({ where: { id: ctx.organizationId }, data: { settings: { ...prev, agenda: parsed.data } as object } });
    return { ok: true };
  }

  // --------------------------- Personas de agenda ---------------------------
  @Get("professionals")
  async listProfessionals() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const pros = await tx.professional.findMany({ where: { active: true }, orderBy: { name: "asc" } });
      return pros.map((p) => ({
        id: p.id,
        name: p.name,
        specialty: p.specialty,
        workingHours: Array.isArray((p.meta as any)?.workingHours) ? (p.meta as any).workingHours : [],
      }));
    });
  }

  @Post("professionals")
  async createProfessional(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const p = z.object({ name: z.string().min(1).max(120), specialty: z.string().max(120).optional(), workingHours: workingHours.optional() }).safeParse(body);
    if (!p.success) throw new BadRequestException("Datos de persona inválidos");
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.professional.create({ data: { organizationId: ctx.organizationId, name: p.data.name, specialty: p.data.specialty ?? null, active: true, meta: { workingHours: p.data.workingHours ?? [] } } }),
    );
  }

  @Put("professionals/:id")
  async updateProfessional(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const p = z.object({ name: z.string().min(1).max(120).optional(), specialty: z.string().max(120).nullable().optional(), workingHours: workingHours.optional(), active: z.boolean().optional() }).safeParse(body);
    if (!p.success) throw new BadRequestException("Datos inválidos");
    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const cur = await tx.professional.findFirst({ where: { id } });
      if (!cur) throw new NotFoundException("Persona no encontrada");
      const meta = { ...((cur.meta as object) ?? {}), ...(p.data.workingHours ? { workingHours: p.data.workingHours } : {}) };
      await tx.professional.update({
        where: { id },
        data: {
          ...(p.data.name ? { name: p.data.name } : {}),
          ...(p.data.specialty !== undefined ? { specialty: p.data.specialty } : {}),
          ...(p.data.active !== undefined ? { active: p.data.active } : {}),
          meta: meta as object,
        },
      });
      return { ok: true };
    });
  }

  @Delete("professionals/:id")
  async removeProfessional(@Param("id") id: string) {
    const ctx = requirePermission("settings:write");
    return this.prisma.withTenant(ctx.organizationId, (tx) => tx.professional.update({ where: { id }, data: { active: false } }).then(() => ({ ok: true })));
  }

  // ------------------------------ Servicios ------------------------------
  @Get("services")
  async listServices() {
    const ctx = requireContext();
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.service.findMany({ where: { active: true }, orderBy: { name: "asc" } }).then((rows) =>
        rows.map((s) => ({ id: s.id, code: s.code, name: s.name, durationMin: s.durationMin, price: s.price ? Number(s.price) : null, currency: s.currency })),
      ),
    );
  }

  @Post("services")
  async createService(@Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const p = z.object({ name: z.string().min(1).max(120), durationMin: z.number().int().min(5).max(1440), price: z.number().nonnegative().optional() }).safeParse(body);
    if (!p.success) throw new BadRequestException("Datos de servicio inválidos");
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.service.create({ data: { organizationId: ctx.organizationId, code: slug(p.data.name), name: p.data.name, durationMin: p.data.durationMin, price: p.data.price ?? null, active: true } }),
    );
  }

  @Put("services/:id")
  async updateService(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requirePermission("settings:write");
    const p = z.object({ name: z.string().min(1).max(120).optional(), durationMin: z.number().int().min(5).max(1440).optional(), price: z.number().nonnegative().nullable().optional() }).safeParse(body);
    if (!p.success) throw new BadRequestException("Datos inválidos");
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.service.update({ where: { id }, data: { ...(p.data.name ? { name: p.data.name } : {}), ...(p.data.durationMin ? { durationMin: p.data.durationMin } : {}), ...(p.data.price !== undefined ? { price: p.data.price } : {}) } }).then(() => ({ ok: true })),
    );
  }

  @Delete("services/:id")
  async removeService(@Param("id") id: string) {
    const ctx = requirePermission("settings:write");
    return this.prisma.withTenant(ctx.organizationId, (tx) => tx.service.update({ where: { id }, data: { active: false } }).then(() => ({ ok: true })));
  }

  /** Construye el proveedor externo (Cláriva/Dentalink) con credenciales descifradas, o null si no hay conexión activa. */
  private async externalProvider(orgId: string): Promise<SchedulingProvider | null> {
    return this.prisma.withTenant(orgId, async (tx) => {
      const conn = await tx.schedulingConnection.findFirst({ where: { status: "active", provider: { in: ["CLARIVA", "DENTALINK"] } } });
      if (!conn) return null;
      const cred = conn.credentialId ? await tx.integrationCredential.findUnique({ where: { id: conn.credentialId } }) : null;
      const apiKey = cred ? decryptSecret(cred.ciphertext) : "";
      const baseUrl = (conn.config as Record<string, unknown> | null)?.baseUrl as string | undefined;
      if (!baseUrl || !apiKey) return null;
      if (conn.provider === "CLARIVA") return new ClarivaSchedulingProvider({ baseUrl, apiKey });
      if (conn.provider === "DENTALINK") return new DentalinkSchedulingProvider({ baseUrl, token: apiKey });
      return null;
    });
  }

  private mapSched(a: SchedAppointment) {
    const name = [a.patient?.firstName, a.patient?.lastName].filter(Boolean).join(" ") || a.patient?.phone || "Sin nombre";
    return {
      id: a.id,
      professionalId: a.professionalId ?? null,
      professionalName: a.professionalName ?? null,
      serviceId: a.serviceId ?? null,
      serviceName: a.serviceName ?? null,
      status: STATUS_MAP[a.status] ?? String(a.status).toUpperCase(),
      startsAt: new Date(a.start).toISOString(),
      endsAt: new Date(a.end).toISOString(),
      notes: a.notes ?? null,
      contact: { name, phone: a.patient?.phone ?? null },
    };
  }

  // ------------------------------ Citas ------------------------------
  // Si hay Cláriva/Dentalink conectado, trae la agenda REAL en vivo del proveedor
  // (fuente de verdad, sin desfase). Si el proveedor no expone listado o falla,
  // cae a la proyección local (alimentada por webhooks) para no quedar en blanco.
  @Get("appointments")
  async listAppointments(@Query("from") from?: string, @Query("to") to?: string) {
    const ctx = requireContext();
    const gte = from ? new Date(from) : new Date(Date.now() - 24 * 3600 * 1000);
    const lte = to ? new Date(to) : new Date(Date.now() + 30 * 24 * 3600 * 1000);

    const provider = await this.externalProvider(ctx.organizationId);
    if (provider && typeof provider.listAppointments === "function") {
      try {
        const live = await provider.listAppointments({ from: gte.toISOString(), to: lte.toISOString() });
        return { source: provider.kind, live: true, appointments: (live ?? []).map((a) => this.mapSched(a)).sort((x, y) => x.startsAt.localeCompare(y.startsAt)) };
      } catch {
        // sigue con la proyección local
      }
    }

    return this.prisma.withTenant(ctx.organizationId, async (tx) => {
      const appts = await tx.appointment.findMany({
        where: { startsAt: { gte, lte } },
        orderBy: { startsAt: "asc" },
        include: { contact: { select: { firstName: true, lastName: true, phone: true } } },
        take: 500,
      });
      const meta = (a: (typeof appts)[number]) => (a.meta as Record<string, unknown> | null) ?? {};
      return {
        source: provider?.kind ?? "native",
        live: false,
        appointments: appts.map((a) => ({
          id: a.id,
          professionalId: a.professionalId,
          professionalName: (meta(a).professionalName as string | undefined) ?? null,
          serviceId: a.serviceId ?? null,
          serviceName: (meta(a).serviceName as string | undefined) ?? null,
          status: a.status,
          startsAt: a.startsAt.toISOString(),
          endsAt: a.endsAt.toISOString(),
          notes: a.notes,
          contact: { name: [a.contact?.firstName, a.contact?.lastName].filter(Boolean).join(" ") || a.contact?.phone || "Sin nombre", phone: a.contact?.phone ?? null },
        })),
      };
    });
  }

  @Post("appointments")
  async createAppointment(@Body() body: unknown) {
    const ctx = requireContext();
    const p = z
      .object({ contactId: z.string().min(1), professionalId: z.string().optional(), serviceId: z.string().optional(), startsAt: z.string(), endsAt: z.string(), notes: z.string().max(1000).optional() })
      .safeParse(body);
    if (!p.success) throw new BadRequestException("Datos de cita inválidos");
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.appointment.create({
        data: {
          organizationId: ctx.organizationId,
          contactId: p.data.contactId,
          professionalId: p.data.professionalId ?? null,
          serviceId: p.data.serviceId ?? null,
          provider: "MOCK",
          status: "CONFIRMED",
          startsAt: new Date(p.data.startsAt),
          endsAt: new Date(p.data.endsAt),
          notes: p.data.notes ?? null,
        },
      }),
    );
  }

  @Patch("appointments/:id")
  async updateAppointment(@Param("id") id: string, @Body() body: unknown) {
    const ctx = requireContext();
    const p = z
      .object({ startsAt: z.string().optional(), endsAt: z.string().optional(), status: z.enum(["PENDING", "CONFIRMED", "CANCELLED", "RESCHEDULED", "COMPLETED", "NO_SHOW"]).optional(), notes: z.string().max(1000).optional() })
      .safeParse(body);
    if (!p.success) throw new BadRequestException("Datos inválidos");
    return this.prisma.withTenant(ctx.organizationId, (tx) =>
      tx.appointment.update({
        where: { id },
        data: {
          ...(p.data.startsAt ? { startsAt: new Date(p.data.startsAt) } : {}),
          ...(p.data.endsAt ? { endsAt: new Date(p.data.endsAt) } : {}),
          ...(p.data.status ? { status: p.data.status } : {}),
          ...(p.data.notes !== undefined ? { notes: p.data.notes } : {}),
        },
      }).then(() => ({ ok: true })),
    );
  }
}
