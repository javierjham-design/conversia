import { describe, expect, it } from "vitest";
import { ToolRegistry, buildCoreTools } from "./index.js";

// Reproduce el caso Margarita (23-oct-2026): el bot agendó 09:15, y un "ok" ~13 min después
// (fuera de la ventana de 3 min del bookedCache en memoria, o tras un reinicio del worker)
// volvió a entrar al flujo y creó una SEGUNDA cita a las 09:30. La guardia PERSISTENTE debe
// detectar la cita activa del día con el mismo profesional y MOVERLA, no crear una segunda.

function makeScheduling() {
  const appts: Array<{ id: string; clinicId: string; professionalId: string; patient: any; start: string; end: string; status: string }> = [];
  let seq = 0;
  return {
    appts,
    kind: "clariva" as const,
    async getProfessionals() {
      return [{ id: "p1", name: "Dr. Javier Aedo", specialty: null }];
    },
    async getAvailableSlots({ from }: { from: string }) {
      // Dos cupos el MISMO día (hora Chile UTC-3): 09:15 y 09:30.
      return [
        { start: `${from}T12:15:00.000Z`, end: `${from}T12:45:00.000Z`, professionalId: "p1", clinicId: "c" },
        { start: `${from}T12:30:00.000Z`, end: `${from}T13:00:00.000Z`, professionalId: "p1", clinicId: "c" },
      ];
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
      return { firstName: "Margarita", lastName: "Ramos", phone: "+56985201656" };
    },
    async updateContactFields() {
      return { updated: [] as string[] };
    },
    async recordAppointment() {
      /* upsert local — no-op en el test */
    },
  };
  return { organizationId: "org1", conversationId, clinicId: "c", agentName: "RESP IMPLANTES", brandName: "Digital-Dent", services } as any;
}

const DAY = "2026-12-07"; // futuro (hoy = 2026-10-26), Chile UTC-3

async function offerAndGetIds(registry: ToolRegistry, ctx: any): Promise<{ id: string; cuando: string }[]> {
  const r = await registry.execute("getAvailability", { professionalId: "p1", fromDate: DAY, toDate: DAY }, ctx);
  expect(r.isError).toBe(false);
  return JSON.parse(r.content).horas as { id: string; cuando: string }[];
}

describe("createAppointment — guardia anti doble-agendamiento", () => {
  it("mueve la cita existente en vez de crear una segunda el mismo día (caso Margarita)", async () => {
    const scheduling = makeScheduling();

    // Turno 1: ofrece y agenda 09:15.
    const reg1 = new ToolRegistry();
    for (const t of buildCoreTools()) reg1.register(t);
    const ctx1 = makeCtx(scheduling, "conv-marg");
    const horas1 = await offerAndGetIds(reg1, ctx1);
    const slot0915 = horas1.find((h) => /0915$/.test(h.id))!;
    const r1 = await reg1.execute("createAppointment", { slotId: slot0915.id }, ctx1);
    expect(JSON.parse(r1.content).ok).toBe(true);
    expect(scheduling.appts).toHaveLength(1);
    expect(scheduling.appts[0].start).toBe(`${DAY}T12:15:00.000Z`);

    // Turno 2, worker "reiniciado" (instancia NUEVA de tools → bookedCache vacío): un "ok" lleva
    // al bot a reofrecer y agendar 09:30. NO debe crear una segunda cita: debe mover la de 09:15.
    const reg2 = new ToolRegistry();
    for (const t of buildCoreTools()) reg2.register(t);
    const ctx2 = makeCtx(scheduling, "conv-marg");
    const horas2 = await offerAndGetIds(reg2, ctx2);
    const slot0930 = horas2.find((h) => /0930$/.test(h.id))!;
    const r2 = await reg2.execute("createAppointment", { slotId: slot0930.id }, ctx2);
    const out2 = JSON.parse(r2.content);

    expect(out2.rescheduled).toBe(true);
    expect(scheduling.appts).toHaveLength(1); // ← una sola cita, no dos
    expect(scheduling.appts[0].start).toBe(`${DAY}T12:30:00.000Z`); // movida a 09:30
  });

  it("devuelve la misma cita (no duplica) si se re-agenda la MISMA hora", async () => {
    const scheduling = makeScheduling();
    const reg1 = new ToolRegistry();
    for (const t of buildCoreTools()) reg1.register(t);
    const ctx1 = makeCtx(scheduling, "c2");
    const horas1 = await offerAndGetIds(reg1, ctx1);
    const slot0915 = horas1.find((h) => /0915$/.test(h.id))!;
    await reg1.execute("createAppointment", { slotId: slot0915.id }, ctx1);

    const reg2 = new ToolRegistry();
    for (const t of buildCoreTools()) reg2.register(t);
    const ctx2 = makeCtx(scheduling, "c2");
    const horas2 = await offerAndGetIds(reg2, ctx2);
    const again = horas2.find((h) => /0915$/.test(h.id))!;
    const r2 = await reg2.execute("createAppointment", { slotId: again.id }, ctx2);

    expect(JSON.parse(r2.content).alreadyBooked).toBe(true);
    expect(scheduling.appts).toHaveLength(1);
  });

  it("tolera el id con día/mes invertido (hMMDD en vez de hDDMM)", async () => {
    const scheduling = makeScheduling();
    const reg = new ToolRegistry();
    for (const t of buildCoreTools()) reg.register(t);
    const ctx = makeCtx(scheduling, "c3");
    const horas = await offerAndGetIds(reg, ctx);
    const real = horas.find((h) => /0915$/.test(h.id))!; // hDDMM-0915
    // El modelo arma el id como hMMDD-0915 (intercambia día y mes).
    const m = real.id.match(/^h(\d{2})(\d{2})-(\d{4})$/)!;
    const swapped = `h${m[2]}${m[1]}-${m[3]}`;
    expect(swapped).not.toBe(real.id);
    const r = await reg.execute("createAppointment", { slotId: swapped }, ctx);
    expect(JSON.parse(r.content).ok).toBe(true);
    expect(scheduling.appts).toHaveLength(1);
    expect(scheduling.appts[0].start).toBe(`${DAY}T12:15:00.000Z`);
  });
});
