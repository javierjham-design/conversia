import { describe, expect, it } from "vitest";
import { ToolRegistry, buildCoreTools } from "./index.js";

// derivarReagendamiento (opción elegida por el dueño): cuando el bot NO puede reagendar con el
// MISMO profesional del paciente, LIBERA (cancela con motivo 'patient_reschedule') su hora actual
// y deriva al equipo → el paciente cae en la lista "Pendientes de reagendar" de Cláriva.

const DAY = "2026-12-21";

function makeScheduling(seed: Array<{ id: string; prof: string; utcHour: number; status?: string }>) {
  const appts = seed.map((s) => ({
    id: s.id, clinicId: "c", professionalId: s.prof, patient: { phone: "+56990000001" },
    start: `${DAY}T${String(s.utcHour).padStart(2, "0")}:00:00.000Z`, end: `${DAY}T${String(s.utcHour).padStart(2, "0")}:15:00.000Z`,
    status: s.status ?? "confirmed",
  }));
  const cancels: Array<{ id: string; reason?: string }> = [];
  return {
    appts, cancels,
    kind: "clariva" as const,
    async getPatientAppointments() { return appts.filter((a) => a.status !== "cancelled"); },
    async cancelAppointment(id: string, reason?: string) {
      const a = appts.find((x) => x.id === id)!;
      a.status = "cancelled";
      cancels.push({ id, reason });
      return a;
    },
  };
}

function makeCtx(scheduling: any, handoffs: string[]) {
  const services = {
    scheduling,
    async contactInfo() { return { firstName: "Ana", lastName: "Pérez", phone: "+56990000001" }; },
    async requestHumanHandoff(reason: string) { handoffs.push(reason); },
  };
  return { organizationId: "org1", conversationId: "c1", clinicId: "c", agentName: "Agendamiento", brandName: "Digital-Dent", services } as any;
}

function reg() {
  const r = new ToolRegistry();
  for (const t of buildCoreTools()) r.register(t);
  return r;
}

describe("derivarReagendamiento — libera la hora + deriva", () => {
  it("con UNA hora futura: la cancela con motivo 'patient_reschedule' y deriva", async () => {
    const sched = makeScheduling([{ id: "cita1", prof: "pV", utcHour: 18 }]);
    const handoffs: string[] = [];
    const r = await reg().execute("derivarReagendamiento", { motivo: "sin horas con Vargas" }, makeCtx(sched, handoffs));
    const out = JSON.parse(r.content);
    expect(out.ok).toBe(true);
    expect(out.citaLiberada).toBeTruthy();
    expect(sched.cancels).toEqual([{ id: "cita1", reason: "patient_reschedule" }]);
    expect(sched.appts[0].status).toBe("cancelled");
    expect(handoffs).toHaveLength(1); // derivado al equipo
  });

  it("con VARIAS horas futuras: NO adivina cuál cancelar, solo deriva", async () => {
    const sched = makeScheduling([{ id: "c1", prof: "pV", utcHour: 18 }, { id: "c2", prof: "pA", utcHour: 20 }]);
    const handoffs: string[] = [];
    const r = await reg().execute("derivarReagendamiento", {}, makeCtx(sched, handoffs));
    const out = JSON.parse(r.content);
    expect(out.ok).toBe(true);
    expect(out.citaLiberada).toBeNull();
    expect(sched.cancels).toHaveLength(0); // no canceló ninguna
    expect(handoffs).toHaveLength(1);
  });

  it("sin horas futuras: no cancela nada, igual deriva", async () => {
    const sched = makeScheduling([]);
    const handoffs: string[] = [];
    const r = await reg().execute("derivarReagendamiento", {}, makeCtx(sched, handoffs));
    const out = JSON.parse(r.content);
    expect(out.ok).toBe(true);
    expect(out.citaLiberada).toBeNull();
    expect(sched.cancels).toHaveLength(0);
    expect(handoffs).toHaveLength(1);
  });
});
