import { describe, expect, it } from "vitest";
import { isMockWhatsappPayload } from "./whatsapp.controller";

/**
 * §4.1 — La detección de "canal simulado" debe mirar el phone_number_id real, NO el texto del
 * cuerpo. Antes `JSON.stringify(body).includes('"mock:')` descartaba (403) cualquier webhook real
 * que contuviera la cadena `"mock:` (p. ej. el cliente escribe `hola "mock:`), tumbando el lote
 * completo de mensajes reales — un DoS de ingreso sin autenticación.
 */
const payload = (text: string, phoneNumberId: string) => ({
  object: "whatsapp_business_account",
  entry: [
    {
      changes: [
        { value: { metadata: { phone_number_id: phoneNumberId }, messages: [{ text: { body: text } }] } },
      ],
    },
  ],
});

describe("isMockWhatsappPayload (§4.1)", () => {
  it('un mensaje REAL que contiene la cadena "mock: NO es mock → se encola', () => {
    expect(isMockWhatsappPayload(payload('hola "mock:', "123456789012345"))).toBe(false);
  });

  it("un payload con phone_number_id mock: SÍ es mock → exige token", () => {
    expect(isMockWhatsappPayload(payload("hola", "mock:digital-dent"))).toBe(true);
  });

  it("payloads vacíos o malformados no son mock (no rompen)", () => {
    expect(isMockWhatsappPayload({})).toBe(false);
    expect(isMockWhatsappPayload(null)).toBe(false);
    expect(isMockWhatsappPayload(undefined)).toBe(false);
    expect(isMockWhatsappPayload({ entry: "x" })).toBe(false);
    expect(isMockWhatsappPayload({ entry: [{}] })).toBe(false);
    expect(isMockWhatsappPayload({ entry: [{ changes: [{ value: {} }] }] })).toBe(false);
    expect(isMockWhatsappPayload({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 123 } } }] }] })).toBe(false);
  });
});
