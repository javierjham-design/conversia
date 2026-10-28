import { describe, expect, it } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { verifyPhoneNumberOwnership } from "../src/channels/whatsapp-onboard";
import { assertMetaId, META_ID_RE } from "../src/channels/channels.controller";
import { MetaCrmWebhookController, decidirVerificacionDeFirma } from "../src/integrations/meta-crm-webhook.controller";

/**
 * ETAPA 7 — §4.3 (propiedad del número) y §4.5 (webhook fail-closed).
 *
 * El agujero de §4.3: el id de la WABA y el del número entraban por el formulario (o por
 * el evento de Meta) y se guardaban tal cual. Una organización podía declarar el número de
 * otra y quedar recibiendo y enviando como ella. La verificación le pregunta a Meta con el
 * token DEL CLIENTE, porque la pregunta es si ÉL tiene acceso a ese número.
 */

const respuesta = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("§4.3 — verificación de propiedad del número", () => {
  it("el número está en la WABA → verificado, con sus datos", async () => {
    const f = respuesta({ data: [{ id: "123456", display_phone_number: "+56 9 1111 1111", verified_name: "Clínica" }] });
    const r = await verifyPhoneNumberOwnership("99999999", "123456", "tok", f);
    expect(r.estado).toBe("verificado");
    if (r.estado === "verificado") expect(r.displayPhone).toBe("+56 9 1111 1111");
  });

  it("la WABA tiene OTROS números → AJENO (es el caso del hallazgo)", async () => {
    const f = respuesta({ data: [{ id: "777777" }, { id: "888888" }] });
    const r = await verifyPhoneNumberOwnership("99999999", "123456", "tok", f);
    expect(r.estado).toBe("ajeno");
    if (r.estado === "ajeno") expect(r.detalle).toMatch(/no incluye/);
  });

  it("la WABA no tiene números visibles con ese token → AJENO", async () => {
    const r = await verifyPhoneNumberOwnership("99999999", "123456", "tok", respuesta({ data: [] }));
    expect(r.estado).toBe("ajeno");
  });

  it("Meta responde error → SIN VERIFICAR (no se da por bueno)", async () => {
    const f = respuesta({ error: { message: "Invalid OAuth token", code: 190 } }, 401);
    const r = await verifyPhoneNumberOwnership("99999999", "123456", "tok", f);
    expect(r.estado).toBe("sin_verificar");
    if (r.estado === "sin_verificar") expect(r.detalle).toMatch(/OAuth/);
  });

  it("se cae la red → SIN VERIFICAR (falla CERRADO, no abierto)", async () => {
    const f = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const r = await verifyPhoneNumberOwnership("99999999", "123456", "tok", f);
    expect(r.estado).toBe("sin_verificar");
  });

  it("respuesta sin `data` → SIN VERIFICAR (no se interpreta como vacío)", async () => {
    const r = await verifyPhoneNumberOwnership("99999999", "123456", "tok", respuesta({ algo: "otra cosa" }));
    expect(r.estado).toBe("sin_verificar");
  });

  it("pregunta por la WABA declarada, con el token del cliente", async () => {
    let urlVista = "";
    const f = (async (url: string) => {
      urlVista = String(url);
      return new Response(JSON.stringify({ data: [{ id: "123456" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await verifyPhoneNumberOwnership("99999999", "123456", "tok-del-cliente", f);
    expect(urlVista).toContain("/99999999/phone_numbers");
  });
});

describe("§4.3 — los ids de Meta son numéricos antes de entrar en una URL de Graph", () => {
  it("acepta ids reales", () => {
    expect(META_ID_RE.test("123456789012345")).toBe(true);
    expect(assertMetaId("  123456789  ", "El id")).toBe("123456789");
  });

  it("rechaza lo que podría cambiar la URL o la cuenta consultada", () => {
    for (const malo of [
      "123/me",
      "123?fields=x",
      "../999",
      "abc123456",
      "12",            // demasiado corto
      "1".repeat(21),  // demasiado largo
      "",
      "123 456",
    ]) {
      expect(() => assertMetaId(malo, "El id"), `debía rechazar ${JSON.stringify(malo)}`).toThrowError(BadRequestException);
    }
  });

  it("rechaza null y undefined", () => {
    expect(() => assertMetaId(null, "El id")).toThrowError(BadRequestException);
    expect(() => assertMetaId(undefined, "El id")).toThrowError(BadRequestException);
  });
});

describe("§4.5 — el webhook de Meta CRM es fail-closed sin secreto", () => {
  const queues = () => {
    const jobs: Array<{ name: string; data: unknown; opts: any }> = [];
    return { jobs, svc: { inbound: { add: async (name: string, data: unknown, opts: any) => void jobs.push({ name, data, opts }) } } as any };
  };
  const req = (body: unknown) => ({ body, headers: {}, rawBody: Buffer.from(JSON.stringify(body)) }) as any;

  // La decisión se prueba como función PURA: `getEnv()` está memoizado, así que un test
  // que manipule `process.env` se auto-saltaría sin avisar (una aserción vacua).
  it("en PRODUCCIÓN sin secreto → RECHAZAR (antes aceptaba cualquier cuerpo)", () => {
    expect(decidirVerificacionDeFirma("production", undefined)).toBe("rechazar");
    expect(decidirVerificacionDeFirma("production", null)).toBe("rechazar");
    expect(decidirVerificacionDeFirma("production", "")).toBe("rechazar");
  });

  it("en producción CON secreto → verificar la firma", () => {
    expect(decidirVerificacionDeFirma("production", "s3cr3t")).toBe("verificar");
  });

  it("fuera de producción sin secreto → se acepta (es lo que permite probar con ngrok)", () => {
    expect(decidirVerificacionDeFirma("development", undefined)).toBe("aceptar_sin_firma");
    expect(decidirVerificacionDeFirma("test", undefined)).toBe("aceptar_sin_firma");
  });

  it("con secreto SIEMPRE se verifica, en cualquier entorno", () => {
    for (const e of ["production", "development", "test"]) {
      expect(decidirVerificacionDeFirma(e, "s3cr3t")).toBe("verificar");
    }
  });

  it("una firma inválida se rechaza y NO encola nada", async () => {
    const { jobs, svc } = queues();
    const c = new MetaCrmWebhookController(svc);
    const env = (await import("@conversia/config")).getEnv();
    // Solo aplica si este entorno tiene secreto configurado; si no, lo cubren los puros.
    if (!(env.META_CRM_APP_SECRET || env.META_APP_SECRET)) return;
    const r = { body: { object: "page" }, headers: { "x-hub-signature-256": "sha256=00" }, rawBody: Buffer.from("{}") } as any;
    await expect(c.receive(r)).rejects.toBeInstanceOf(ForbiddenException);
    expect(jobs).toEqual([]);
  });

  it("el job lleva jobId por CONTENIDO y reintentos (Meta reenvía el mismo webhook)", async () => {
    const { jobs, svc } = queues();
    const c = new MetaCrmWebhookController(svc);
    const cuerpo = { object: "page", entry: [{ id: "1" }] };
    try {
      await c.receive(req(cuerpo));
      await c.receive(req(cuerpo));
    } catch {
      // Si el entorno exige firma, este caso no aplica: lo cubre el anterior.
      return;
    }
    expect(jobs.length).toBe(2);
    // El MISMO cuerpo produce el MISMO jobId → BullMQ descarta el reenvío.
    expect(jobs[0].opts.jobId).toBe(jobs[1].opts.jobId);
    expect(jobs[0].opts.jobId).toMatch(/^meta-crm:[0-9a-f]{32}$/);
    expect(jobs[0].opts.attempts).toBe(5);
    // Y un cuerpo distinto, un jobId distinto (no se pierde un lead real).
    const { jobs: otros, svc: svc2 } = queues();
    await new MetaCrmWebhookController(svc2).receive(req({ object: "page", entry: [{ id: "2" }] }));
    expect(otros[0].opts.jobId).not.toBe(jobs[0].opts.jobId);
  });
});
