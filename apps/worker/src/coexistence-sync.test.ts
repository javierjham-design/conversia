import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@conversia/database", () => ({ getAdminPrisma: vi.fn(), withTenant: vi.fn() }));
import { getAdminPrisma, withTenant } from "@conversia/database";
import { parseCoexistenceSync, processCoexistenceSync } from "./coexistence-sync";

const asMock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;

/** tx falso que captura las operaciones; devuelve lo que configures en `seed`. */
function fakeTx(seed: Partial<Record<string, any>> = {}) {
  return {
    whatsappAccount: { findFirst: vi.fn(async () => seed.account ?? { id: "acc1" }) },
    whatsappPhoneNumber: { findUnique: vi.fn(async () => seed.number ?? null), create: vi.fn(async () => ({})) },
    channelConnection: { findFirst: vi.fn(async () => seed.channel ?? null), update: vi.fn(async () => ({})) },
    contact: { findFirst: vi.fn(async () => seed.contact ?? null), create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
    integrationEvent: { create: vi.fn(async () => ({})) },
  };
}

describe("parseCoexistenceSync — extrae los campos de sync a nivel WABA", () => {
  it("toma phone_number / smb_app_state_sync / history con su waba_id; ignora messages", () => {
    const raw = {
      entry: [
        {
          id: "WABA9",
          changes: [
            { field: "phone_number", value: { phone_number_id: "P1", display_phone_number: "+56 9 1" } },
            { field: "smb_app_state_sync", value: { state_sync: [] } },
            { field: "history", value: { contacts: [] } },
            { field: "messages", value: { messages: [] } },
          ],
        },
      ],
    };
    const out = parseCoexistenceSync(raw);
    expect(out.map((c) => c.field)).toEqual(["phone_number", "smb_app_state_sync", "history"]);
    expect(out[0].wabaId).toBe("WABA9");
  });
  it("devuelve [] si no hay entry", () => expect(parseCoexistenceSync({})).toEqual([]));
});

describe("processCoexistenceSync — enruta por campo y resuelve la org por waba", () => {
  afterEach(() => vi.restoreAllMocks());

  it("WABA ajena (sin org) → no hace nada", async () => {
    asMock(getAdminPrisma).mockReturnValue({ whatsappAccount: { findFirst: vi.fn(async () => null) } });
    const wt = asMock(withTenant).mockImplementation(async () => undefined);
    await processCoexistenceSync({ entry: [{ id: "OTRA", changes: [{ field: "phone_number", value: { phone_number_id: "P" } }] }] });
    expect(wt).not.toHaveBeenCalled();
  });

  it("phone_number → crea la fila del número y apaga pendingNumber", async () => {
    asMock(getAdminPrisma).mockReturnValue({ whatsappAccount: { findFirst: vi.fn(async () => ({ organizationId: "ORG1" })) } });
    const tx = fakeTx({ channel: { id: "ch1", config: { coexistence: true, pendingNumber: true } } });
    asMock(withTenant).mockImplementation(async (_org: string, cb: (t: any) => Promise<unknown>) => cb(tx));
    await processCoexistenceSync({ entry: [{ id: "WABA9", changes: [{ field: "phone_number", value: { phone_number_id: "P1", display_phone_number: "+56 9 1" } }] }] });
    expect(tx.whatsappPhoneNumber.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ phoneNumberId: "P1" }) }));
    expect(tx.channelConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "active", config: expect.objectContaining({ pendingNumber: false }) }) }));
  });

  it("smb_app_state_sync → upsert de contactos (dedup por teléfono normalizado)", async () => {
    asMock(getAdminPrisma).mockReturnValue({ whatsappAccount: { findFirst: vi.fn(async () => ({ organizationId: "ORG1" })) } });
    const tx = fakeTx();
    asMock(withTenant).mockImplementation(async (_org: string, cb: (t: any) => Promise<unknown>) => cb(tx));
    await processCoexistenceSync({ entry: [{ id: "WABA9", changes: [{ field: "smb_app_state_sync", value: { state_sync: [{ type: "contact", action: "add", contact: { full_name: "Ana", phone_number: "+56 9 1111 2222" } }] } }] }] });
    expect(tx.contact.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ phone: "+56911112222", firstName: "Ana" }) }));
  });

  it("history → sincroniza contactos y deja constancia con el conteo", async () => {
    asMock(getAdminPrisma).mockReturnValue({ whatsappAccount: { findFirst: vi.fn(async () => ({ organizationId: "ORG1" })) } });
    const tx = fakeTx();
    asMock(withTenant).mockImplementation(async (_org: string, cb: (t: any) => Promise<unknown>) => cb(tx));
    await processCoexistenceSync({ entry: [{ id: "WABA9", changes: [{ field: "history", value: { contacts: [{ wa_id: "56933334444", profile: { name: "Bea" } }], history: [{ threads: [{ messages: [{}, {}] }] }] } }] }] });
    expect(tx.contact.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ phone: "+56933334444" }) }));
    expect(tx.integrationEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ type: "coexistence.history_received", payload: expect.objectContaining({ contacts: 1, messages: 2 }) }) }));
  });
});
