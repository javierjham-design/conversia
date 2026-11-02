/**
 * Pacientes PENDIENTES DE REAGENDAR — lógica pura (testeable sin BD).
 *
 * Cuando un paciente escribe "reagendar", el worker LIBERA su hora al toque (la cita
 * queda CANCELLED) y etiqueta la conversación "Reagenda solicitada". Si después el
 * paciente no vuelve a hablar, queda EN EL AIRE: sin hora y sin que nadie lo vea.
 *
 * Esta lista los rescata. Un paciente está pendiente si pidió reagendar y NO volvió a
 * tener hora: no tiene ninguna cita NO cancelada con fecha >= el momento en que lo pidió.
 * Apenas reagenda (se le crea una cita), sale solo de la lista. No mezcla leads: opera
 * sobre citas/pacientes, no sobre el pipeline de leads.
 */

export interface PendingApptLite {
  /** PENDING | CONFIRMED | RESCHEDULED | CANCELLED | COMPLETED | NO_SHOW */
  status: string;
  startsAt: Date;
  professionalName: string | null;
}

export interface RescheduleRequest {
  contactId: string;
  conversationId: string;
  /** Cuándo pidió reagendar (createdAt de la etiqueta "Reagenda solicitada"). */
  requestedAt: Date;
}

export interface PendingRescheduleItem {
  contactId: string;
  name: string;
  phone: string | null;
  conversationId: string;
  requestedAt: string;
  /** La hora que se liberó (su cita cancelada más reciente), para dar contexto a recepción. */
  canceledSlot: { startsAt: string; professionalName: string | null } | null;
}

export function selectPendingReschedule(input: {
  now: Date;
  requests: RescheduleRequest[];
  apptsByContact: Map<string, PendingApptLite[]>;
  contacts: Map<string, { name: string; phone: string | null }>;
}): PendingRescheduleItem[] {
  // Un pedido por contacto: el MÁS RECIENTE (si pidió reagendar varias veces).
  const latest = new Map<string, RescheduleRequest>();
  for (const r of input.requests) {
    const prev = latest.get(r.contactId);
    if (!prev || r.requestedAt.getTime() > prev.requestedAt.getTime()) latest.set(r.contactId, r);
  }

  const items: PendingRescheduleItem[] = [];
  for (const [contactId, req] of latest) {
    const contact = input.contacts.get(contactId);
    if (!contact) continue;
    const appts = input.apptsByContact.get(contactId) ?? [];
    // ¿Ya reagendó? = tiene ALGUNA cita no cancelada con hora >= cuando pidió reagendar.
    // (una cita futura cae aquí; también una que ya ocurrió y quedó COMPLETED tras pedirlo).
    const rebooked = appts.some(
      (a) => a.status !== "CANCELLED" && a.startsAt.getTime() >= req.requestedAt.getTime(),
    );
    if (rebooked) continue;
    const cancelled =
      appts
        .filter((a) => a.status === "CANCELLED")
        .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime())[0] ?? null;
    items.push({
      contactId,
      name: contact.name,
      phone: contact.phone,
      conversationId: req.conversationId,
      requestedAt: req.requestedAt.toISOString(),
      canceledSlot: cancelled
        ? { startsAt: cancelled.startsAt.toISOString(), professionalName: cancelled.professionalName }
        : null,
    });
  }
  // Más reciente primero (el que acaba de quedar en el aire, arriba).
  items.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  return items;
}
