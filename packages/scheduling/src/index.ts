/**
 * @conversia/scheduling — Adaptadores de agenda.
 * Cada tenant (o sede) elige su proveedor vía scheduling_connections.
 * La IA solo ve la interfaz SchedulingProvider; nunca el proveedor real.
 */
import { createHmac } from "node:crypto";
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10000);
    try {
      const res = await fetch(`${this.opts.baseUrl}/api/v1${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.apiKey}`,
          "content-type": "application/json",
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
  getAvailableSlots(q: AvailabilityQuery) {
    const params = new URLSearchParams();
    if (q.clinicId) params.set("clinicId", q.clinicId);
    if (q.professionalId) params.set("professionalId", q.professionalId);
    if (q.serviceId) params.set("serviceId", q.serviceId);
    params.set("from", q.from);
    params.set("to", q.to);
    return this.request<SchedSlot[]>("GET", `/availability?${params.toString()}`);
  }
  createAppointment(input: CreateAppointmentInput) {
    return this.request<SchedAppointment>("POST", "/appointments", input);
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

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
  getAvailableSlots(q: AvailabilityQuery) {
    const params = new URLSearchParams();
    if (q.clinicId) params.set("clinicId", q.clinicId);
    if (q.professionalId) params.set("professionalId", q.professionalId);
    if (q.serviceId) params.set("serviceId", q.serviceId);
    params.set("from", q.from);
    params.set("to", q.to);
    return this.request<SchedSlot[]>("GET", `/availability?${params.toString()}`);
  }
  createAppointment(input: CreateAppointmentInput) {
    return this.request<SchedAppointment>("POST", "/appointments", input);
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
