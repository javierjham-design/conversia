import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Cuando el paciente pide REAGENDAR (o CANCELAR) por WhatsApp, el bot libera su cita y hace
 * write-back a la agenda externa. El MOTIVO ("patient_reschedule" | "patient_cancel") DEBE
 * viajar en esa cancelación: el contrato ya lo acepta (POST /appointments/:id/cancel { reason }),
 * y es lo que le permite a Cláriva armar su lista nativa de "pendientes de reagendar" (cancelada
 * por reagendamiento y sin hora futura). Antes el caller NO pasaba el motivo → Cláriva no podía
 * distinguir un reagendamiento de una cancelación cualquiera. Este test fija ese contrato.
 */

const provider = {
  cancelAppointment: vi.fn(async () => ({})),
  confirmAppointment: vi.fn(async () => ({})),
};

// tx único que cubre todas las ramas (reagendar + cancelar + acuse).
const tx = {
  conversation: {
    findUnique: vi.fn(async () => ({ aiEnabled: true, contact: { phone: "56912345678" }, channelConnectionId: "cc1" })),
    update: vi.fn(async () => ({})),
  },
  appointment: {
    findFirst: vi.fn(async () => ({
      id: "appt1",
      externalId: "ext-abc",
      status: "CONFIRMED",
      startsAt: new Date(Date.now() + 86_400_000),
      endsAt: new Date(Date.now() + 86_400_000 + 1_800_000),
      timezone: "America/Santiago",
      professionalId: "p1",
      meta: { professionalId: "p1", professionalName: "Dra. X" },
    })),
    update: vi.fn(async () => ({})),
  },
  integrationEvent: { create: vi.fn(async () => ({})) },
  tag: { upsert: vi.fn(async () => ({ id: "tag1" })) },
  tagAssignment: { createMany: vi.fn(async () => ({})) },
  conversationAiNote: { create: vi.fn(async () => ({})) },
  message: { create: vi.fn(async () => ({ id: "msg1" })), update: vi.fn(async () => ({})) },
};

vi.mock("@conversia/database", () => ({
  withTenant: async (_org: string, fn: (t: unknown) => unknown) => fn(tx),
}));
vi.mock("./tool-services", () => ({ getSchedulingProviderFor: async () => provider }));
vi.mock("./workflow-runtime", () => ({ dispatchEvent: vi.fn(async () => ({})) }));
vi.mock("./channel-providers", () => ({
  getChannelProvider: () => ({ send: vi.fn(async () => ({ externalId: "wamid1" })) }),
}));
vi.mock("./channel-auth", () => ({
  ChannelAuthError: class extends Error {},
  markChannelAuthError: vi.fn(async () => ({})),
  resolveChannelAuth: async () => ({ phoneNumberId: "pn1", accessToken: "tok", channelConnectionId: "cc1" }),
}));
vi.mock("./service-metering", () => ({ recordServiceSend: vi.fn(async () => ({})) }));
vi.mock("./messaging-guard", () => ({ chargeServiceSend: vi.fn(async () => ({ blocked: false })) }));
vi.mock("./wallet", () => ({ refundForMessage: vi.fn(async () => ({})) }));

import { handleAppointmentResponse } from "./appointment-responses";

describe("handleAppointmentResponse — el motivo viaja al write-back externo (señal para Cláriva)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("REAGENDAR → cancela en la agenda externa con reason='patient_reschedule' y deja al agente seguir", async () => {
    const handled = await handleAppointmentResponse("org1", "conv1", "contact1", "reagendar");
    expect(provider.cancelAppointment).toHaveBeenCalledWith("ext-abc", "patient_reschedule");
    // devuelve false: el agente ofrece horarios y agenda la nueva (no la maneja este módulo).
    expect(handled).toBe(false);
  });

  it("CANCELAR explícito → cancela con reason='patient_cancel' (no contamina la lista de reagendar)", async () => {
    const handled = await handleAppointmentResponse("org1", "conv1", "contact1", "cancelar");
    expect(provider.cancelAppointment).toHaveBeenCalledWith("ext-abc", "patient_cancel");
    expect(handled).toBe(true);
  });

  it("CONFIRMAR no cancela nada (no toca la agenda con un cancel)", async () => {
    await handleAppointmentResponse("org1", "conv1", "contact1", "confirmar");
    expect(provider.cancelAppointment).not.toHaveBeenCalled();
    expect(provider.confirmAppointment).toHaveBeenCalledWith("ext-abc");
  });
});
