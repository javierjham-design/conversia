import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry, buildCoreTools } from "./index.js";

// CASO REAL (Digital-Dent, nov-2026): el paciente pide "lunes 9"; el bot descartaba el número
// del día (solo miraba "lunes"), abanicaba TODOS los lunes y, si el 9 estaba lleno, ofrecía el
// 16 SIN avisar que el 9 no tenía. Estos tests fijan la resolución del DÍA DEL MES: se consulta
// ESE día; si hay, se ofrece ESE día; si no, se DICE y se ofrecen los más cercanos con cupo.

// Fake de Cláriva con disponibilidad por día civil (hora Chile; nov = UTC-3).
function makeSched(slotsByDay: Record<string, string[]>) {
  return {
    kind: "clariva" as const,
    async getProfessionals() {
      return [{ id: "p1", name: "Dr. Aedo", specialty: null }];
    },
    async getAvailableSlots({ from, to }: { from: string; to: string }) {
      const out: Array<{ start: string; end: string; professionalId: string; clinicId: string }> = [];
      for (const [day, horas] of Object.entries(slotsByDay)) {
        if (day < from || day > to) continue;
        for (const hhmmUtc of horas) {
          const start = `${day}T${hhmmUtc}:00.000Z`;
          out.push({ start, end: new Date(new Date(start).getTime() + 30 * 60000).toISOString(), professionalId: "p1", clinicId: "c" });
        }
      }
      return out;
    },
    async createAppointment(input: any) {
      return { id: "a1", clinicId: input.clinicId, professionalId: input.professionalId, patient: input.patient, start: input.start, end: input.end, status: "pending" };
    },
    async getPatientAppointments() {
      return [];
    },
    async updateAppointment(id: string, changes: any) {
      return { id, ...changes };
    },
  };
}

function makeCtx(scheduling: any, lastUserText: string) {
  const services = {
    scheduling,
    async contactInfo() {
      return { firstName: "Paciente", lastName: "Prueba", phone: "+56990000000" };
    },
    async updateContactFields() {
      return { updated: [] as string[] };
    },
    async recordAppointment() {},
  };
  return { organizationId: "org1", conversationId: `c-${Math.random()}`, clinicId: "c", agentName: "AG", brandName: "Digital-Dent", services, lastUserText } as any;
}

function reg() {
  const r = new ToolRegistry();
  for (const t of buildCoreTools()) r.register(t);
  return r;
}

async function ask(lastUserText: string, slotsByDay: Record<string, string[]>) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-07T12:00:00-03:00")); // hoy = sábado 7-nov-2026 (Chile)
  try {
    const r = await reg().execute("getAvailability", { professionalId: "p1" }, makeCtx(makeSched(slotsByDay), lastUserText));
    return JSON.parse(r.content);
  } finally {
    vi.useRealTimers();
  }
}

describe("getAvailability — resolución del día del mes pedido", () => {
  afterEach(() => vi.useRealTimers());

  it("'9 de noviembre' CON cupos ese día → ofrece SOLO el 9, no abanica al 16", async () => {
    const out = await ask("hola, quiero una hora el 9 de noviembre", {
      "2026-11-09": ["12:15", "12:30", "12:45", "13:00"],
      "2026-11-16": ["12:15", "12:30"],
    });
    expect(out.horas.length).toBe(4); // las 4 del día 9 (rama de un solo día)
    expect(out.horas.every((h: any) => /^h0911-/.test(h.id))).toBe(true); // día 09, mes 11
    expect(out.horas.some((h: any) => /^h1611-/.test(h.id))).toBe(false); // NINGUNA del 16
    expect(out.nota).toContain("9 de noviembre");
  });

  it("'el 9' SIN cupos ese día → lo DICE y ofrece los más cercanos con cupo (no salta mudo)", async () => {
    const out = await ask("tienes para el 9?", {
      "2026-11-10": ["18:00"],
      "2026-11-16": ["12:15", "12:30"],
    });
    expect(out.nota).toMatch(/NO tiene horas/i);
    expect(out.nota).toContain("9 de noviembre");
    // ofrece el 10 y el 16 (cercanos con cupo), NINGUNA simulada del 9
    expect(out.horas.length).toBeGreaterThan(0);
    expect(out.horas.some((h: any) => /^h0911-/.test(h.id))).toBe(false);
    expect(out.horas.some((h: any) => /^h1011-/.test(h.id))).toBe(true);
  });

  it("'lunes 9' (el 9 SÍ es lunes) resuelve al 9 sin conflicto", async () => {
    const out = await ask("me das hora el lunes 9", { "2026-11-09": ["12:15", "12:30"] });
    expect(out.aclararFecha).toBeUndefined();
    expect(out.horas.every((h: any) => /^h0911-/.test(h.id))).toBe(true);
  });

  it("'lunes 10' (el 10 cae martes) → pide aclarar, no ofrece horas a ciegas", async () => {
    const out = await ask("quiero el lunes 10", { "2026-11-10": ["12:15"] });
    expect(out.aclararFecha).toBe(true);
    expect(out.horas).toBeUndefined();
  });

  it("sin día del mes en el texto → comportamiento normal (no rompe el camino genérico)", async () => {
    const out = await ask("hola, tienen horas disponibles?", {
      "2026-11-09": ["12:15"],
      "2026-11-12": ["15:00"],
    });
    expect(out.aclararFecha).toBeUndefined();
    expect(out.horas.length).toBeGreaterThan(0); // abanico normal por día
  });
});
