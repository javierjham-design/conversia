// Flujos PUBLICADOS reales de Digital Dent (leídos de producción 2026-08-12).
// Fixture congelado para el test de round-trip de serialización: abrir en el
// canvas + guardar sin editar debe producir un JSON EQUIVALENTE (mismos nodos,
// aristas, config de nodos Y config del disparador). Protege contra que la
// reescritura del canvas —o cualquier cambio de serialización— corrompa un flujo
// de producción al abrirlo y guardarlo. NO editar a mano salvo re-exportar.
export const DIGITAL_DENT_FLOWS: { name: string; definition: any }[] = [
  {
    name: "Confirmación de cita",
    definition: {
      edges: [
        { to: "n2", from: "n1" },
        { to: "n3", from: "n2" },
      ],
      nodes: [
        { id: "n1", type: "send_text", config: { text: "Hola {{contact.firstName}} 👋 Te recordamos tu hora en {{clinic.name}} el {{appointment.date}} a las {{appointment.time}}. ¿Confirmas tu asistencia? Responde SÍ para confirmar o CAMBIAR para reagendar." } },
        { id: "n2", type: "wait", config: { hours: 6, cancelOn: "contact_reply" } },
        { id: "n3", type: "run_agent", config: { agentSlug: "agendamiento" } },
      ],
      trigger: { type: "appointment_upcoming", config: { hoursBefore: 24 } },
      variables: {},
    },
  },
  {
    name: "Lead nuevo por WhatsApp",
    definition: {
      edges: [
        { to: "n2", from: "n1" },
        { to: "n3", from: "n2" },
        { to: "n4", from: "n3" },
        { to: "n5", from: "n4", when: "true" },
        { to: "n6", from: "n5" },
        { to: "n7", from: "n6" },
        { to: "n8", from: "n7", when: "true" },
      ],
      nodes: [
        { id: "n1", type: "update_lead_status", config: { statusCode: "nuevo" } },
        { id: "n2", type: "run_agent", config: { agentSlug: "recepcionista" } },
        { id: "n3", type: "wait", config: { minutes: 5, cancelOn: "contact_reply" } },
        { id: "n4", type: "condition", config: { kind: "no_reply" } },
        { id: "n5", type: "send_text", config: { text: "¿Sigues por ahí? 😊 Si quieres te cuento valores o buscamos una hora que te acomode." } },
        { id: "n6", type: "wait", config: { hours: 12, cancelOn: "contact_reply" } },
        { id: "n7", type: "condition", config: { kind: "no_reply" } },
        { id: "n8", type: "update_lead_status", config: { statusCode: "cold_lead" } },
      ],
      trigger: { type: "conversation_started", config: {} },
      variables: {},
    },
  },
];
