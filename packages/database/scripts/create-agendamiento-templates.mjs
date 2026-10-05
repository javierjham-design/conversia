// Crea en Meta (vía la API de TuBot) las 4 plantillas de agendamiento con cuerpo +
// ejemplos + botones quick-reply + binding posicional. Quedan PENDING hasta que Meta
// las apruebe. Idempotente del lado de Meta: si ya existe una con ese nombre, Meta
// responde error y el script sigue con las demás (lo reporta).
//
// Uso (PowerShell):
//   $env:API_URL="https://api-production-cf8e.up.railway.app"
//   $env:TOKEN="<JWT admin de la org>"      # mismo token con el que opera el panel
//   $env:CHANNEL_ID="<id del channel_connection WhatsApp>"
//   node packages/database/scripts/create-agendamiento-templates.mjs
//
// El CHANNEL_ID se ve en Canales → (tu WhatsApp) o en la URL del canal. El mapeo
// variable→campo se persiste en el canal (lo usa resolveTemplateParams al enviar).

const API_URL = process.env.API_URL;
const TOKEN = process.env.TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!API_URL || !TOKEN || !CHANNEL_ID) {
  console.error("Faltan variables: API_URL, TOKEN y CHANNEL_ID son obligatorias.");
  process.exit(1);
}

const VARS4 = ["contact.firstName", "organization.name", "appointment.date", "appointment.time"];
const VARS2 = ["contact.firstName", "organization.name"];
const EX4 = ["María", "Digital Dent", "lunes 6 de octubre", "15:30"];
const EX2 = ["María", "Digital Dent"];

const templates = [
  {
    name: "recordatorio_cita",
    category: "UTILITY",
    language: "es",
    bodyText: "Hola {{1}} 👋 Te recordamos tu cita en {{2}} el {{3}} a las {{4}}. ¿Confirmas tu asistencia?",
    bodyExamples: EX4,
    variableFields: VARS4,
    quickReplies: ["Confirmar", "Reagendar"],
  },
  {
    name: "recordatorio_cita_insistencia",
    category: "UTILITY",
    language: "es",
    bodyText: "Hola {{1}} 👋 Solo para confirmar tu cita de mañana en {{2}} el {{3}} a las {{4}}. ¿Nos confirmas que vienes?",
    bodyExamples: EX4,
    variableFields: VARS4,
    quickReplies: ["Confirmar", "Reagendar"],
  },
  {
    name: "recaptura_noshow",
    category: "MARKETING",
    language: "es",
    bodyText: "Hola {{1}} 👋 Vimos que no pudiste asistir a tu cita en {{2}}. ¿Quieres que te ayudemos a reagendar? Estamos para apoyarte 😊",
    bodyExamples: EX2,
    variableFields: VARS2,
    quickReplies: ["Reagendar"],
  },
  {
    name: "recaptura_tratamiento",
    category: "MARKETING",
    language: "es",
    bodyText: "Hola {{1}} 👋 Notamos que tu tratamiento en {{2}} quedó pendiente. Retomarlo a tiempo hace la diferencia en tu salud. ¿Lo retomamos?",
    bodyExamples: EX2,
    variableFields: VARS2,
    quickReplies: ["Quiero retomarlo"],
  },
];

const base = API_URL.replace(/\/+$/, "");
let ok = 0;
for (const t of templates) {
  try {
    const res = await fetch(`${base}/channels/${encodeURIComponent(CHANNEL_ID)}/templates`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(t),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      ok++;
      console.log(`✔ ${t.name} → ${json.status ?? "PENDING"} (${json.category ?? t.category})`);
    } else {
      console.error(`✖ ${t.name} → ${res.status}: ${json?.message ?? JSON.stringify(json).slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`✖ ${t.name} → ${err.message}`);
  }
}
console.log(`\nListo: ${ok}/${templates.length} enviadas a aprobación. Revisa Canales → Plantillas; al quedar APPROVED se sincronizan y se empujan a Cláriva.`);
