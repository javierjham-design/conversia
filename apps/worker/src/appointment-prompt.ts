/**
 * Bloque de prompt para un paciente que YA tiene una hora agendada.
 *
 * Dos objetivos: (1) que NINGÚN agente lo trate como lead nuevo (no pedir nombre ni mandar link),
 * y (2) guiar bien el REAGENDAMIENTO — consultar disponibilidad con SU MISMO profesional (para no
 * terminar agendado con otro doctor, caso Rubén) y dejar que createAppointment MUEVA su cita en vez
 * de crear una segunda. Puro y determinista para poder testearlo sin la maquinaria del turno.
 */
export function buildUpcomingAppointmentBlock(input: {
  cuando: string;
  professionalName?: string | null;
  professionalId?: string | null;
  status: string;
}): string {
  const prof = input.professionalName ? ` con ${input.professionalName}` : "";
  const conProf = input.professionalId
    ? `professionalId=${input.professionalId} (su MISMO profesional)`
    : "su MISMO profesional";
  return (
    `\n\n## ⚠️ Este paciente YA tiene una hora agendada\n` +
    `Tiene una cita el ${input.cuando}${prof} (estado: ${input.status.toLowerCase()}). ` +
    `NO lo trates como paciente nuevo: no le pidas nombre ni datos ni le mandes un link para agendar. ` +
    `Si escribe sobre su hora (confirmarla, cambiarla, reagendar o dice que no puede asistir), ayúdalo con ESA cita ` +
    `(confírmala o reagéndala) o, si no manejas agenda, deriva al agente de Agendamiento.\n` +
    `REAGENDAR (quiere otro día/hora): consulta getAvailability pasando ${conProf} y ofrécele SOLO ese ` +
    `profesional, salvo que PIDA EXPRESAMENTE cambiar de doctor. Al agendar con createAppointment el ` +
    `sistema MOVERÁ esta cita (no creará una segunda): no la dupliques ni le pidas que cancele la anterior.\n` +
    `Solo si el paciente pide EXPLÍCITAMENTE una cita ADICIONAL (ADEMÁS de la que ya tiene), pasa ` +
    `esCitaAdicional=true a createAppointment para que se cree una nueva sin mover la actual.`
  );
}
