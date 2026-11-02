import type { PrismaService } from "../prisma.service";
import type { QueueService } from "../queues";

/**
 * Espejo a Google Calendar de las citas tocadas DESDE EL PANEL.
 *
 * Brecha que cierra: el espejo lo encolaban solo el bot (`tool-services.ts`) y el webhook de
 * Cláriva. Una cita creada, movida o cancelada por el dueño en la pantalla de Agenda no
 * llegaba nunca a Google — justo el caso del dueño que quiere manejar su agenda desde el
 * teléfono. El job es el MISMO que usa el bot (cola `integration-sync`, `kind: calendar_sync`),
 * así que no hay un segundo camino que mantener.
 *
 * Decisiones:
 * - **No rompe nada si falla.** El espejo es secundario: la cita ya está guardada. Un error
 *   de cola no puede devolver 500 a quien agendó bien.
 * - **Guarda barata antes de encolar** (1 consulta): sin conexión de Google o con el espejo
 *   apagado no se encola nada, igual que hace el worker. Evita llenar la cola de jobs que
 *   van a salir por la puerta de atrás.
 */
export type CalendarMirrorAction = "upsert" | "cancel";

/** ¿Tiene este tenant el espejo a Google activo? (misma condición que el worker). */
export async function calendarMirrorEnabled(prisma: PrismaService, organizationId: string): Promise<boolean> {
  const conn = await prisma.withTenant(organizationId, (tx) =>
    tx.integrationConnection.findFirst({ where: { organizationId, provider: "google" }, select: { config: true } }),
  );
  const cfg = (conn?.config as Record<string, unknown> | null) ?? null;
  return Boolean(cfg?.calendarSync && cfg?.calendarId);
}

/** Encola el espejo de UNA cita. Nunca lanza: loguea y sigue. */
export async function enqueueCalendarMirror(
  prisma: PrismaService,
  queues: QueueService,
  organizationId: string,
  appointmentId: string,
  action: CalendarMirrorAction,
): Promise<void> {
  try {
    if (!(await calendarMirrorEnabled(prisma, organizationId))) return;
    await queues.sync.add(
      "calendar",
      { organizationId, kind: "calendar_sync" as const, payload: { appointmentId, action } },
      { attempts: 5, backoff: { type: "exponential" as const, delay: 30_000 }, removeOnComplete: 500, removeOnFail: 1000 },
    );
  } catch (err) {
    console.error(`✖ enqueueCalendarMirror(${action}):`, (err as Error).message);
  }
}

/**
 * Qué acción corresponde según el estado en que queda la cita (pura, testeable). Solo
 * CANCELLED borra el evento; todo lo demás es upsert (crear, mover, cambiar notas,
 * confirmar). `NO_SHOW` y `COMPLETED` son citas que ya ocurrieron: borrarlas de Google le
 * haría desaparecer al dueño el registro de su día.
 */
export function mirrorActionForStatus(status: string | null | undefined): CalendarMirrorAction {
  return status === "CANCELLED" ? "cancel" : "upsert";
}
