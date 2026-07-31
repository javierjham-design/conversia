// Se implementa en la Fase 2 (Google Calendar).
export async function syncAppointmentToGoogle(_organizationId: string, _payload: { appointmentId: string; action: "upsert" | "cancel" }): Promise<void> {
  throw new Error("Google Calendar aun no esta conectado");
}
