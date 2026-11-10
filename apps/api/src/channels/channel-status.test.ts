import { describe, expect, it, vi } from "vitest";
import { ChannelsController } from "./channels.controller";
import { runWithContext, type RequestContext } from "../tenancy/context";
import {
  armarReporte,
  consultarNumero,
  consultarSuscripcionWaba,
  resumirReporte,
  type ChequeoDeCanal,
  type EntradaDelReporte,
  type ReporteDeCanal,
} from "./channel-status";

/**
 * A1 — REPORTE DE CONEXIÓN.
 *
 * Lo que fijan estos tests es el JUICIO: con los mismos datos de Meta, qué se le dice al dueño
 * y qué se le ofrece hacer. Esa parte es pura (`armarReporte`), así que se prueba con fixtures
 * de Graph en vez de con una cuenta de WhatsApp de verdad.
 *
 * El último describe protege el refactor: `POST /channels/:id/test` —que usa TAMBIÉN el panel
 * de TuBot, en producción— pasó a leer el número por la misma función que el reporte, y tiene
 * que responder exactamente las mismas frases que antes.
 */

const okRes = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errRes = (status: number, error: unknown) => ({ ok: false, status, json: async () => ({ error }) }) as unknown as Response;

/** Canal sano por coexistencia, con todo en verde. Cada test cambia solo lo que le interesa. */
const BASE: EntradaDelReporte = {
  canal: { id: "ch1", type: "WHATSAPP_CLOUD", name: "WhatsApp +56 9 1234 5678", status: "active", config: { coexistence: true, coexVerified: true } },
  defaultAgent: { id: "ag1", name: "Recepción" },
  numeroLocal: { phoneNumberId: "111222333", displayPhone: "+56 9 1234 5678" },
  wabaId: "999888777",
  graph: { ok: true, tokenVencido: false, displayPhone: "+56 9 1234 5678", verifiedName: "Barbería Centro", qualityRating: "GREEN", coexVerified: true, error: null },
  suscripcion: { suscrita: true, campos: ["messages"], otras: [] },
  accountAlert: null,
  lastInboundAt: "2026-11-10T14:00:00.000Z",
  lastOutboundAt: "2026-11-10T14:00:09.000Z",
  sinToken: false,
};
const chequeo = (r: ReporteDeCanal, key: string): ChequeoDeCanal => r.checks.find((c) => c.key === key)!;
/** Lo que la pantalla pinta en rojo: fallos de verdad, sin contar lo que no se pudo averiguar. */
const fallosReales = (r: ReporteDeCanal): ChequeoDeCanal[] => r.checks.filter((c) => !c.ok && !c.unknown);

describe("número sano: el dueño ve que quedó conectado", () => {
  const r = armarReporte(BASE);

  it("no hay nada que arreglar", () => {
    expect(fallosReales(r)).toEqual([]);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });

  it("trae lo que el dueño quiere leer: número, nombre, calidad, quién atiende", () => {
    expect(r.displayPhone).toBe("+56 9 1234 5678");
    expect(r.verifiedName).toBe("Barbería Centro");
    expect(r.qualityRating).toBe("GREEN");
    expect(r.defaultAgent).toEqual({ id: "ag1", name: "Recepción" });
    expect(r.mode).toBe("coexistence");
    expect(r.coexVerified).toBe(true);
    expect(r.pendingNumber).toBe(false);
    expect(r.tokenHealthy).toBe(true);
    expect(r.lastInboundAt).toBe("2026-11-10T14:00:00.000Z");
  });

  it("el resumen para Convi dice el número y quién atiende", () => {
    expect(resumirReporte(r)).toBe("Conectado y atendiendo: +56 9 1234 5678 · atiende Recepción.");
  });

  it("NINGÚN token ni secreto viaja en el reporte", () => {
    // El reporte va directo a la pantalla del cliente. Si alguien agrega un campo con el
    // token del canal, esto falla acá y no en producción.
    const claves = JSON.stringify(r).match(/"[a-zA-Z]+"\s*:/g) ?? [];
    const sospechosas = claves.filter((k) => /token|secret|cipher|credential/i.test(k) && !/tokenHealthy/.test(k));
    expect(sospechosas).toEqual([]);
  });
});

describe("coexistencia recién conectada: Meta aún no publicó el número", () => {
  // Es el caso (a) de la reproducción: el canal nace ACTIVO, sin fila de número, y la página
  // mostraba "Conectado ·" sin nada después del punto.
  const r = armarReporte({ ...BASE, numeroLocal: null, graph: null, canal: { ...BASE.canal, config: { coexistence: true, pendingNumber: true } } });

  it("se declara pendiente, no roto", () => {
    expect(r.pendingNumber).toBe(true);
    expect(r.displayPhone).toBeNull();
    expect(chequeo(r, "numero").ok).toBe(false);
    expect(chequeo(r, "numero").detail).toMatch(/todavía no publica el número/i);
  });

  it("le dice al dueño que NO tiene que hacer nada", () => {
    expect(chequeo(r, "numero").fix).toMatch(/no tienes que hacer nada/i);
  });

  it("el resumen explica la espera en vez de alarmar", () => {
    expect(resumirReporte(r)).toMatch(/está publicando el número/i);
    expect(resumirReporte(r)).not.toMatch(/pendiente[s]?:/i);
  });
});

describe("acceso con Meta vencido (190)", () => {
  const r = armarReporte({ ...BASE, graph: { ok: false, tokenVencido: true, displayPhone: null, verifiedName: null, qualityRating: null, coexVerified: false, error: "El acceso con Meta venció o fue revocado." } });

  it("tokenHealthy en false y el chequeo es un FALLO, no un 'no se pudo saber'", () => {
    expect(r.tokenHealthy).toBe(false);
    expect(chequeo(r, "token").ok).toBe(false);
    expect(chequeo(r, "token").unknown).toBeUndefined();
    expect(chequeo(r, "token").fix).toMatch(/vuelve a conectar/i);
  });

  it("explica la consecuencia: el asistente no puede responder", () => {
    expect(chequeo(r, "token").detail).toMatch(/no puede responder/i);
  });

  it("el número sigue mostrándose desde la fila local (no se pierde la pantalla)", () => {
    expect(r.displayPhone).toBe("+56 9 1234 5678");
  });
});

describe("Meta no nos avisa de los mensajes (app no suscrita)", () => {
  it("es un fallo accionable: el asistente no ve los mensajes", () => {
    const r = armarReporte({ ...BASE, suscripcion: { suscrita: false, campos: [], otras: [] } });
    expect(r.webhookSubscribed).toBe(false);
    expect(chequeo(r, "webhook").ok).toBe(false);
    expect(chequeo(r, "webhook").detail).toMatch(/no los ve/i);
    expect(chequeo(r, "webhook").fix).toMatch(/vuelve a conectar/i);
  });

  it("si OTRA app está suscrita lo advierte (puede estar robándose los mensajes)", () => {
    const r = armarReporte({ ...BASE, suscripcion: { suscrita: true, campos: ["messages"], otras: ["Otro CRM"] } });
    expect(chequeo(r, "webhook").ok).toBe(true);
    expect(chequeo(r, "webhook").detail).toMatch(/Otro CRM/);
  });
});

describe("canal conectado SIN asistente asignado", () => {
  // Caso (b) de la reproducción: el encabezado decía "Conectado" y el pie "conecta tu número".
  const r = armarReporte({ ...BASE, defaultAgent: null });

  it("lo marca como lo único pendiente, con la acción concreta", () => {
    expect(fallosReales(r).map((c) => c.key)).toEqual(["asistente"]);
    expect(chequeo(r, "asistente").fix).toMatch(/asigna tu asistente/i);
    expect(chequeo(r, "asistente").detail).toMatch(/sin responder/i);
  });

  it("el resumen no dice «conectado y atendiendo» cuando nadie atiende", () => {
    expect(resumirReporte(r)).toMatch(/un punto pendiente/i);
  });
});

describe("calidad del número", () => {
  const con = (qualityRating: string | null) => armarReporte({ ...BASE, graph: { ...BASE.graph!, qualityRating } });

  it("ROJA es un fallo con qué hacer", () => {
    expect(chequeo(con("RED"), "calidad").ok).toBe(false);
    expect(chequeo(con("RED"), "calidad").fix).toMatch(/masivos/i);
  });

  it("AMARILLA avisa pero no alarma", () => {
    expect(chequeo(con("YELLOW"), "calidad").ok).toBe(true);
    expect(chequeo(con("YELLOW"), "calidad").detail).toMatch(/amarilla/i);
  });

  it("sin dato de Meta queda como «no se pudo saber», no como fallo", () => {
    expect(chequeo(con(null), "calidad").unknown).toBe(true);
    expect(fallosReales(con(null))).toEqual([]);
  });

  it("una calidad que Meta no documenta no se inventa", () => {
    expect(con("MARAVILLOSA").qualityRating).toBeNull();
  });
});

describe("avisos de la cuenta de WhatsApp", () => {
  const r = armarReporte({ ...BASE, accountAlert: { type: "whatsapp.account_update", message: "Tu cuenta quedó restringida por calidad", at: "2026-11-09T18:30:00.000Z" } });

  it("lo cuenta con la fecha en la hora de Chile", () => {
    expect(chequeo(r, "cuenta").ok).toBe(false);
    expect(chequeo(r, "cuenta").detail).toContain("Tu cuenta quedó restringida por calidad");
    // 18:30Z = 15:30 en Chile (noviembre, -03:00): la hora que entiende el dueño, no la UTC.
    expect(chequeo(r, "cuenta").detail).toContain("15:30");
    expect(chequeo(r, "cuenta").detail).not.toContain("18:30");
  });
});

describe("un hipo de Meta NO se le muestra al dueño como una cuenta rota", () => {
  it("sin suscripción ni calidad (Graph no respondió) no hay ningún fallo real", () => {
    const r = armarReporte({ ...BASE, suscripcion: null, graph: { ...BASE.graph!, qualityRating: null } });
    expect(fallosReales(r)).toEqual([]);
    expect(chequeo(r, "webhook").unknown).toBe(true);
    expect(r.webhookSubscribed).toBeNull();
  });
});

describe("consultarNumero — una sola llamada a Graph", () => {
  it("pide los cinco campos JUNTOS (número, nombre, calidad y el par de coexistencia)", async () => {
    const f = vi.fn().mockResolvedValue(okRes({ display_phone_number: "+56 9 1", verified_name: "N", quality_rating: "GREEN", platform_type: "CLOUD_API", is_on_biz_app: true }));
    const r = await consultarNumero("111", "TOKEN", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(1);
    const url = String(f.mock.calls[0][0]);
    for (const campo of ["display_phone_number", "verified_name", "quality_rating", "platform_type", "is_on_biz_app"]) {
      expect(url).toContain(campo);
    }
    expect(r.coexVerified).toBe(true);
  });

  it("is_on_biz_app sin CLOUD_API no es coexistencia verificada", async () => {
    const f = vi.fn().mockResolvedValue(okRes({ display_phone_number: "+56 9 1", is_on_biz_app: true, platform_type: "ON_PREMISE" }));
    expect((await consultarNumero("111", "T", f as unknown as typeof fetch)).coexVerified).toBe(false);
  });

  it("190 → tokenVencido con una frase que el dueño entiende", async () => {
    const f = vi.fn().mockResolvedValue(errRes(400, { code: 190, message: "Error validating access token" }));
    const r = await consultarNumero("111", "T", f as unknown as typeof fetch);
    expect(r.tokenVencido).toBe(true);
    expect(r.error).toMatch(/venció o fue revocado/i);
  });

  it("otro error de Meta se repite tal cual (sirve para el diagnóstico)", async () => {
    const f = vi.fn().mockResolvedValue(errRes(400, { code: 100, message: "Unsupported get request" }));
    const r = await consultarNumero("111", "T", f as unknown as typeof fetch);
    expect(r.tokenVencido).toBe(false);
    expect(r.error).toBe("Unsupported get request");
  });

  it("si la red falla no lanza: lo dice en el resultado", async () => {
    const f = vi.fn().mockRejectedValue(new Error("ETIMEDOUT"));
    const r = await consultarNumero("111", "T", f as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Error de red: ETIMEDOUT/);
  });
});

describe("consultarSuscripcionWaba", () => {
  const cuerpo = (apps: unknown[]) => okRes({ data: apps });

  it("reconoce nuestra app y sus campos", async () => {
    const f = vi.fn().mockResolvedValue(cuerpo([{ whatsapp_business_api_data: { id: "APP1", name: "Conversia", subscribed_fields: ["messages"] } }]));
    const r = await consultarSuscripcionWaba("W1", "T", "APP1", f as unknown as typeof fetch);
    expect(r).toEqual({ suscrita: true, campos: ["messages"], otras: [] });
  });

  it("lista las OTRAS apps suscritas a la misma cuenta", async () => {
    const f = vi.fn().mockResolvedValue(cuerpo([
      { whatsapp_business_api_data: { id: "APP1", subscribed_fields: ["messages"] } },
      { whatsapp_business_api_data: { id: "APP9", name: "Otro CRM" } },
    ]));
    const r = await consultarSuscripcionWaba("W1", "T", "APP1", f as unknown as typeof fetch);
    expect(r.suscrita).toBe(true);
    expect(r.otras).toEqual(["Otro CRM"]);
  });

  it("nuestra app ausente → suscrita false (eso sí es un problema)", async () => {
    const f = vi.fn().mockResolvedValue(cuerpo([{ whatsapp_business_api_data: { id: "APP9", name: "Otro" } }]));
    expect((await consultarSuscripcionWaba("W1", "T", "APP1", f as unknown as typeof fetch)).suscrita).toBe(false);
  });

  it("si Meta falla devuelve NULL, nunca false: no se acusa a una cuenta sana", async () => {
    const malo = vi.fn().mockResolvedValue(errRes(500, { message: "oops" }));
    expect((await consultarSuscripcionWaba("W1", "T", "APP1", malo as unknown as typeof fetch)).suscrita).toBeNull();
    const caido = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    expect((await consultarSuscripcionWaba("W1", "T", "APP1", caido as unknown as typeof fetch)).suscrita).toBeNull();
  });
});

describe("POST /channels/:id/test sigue respondiendo IGUAL tras compartir la consulta", () => {
  // Este endpoint lo usa el panel de TuBot en producción: el refactor no puede cambiarle
  // ni una frase. Por eso las respuestas van fijadas literalmente.
  const ctx = (): RequestContext => ({ userId: "u1", organizationId: "org1", roleCode: "owner", permissions: ["channels:write"] });

  function controlador(datos: { phoneNumberId: string; token: string | null }) {
    const estados: Array<{ status: string; message?: string }> = [];
    const tx = {
      channelConnection: {
        findUnique: async () => ({ id: "ch1", type: "WHATSAPP_CLOUD", status: "active", config: {} }),
        update: async ({ data }: { data: { status: string } }) => { estados.push({ status: data.status }); return data; },
      },
      whatsappPhoneNumber: { findFirst: async () => ({ phoneNumberId: datos.phoneNumberId, accountId: "acc1" }) },
      whatsappAccount: { findUnique: async () => ({ id: "acc1", credentialId: null }) },
      integrationCredential: { findUnique: async () => null },
      integrationEvent: { create: async () => ({}) },
    };
    const prisma = { withTenant: (_o: string, fn: (t: unknown) => unknown) => fn(tx), admin: {} } as never;
    const c = new ChannelsController(prisma, { reporte: async () => ({}), invalidar: async () => undefined } as never);
    // El token sale de la credencial descifrada; acá se inyecta el resultado de esa lectura.
    (c as unknown as { prisma: unknown }).prisma = { withTenant: async () => ({ mock: false, phoneNumberId: datos.phoneNumberId, token: datos.token }), admin: {} };
    return { c, estados };
  }

  it("número OK → la misma frase «Número verificado: … · calidad: …»", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(okRes({ display_phone_number: "+56 9 1234 5678", verified_name: "Barbería", quality_rating: "GREEN" })) as never;
    try {
      const { c } = controlador({ phoneNumberId: "111", token: "TOKEN" });
      const r = (await runWithContext(ctx(), () => c.test("ch1"))) as { ok: boolean; detail: string };
      expect(r).toEqual({ ok: true, detail: "Número verificado: +56 9 1234 5678 (Barbería) · calidad: GREEN" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("campos faltantes → los mismos rellenos «?» y «sin nombre»", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(okRes({})) as never;
    try {
      const { c } = controlador({ phoneNumberId: "111", token: "TOKEN" });
      const r = (await runWithContext(ctx(), () => c.test("ch1"))) as { detail: string };
      expect(r.detail).toBe("Número verificado: ? (sin nombre) · calidad: ?");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("190 → la misma frase de token vencido", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(errRes(401, { code: 190, message: "Error validating access token" })) as never;
    try {
      const { c } = controlador({ phoneNumberId: "111", token: "TOKEN" });
      const r = (await runWithContext(ctx(), () => c.test("ch1"))) as { ok: boolean; detail: string };
      expect(r).toEqual({ ok: false, detail: "El token del canal está vencido o fue revocado — reautoriza WhatsApp en Canales." });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("otro error de Meta → se repite el mensaje de Meta", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(errRes(400, { code: 100, message: "Unsupported get request" })) as never;
    try {
      const { c } = controlador({ phoneNumberId: "111", token: "TOKEN" });
      const r = (await runWithContext(ctx(), () => c.test("ch1"))) as { ok: boolean; detail: string };
      expect(r).toEqual({ ok: false, detail: "Unsupported get request" });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("canal sin token propio → el mismo aviso, sin llamar a Meta", async () => {
    const original = globalThis.fetch;
    const f = vi.fn();
    globalThis.fetch = f as never;
    try {
      const { c } = controlador({ phoneNumberId: "111", token: null });
      const r = (await runWithContext(ctx(), () => c.test("ch1"))) as { ok: boolean; detail: string };
      expect(r).toEqual({ ok: false, detail: "Sin token: carga el access token del canal" });
      expect(f).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});
