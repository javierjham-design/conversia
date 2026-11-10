import { describe, expect, it } from "vitest";
import { ToolRegistry, buildCoreTools } from "./index.js";

// Bug real Digital-Dent (10-nov-2026): al REAGENDAR, el bot cambiaba de profesional. A los pacientes
// de la Dra. Vargas (y del Dr. Aedo) los reagendaba con el Dr. Pabst, porque:
//   1) getAvailability sin profesional fijo traía los cupos de CUALQUIERA (Pabst domina la agenda), y
//   2) createAppointment decidía la cita a MOVER por el profesional del SLOT nuevo → si el paciente
//      tenía Vargas y el slot era Pabst, no encontraba match y CREABA una 2ª cita con Pabst.
// La regla del dueño: reagendar SIEMPRE con el MISMO profesional; si no hay horas que acomoden, derivar.

const V = "pV"; // Dra. Vargas
const P = "pP"; // Dr. Pabst
const DAY = "2026-12-21"; // futuro

function makeScheduling() {
  const appts: Array<{ id: string; clinicId: string; professionalId: string; patient: any; start: string; end: string; status: string }> = [];
  const availCalls: Array<string | undefined> = []; // professionalId con que se consultó la disponibilidad
  let seq = 0;
  const mk = (pid: string, utcHour: number, min: number) => ({
    start: `${DAY}T${String(utcHour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00.000Z`,
    end: `${DAY}T${String(utcHour).padStart(2, "0")}:${String(min + 15).padStart(2, "0")}:00.000Z`,
    professionalId: pid,
    clinicId: "c",
  });
  return {
    appts,
    availCalls,
    kind: "clariva" as const,
    async getProfessionals() {
      return [{ id: V, name: "Dra. Paula Vargas Rodriguez", specialty: null }, { id: P, name: "Dr. Nicolas Pabst Prassel", specialty: null }];
    },
    async getAvailableSlots(q: { professionalId?: string; from: string }) {
      availCalls.push(q.professionalId);
      // Con profesional fijo → solo sus cupos. Sin fijar → mezcla (Pabst primero, como en prod).
      if (q.professionalId) return [mk(q.professionalId, 12, 15), mk(q.professionalId, 12, 30)];
      return [mk(P, 12, 15), mk(V, 13, 15)];
    },
    async createAppointment(input: any) {
      const appt = { id: `a${++seq}`, clinicId: input.clinicId, professionalId: input.professionalId, patient: input.patient, start: input.start, end: input.end, status: "pending" };
      appts.push(appt);
      return appt;
    },
    async getPatientAppointments() {
      return appts.filter((a) => a.status !== "cancelled");
    },
    async updateAppointment(id: string, changes: any) {
      const a = appts.find((x) => x.id === id)!;
      Object.assign(a, changes);
      return a;
    },
  };
}

function makeCtx(scheduling: ReturnType<typeof makeScheduling>, conversationId: string) {
  const services = {
    scheduling,
    async contactInfo() {
      return { firstName: "Ana", lastName: "Pérez", phone: "+56990000001" };
    },
    async updateContactFields() {
      return { updated: [] as string[] };
    },
    async recordAppointment() {},
  };
  return { organizationId: "org1", conversationId, clinicId: "c", agentName: "Agendamiento", brandName: "Digital-Dent", services } as any;
}

// Siembra una cita futura del paciente con `prof` (simula la cita que YA tenía).
function seedCita(scheduling: ReturnType<typeof makeScheduling>, prof: string, utcHour = 15, min = 0) {
  scheduling.appts.push({ id: "existente", clinicId: "c", professionalId: prof, patient: { phone: "+56990000001" }, start: `${DAY}T${String(utcHour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00.000Z`, end: `${DAY}T${String(utcHour).padStart(2, "0")}:15:00.000Z`, status: "confirmed" });
}

async function offer(reg: ToolRegistry, ctx: any, input: Record<string, unknown>) {
  const r = await reg.execute("getAvailability", { fromDate: DAY, toDate: DAY, ...input }, ctx);
  expect(r.isError).toBe(false);
  return JSON.parse(r.content);
}

describe("reagendamiento — mismo profesional", () => {
  it("getAvailability SIN profesional fija el del paciente que ya tiene cita (no ofrece a otro)", async () => {
    const sched = makeScheduling();
    seedCita(sched, V); // su cita es con Vargas
    const reg = new ToolRegistry();
    for (const t of buildCoreTools()) reg.register(t);
    const ctx = makeCtx(sched, "c-pin");
    await offer(reg, ctx, {}); // el modelo NO pasó professionalId
    // La disponibilidad se consultó fijada a Vargas, no "sin profesional".
    expect(sched.availCalls.at(-1)).toBe(V);
  });

  it("createAppointment RECHAZA agendar con otro profesional al reagendar (bloqueo duro)", async () => {
    const sched = makeScheduling();
    seedCita(sched, V); // su cita es con Vargas
    const reg = new ToolRegistry();
    for (const t of buildCoreTools()) reg.register(t);
    const ctx = makeCtx(sched, "c-block");
    // Forzamos ver cupos de Pabst pasando su id explícito (evita el auto-fijado).
    const disp = await offer(reg, ctx, { professionalId: P });
    const slotPabst = (disp.horas as { id: string }[])[0];
    const r = await reg.execute("createAppointment", { slotId: slotPabst.id }, ctx);
    const out = JSON.parse(r.content);
    expect(out.wrongProfessional).toBe(true);
    expect(out.ok).toBeUndefined();
    // NO se creó una 2ª cita ni se tocó la de Vargas.
    expect(sched.appts).toHaveLength(1);
    expect(sched.appts[0].professionalId).toBe(V);
  });

  it("reagenda MOVIENDO la cita cuando el slot es del MISMO profesional", async () => {
    const sched = makeScheduling();
    seedCita(sched, V, 12, 15); // Vargas a las 09:15 Chile (12:15 UTC)
    const reg = new ToolRegistry();
    for (const t of buildCoreTools()) reg.register(t);
    const ctx = makeCtx(sched, "c-move");
    const disp = await offer(reg, ctx, {}); // auto-fija Vargas → cupos de Vargas (12:15, 12:30)
    expect(sched.availCalls.at(-1)).toBe(V);
    const slot0930 = (disp.horas as { id: string }[]).find((h) => /0930$/.test(h.id))!;
    const r = await reg.execute("createAppointment", { slotId: slot0930.id }, ctx);
    const out = JSON.parse(r.content);
    expect(out.rescheduled).toBe(true);
    expect(sched.appts).toHaveLength(1); // movió, no duplicó
    expect(sched.appts[0].professionalId).toBe(V); // sigue con Vargas
    expect(sched.appts[0].start).toBe(`${DAY}T12:30:00.000Z`);
  });

  it("esCitaAdicional:true permite agendar con otro profesional (cita ADEMÁS de la que tiene)", async () => {
    const sched = makeScheduling();
    seedCita(sched, V);
    const reg = new ToolRegistry();
    for (const t of buildCoreTools()) reg.register(t);
    const ctx = makeCtx(sched, "c-extra");
    const disp = await offer(reg, ctx, { professionalId: P });
    const slotPabst = (disp.horas as { id: string }[])[0];
    const r = await reg.execute("createAppointment", { slotId: slotPabst.id, esCitaAdicional: true }, ctx);
    const out = JSON.parse(r.content);
    expect(out.ok).toBe(true);
    expect(out.wrongProfessional).toBeUndefined();
    expect(sched.appts).toHaveLength(2); // la de Vargas + la nueva con Pabst
  });
});
