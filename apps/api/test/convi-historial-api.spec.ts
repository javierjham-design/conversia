import { describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { AssistantController } from "../src/assistant/assistant.controller";
import { AssistantThreadsService, UMBRAL_DE_RESUMEN, tituloDesde } from "../src/assistant/assistant-threads.service";
import { runWithContext } from "../src/tenancy/context";
import type { PrismaService } from "../src/prisma.service";

/**
 * B2 — EL SERVIDOR ES EL DUEÑO DEL HILO.
 *
 * Lo que fijan estos tests:
 * - de qué hilo se escribe (el abierto, o uno creado), y que pedir un hilo AJENO no devuelva
 *   nada: ese es el ataque obvio cuando el cliente puede mandar `threadId`;
 * - que el historial del prompt salga de la base, en orden y acotado;
 * - que una conversación larga se resuma en vez de crecer sin techo o perder el principio.
 */

interface Hilo {
  id: string;
  organizationId: string;
  userId: string;
  title: string | null;
  summary: string | null;
  status: string;
  lastMessageAt: Date;
  createdAt: Date;
}
interface Mensaje {
  id: string;
  organizationId: string;
  threadId: string;
  role: string;
  content: string;
  actions?: unknown;
  adjuntos?: unknown;
  route?: string | null;
  createdAt: Date;
}

/** Doble de la base, en memoria, con los filtros que el servicio usa de verdad. */
function fakeDb(hilos: Hilo[] = [], mensajes: Mensaje[] = []) {
  let seq = 0;
  const coincide = (h: Hilo, w: Record<string, any>): boolean =>
    (w.id === undefined || h.id === w.id) &&
    (w.userId === undefined || h.userId === w.userId) &&
    (w.status === undefined || h.status === w.status) &&
    (w.id?.not === undefined || h.id !== w.id.not);

  const tx = {
    assistantThread: {
      findFirst: async ({ where = {} }: any) => hilos.filter((h) => coincide(h, where))[0] ?? null,
      findUnique: async ({ where }: any) => hilos.find((h) => h.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const h: Hilo = { id: `h${++seq}`, title: null, summary: null, status: "open", lastMessageAt: new Date(), createdAt: new Date(), ...data };
        hilos.push(h);
        return h;
      },
      update: async ({ where, data }: any) => {
        const h = hilos.find((x) => x.id === where.id)!;
        Object.assign(h, data);
        return h;
      },
      updateMany: async ({ where = {}, data }: any) => {
        let n = 0;
        for (const h of hilos) if (coincide(h, where)) { Object.assign(h, data); n++; }
        return { count: n };
      },
      findMany: async ({ where = {} }: any) => hilos.filter((h) => coincide(h, where)),
    },
    assistantMessage: {
      count: async ({ where }: any) => mensajes.filter((m) => m.threadId === where.threadId).length,
      create: async ({ data }: any) => {
        const m: Mensaje = { id: `m${++seq}`, createdAt: new Date(Date.now() + seq), ...data };
        mensajes.push(m);
        return m;
      },
      findFirst: async ({ where, orderBy }: any) => {
        const l = mensajes.filter((m) => m.threadId === where.threadId && (!where.role || m.role === where.role));
        l.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        return (orderBy?.createdAt === "desc" ? l[l.length - 1] : l[0]) ?? null;
      },
      findMany: async ({ where, orderBy, take }: any) => {
        let l = mensajes.filter((m) => m.threadId === where.threadId);
        l.sort((a, b) => (orderBy?.createdAt === "desc" ? b.createdAt.getTime() - a.createdAt.getTime() : a.createdAt.getTime() - b.createdAt.getTime()));
        if (take) l = l.slice(0, take);
        return l;
      },
    },
  };
  const prisma = {
    withTenant: (_org: string, fn: (t: unknown) => unknown) => fn(tx),
    admin: { user: { findMany: async () => [{ id: "u1", name: "Javier" }] } },
  } as unknown as PrismaService;
  return { prisma, hilos, mensajes, svc: new AssistantThreadsService(prisma) };
}

const hilo = (over: Partial<Hilo> = {}): Hilo => ({
  id: "h1",
  organizationId: "org1",
  userId: "u1",
  title: null,
  summary: null,
  status: "open",
  lastMessageAt: new Date("2026-11-10T12:00:00Z"),
  createdAt: new Date("2026-11-10T11:00:00Z"),
  ...over,
});

describe("de qué hilo se escribe", () => {
  it("sin threadId, toma el ABIERTO del usuario", async () => {
    const { svc } = fakeDb([hilo({ id: "abierto" }), hilo({ id: "viejo", status: "archived" })]);
    expect((await svc.hiloParaEscribir("org1", "u1")).id).toBe("abierto");
  });

  it("si no hay ninguno abierto, crea uno", async () => {
    const { svc, hilos } = fakeDb([hilo({ id: "viejo", status: "archived" })]);
    const h = await svc.hiloParaEscribir("org1", "u1");
    expect(hilos.find((x) => x.id === h.id)?.status).toBe("open");
    expect(hilos).toHaveLength(2);
  });

  it("un threadId de OTRO usuario no existe (404), no se confirma ni que esté", async () => {
    // Es el ataque obvio en cuanto el cliente puede mandar el id del hilo.
    const { svc } = fakeDb([hilo({ id: "ajeno", userId: "otro" })]);
    await expect(svc.hiloParaEscribir("org1", "u1", "ajeno")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("un threadId propio ARCHIVADO se reabre para seguir ahí", async () => {
    const { svc, hilos } = fakeDb([hilo({ id: "mio", status: "archived" })]);
    expect((await svc.hiloParaEscribir("org1", "u1", "mio")).id).toBe("mio");
    expect(hilos[0].status).toBe("open");
  });
});

describe("el historial del prompt sale de la BASE", () => {
  it("en orden cronológico y con el rol correcto", async () => {
    const { svc } = fakeDb(
      [hilo()],
      [
        { id: "m1", organizationId: "org1", threadId: "h1", role: "user", content: "hola", createdAt: new Date(1) },
        { id: "m2", organizationId: "org1", threadId: "h1", role: "assistant", content: "¿en qué te ayudo?", createdAt: new Date(2) },
      ],
    );
    expect(await svc.historialParaElPrompt("org1", "h1")).toEqual([
      { role: "user", content: "hola" },
      { role: "assistant", content: "¿en qué te ayudo?" },
    ]);
  });

  it("de una conversación larga trae solo los últimos N", async () => {
    const msgs = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, organizationId: "org1", threadId: "h1", role: i % 2 ? "assistant" : "user", content: `n${i}`, createdAt: new Date(i + 1) }));
    const { svc } = fakeDb([hilo()], msgs);
    const h = await svc.historialParaElPrompt("org1", "h1", 20);
    expect(h).toHaveLength(20);
    expect(h[0].content).toBe("n40");
    expect(h[19].content).toBe("n59");
  });
});

describe("guardar el turno", () => {
  it("guarda lo que escribió el dueño y lo que contestó Convi", async () => {
    const { svc, mensajes } = fakeDb([hilo()]);
    await svc.guardarTurno({ organizationId: "org1", threadId: "h1", userMessage: "quiero cobrar 12000 el corte", reply: "listo" });
    expect(mensajes.map((m) => [m.role, m.content])).toEqual([
      ["user", "quiero cobrar 12000 el corte"],
      ["assistant", "listo"],
    ]);
  });

  it("el título sale del PRIMER mensaje y después no se toca", async () => {
    const { svc, hilos } = fakeDb([hilo()]);
    await svc.guardarTurno({ organizationId: "org1", threadId: "h1", userMessage: "quiero cobrar doce mil pesos por el corte de pelo", reply: "ok" });
    expect(hilos[0].title).toBe("quiero cobrar doce mil pesos por");
    await svc.guardarTurno({ organizationId: "org1", threadId: "h1", userMessage: "otra cosa distinta", reply: "ok" });
    expect(hilos[0].title).toBe("quiero cobrar doce mil pesos por");
  });

  it("del adjunto se guarda SOLO tipo y nombre, nunca el archivo", async () => {
    const { svc, mensajes } = fakeDb([hilo()]);
    await svc.guardarTurno({
      organizationId: "org1",
      threadId: "h1",
      userMessage: "mira esto",
      reply: "ok",
      adjuntos: [{ tipo: "imagen", nombre: "lista-precios.jpg" }],
    });
    expect(mensajes[0].adjuntos).toEqual([{ tipo: "imagen", nombre: "lista-precios.jpg" }]);
    expect(JSON.stringify(mensajes[0])).not.toMatch(/base64|data:|contenido/i);
  });

  it("si la base falla, el turno NO se cae: el dueño ya tiene su respuesta", async () => {
    const { svc } = fakeDb([hilo()]);
    const roto = new AssistantThreadsService({ withTenant: async () => { throw new Error("base caída"); } } as unknown as PrismaService);
    await expect(roto.guardarTurno({ organizationId: "org1", threadId: "h1", userMessage: "x", reply: "y" })).resolves.toBeUndefined();
    expect(svc).toBeTruthy();
  });
});

describe("conversación larga: se resume lo viejo", () => {
  const largo = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `m${i}`, organizationId: "org1", threadId: "h1", role: i % 2 ? "assistant" : "user", content: `mensaje ${i}`, createdAt: new Date(i + 1) }));

  it(`por debajo de ${UMBRAL_DE_RESUMEN} mensajes NO resume (no gasta una llamada de más)`, async () => {
    const { svc, hilos } = fakeDb([hilo()], largo(UMBRAL_DE_RESUMEN));
    await svc.resumirSiHaceFalta("org1", "h1");
    expect(hilos[0].summary).toBeNull();
  });

  it("pasado el umbral deja el resumen en el hilo", async () => {
    const { svc, hilos } = fakeDb([hilo()], largo(UMBRAL_DE_RESUMEN + 6));
    await svc.resumirSiHaceFalta("org1", "h1");
    expect(hilos[0].summary).toBeTruthy();
  });

  it("si resumir falla, el hilo sigue sin resumen y sin romper el turno", async () => {
    const roto = new AssistantThreadsService({ withTenant: async () => { throw new Error("base caída"); } } as unknown as PrismaService);
    await expect(roto.resumirSiHaceFalta("org1", "h1")).resolves.toBeUndefined();
  });
});

describe("leer el historial", () => {
  it("un usuario NO puede leer el hilo de otro de su organización", async () => {
    const { svc } = fakeDb([hilo({ id: "ajeno", userId: "otro" })]);
    await expect(svc.mensajes("org1", "u1", "ajeno", { esAdmin: false })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("un administrador sí (decisión del dueño: los ve él y los administradores)", async () => {
    const { svc } = fakeDb([hilo({ id: "ajeno", userId: "otro" })], []);
    const r = await svc.mensajes("org1", "u1", "ajeno", { esAdmin: true });
    expect(r.thread.id).toBe("ajeno");
  });

  it("la lista de un usuario normal es SOLO la suya", async () => {
    const { svc } = fakeDb([hilo({ id: "mio" }), hilo({ id: "ajeno", userId: "otro" })]);
    const r = await svc.listar("org1", "u1", { esAdmin: false });
    expect(r.hilos.map((h) => h.id)).toEqual(["mio"]);
  });

  it("la del administrador incluye de quién es cada hilo", async () => {
    const { svc } = fakeDb([hilo({ id: "mio" })]);
    const r = await svc.listar("org1", "u1", { esAdmin: true });
    expect(r.hilos[0].userName).toBe("Javier");
  });
});

describe("nueva conversación", () => {
  it("archiva la abierta antes de abrir otra (la base solo admite una)", async () => {
    const { svc, hilos } = fakeDb([hilo({ id: "abierto" })]);
    const nuevo = await svc.nuevoHilo("org1", "u1");
    expect(hilos.find((h) => h.id === "abierto")!.status).toBe("archived");
    expect(hilos.find((h) => h.id === nuevo.id)!.status).toBe("open");
    expect(hilos.filter((h) => h.status === "open")).toHaveLength(1);
  });
});

describe("tituloDesde", () => {
  it("toma seis palabras", () => {
    expect(tituloDesde("una dos tres cuatro cinco seis siete ocho")).toBe("una dos tres cuatro cinco seis");
  });
  it("un mensaje vacío no inventa título", () => {
    expect(tituloDesde("   ")).toBeNull();
  });
});

describe("el `history` del cuerpo se acepta y se IGNORA", () => {
  // Es la propiedad que de verdad importa: antes, lo que Convi "recordaba" era lo que el
  // navegador le mandara. Un cliente podía escribirle una conversación que nunca ocurrió.
  it("el modelo recibe el historial de la BASE, no el del navegador", async () => {
    const recibido: { history?: unknown; resumen?: unknown } = {};
    const assistant = {
      orgBrand: async () => "conversia",
      run: async (_c: unknown, _m: string, history: unknown, _r: unknown, _a: unknown, resumen: unknown) => {
        recibido.history = history;
        recibido.resumen = resumen;
        return { reply: "ok", mode: "asistencia", wrote: false, qa: null, actions: [], degradado: false };
      },
    };
    const hilos = {
      hiloParaEscribir: async () => ({ id: "h1", summary: "lo que ya habíamos acordado" }),
      historialParaElPrompt: async () => [{ role: "user", content: "lo que PASÓ de verdad" }],
      guardarTurno: async () => undefined,
      resumirSiHaceFalta: async () => undefined,
    };
    const rate = { custom: async () => ({ allowed: true }) };
    const c = new AssistantController(assistant as never, rate as never, hilos as never);

    const r = (await runWithContext({ userId: "u1", organizationId: "org1", roleCode: "owner", permissions: [] }, () =>
      c.message({ message: "hola", history: [{ role: "user", content: "UNA CONVERSACIÓN INVENTADA POR EL CLIENTE" }] }),
    )) as { threadId: string };

    expect(recibido.history).toEqual([{ role: "user", content: "lo que PASÓ de verdad" }]);
    expect(JSON.stringify(recibido.history)).not.toMatch(/INVENTADA/);
    expect(recibido.resumen).toBe("lo que ya habíamos acordado");
    expect(r.threadId).toBe("h1");
  });
});
