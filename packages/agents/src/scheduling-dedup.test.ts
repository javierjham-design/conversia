import { afterEach, describe, expect, it, vi } from "vitest";
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

// Reagendamiento a OTRA semana (caso Rubén, 29-oct-2026): el paciente pidió mover su hora del
// 30-oct a la semana siguiente. Antes el "mover en vez de duplicar" solo cubría el MISMO día →
// un cambio a otro día creaba una 2ª cita y dejaba la vieja VIVA ocupando el bloque. Ahora, si
// la cita del mismo profesional es inequívoca (una sola), se mueve aunque sea otro día.
const DAY2 = "2026-12-14"; // otra semana (DAY = 2026-12-07)

async function offerForDay(registry: ToolRegistry, ctx: any, day: string): Promise<{ id: string; cuando: string }[]> {
  const r = await registry.execute("getAvailability", { professionalId: "p1", fromDate: day, toDate: day }, ctx);
  expect(r.isError).toBe(false);
  return JSON.parse(r.content).horas as { id: string; cuando: string }[];
}

describe("createAppointment — reagendar a otro día no duplica", () => {
  it("mueve la cita a OTRA semana con el MISMO profesional (caso Rubén), no crea una segunda", async () => {
    const scheduling = makeScheduling();

    // Turno 1: agenda 09:15 el DAY.
    const reg1 = new ToolRegistry();
    for (const t of buildCoreTools()) reg1.register(t);
    const ctx1 = makeCtx(scheduling, "conv-ruben");
    const h1 = await offerForDay(reg1, ctx1, DAY);
    await reg1.execute("createAppointment", { slotId: h1.find((h) => /0915$/.test(h.id))!.id }, ctx1);
    expect(scheduling.appts).toHaveLength(1);

    // Turno 2, worker "reiniciado" (tools nuevas → bookedCache vacío): reagenda a la OTRA semana.
    const reg2 = new ToolRegistry();
    for (const t of buildCoreTools()) reg2.register(t);
    const ctx2 = makeCtx(scheduling, "conv-ruben");
    const h2 = await offerForDay(reg2, ctx2, DAY2);
    const r2 = await reg2.execute("createAppointment", { slotId: h2.find((h) => /0915$/.test(h.id))!.id }, ctx2);
    const out2 = JSON.parse(r2.content);

    expect(out2.rescheduled).toBe(true);
    expect(scheduling.appts).toHaveLength(1); // ← una sola cita, la vieja se movió
    expect(scheduling.appts[0].start).toBe(`${DAY2}T12:15:00.000Z`);
  });

  it("esCitaAdicional=true crea una SEGUNDA cita (no mueve la existente)", async () => {
    const scheduling = makeScheduling();

    const reg1 = new ToolRegistry();
    for (const t of buildCoreTools()) reg1.register(t);
    const ctx1 = makeCtx(scheduling, "conv-add");
    const h1 = await offerForDay(reg1, ctx1, DAY);
    await reg1.execute("createAppointment", { slotId: h1.find((h) => /0915$/.test(h.id))!.id }, ctx1);
    expect(scheduling.appts).toHaveLength(1);

    const reg2 = new ToolRegistry();
    for (const t of buildCoreTools()) reg2.register(t);
    const ctx2 = makeCtx(scheduling, "conv-add");
    const h2 = await offerForDay(reg2, ctx2, DAY2);
    const r2 = await reg2.execute("createAppointment", { slotId: h2.find((h) => /0915$/.test(h.id))!.id, esCitaAdicional: true }, ctx2);
    const out2 = JSON.parse(r2.content);

    expect(out2.ok).toBe(true);
    expect(out2.rescheduled).toBeUndefined();
    expect(scheduling.appts).toHaveLength(2); // ← cita ADICIONAL: se crean dos
  });
});

// Caso Víctor (2-nov-2026): el bot ofreció horas, el paciente demoró ~40 min en elegir y la hora
// ya se había tomado → el bot se desdijo ("no disponible"). Fijamos (1) que confirmar una hora
// vencida NO agende a ciegas y pida reconsultar, y (2) que getAvailability advierta que las horas
// no quedan reservadas y que no se repitan de memoria.
describe("horas que vencen entre la oferta y la confirmación (caso Víctor)", () => {
  afterEach(() => vi.useRealTimers());

  it("getAvailability avisa que las horas NO quedan reservadas y que hay que reconsultar antes de confirmar", async () => {
    const reg = new ToolRegistry();
    for (const t of buildCoreTools()) reg.register(t);
    const ctx = makeCtx(makeScheduling(), "conv-fresh");
    const r = await reg.execute("getAvailability", { professionalId: "p1", fromDate: DAY, toDate: DAY }, ctx);
    const out = JSON.parse(r.content);
    expect(out.nota).toContain("NO quedan reservadas");
    expect(out.nota).toMatch(/vuelve a llamar getAvailability ANTES de confirmar/i);
  });

  it("confirmar una hora cuya lista YA venció (TTL 10 min) no agenda: pide reconsultar (slotExpired)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-02T12:00:00-03:00")); // la oferta
    const scheduling = makeScheduling();
    const reg = new ToolRegistry();
    for (const t of buildCoreTools()) reg.register(t);
    const ctx = makeCtx(scheduling, "conv-victor");
    const horas = await offerAndGetIds(reg, ctx);
    const elegida = horas[0]!; // la hora que el paciente elegirá

    // El paciente responde 11 minutos después (> TTL de 10 min): la lista venció.
    vi.setSystemTime(new Date("2026-11-02T12:11:00-03:00"));
    const r = await reg.execute("createAppointment", { slotId: elegida.id }, ctx);
    const out = JSON.parse(r.content);

    expect(out.slotExpired).toBe(true);
    expect(out.error).toMatch(/vuelve a llamar getAvailability/i);
    expect(scheduling.appts).toHaveLength(0); // NO se agendó a ciegas una hora vencida
  });
});
