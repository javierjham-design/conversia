/**
 * @conversia/scheduling — Adaptadores de agenda.
 * Cada tenant (o sede) elige su proveedor vía scheduling_connections.
 * La IA solo ve la interfaz SchedulingProvider; nunca el proveedor real.
 */
export * from "./availability";
import { computeNativeSlots, type WorkBlock } from "./availability";
import { createHmac, randomUUID } from "node:crypto";
import type {
  AvailabilityQuery,
  CreateAppointmentInput,
  SchedAppointment,
  SchedClinic,
  SchedPatient,
  SchedProfessional,
  SchedService,
  SchedSlot,
  SchedulingProvider,
} from "@conversia/types";

// ------------------------------------------------------------------
// Mock: agenda en memoria, determinista. Sirve para desarrollo y tests
// (incluye validación de doble reserva).
// ------------------------------------------------------------------

export interface MockSchedulingData {
  clinics: SchedClinic[];
  professionals: SchedProfessional[];
  services: SchedService[];
  /** hora de inicio/fin de agenda local, paso en minutos */
  dayStartHour?: number;
  dayEndHour?: number;
  slotMinutes?: number;
  /** offset horario fijo para el mock, p.ej. "-04:00" (Chile) */
  utcOffset?: string;
}

export class MockSchedulingProvider implements SchedulingProvider {
  readonly kind = "mock";
  private appointments = new Map<string, SchedAppointment>();
  private patients = new Map<string, SchedPatient>();
  private seq = 0;

  constructor(private data: MockSchedulingData) {}

  async getClinics(): Promise<SchedClinic[]> {
    return this.data.clinics;
  }

  async getProfessionals(clinicId?: string): Promise<SchedProfessional[]> {
    return this.data.professionals.filter(
      (p) => !clinicId || !p.clinicIds?.length || p.clinicIds.includes(clinicId),
    );
  }

  async getServices(): Promise<SchedService[]> {
    return this.data.services;
  }

  async getProfessionalServices(): Promise<SchedService[]> {
    return this.data.services;
  }

  async getAvailableSlots(query: AvailabilityQuery): Promise<SchedSlot[]> {
    const startHour = this.data.dayStartHour ?? 10;
    const endHour = this.data.dayEndHour ?? 18;
    const step = this.data.slotMinutes ?? 30;
    const offset = this.data.utcOffset ?? "-04:00";
    const professionals = query.professionalId
      ? this.data.professionals.filter((p) => p.id === query.professionalId)
      : this.data.professionals;
    const clinicId = query.clinicId ?? this.data.clinics[0]?.id ?? "clinic-1";

    const slots: SchedSlot[] = [];
    const from = new Date(`${query.from}T00:00:00Z`);
    const to = new Date(`${query.to}T00:00:00Z`);
    for (let d = new Date(from); d <= to && slots.length < 200; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = d.getUTCDay();
      if (day === 0) continue; // domingo cerrado
      const dateStr = d.toISOString().slice(0, 10);
      for (const prof of professionals) {
        for (let h = startHour; h < endHour; h++) {
          for (let m = 0; m < 60; m += step) {
            const start = `${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${offset}`;
            const endDate = new Date(new Date(start).getTime() + step * 60000);
            const end = endDate.toISOString();
            const taken = [...this.appointments.values()].some(
              (a) =>
                a.professionalId === prof.id &&
                a.status !== "cancelled" &&
                new Date(a.start).getTime() === new Date(start).getTime(),
            );
            if (!taken) {
              slots.push({ start, end, professionalId: prof.id, clinicId, serviceId: query.serviceId });
            }
          }
        }
      }
    }
    // Solo horas futuras
    const now = Date.now();
    return slots.filter((s) => new Date(s.start).getTime() > now);
  }

  async createAppointment(input: CreateAppointmentInput): Promise<SchedAppointment> {
    const conflict = [...this.appointments.values()].some(
      (a) =>
        a.professionalId === input.professionalId &&
        a.status !== "cancelled" &&
        new Date(a.start).getTime() === new Date(input.start).getTime(),
    );
    if (conflict) {
      throw new Error("El horario ya no está disponible (doble reserva evitada)");
    }
    const id = `mock-appt-${++this.seq}`;
    const appt: SchedAppointment = {
      id,
      clinicId: input.clinicId,
      professionalId: input.professionalId,
      serviceId: input.serviceId,
      patient: input.patient,
      start: input.start,
      end: input.end,
      status: "pending",
      notes: input.notes,
    };
    this.appointments.set(id, appt);
    this.patients.set(input.patient.phone, input.patient);
    return appt;
  }

  async updateAppointment(id: string, changes: Partial<CreateAppointmentInput>): Promise<SchedAppointment> {
    const appt = this.mustGet(id);
    const updated: SchedAppointment = {
      ...appt,
      ...("start" in changes && changes.start ? { start: changes.start, status: "rescheduled" as const } : {}),
      ...("end" in changes && changes.end ? { end: changes.end } : {}),
      ...("notes" in changes ? { notes: changes.notes } : {}),
    };
    this.appointments.set(id, updated);
    return updated;
  }

  async cancelAppointment(id: string): Promise<SchedAppointment> {
    const appt = this.mustGet(id);
    appt.status = "cancelled";
    return appt;
  }

  async confirmAppointment(id: string): Promise<SchedAppointment> {
    const appt = this.mustGet(id);
    appt.status = "confirmed";
    return appt;
  }

  async getAppointment(id: string): Promise<SchedAppointment | null> {
    return this.appointments.get(id) ?? null;
  }

  async getPatientAppointments(phone: string): Promise<SchedAppointment[]> {
    return [...this.appointments.values()].filter((a) => a.patient.phone === phone);
  }

  async createOrUpdatePatient(patient: SchedPatient): Promise<SchedPatient> {
    this.patients.set(patient.phone, patient);
    return patient;
  }

  async markAttendance(id: string): Promise<void> {
    this.mustGet(id).status = "completed";
  }

  async markNoShow(id: string): Promise<void> {
    this.mustGet(id).status = "no_show";
  }

  private mustGet(id: string): SchedAppointment {
    const appt = this.appointments.get(id);
    if (!appt) throw new Error(`Cita no encontrada: ${id}`);
    return appt;
  }
}

// ------------------------------------------------------------------
// AGENDA NATIVA de TuBot: disponibilidad real desde los horarios de cada persona
// (WorkBlock por día) + citas ocupadas, con el motor computeNativeSlots. Los datos
// (personas con horarios, servicios, citas ocupadas, config) los carga el worker desde
// la BD y los pasa aquí; la persistencia de la cita creada la hace recordAppointment.
// ------------------------------------------------------------------

export interface NativeAgendaConfig {
  slotStepMin?: number; // granularidad (mínimo 5)
  bufferMin?: number; // separación entre citas
  minAdvanceMin?: number; // anticipación mínima
  offset?: string; // ej "-04:00"
}
export interface NativeProfessional {
  id: string;
  name: string;
  specialty?: string;
  clinicIds?: string[];
  workingHours: WorkBlock[]; // bloques de trabajo por día de semana
  defaultDurationMin?: number; // duración propia (recurso tipo servicio, ej "cambio de aceite" 30m)
}
export interface NativeSchedulingData {
  clinics: SchedClinic[];
  professionals: NativeProfessional[];
  services: SchedService[];
  busy: { professionalId: string; start: string; end: string }[]; // citas ocupadas (futuras)
  config?: NativeAgendaConfig;
}

export class NativeSchedulingProvider implements SchedulingProvider {
  readonly kind = "native";
  constructor(private data: NativeSchedulingData) {}

  async getClinics(): Promise<SchedClinic[]> {
    return this.data.clinics;
  }
  async getProfessionals(clinicId?: string): Promise<SchedProfessional[]> {
    return this.data.professionals
      .filter((p) => !clinicId || !p.clinicIds?.length || p.clinicIds.includes(clinicId))
      .map((p) => ({ id: p.id, name: p.name, specialty: p.specialty, clinicIds: p.clinicIds }));
  }
  async getServices(): Promise<SchedService[]> {
    return this.data.services;
  }
  async getProfessionalServices(): Promise<SchedService[]> {
    return this.data.services;
  }

  async getAvailableSlots(query: AvailabilityQuery): Promise<SchedSlot[]> {
    const cfg = this.data.config ?? {};
    const svc = query.serviceId ? this.data.services.find((s) => s.id === query.serviceId) : undefined;
    const clinicId = query.clinicId ?? this.data.clinics[0]?.id ?? "";
    const pros = query.professionalId ? this.data.professionals.filter((p) => p.id === query.professionalId) : this.data.professionals;

    const out: SchedSlot[] = [];
    for (const prof of pros) {
      if (!prof.workingHours?.length) continue;
      // Duración: la del servicio pedido, o la propia del recurso (tipo servicio), o 30.
      const durationMin = svc?.durationMin ?? prof.defaultDurationMin ?? 30;
      const slots = computeNativeSlots({
        fromDate: query.from,
        toDate: query.to,
        workBlocks: prof.workingHours,
        busy: this.data.busy.filter((b) => b.professionalId === prof.id),
        durationMin,
        slotStepMin: cfg.slotStepMin,
        bufferMin: cfg.bufferMin,
        minAdvanceMin: cfg.minAdvanceMin,
        offset: cfg.offset,
      });
      for (const s of slots) out.push({ start: s.start, end: s.end, professionalId: prof.id, clinicId, serviceId: query.serviceId });
    }
    out.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    return out.slice(0, 200);
  }

  async createAppointment(input: CreateAppointmentInput): Promise<SchedAppointment> {
    // Anti doble-reserva contra las citas ya ocupadas cargadas.
    const s = new Date(input.start).getTime();
    const e = new Date(input.end).getTime();
    const buf = (this.data.config?.bufferMin ?? 0) * 60000;
    const clash = this.data.busy
      .filter((b) => b.professionalId === input.professionalId)
      .some((b) => s < new Date(b.end).getTime() + buf && e + buf > new Date(b.start).getTime());
    if (clash) throw new Error("El horario ya no está disponible (doble reserva evitada)");
    return {
      id: randomUUID(),
      clinicId: input.clinicId,
      professionalId: input.professionalId,
      serviceId: input.serviceId,
      patient: input.patient,
      start: input.start,
      end: input.end,
      status: "pending",
      notes: input.notes,
    };
  }

  // Las mutaciones sobre citas existentes (reagendar/cancelar/confirmar/asistencia) viven
  // en la BD local; se cablearán a tool-services en la Fase 2. Por ahora, informan claro.
  private notYet(): never {
    throw new Error("Esta acción de agenda (reagendar/cancelar) aún no está disponible en la agenda nativa; deriva al equipo.");
  }
  async updateAppointment(): Promise<SchedAppointment> { return this.notYet(); }
  async cancelAppointment(): Promise<SchedAppointment> { return this.notYet(); }
  async confirmAppointment(): Promise<SchedAppointment> { return this.notYet(); }
  async getAppointment(): Promise<SchedAppointment | null> { return null; }
  async getPatientAppointments(): Promise<SchedAppointment[]> { return []; }
  async createOrUpdatePatient(patient: SchedPatient): Promise<SchedPatient> { return patient; }
  async markAttendance(): Promise<void> { /* se maneja en la BD (Fase 2) */ }
  async markNoShow(): Promise<void> { /* se maneja en la BD (Fase 2) */ }
}

// ------------------------------------------------------------------
// Cláriva: cliente HTTP del contrato preliminar (docs/CLARIVA.md).
// Cláriva es una plataforma EXTERNA: cero acoplamiento a su BD.
// ------------------------------------------------------------------

export interface ClarivaClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
}

export class ClarivaSchedulingProvider implements SchedulingProvider {
  readonly kind = "clariva";

  constructor(private opts: ClarivaClientOptions) {}

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10000);
    try {
      // Tolera baseUrl con o sin `/api/v1` (y barra final): evita `/api/v1/api/v1`.
      const base = this.opts.baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
      const res = await fetch(`${base}/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "content-type": "application/json",
          ...(extraHeaders ?? {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Cláriva ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  getClinics() {
    return this.request<SchedClinic[]>("GET", "/clinics");
  }
  getProfessionals(clinicId?: string) {
    return this.request<SchedProfessional[]>("GET", `/professionals${clinicId ? `?clinicId=${clinicId}` : ""}`);
  }
  getServices(clinicId?: string) {
    return this.request<SchedService[]>("GET", `/services${clinicId ? `?clinicId=${clinicId}` : ""}`);
  }
  getProfessionalServices(professionalId: string) {
    return this.request<SchedService[]>("GET", `/professionals/${professionalId}/services`);
  }
  async getAvailableSlots(q: AvailabilityQuery): Promise<SchedSlot[]> {
    // Cláriva espera FECHA (YYYY-MM-DD) y calcula la disponibilidad POR profesional:
    // sin professionalId devuelve vacío. Si no viene, se consulta a cada profesional
    // y se agrega (así el bot encuentra horarios aunque no fije un profesional).
    const from = q.from.slice(0, 10);
    const to = q.to.slice(0, 10);
    // NOTA: NO se envía serviceId. La disponibilidad de Cláriva no filtra por
    // servicio de forma confiable (confirmado por su dev) → mandarlo producía
    // resultados intermitentes/vacíos. La duración se fija en createAppointment.
    const one = async (professionalId?: string): Promise<SchedSlot[]> => {
      const params = new URLSearchParams();
      if (q.clinicId) params.set("clinicId", q.clinicId);
      if (professionalId) params.set("professionalId", professionalId);
      params.set("from", from);
      params.set("to", to);
      const path = `/availability?${params.toString()}`;
      // Reintento ante fallo transitorio de red/timeout (evita vacíos espurios).
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await this.request<SchedSlot[]>("GET", path);
          return r ?? [];
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    };
    if (q.professionalId) return one(q.professionalId);
    const pros = await this.getProfessionals(q.clinicId).catch(() => [] as SchedProfessional[]);
    if (!pros.length) return one();
    const per = await Promise.all(pros.map((p) => one(p.id).catch(() => [] as SchedSlot[])));
    return per.flat();
  }
  createAppointment(input: CreateAppointmentInput) {
    // Idempotency-Key determinístico (profesional+inicio+teléfono): el proveedor
    // dedupe reintentos idénticos aunque lleguen de réplicas distintas del worker.
    const raw = `tubot|${input.professionalId}|${input.start}|${input.patient?.phone ?? ""}`;
    const idem = Buffer.from(raw).toString("base64url").slice(0, 64);
    return this.request<SchedAppointment>("POST", "/appointments", input, { "Idempotency-Key": idem });
  }
  listAppointments(q: AvailabilityQuery) {
    const params = new URLSearchParams();
    if (q.clinicId) params.set("clinicId", q.clinicId);
    if (q.professionalId) params.set("professionalId", q.professionalId);
    if (q.serviceId) params.set("serviceId", q.serviceId);
    params.set("from", q.from);
    params.set("to", q.to);
    return this.request<SchedAppointment[]>("GET", `/appointments?${params.toString()}`);
  }
  updateAppointment(id: string, changes: Partial<CreateAppointmentInput>) {
    return this.request<SchedAppointment>("PATCH", `/appointments/${id}`, changes);
  }
  cancelAppointment(id: string, reason?: string) {
    return this.request<SchedAppointment>("POST", `/appointments/${id}/cancel`, { reason });
  }
  confirmAppointment(id: string) {
    return this.request<SchedAppointment>("POST", `/appointments/${id}/confirm`);
  }
  getAppointment(id: string) {
    return this.request<SchedAppointment | null>("GET", `/appointments/${id}`);
  }
  getPatientAppointments(phone: string) {
    return this.request<SchedAppointment[]>("GET", `/patients/${encodeURIComponent(phone)}/appointments`);
  }
  createOrUpdatePatient(patient: SchedPatient) {
    return this.request<SchedPatient>("PUT", "/patients", patient);
  }
  async markAttendance(id: string) {
    await this.request("POST", `/appointments/${id}/attendance`, { attended: true });
  }
  async markNoShow(id: string) {
    await this.request("POST", `/appointments/${id}/attendance`, { attended: false });
  }
}

// ------------------------------------------------------------------
// Agenda PERSONALIZADA: el sistema del tenant implementa el contrato estándar
// (los mismos endpoints del contrato Cláriva) y firma cada petición con HMAC.
// ------------------------------------------------------------------

export interface CustomClientOptions {
  baseUrl: string; // raíz del contrato (SIN /api/v1; se puede incluir si su server lo exige)
  secret: string; // HMAC compartido
  timeoutMs?: number;
}

/** Firma del contrato estándar: sha256=HMAC(secret, `${ts}.${method}.${path}.${body}`). */
export function buildCustomSignature(secret: string, timestamp: string, method: string, path: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${method.toUpperCase()}.${path}.${body}`).digest("hex");
}

export class CustomSchedulingProvider implements SchedulingProvider {
  readonly kind = "custom";

  constructor(private opts: CustomClientOptions) {}

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 8000);
    const payload = body === undefined ? "" : JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const res = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-conversia-timestamp": timestamp,
          "x-conversia-signature": buildCustomSignature(this.opts.secret, timestamp, method, path, payload),
          ...(extraHeaders ?? {}),
        },
        body: payload || undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Agenda personalizada ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  getClinics() {
    return this.request<SchedClinic[]>("GET", "/clinics");
  }
  getProfessionals(clinicId?: string) {
    return this.request<SchedProfessional[]>("GET", `/professionals${clinicId ? `?clinicId=${clinicId}` : ""}`);
  }
  getServices(clinicId?: string) {
    return this.request<SchedService[]>("GET", `/services${clinicId ? `?clinicId=${clinicId}` : ""}`);
  }
  getProfessionalServices(professionalId: string) {
    return this.request<SchedService[]>("GET", `/professionals/${professionalId}/services`);
  }
  async getAvailableSlots(q: AvailabilityQuery): Promise<SchedSlot[]> {
    // Cláriva espera FECHA (YYYY-MM-DD) y calcula la disponibilidad POR profesional:
    // sin professionalId devuelve vacío. Si no viene, se consulta a cada profesional
    // y se agrega (así el bot encuentra horarios aunque no fije un profesional).
    const from = q.from.slice(0, 10);
    const to = q.to.slice(0, 10);
    // NOTA: NO se envía serviceId. La disponibilidad de Cláriva no filtra por
    // servicio de forma confiable (confirmado por su dev) → mandarlo producía
    // resultados intermitentes/vacíos. La duración se fija en createAppointment.
    const one = async (professionalId?: string): Promise<SchedSlot[]> => {
      const params = new URLSearchParams();
      if (q.clinicId) params.set("clinicId", q.clinicId);
      if (professionalId) params.set("professionalId", professionalId);
      params.set("from", from);
      params.set("to", to);
      const path = `/availability?${params.toString()}`;
      // Reintento ante fallo transitorio de red/timeout (evita vacíos espurios).
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await this.request<SchedSlot[]>("GET", path);
          return r ?? [];
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    };
    if (q.professionalId) return one(q.professionalId);
    const pros = await this.getProfessionals(q.clinicId).catch(() => [] as SchedProfessional[]);
    if (!pros.length) return one();
    const per = await Promise.all(pros.map((p) => one(p.id).catch(() => [] as SchedSlot[])));
    return per.flat();
  }
  createAppointment(input: CreateAppointmentInput) {
    // Idempotency-Key determinístico (profesional+inicio+teléfono): el proveedor
    // dedupe reintentos idénticos aunque lleguen de réplicas distintas del worker.
    const raw = `tubot|${input.professionalId}|${input.start}|${input.patient?.phone ?? ""}`;
    const idem = Buffer.from(raw).toString("base64url").slice(0, 64);
    return this.request<SchedAppointment>("POST", "/appointments", input, { "Idempotency-Key": idem });
  }
  listAppointments(q: AvailabilityQuery) {
    const params = new URLSearchParams();
    if (q.clinicId) params.set("clinicId", q.clinicId);
    if (q.professionalId) params.set("professionalId", q.professionalId);
    if (q.serviceId) params.set("serviceId", q.serviceId);
    params.set("from", q.from);
    params.set("to", q.to);
    return this.request<SchedAppointment[]>("GET", `/appointments?${params.toString()}`);
  }
  updateAppointment(id: string, changes: Partial<CreateAppointmentInput>) {
    return this.request<SchedAppointment>("PATCH", `/appointments/${id}`, changes);
  }
  cancelAppointment(id: string, reason?: string) {
    return this.request<SchedAppointment>("POST", `/appointments/${id}/cancel`, { reason });
  }
  confirmAppointment(id: string) {
    return this.request<SchedAppointment>("POST", `/appointments/${id}/confirm`);
  }
  getAppointment(id: string) {
    return this.request<SchedAppointment | null>("GET", `/appointments/${id}`);
  }
  getPatientAppointments(phone: string) {
    return this.request<SchedAppointment[]>("GET", `/patients/${encodeURIComponent(phone)}/appointments`);
  }
  createOrUpdatePatient(patient: SchedPatient) {
    return this.request<SchedPatient>("PUT", "/patients", patient);
  }
  async markAttendance(id: string) {
    await this.request("POST", `/appointments/${id}/attendance`, { attended: true });
  }
  async markNoShow(id: string) {
    await this.request("POST", `/appointments/${id}/attendance`, { attended: false });
  }
}

// ------------------------------------------------------------------

export {
  DentalinkSchedulingProvider,
  computeDentalinkSlots,
  mapDentalinkCita,
  mapDentalinkEstado,
  parseOffsetMs,
  type DentalinkCita,
  type DentalinkClientOptions,
} from "./dentalink";
import { DentalinkSchedulingProvider, type DentalinkClientOptions } from "./dentalink";

export interface ProviderSelection {
  provider: "mock" | "clariva" | "custom" | "dentalink";
  mockData?: MockSchedulingData;
  clariva?: ClarivaClientOptions;
  custom?: CustomClientOptions;
  dentalink?: DentalinkClientOptions;
}

export function createSchedulingProvider(sel: ProviderSelection): SchedulingProvider {
  if (sel.provider === "clariva" && sel.clariva) {
    return new ClarivaSchedulingProvider(sel.clariva);
  }
  if (sel.provider === "custom" && sel.custom) {
    return new CustomSchedulingProvider(sel.custom);
  }
  if (sel.provider === "dentalink" && sel.dentalink) {
    return new DentalinkSchedulingProvider(sel.dentalink);
  }
  return new MockSchedulingProvider(
    sel.mockData ?? {
      clinics: [{ id: "clinic-1", name: "Sede Demo", timezone: "America/Santiago" }],
      professionals: [{ id: "prof-1", name: "Profesional Demo" }],
      services: [{ id: "svc-1", name: "Consulta", durationMin: 30 }],
    },
  );
}
