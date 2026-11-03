import { describe, expect, it } from "vitest";
import { calendarMirrorEnabled, enqueueCalendarMirror, mirrorActionForStatus } from "../src/scheduling/calendar-mirror";

/**
 * ETAPA 0 (c) — las citas tocadas DESDE EL PANEL también van a Google.
 *
 * Brecha: `enqueueCalendarSync` lo llamaban solo el bot y el webhook de Cláriva, así que una
 * cita creada, movida o cancelada por el dueño en la pantalla de Agenda no llegaba nunca a su
 * calendario. El dueño veía "la sincronización no sirve" cuando en realidad ese camino no
 * existía.
 *
 * El job encolado tiene que ser EL MISMO que encola el bot (cola `integration-sync`,
 * `kind: "calendar_sync"`, payload `{appointmentId, action}`), porque el despachador del
 * worker rutea por `kind` (`sync-worker.ts`). Si el payload no calza, el job se descarta con
 * un warning y nadie se entera.
 */

interface JobEncolado {
  name: string;
  data: { organizationId: string; kind: string; payload: { appointmentId: string; action: string } };
  opts: Record<string, unknown>;
}

/** Dobles mínimos: la cola solo registra, y el prisma devuelve la config que le pasemos. */
function dobles(config: Record<string, unknown> | null) {
  const jobs: JobEncolado[] = [];
  const prisma = {
    withTenant: async (_orgId: string, fn: (tx: unknown) => unknown) =>
      fn({
        integrationConnection: {
          findFirst: async () => (config === null ? null : { config }),
        },
      }),
  };
  const queues = {
    sync: {
      add: async (name: string, data: JobEncolado["data"], opts: Record<string, unknown>) => {
        jobs.push({ name, data, opts });
      },
    },
  };
  // Los dobles solo implementan lo que el helper usa; el tipo real exige todo el servicio.
  return { jobs, prisma: prisma as never, queues: queues as never };
}

describe("mirrorActionForStatus", () => {
  it("CANCELLED borra el evento", () => {
    expect(mirrorActionForStatus("CANCELLED")).toBe("cancel");
  });
  it("todo lo demás es upsert", () => {
    for (const s of ["PENDING", "CONFIRMED", "RESCHEDULED", "COMPLETED", "NO_SHOW"]) {
      expect(mirrorActionForStatus(s)).toBe("upsert");
    }
  });
  it("una cita que ya ocurrió NO se borra de Google", () => {
    // Borrar NO_SHOW o COMPLETED le haría desaparecer al dueño el registro de su día.
    expect(mirrorActionForStatus("NO_SHOW")).toBe("upsert");
    expect(mirrorActionForStatus("COMPLETED")).toBe("upsert");
  });
  it("sin estado, upsert", () => {
    expect(mirrorActionForStatus(null)).toBe("upsert");
    expect(mirrorActionForStatus(undefined)).toBe("upsert");
  });
});

describe("calendarMirrorEnabled — la misma condición que usa el worker", () => {
  it("espejo activo: conexión con calendarId y calendarSync", async () => {
    const { prisma } = dobles({ calendarId: "a@gmail.com", calendarSync: true });
    expect(await calendarMirrorEnabled(prisma, "org_1")).toBe(true);
  });
  it("apagado si falta el toggle o el calendario", async () => {
    expect(await calendarMirrorEnabled(dobles({ calendarId: "a@gmail.com", calendarSync: false }).prisma, "org_1")).toBe(false);
    expect(await calendarMirrorEnabled(dobles({ calendarSync: true }).prisma, "org_1")).toBe(false);
    expect(await calendarMirrorEnabled(dobles({}).prisma, "org_1")).toBe(false);
  });
  it("sin conexión de Google, apagado", async () => {
    expect(await calendarMirrorEnabled(dobles(null).prisma, "org_1")).toBe(false);
  });
});

describe("enqueueCalendarMirror", () => {
  const activo = { calendarId: "a@gmail.com", calendarSync: true };

  it("encola el MISMO job que el bot", async () => {
    const { jobs, prisma, queues } = dobles(activo);
    await enqueueCalendarMirror(prisma, queues, "org_1", "appt_9", "upsert");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toEqual({ organizationId: "org_1", kind: "calendar_sync", payload: { appointmentId: "appt_9", action: "upsert" } });
  });

  it("pasa la acción de cancelar tal cual", async () => {
    const { jobs, prisma, queues } = dobles(activo);
    await enqueueCalendarMirror(prisma, queues, "org_1", "appt_9", "cancel");
    expect(jobs[0].data.payload.action).toBe("cancel");
  });

  it("reintenta con backoff (un fallo pasajero de Google no pierde el evento)", async () => {
    const { jobs, prisma, queues } = dobles(activo);
    await enqueueCalendarMirror(prisma, queues, "org_1", "appt_9", "upsert");
    expect(jobs[0].opts.attempts).toBe(5);
    expect(jobs[0].opts.backoff).toEqual({ type: "exponential", delay: 30_000 });
  });

  it("con el espejo apagado NO encola nada", async () => {
    const { jobs, prisma, queues } = dobles({ calendarSync: false });
    await enqueueCalendarMirror(prisma, queues, "org_1", "appt_9", "upsert");
    expect(jobs).toHaveLength(0);
  });

  it("sin conexión de Google NO encola nada", async () => {
    const { jobs, prisma, queues } = dobles(null);
    await enqueueCalendarMirror(prisma, queues, "org_1", "appt_9", "upsert");
    expect(jobs).toHaveLength(0);
  });

  it("si la cola falla NO rompe la operación del panel", async () => {
    // La cita ya está guardada: el espejo es secundario y no puede devolver 500 a quien
    // agendó bien.
    const { prisma } = dobles(activo);
    const queues = { sync: { add: async () => { throw new Error("redis caído"); } } } as never;
    await expect(enqueueCalendarMirror(prisma, queues, "org_1", "appt_9", "upsert")).resolves.toBeUndefined();
  });

  it("si la consulta de la config falla tampoco rompe", async () => {
    const prisma = { withTenant: async () => { throw new Error("tx abortada"); } } as never;
    const queues = { sync: { add: async () => undefined } } as never;
    await expect(enqueueCalendarMirror(prisma, queues, "org_1", "appt_9", "upsert")).resolves.toBeUndefined();
  });
});
