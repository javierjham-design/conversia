import { describe, expect, it } from "vitest";
import { selectPendingReschedule, type PendingApptLite, type RescheduleRequest } from "./pending-reschedule";

const NOW = new Date("2026-11-01T12:00:00.000Z");
const REQ = new Date("2026-10-30T15:00:00.000Z"); // cuando pidió reagendar

function run(
  requests: RescheduleRequest[],
  appts: Record<string, PendingApptLite[]>,
  contacts: Record<string, { name: string; phone: string | null }>,
) {
  return selectPendingReschedule({
    now: NOW,
    requests,
    apptsByContact: new Map(Object.entries(appts)),
    contacts: new Map(Object.entries(contacts)),
  });
}

const req = (contactId: string, requestedAt = REQ): RescheduleRequest => ({ contactId, conversationId: `conv_${contactId}`, requestedAt });

describe("selectPendingReschedule", () => {
  it("pendiente: pidió reagendar y solo le queda la cita CANCELADA (en el aire)", () => {
    const rows = run(
      [req("c1")],
      { c1: [{ status: "CANCELLED", startsAt: new Date("2026-11-02T13:00:00Z"), professionalName: "Dr. A" }] },
      { c1: { name: "Paciente Uno", phone: "+569111" } },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].contactId).toBe("c1");
    expect(rows[0].conversationId).toBe("conv_c1");
    expect(rows[0].canceledSlot?.professionalName).toBe("Dr. A");
    expect(rows[0].canceledSlot?.startsAt).toBe("2026-11-02T13:00:00.000Z");
  });

  it("YA reagendó (tiene cita futura) → sale de la lista", () => {
    const rows = run(
      [req("c1")],
      {
        c1: [
          { status: "CANCELLED", startsAt: new Date("2026-11-02T13:00:00Z"), professionalName: "Dr. A" },
          { status: "PENDING", startsAt: new Date("2026-11-05T16:00:00Z"), professionalName: "Dr. A" },
        ],
      },
      { c1: { name: "Paciente Uno", phone: null } },
    );
    expect(rows).toHaveLength(0);
  });

  it("reagendó y YA atendió (COMPLETED tras pedirlo) → no está en el aire", () => {
    const rows = run(
      [req("c1")],
      { c1: [{ status: "COMPLETED", startsAt: new Date("2026-10-31T10:00:00Z"), professionalName: "Dr. A" }] },
      { c1: { name: "Paciente Uno", phone: null } },
    );
    expect(rows).toHaveLength(0);
  });

  it("una cita vieja COMPLETED anterior al pedido NO cuenta como reagendo", () => {
    const rows = run(
      [req("c1")],
      {
        c1: [
          { status: "COMPLETED", startsAt: new Date("2026-10-20T10:00:00Z"), professionalName: "Dr. A" }, // antes del pedido
          { status: "CANCELLED", startsAt: new Date("2026-11-02T13:00:00Z"), professionalName: "Dr. A" },
        ],
      },
      { c1: { name: "Paciente Uno", phone: "+569111" } },
    );
    expect(rows).toHaveLength(1);
  });

  it("toma el pedido más reciente y ordena por más reciente primero; ignora contactos sin ficha", () => {
    const older = new Date("2026-10-25T10:00:00Z");
    const newer = new Date("2026-10-31T09:00:00Z");
    const rows = run(
      [req("c1", older), req("c1", newer), req("c2", older), req("cX", newer)],
      {
        c1: [{ status: "CANCELLED", startsAt: new Date("2026-11-03T10:00:00Z"), professionalName: null }],
        c2: [{ status: "CANCELLED", startsAt: new Date("2026-11-01T10:00:00Z"), professionalName: null }],
        // cX no tiene ficha en `contacts` → se ignora
      },
      { c1: { name: "Uno", phone: null }, c2: { name: "Dos", phone: null } },
    );
    expect(rows.map((r) => r.contactId)).toEqual(["c1", "c2"]); // c1 primero (pedido más reciente)
    expect(rows[0].requestedAt).toBe(newer.toISOString());
  });
});
