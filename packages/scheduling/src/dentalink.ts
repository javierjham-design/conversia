/**
 * Dentalink (Healthatom) — proveedor de agenda dental.
 * API real: https://api.dentalink.healthatom.com/api/v1 con header
 * `Authorization: Token <token>` y sobre `{ data: [...] }`.
 *
 * Disponibilidad v1: horario laboral configurado por el tenant MENOS las citas
 * ya agendadas en Dentalink (la API no expone un endpoint simple de huecos).
 * La IA nunca inventa horas: todo sale de computeDentalinkSlots sobre citas reales.
 */
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

export interface DentalinkClientOptions {
  token: string;
  baseUrl?: string; // default API pública de Healthatom
  timeoutMs?: number;
  /** Ventana laboral para calcular huecos (defaults razonables de clínica). */
  workStartHour?: number; // 9
  workEndHour?: number; // 19
  slotMinutes?: number; // 30
  utcOffset?: string; // "-04:00" (Chile continental)
}

const DEFAULT_BASE = "https://api.dentalink.healthatom.com/api/v1";

// --------------------------- Mapeos puros (testeados con fixtures) ---------------------------

/** Estado de Dentalink (texto libre por clínica) → estado estándar. */
export function mapDentalinkEstado(estado: string | null | undefined): SchedAppointment["status"] {
  const s = (estado ?? "").toLowerCase();
  if (/anulad|cancelad/.test(s)) return "cancelled";
  if (/no asis|no-show|inasist/.test(s)) return "no_show";
  if (/atendid|realizad|complet/.test(s)) return "completed";
  if (/reagend/.test(s)) return "rescheduled";
  if (/no confirmad|sin confirmar|por confirmar/.test(s)) return "pending"; // negaciones antes del match positivo
  if (/confirmad/.test(s)) return "confirmed";
  return "pending";
}

export interface DentalinkCita {
  id: number | string;
  id_paciente?: number | string;
  id_dentista: number | string;
  id_sucursal: number | string;
  fecha: string; // YYYY-MM-DD
  hora_inicio: string; // HH:MM
  duracion: number; // minutos
  estado_cita?: string;
  comentario?: string | null;
  nombre_paciente?: string;
  apellidos_paciente?: string;
  celular_paciente?: string;
}

/** Cita de Dentalink → cita estándar (ISO con offset del tenant). */
export function mapDentalinkCita(cita: DentalinkCita, utcOffset = "-04:00"): SchedAppointment {
  const start = `${cita.fecha}T${cita.hora_inicio.padStart(5, "0")}:00${utcOffset}`;
  const end = new Date(new Date(start).getTime() + (Number(cita.duracion) || 30) * 60_000).toISOString();
  return {
    id: String(cita.id),
    clinicId: String(cita.id_sucursal),
    professionalId: String(cita.id_dentista),
    patient: {
      externalId: cita.id_paciente != null ? String(cita.id_paciente) : undefined,
      firstName: cita.nombre_paciente ?? "",
      lastName: cita.apellidos_paciente,
      phone: cita.celular_paciente ?? "",
    },
    start,
    end,
    status: mapDentalinkEstado(cita.estado_cita),
    notes: cita.comentario ?? undefined,
  };
}

/**
 * Huecos disponibles: ventana laboral menos citas ocupadas (no canceladas).
 * Determinista y sin red — la parte con juicio va con tests de fixtures.
 */
export function computeDentalinkSlots(args: {
  from: string; // YYYY-MM-DD
  to: string;
  professionalId: string;
  clinicId: string;
  busy: DentalinkCita[];
  workStartHour?: number;
  workEndHour?: number;
  slotMinutes?: number;
  utcOffset?: string;
  now?: Date;
}): SchedSlot[] {
  const startHour = args.workStartHour ?? 9;
  const endHour = args.workEndHour ?? 19;
  const step = args.slotMinutes ?? 30;
  const offset = args.utcOffset ?? "-04:00";
  const now = (args.now ?? new Date()).getTime();

  // Intervalos ocupados del profesional (ignora canceladas/anuladas)
  const busyRanges = args.busy
    .filter((c) => String(c.id_dentista) === args.professionalId && mapDentalinkEstado(c.estado_cita) !== "cancelled")
    .map((c) => {
      const s = new Date(`${c.fecha}T${c.hora_inicio.padStart(5, "0")}:00${offset}`).getTime();
      return { start: s, end: s + (Number(c.duracion) || 30) * 60_000 };
    });

  const slots: SchedSlot[] = [];
  const from = new Date(`${args.from}T00:00:00Z`);
  const to = new Date(`${args.to}T00:00:00Z`);
  for (let d = new Date(from); d <= to && slots.length < 200; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() === 0) continue; // domingo cerrado
    const dateStr = d.toISOString().slice(0, 10);
    for (let h = startHour; h < endHour; h++) {
      for (let m = 0; m < 60; m += step) {
        const startIso = `${dateStr}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00${offset}`;
        const startMs = new Date(startIso).getTime();
        const endMs = startMs + step * 60_000;
        if (startMs <= now) continue;
        const taken = busyRanges.some((b) => startMs < b.end && endMs > b.start); // solapamiento
        if (!taken) {
          slots.push({
            start: startIso,
            end: new Date(endMs).toISOString(),
            professionalId: args.professionalId,
            clinicId: args.clinicId,
          });
        }
      }
    }
  }
  return slots;
}

// --------------------------- Cliente HTTP ---------------------------

export class DentalinkSchedulingProvider implements SchedulingProvider {
  readonly kind = "dentalink";
  private estadosCache: { id: number; nombre: string }[] | null = null;

  constructor(private opts: DentalinkClientOptions) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);
    try {
      const res = await fetch(`${(this.opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          authorization: `Token ${this.opts.token}`,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Dentalink ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      }
      const json: any = await res.json();
      return (json?.data ?? json) as T; // sobre {data: ...}
    } finally {
      clearTimeout(timer);
    }
  }

  private q(filter: Record<string, unknown>): string {
    return `?q=${encodeURIComponent(JSON.stringify(filter))}`;
  }

  async getClinics(): Promise<SchedClinic[]> {
    const rows = await this.request<any[]>("GET", "/sucursales");
    return rows.map((s) => ({ id: String(s.id), name: s.nombre ?? `Sucursal ${s.id}`, timezone: "America/Santiago" }));
  }

  async getProfessionals(clinicId?: string): Promise<SchedProfessional[]> {
    const rows = await this.request<any[]>("GET", "/dentistas");
    return rows
      .filter((d) => d.habilitado !== false && d.habilitado !== 0)
      .filter((d) => !clinicId || d.id_sucursal == null || String(d.id_sucursal) === clinicId)
      .map((d) => ({
        id: String(d.id),
        name: [d.nombre, d.apellidos].filter(Boolean).join(" ") || `Dentista ${d.id}`,
        specialty: d.especialidad ?? undefined,
      }));
  }

  /** Dentalink no expone catálogo de servicios agendables por API: los servicios viven en Conversia. */
  async getServices(): Promise<SchedService[]> {
    return [];
  }
  async getProfessionalServices(): Promise<SchedService[]> {
    return [];
  }

  async getAvailableSlots(query: AvailabilityQuery): Promise<SchedSlot[]> {
    const clinics = query.clinicId ? [{ id: query.clinicId }] : await this.getClinics();
    const clinicId = String(clinics[0]?.id ?? "1");
    const professionals = query.professionalId
      ? [{ id: query.professionalId }]
      : await this.getProfessionals(clinicId);
    const busy = await this.request<DentalinkCita[]>(
      "GET",
      `/citas${this.q({ fecha: { gte: query.from, lte: query.to } })}`,
    );
    const slots: SchedSlot[] = [];
    for (const prof of professionals.slice(0, 5)) {
      slots.push(
        ...computeDentalinkSlots({
          from: query.from,
          to: query.to,
          professionalId: String(prof.id),
          clinicId,
          busy,
          workStartHour: this.opts.workStartHour,
          workEndHour: this.opts.workEndHour,
          slotMinutes: this.opts.slotMinutes,
          utcOffset: this.opts.utcOffset,
        }),
      );
    }
    return slots.sort((a, b) => a.start.localeCompare(b.start)).slice(0, 200);
  }

  async createAppointment(input: CreateAppointmentInput): Promise<SchedAppointment> {
    const patient = await this.createOrUpdatePatient(input.patient);
    const start = new Date(input.start);
    const durMin = Math.max(15, Math.round((new Date(input.end).getTime() - start.getTime()) / 60_000));
    const offset = this.opts.utcOffset ?? "-04:00";
    // fecha/hora en el huso del tenant (el input viene ISO con offset)
    const local = new Date(start.getTime() + parseOffsetMs(offset));
    const cita = await this.request<DentalinkCita>("POST", "/citas", {
      id_paciente: Number(patient.externalId),
      id_dentista: Number(input.professionalId),
      id_sucursal: Number(input.clinicId),
      fecha: local.toISOString().slice(0, 10),
      hora_inicio: local.toISOString().slice(11, 16),
      duracion: durMin,
      comentario: input.notes ?? "Agendada por TuBot",
    });
    return mapDentalinkCita(cita, offset);
  }

  async updateAppointment(id: string, changes: Partial<CreateAppointmentInput>): Promise<SchedAppointment> {
    const body: Record<string, unknown> = {};
    if (changes.start) {
      const offset = this.opts.utcOffset ?? "-04:00";
      const local = new Date(new Date(changes.start).getTime() + parseOffsetMs(offset));
      body.fecha = local.toISOString().slice(0, 10);
      body.hora_inicio = local.toISOString().slice(11, 16);
    }
    if (changes.start && changes.end) {
      body.duracion = Math.max(15, Math.round((new Date(changes.end).getTime() - new Date(changes.start).getTime()) / 60_000));
    }
    if (changes.notes !== undefined) body.comentario = changes.notes;
    const cita = await this.request<DentalinkCita>("PUT", `/citas/${id}`, body);
    return mapDentalinkCita(cita, this.opts.utcOffset);
  }

  async cancelAppointment(id: string): Promise<SchedAppointment> {
    return this.setEstado(id, /anulad|cancelad/);
  }
  async confirmAppointment(id: string): Promise<SchedAppointment> {
    return this.setEstado(id, /confirmad/);
  }
  async markAttendance(id: string): Promise<void> {
    await this.setEstado(id, /atendid|realizad/);
  }
  async markNoShow(id: string): Promise<void> {
    await this.setEstado(id, /no asis|inasist/);
  }

  async getAppointment(id: string): Promise<SchedAppointment | null> {
    try {
      const cita = await this.request<DentalinkCita>("GET", `/citas/${id}`);
      return mapDentalinkCita(cita, this.opts.utcOffset);
    } catch {
      return null;
    }
  }

  async getPatientAppointments(phone: string): Promise<SchedAppointment[]> {
    const paciente = await this.findPatientByPhone(phone);
    if (!paciente) return [];
    const citas = await this.request<DentalinkCita[]>("GET", `/citas${this.q({ id_paciente: { eq: Number(paciente.id) } })}`);
    return citas.map((c) => mapDentalinkCita(c, this.opts.utcOffset));
  }

  async createOrUpdatePatient(patient: SchedPatient): Promise<SchedPatient> {
    const existing = await this.findPatientByPhone(patient.phone);
    if (existing) {
      return { ...patient, externalId: String(existing.id) };
    }
    const created = await this.request<any>("POST", "/pacientes", {
      nombre: patient.firstName,
      apellidos: patient.lastName ?? ".",
      celular: patient.phone,
      email: patient.email,
      rut: patient.documentId,
    });
    return { ...patient, externalId: String(created.id) };
  }

  // --------------------------- privados ---------------------------

  private async findPatientByPhone(phone: string): Promise<{ id: number | string } | null> {
    const digits = phone.replace(/\D/g, "");
    const tail = digits.slice(-8); // Dentalink guarda el celular en formatos variados
    if (!tail) return null;
    const rows = await this.request<any[]>("GET", `/pacientes${this.q({ celular: { lk: tail } })}`);
    return rows.find((p) => String(p.celular ?? "").replace(/\D/g, "").endsWith(tail)) ?? null;
  }

  private async getEstados(): Promise<{ id: number; nombre: string }[]> {
    if (!this.estadosCache) {
      const rows = await this.request<any[]>("GET", "/citas/estados");
      this.estadosCache = rows.map((e) => ({ id: Number(e.id), nombre: String(e.nombre ?? "") }));
    }
    return this.estadosCache;
  }

  private async setEstado(id: string, match: RegExp): Promise<SchedAppointment> {
    const estados = await this.getEstados();
    const estado = estados.find((e) => match.test(e.nombre.toLowerCase()));
    if (!estado) {
      throw new Error(`Dentalink: no existe un estado de cita que coincida con ${match} — créalo en Dentalink`);
    }
    const cita = await this.request<DentalinkCita>("PUT", `/citas/${id}`, { id_estado: estado.id });
    return mapDentalinkCita(cita, this.opts.utcOffset);
  }
}

/** "-04:00" → milisegundos con signo (para desplazar a hora local del tenant). */
export function parseOffsetMs(offset: string): number {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
}
