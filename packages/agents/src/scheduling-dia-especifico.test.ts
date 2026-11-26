import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry, buildCoreTools, diaDelMesPedido } from "./index.js";

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

// Cuando el proveedor (Cláriva) se cae/timeout, el bot NO debe decir "no hay horas": debe avisar
// que no pudo revisar la agenda. Antes el error se tragaba como [] → sinCupos → paciente perdido.
describe("getAvailability — error del proveedor NO es 'no hay horas'", () => {
  it("si getAvailableSlots lanza (proveedor caído) → errorAgenda, sin sinCupos", async () => {
    const sched = {
      kind: "clariva" as const,
      async getProfessionals() { return [{ id: "p1", name: "Dr. Aedo", specialty: null }]; },
      async getAvailableSlots() { throw new Error("Cláriva GET /availability → 503"); },
      async createAppointment(i: any) { return i; },
      async getPatientAppointments() { return []; },
      async updateAppointment(id: string, c: any) { return { id, ...c }; },
    };
    const r = await reg().execute("getAvailability", { professionalId: "p1" }, makeCtx(sched, "quiero una hora"));
    const out = JSON.parse(r.content);
    expect(out.errorAgenda).toBe(true);
    expect(out.sinCupos).toBeUndefined();
    expect(out.nota).toMatch(/NO digas que no hay horas/i);
  });
});

// Caso Tatiana (7-nov-2026): la lista ofreció la MISMA hora (15:15) en miércoles, jueves y viernes.
// El paciente dijo "Miércoles 15:15"; el modelo mandó la hora sin fijar el día → getSlot daba null →
// el bot decía "ya no está disponible" y re-ofrecía (incluyendo el mismo 15:15). Ahora se desambigua
// por el día que nombró el paciente y se agenda; si no se puede, se PREGUNTA, nunca "no disponible".
describe("createAppointment — misma hora en varios días: desambiguar, no decir 'no disponible'", () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00-03:00")); // sábado 7-nov (Chile)
    // 15:15 Chile (UTC-3 en noviembre) = 18:15 UTC, el MISMO horario en 3 días.
    const sched = makeSched({ "2026-11-11": ["18:15"], "2026-11-12": ["18:15"], "2026-11-13": ["18:15"] });
    const r = reg();
    const ctx = makeCtx(sched, "en la tarde");
    return { r, ctx };
  }
  async function offerTarde(r: any, ctx: any) {
    ctx.lastUserText = "en la tarde";
    const a = await r.execute("getAvailability", { professionalId: "p1", franja: "tarde" }, ctx);
    return JSON.parse(a.content);
  }

  it("'miércoles 15:15' (3 cupos a esa hora) → agenda el MIÉRCOLES, sin slotExpired ni 'no disponible'", async () => {
    const { r, ctx } = setup();
    const off = await offerTarde(r, ctx);
    expect(off.horas.length).toBe(3); // mié/jue/vie a las 15:15
    ctx.lastUserText = "Miércoles 15:15";
    const res = await r.execute("createAppointment", { slotId: "1515" }, ctx); // hora sin día = ambiguo
    const out = JSON.parse(res.content);
    expect(out.slotExpired).toBeUndefined();
    expect(out.needsDayClarification).toBeUndefined();
    expect(out.ok).toBe(true);
    expect(out.appointment.start).toBe("2026-11-11T18:15:00.000Z"); // miércoles 11
  });

  it("'miércoles 25 a las 15' se resuelve por el NÚMERO de día aunque el weekday no alcance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00-03:00"));
    // Varios MIÉRCOLES a las 15:00 (18:00 UTC): 12, 19, 26-nov (todos miércoles).
    const sched = makeSched({ "2026-11-12": ["18:00"], "2026-11-19": ["18:00"], "2026-11-26": ["18:00"] });
    const r = reg();
    const ctx = makeCtx(sched, "en la tarde");
    ctx.lastUserText = "en la tarde";
    await r.execute("getAvailability", { professionalId: "p1", franja: "tarde" }, ctx);
    ctx.lastUserText = "miércoles 26 a las 15:00"; // 26 fija el día entre los miércoles
    const out = JSON.parse((await r.execute("createAppointment", { slotId: "1500" }, ctx)).content);
    expect(out.ok).toBe(true);
    expect(out.appointment.start).toBe("2026-11-26T18:00:00.000Z");
  });

  it("sin día en el texto → PIDE aclarar, no agenda a ciegas ni dice 'no disponible'", async () => {
    const { r, ctx } = setup();
    await offerTarde(r, ctx);
    ctx.lastUserText = "la de las 15:15";
    const out = JSON.parse((await r.execute("createAppointment", { slotId: "1515" }, ctx)).content);
    expect(out.needsDayClarification).toBe(true);
    expect(out.slotExpired).toBeUndefined();
    expect(out.ok).toBeUndefined();
  });
});

// CASO REAL (Claudio Quintana, Digital-Dent, 16-nov-2026 — un LUNES): pidió "lunes 23 18:15"
// (el PRÓXIMO lunes) y el bot agendó HOY (lunes 16) 18:15, con OTRO profesional. getSlot resolvió
// DIRECTO el id de HOY (la lista que ve el modelo trae cupos de días que el paciente no pidió), así
// que la desambiguación por día —que solo corre cuando getSlot da null— nunca entró. La GUARDA DE
// DÍA valida el día del slot contra el día que el paciente nombró y NUNCA agenda otro.
describe("createAppointment — GUARDA DE DÍA: nunca agenda un día que el paciente no pidió (caso Claudio)", () => {
  afterEach(() => vi.useRealTimers());

  function lunes16() {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T12:00:00-03:00")); // hoy = lunes 16-nov-2026 (Chile)
  }

  it("'lunes 23 18:15' pero el modelo manda el id de HOY (misma hora) → agenda el 23, NO hoy", async () => {
    lunes16();
    // 18:15 Chile (UTC-3 en noviembre) = 21:15 UTC. El MISMO horario HOY (lun 16) y el próximo lunes (23).
    const sched = makeSched({ "2026-11-16": ["21:15"], "2026-11-23": ["21:15"] });
    const r = reg();
    const ctx = makeCtx(sched, "en la tarde");
    ctx.lastUserText = "en la tarde";
    await r.execute("getAvailability", { professionalId: "p1", franja: "tarde" }, ctx); // cachea hoy Y el 23
    ctx.lastUserText = "Lunes 23 18:15";
    const out = JSON.parse((await r.execute("createAppointment", { slotId: "h1611-1815" }, ctx)).content); // id de HOY
    expect(out.ok).toBe(true);
    expect(out.appointment.start).toBe("2026-11-23T21:15:00.000Z"); // el 23, NO hoy (16)
  });

  it("mismo caso pero el día 23 NO está en el caché → PIDE aclarar, jamás agenda hoy", async () => {
    lunes16();
    const sched = makeSched({ "2026-11-16": ["21:15"] }); // solo HOY a esa hora
    const r = reg();
    const ctx = makeCtx(sched, "en la tarde");
    ctx.lastUserText = "en la tarde";
    await r.execute("getAvailability", { professionalId: "p1", franja: "tarde" }, ctx);
    ctx.lastUserText = "Lunes 23 18:15";
    const out = JSON.parse((await r.execute("createAppointment", { slotId: "h1611-1815" }, ctx)).content);
    expect(out.needsDayClarification).toBe(true);
    expect(out.ok).toBeUndefined();
    expect(out.appointment).toBeUndefined();
  });

  it("si el id YA es del día pedido (23), la guarda no estorba y agenda normal", async () => {
    lunes16();
    const sched = makeSched({ "2026-11-16": ["21:15"], "2026-11-23": ["21:15"] });
    const r = reg();
    const ctx = makeCtx(sched, "en la tarde");
    ctx.lastUserText = "en la tarde";
    await r.execute("getAvailability", { professionalId: "p1", franja: "tarde" }, ctx);
    ctx.lastUserText = "Lunes 23 18:15";
    const out = JSON.parse((await r.execute("createAppointment", { slotId: "h2311-1815" }, ctx)).content); // id correcto
    expect(out.ok).toBe(true);
    expect(out.appointment.start).toBe("2026-11-23T21:15:00.000Z");
  });
});

// Unidad del extractor (lo usa la guarda de día). Fija que distingue un DÍA de una HORA: si confundiera
// "a las 3" o "18:15" con un día, bloquearía agendamientos legítimos.
describe("diaDelMesPedido — distingue el día del mes de una hora", () => {
  it("toma el día cuando el paciente lo nombra", () => {
    expect(diaDelMesPedido("Lunes 23 18:15")).toEqual({ day: 23, month: null });
    expect(diaDelMesPedido("me sirve el 9")).toEqual({ day: 9, month: null });
    expect(diaDelMesPedido("quiero el 23 de diciembre")).toEqual({ day: 23, month: 11 });
  });
  it("NO confunde una hora con un día", () => {
    expect(diaDelMesPedido("a las 3")).toBeNull();
    expect(diaDelMesPedido("la de las 18:15")).toBeNull();
    expect(diaDelMesPedido("miércoles 15:15")).toBeNull(); // 15:15 es hora, no el día 15
    expect(diaDelMesPedido("jueves 9 hrs")).toBeNull();
  });
});

// CASO REAL (Ricardo Heise, Digital-Dent, 26-nov-2026): pidió "después del 5 de enero". El bot solo
// miraba 28 días adelante, DESCARTÓ el día pedido, consultó nov-dic y AFIRMÓ "no hay disponibilidad
// en enero" → el paciente se fue a otra clínica HABIENDO cupos (la agenda estaba abierta hasta
// agosto). Estos tests fijan que una fecha LEJANA se consulta de verdad y JAMÁS se niega a ciegas.
describe("getAvailability — fecha LEJANA (más allá de 28 días): consultarla, nunca negarla (caso Ricardo)", () => {
  afterEach(() => vi.useRealTimers());
  const hoy26nov = () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T12:00:00-03:00")); // hoy = 26-nov-2026 (Chile)
  };
  const pedir = async (lastUserText: string, slotsByDay: Record<string, string[]>) =>
    JSON.parse((await reg().execute("getAvailability", { professionalId: "p1" }, makeCtx(makeSched(slotsByDay), lastUserText))).content);

  it("'después del 5 de enero' → ofrece ENERO (hay cupos), NO dice 'no hay'", async () => {
    hoy26nov();
    // Cupos reales en enero 2027 — justo lo que el bot NO veía por la ventana de 28 días.
    const out = await pedir("después del 5 de enero", { "2027-01-05": ["13:00", "13:15"], "2027-01-07": ["14:00"] });
    expect(out.sinCupos).toBeUndefined();
    expect(out.errorAgenda).toBeUndefined();
    expect(out.horas.length).toBeGreaterThan(0);
    expect(out.horas.every((h: any) => /^h\d{2}01-/.test(h.id))).toBe(true); // TODAS de enero (id hDDMM → mes 01)
  });

  it("'en febrero' (mes sin día) → ofrece FEBRERO, no niega", async () => {
    hoy26nov();
    const out = await pedir("quiero una hora en febrero", { "2027-02-10": ["13:00"], "2027-02-12": ["14:00"] });
    expect(out.sinCupos).toBeUndefined();
    expect(out.horas.length).toBeGreaterThan(0);
    expect(out.horas.every((h: any) => /^h\d{2}02-/.test(h.id))).toBe(true); // mes 02
  });

  it("si el día pedido (lejano) está lleno → ofrece el más cercano CON cupo DE ESE MES, no esta semana", async () => {
    hoy26nov();
    const out = await pedir("el 5 de enero", { "2026-11-27": ["13:00"], "2027-01-08": ["14:00"], "2027-01-09": ["15:00"] });
    expect(out.sinCupos).toBeUndefined();
    expect(out.horas.length).toBeGreaterThan(0);
    expect(out.horas.every((h: any) => /^h\d{2}01-/.test(h.id))).toBe(true); // enero, NUNCA noviembre
  });

  it("fecha a MÁS de ~5 meses → fechaLejana (deriva a una persona), NUNCA 'no hay'", async () => {
    hoy26nov();
    const out = await pedir("quiero el 5 de mayo", { "2027-05-05": ["13:00"] });
    expect(out.fechaLejana).toBe(true);
    expect(out.sinCupos).toBeUndefined();
    expect(out.nota).toMatch(/transferToHuman/);
  });

  it("un pedido CERCANO normal NO se rompe (sigue consultando los próximos días)", async () => {
    hoy26nov();
    const out = await pedir("¿tienen horas esta semana?", { "2026-11-27": ["13:00"], "2026-11-28": ["14:00"] });
    expect(out.sinCupos).toBeUndefined();
    expect(out.fechaLejana).toBeUndefined();
    expect(out.horas.length).toBeGreaterThan(0);
  });
});
