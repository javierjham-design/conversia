#!/usr/bin/env node
/**
 * Simulador de mensajes entrantes de WhatsApp (formato Meta Cloud API).
 * Permite probar el pipeline completo sin credenciales:
 *
 *   node scripts/simulate-inbound.mjs --phone 56912345678 --text "Hola" [--org digital-dent]
 *
 * Requiere api + worker corriendo (pnpm dev) y el seed cargado.
 */
const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const phone = arg("phone", "56912345678");
const text = arg("text", "Hola, quiero información");
const org = arg("org", "digital-dent");
const apiUrl = process.env.API_URL ?? "http://localhost:4000";

const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "0",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "56900000000", phone_number_id: `mock:${org}` },
            contacts: [{ profile: { name: "Paciente Simulado" }, wa_id: phone }],
            messages: [
              {
                from: phone,
                id: `wamid.sim.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: "text",
                text: { body: text },
              },
            ],
          },
        },
      ],
    },
  ],
};

const res = await fetch(`${apiUrl}/webhooks/whatsapp`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    // Los canales mock exigen este token (MOCK_INBOUND_TOKEN del API)
    "x-conversia-mock-token": process.env.MOCK_INBOUND_TOKEN ?? "dev-mock-inbound-token",
  },
  body: JSON.stringify(payload),
});

console.log(`→ ${apiUrl}/webhooks/whatsapp [${res.status}]`, await res.text());
console.log(`Mensaje simulado de +${phone} para el tenant "${org}": "${text}"`);
console.log("Revisa la consola del worker para ver la respuesta del agente.");
