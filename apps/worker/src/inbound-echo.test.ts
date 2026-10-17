import { describe, it, expect } from "vitest";
import { parseWebhook } from "./inbound";

/**
 * PELDAÑO 1 (coexistencia) — contrato de parseo del webhook `smb_message_echoes`:
 * los mensajes que el dueño responde a MANO desde su app WhatsApp Business deben
 * reconocerse como ecos SALIENTES. Camino inerte para WABAs normales (TuBot).
 */
describe("parseWebhook — ecos de coexistencia (smb_message_echoes)", () => {
  it("reconoce un eco de texto como saliente (to=cliente, id=wamid)", () => {
    const raw = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA_1",
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "+56 9 1111 1111", phone_number_id: "PHONE_1" },
                message_echoes: [
                  { from: "56911111111", to: "56922222222", id: "wamid.ECHO1", timestamp: "1700000000", type: "text", text: { body: "Hola, te confirmo tu hora" } },
                ],
              },
            },
          ],
        },
      ],
    };
    const { messages, statuses, echoes } = parseWebhook(raw);
    expect(messages).toHaveLength(0);
    expect(statuses).toHaveLength(0);
    expect(echoes).toHaveLength(1);
    expect(echoes[0]).toMatchObject({
      phoneNumberId: "PHONE_1",
      externalId: "wamid.ECHO1",
      to: "56922222222",
      type: "text",
      text: "Hola, te confirmo tu hora",
    });
  });

  it("toma el caption como texto en ecos de imagen", () => {
    const raw = {
      entry: [
        {
          changes: [
            {
              field: "smb_message_echoes",
              value: {
                metadata: { phone_number_id: "PHONE_1" },
                message_echoes: [{ from: "56911111111", to: "56922222222", id: "wamid.IMG", type: "image", image: { caption: "aquí la foto" } }],
              },
            },
          ],
        },
      ],
    };
    const { echoes } = parseWebhook(raw);
    expect(echoes).toHaveLength(1);
    expect(echoes[0]).toMatchObject({ externalId: "wamid.IMG", type: "image", text: "aquí la foto" });
  });

  it("un webhook NORMAL (entrante) no produce ecos", () => {
    const raw = {
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "PHONE_1" },
                contacts: [{ profile: { name: "Ana" } }],
                messages: [{ from: "56922222222", id: "wamid.IN1", type: "text", text: { body: "quiero una hora" } }],
              },
            },
          ],
        },
      ],
    };
    const { messages, echoes } = parseWebhook(raw);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ externalId: "wamid.IN1", from: "56922222222", text: "quiero una hora" });
    expect(echoes).toHaveLength(0); // inerte para WABAs normales (TuBot)
  });

  it("maneja entrantes + ecos en el mismo payload sin mezclarlos", () => {
    const raw = {
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: { metadata: { phone_number_id: "PHONE_1" }, messages: [{ from: "56922222222", id: "wamid.IN", type: "text", text: { body: "hola" } }] },
            },
            {
              field: "smb_message_echoes",
              value: { metadata: { phone_number_id: "PHONE_1" }, message_echoes: [{ from: "56911111111", to: "56922222222", id: "wamid.ECHO", type: "text", text: { body: "respuesta a mano" } }] },
            },
          ],
        },
      ],
    };
    const { messages, echoes } = parseWebhook(raw);
    expect(messages).toHaveLength(1);
    expect(echoes).toHaveLength(1);
    expect(messages[0].externalId).toBe("wamid.IN");
    expect(echoes[0].externalId).toBe("wamid.ECHO");
  });
});
