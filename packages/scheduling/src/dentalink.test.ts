import { describe, expect, it } from "vitest";
import { computeDentalinkSlots, mapDentalinkCita, mapDentalinkEstado, parseOffsetMs, type DentalinkCita } from "./dentalink";

// Fixtures con la forma real de la API de Dentalink (sobre {data} ya desenvuelto)
const CITA_FIXTURE: DentalinkCita = {
  id: 4581,
  id_paciente: 912,
  id_dentista: 626,
  id_sucursal: 3,
  fecha: "2026-08-10",
  hora_inicio: "15:30",
  duracion: 45,
  estado_cita: "Confirmada",
  comentario: "Control de ortodoncia",
  nombre_paciente: "María",
  apellidos_paciente: "Pérez Soto",
  celular_paciente: "+56 9 8765 4321",
};

describe("mapDentalinkEstado", () => {
  it("mapea los textos típicos de las clínicas chilenas", () => {
    expect(mapDentalinkEstado("Anulada")).toBe("cancelled");
    expect(mapDentalinkEstado("Cita cancelada")).toBe("cancelled");
    expect(mapDentalinkEstado("No asiste")).toBe("no_show");
    expect(mapDentalinkEstado("Atendida")).toBe("completed");
    expect(mapDentalinkEstado("Realizada")).toBe("completed");
    expect(mapDentalinkEstado("Reagendada")).toBe("rescheduled");
    expect(mapDentalinkEstado("Confirmada")).toBe("confirmed");
    expect(mapDentalinkEstado("No confirmada")).toBe("pending"); // la negación gana al match positivo
    expect(mapDentalinkEstado("Por confirmar")).toBe("pending");
  });

  it("estados desconocidos o vacíos quedan pendientes", () => {
    expect(mapDentalinkEstado("En espera")).toBe("pending");
    expect(mapDentalinkEstado(undefined)).toBe("pending");
    expect(mapDentalinkEstado("")).toBe("pending");
  });
});

describe("mapDentalinkCita", () => {
  it("convierte fecha/hora/duración al contrato estándar con offset", () => {
    const appt = mapDentalinkCita(CITA_FIXTURE, "-04:00");
    expect(appt.id).toBe("4581");
    expect(appt.clinicId).toBe("3");
    expect(appt.professionalId).toBe("626");
    expect(appt.start).toBe("2026-08-10T15:30:00-04:00");
    // 15:30 -04:00 + 45 min = 20:15 UTC
    expect(appt.end).toBe("2026-08-10T20:15:00.000Z");
    expect(appt.status).toBe("confirmed");
    expect(appt.patient.firstName).toBe("María");
    expect(appt.patient.externalId).toBe("912");
    expect(appt.notes).toBe("Control de ortodoncia");
  });

  it("tolera hora corta y duración faltante (default 30)", () => {
    const appt = mapDentalinkCita({ ...CITA_FIXTURE, hora_inicio: "9:00", duracion: 0 });
    expect(appt.start).toBe("2026-08-10T09:00:00-04:00");
    expect(new Date(appt.end).getTime() - new Date(appt.start).getTime()).toBe(30 * 60_000);
  });
});

describe("computeDentalinkSlots", () => {
  const base = {
    from: "2026-08-10", // lunes
    to: "2026-08-10",
    professionalId: "626",
    clinicId: "3",
    workStartHour: 9,
    workEndHour: 11,
    slotMinutes: 30,
    utcOffset: "-04:00",
    now: new Date("2026-08-01T00:00:00Z"),
  };

  it("sin citas ocupadas genera toda la ventana laboral", () => {
    const slots = computeDentalinkSlots({ ...base, busy: [] });
    expect(slots.map((s) => s.start)).toEqual([
      "2026-08-10T09:00:00-04:00",
      "2026-08-10T09:30:00-04:00",
      "2026-08-10T10:00:00-04:00",
      "2026-08-10T10:30:00-04:00",
    ]);
  });

  it("resta las citas existentes (incluye solapamientos parciales)", () => {
    // 09:15–10:00 ocupa los slots de 09:00 y 09:30
    const busy: DentalinkCita[] = [{ ...CITA_FIXTURE, fecha: "2026-08-10", hora_inicio: "09:15", duracion: 45 }];
    const slots = computeDentalinkSlots({ ...base, busy });
    expect(slots.map((s) => s.start)).toEqual(["2026-08-10T10:00:00-04:00", "2026-08-10T10:30:00-04:00"]);
  });

  it("ignora citas anuladas y citas de otro dentista", () => {
    const busy: DentalinkCita[] = [
      { ...CITA_FIXTURE, hora_inicio: "09:00", estado_cita: "Anulada" },
      { ...CITA_FIXTURE, id_dentista: 999, hora_inicio: "10:00", estado_cita: "Confirmada" },
    ];
    expect(computeDentalinkSlots({ ...base, busy })).toHaveLength(4);
  });

  it("no ofrece horas pasadas ni domingos", () => {
    const past = computeDentalinkSlots({ ...base, busy: [], now: new Date("2026-08-10T13:45:00Z") }); // 09:45 local
    expect(past.map((s) => s.start)).toEqual([
      "2026-08-10T10:00:00-04:00",
      "2026-08-10T10:30:00-04:00",
    ]);
    const sunday = computeDentalinkSlots({ ...base, from: "2026-08-09", to: "2026-08-09", busy: [] });
    expect(sunday).toHaveLength(0);
  });
});

describe("parseOffsetMs", () => {
  it("convierte offsets con signo", () => {
    expect(parseOffsetMs("-04:00")).toBe(-4 * 3600_000);
    expect(parseOffsetMs("+05:30")).toBe(5.5 * 3600_000);
    expect(parseOffsetMs("no-valido")).toBe(0);
  });
});
