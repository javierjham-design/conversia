import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVENTOS_TIKTOK,
  armarPayloadTiktok,
  hashCorreo,
  hashIdPropio,
  hashTelefono,
  leerRespuestaTiktok,
  momentoDelEvento,
} from "./tiktok";

/**
 * TIKTOK EVENTS API — las cuatro formas que tiene esta integración de fallar SIN AVISAR.
 *
 * Ninguna de las cuatro da error en pantalla. Las cuatro terminan en «evento enviado» mientras
 * TikTok sigue sin saber qué anuncios venden, que es exactamente lo que se quería arreglar.
 *
 *  1. **TikTok responde HTTP 200 cuando RECHAZA el evento.** El error viene en el campo `code`
 *     del cuerpo. Un `if (res.ok)` da por bueno un token vencido o un pixel inexistente.
 *  2. **Un hash normalizado distinto no calza con nadie.** El evento se acepta, se cuenta como
 *     enviado, y no sirve de nada porque TikTok no puede asociarlo a ninguna persona.
 *  3. **`event_time` en milisegundos.** TikTok lo lee como un año imposible y descarta el
 *     evento por estar fuera de la ventana aceptada, sin decir que fue por eso.
 *  4. **Una fecha que cruzó la cola llega como TEXTO.** Un `Date` encolado se serializa a JSON;
 *     llamar `.getTime()` sobre el string revienta DENTRO de un job, donde nadie mira.
 */

const CONFIG = { eventSourceId: "C1A2B3D4E5", eventSource: "crm" };
const AHORA = new Date("2026-11-26T15:30:00.000Z");
const BASE = { eventName: "CompletePayment", eventId: "run1:nodo1" };

// ─────────────────────────────────────────────────────────────────────────────
// 1. El 200 mentiroso
// ─────────────────────────────────────────────────────────────────────────────
describe("un 200 de TikTok NO significa que el evento se registró", () => {
  it("`code: 0` es el único éxito", () => {
    expect(leerRespuestaTiktok(200, { code: 0, message: "OK" })).toEqual({ ok: true, detalle: "OK" });
  });

  it("200 con `code` distinto de 0 es un RECHAZO, y el motivo se conserva", () => {
    const r = leerRespuestaTiktok(200, { code: 40001, message: "Access token is invalid" });
    expect(r.ok).toBe(false);
    expect(r.detalle).toContain("40001");
    expect(r.detalle, "sin el mensaje de TikTok nadie puede arreglarlo").toContain("Access token is invalid");
  });

  it("200 sin `code` legible tampoco se da por bueno", () => {
    // Pasa si TikTok cambia el contrato o si un proxy devuelve otra cosa. Afirmar éxito acá
    // sería inventar: no se sabe si quedó registrado.
    for (const cuerpo of [null, {}, { message: "algo" }, "texto suelto"]) {
      expect(leerRespuestaTiktok(200, cuerpo).ok, `con el cuerpo ${JSON.stringify(cuerpo)}`).toBe(false);
    }
  });

  it("`code` que viene como TEXTO (\"0\") también se entiende", () => {
    expect(leerRespuestaTiktok(200, { code: "0" }).ok).toBe(true);
    expect(leerRespuestaTiktok(200, { code: "40001" }).ok).toBe(false);
  });

  it("un HTTP de error es error, y se dice cuál", () => {
    expect(leerRespuestaTiktok(401, { message: "no autorizado" })).toMatchObject({ ok: false });
    expect(leerRespuestaTiktok(500, {}).detalle).toContain("500");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Los hashes: distinto formato = no calza con NADIE
// ─────────────────────────────────────────────────────────────────────────────
describe("el calce depende de normalizar antes de hashear", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");

  it("el mismo teléfono escrito de cinco maneras produce UN SOLO hash", () => {
    const formas = ["+56912345678", "56912345678", "+56 9 1234 5678", "(569) 1234-5678", " +56-9-1234-5678 "];
    const hashes = new Set(formas.map(hashTelefono));
    expect(hashes.size, `salieron ${hashes.size} hashes distintos: ${[...hashes].join(" ")}`).toBe(1);
  });

  it("y ese hash es E.164: «+» y solo dígitos", () => {
    expect(hashTelefono("+56 9 1234 5678")).toBe(sha("+56912345678"));
  });

  it("el correo se hashea en minúsculas y sin espacios alrededor", () => {
    expect(hashCorreo("  Javier@Clinica.CL ")).toBe(sha("javier@clinica.cl"));
    expect(hashCorreo("JAVIER@CLINICA.CL")).toBe(hashCorreo("javier@clinica.cl"));
  });

  it("el identificador propio, igual", () => {
    expect(hashIdPropio(" CONTACT_abc ")).toBe(sha("contact_abc"));
  });

  it("nunca sale el dato en claro: lo que viaja son 64 hex", () => {
    const payload = armarPayloadTiktok(CONFIG, { ...BASE, phone: "+56912345678", email: "a@b.cl", externalId: "c1" }, AHORA);
    const user = payload.data[0].user as Record<string, string[]>;
    const crudo = JSON.stringify(payload);
    expect(crudo, "el teléfono salió en claro hacia TikTok").not.toContain("56912345678");
    expect(crudo, "el correo salió en claro hacia TikTok").not.toContain("a@b.cl");
    for (const campo of ["phone", "email", "external_id"]) {
      expect(user[campo]).toHaveLength(1);
      expect(user[campo][0]).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("sin identificadores, `user` va vacío (y el remitente no manda el evento)", () => {
    const payload = armarPayloadTiktok(CONFIG, BASE, AHORA);
    expect(payload.data[0].user).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. y 4. El tiempo
// ─────────────────────────────────────────────────────────────────────────────
describe("el momento del evento", () => {
  it("va en SEGUNDOS, no en milisegundos", () => {
    const payload = armarPayloadTiktok(CONFIG, BASE, AHORA);
    expect(payload.data[0].event_time).toBe(Math.floor(AHORA.getTime() / 1000));
    // El control que importa: en milisegundos el número tiene 13 dígitos y TikTok lo lee como
    // el año 56.000. Si alguien quita el /1000, esto cae.
    expect(String(payload.data[0].event_time)).toHaveLength(10);
  });

  it("una fecha que CRUZÓ LA COLA (texto ISO) se entiende igual", () => {
    // Esto es lo que de verdad pasa: el runtime encola `occurredAt: new Date().toISOString()`
    // y BullMQ lo entrega como string. Con `.getTime()` directo, el job revienta.
    const comoLlegaDeLaCola = "2026-11-26T15:30:00.000Z";
    const payload = armarPayloadTiktok(CONFIG, { ...BASE, occurredAt: comoLlegaDeLaCola }, new Date(0));
    expect(payload.data[0].event_time).toBe(Math.floor(Date.parse(comoLlegaDeLaCola) / 1000));
  });

  it("una fecha basura no tumba el envío: cae a «ahora»", () => {
    for (const malo of ["", "   ", "no-es-fecha", new Date("x")] as (string | Date)[]) {
      expect(momentoDelEvento(malo, AHORA).getTime()).toBe(AHORA.getTime());
    }
    expect(momentoDelEvento(undefined, AHORA).getTime()).toBe(AHORA.getTime());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// La deduplicación y la forma del cuerpo
// ─────────────────────────────────────────────────────────────────────────────
describe("el cuerpo que se le manda a TikTok", () => {
  it("lleva el origen y el destino del tenant, y UN evento por llamada", () => {
    const payload = armarPayloadTiktok(CONFIG, BASE, AHORA);
    expect(payload.event_source).toBe("crm");
    expect(payload.event_source_id).toBe("C1A2B3D4E5");
    expect(payload.data).toHaveLength(1);
    expect(payload.data[0].event).toBe("CompletePayment");
  });

  it("el `event_id` se respeta tal cual: es la clave de deduplicación", () => {
    // Si no se propagara, un reintento tras un timeout contaría la conversión DOS veces y le
    // enseñaría a TikTok que el anuncio rinde el doble de lo que rinde.
    expect(armarPayloadTiktok(CONFIG, { ...BASE, eventId: "run7:nodo3" }, AHORA).data[0].event_id).toBe("run7:nodo3");
  });

  it("el valor solo viaja si es un número de verdad, y arrastra la moneda", () => {
    const con = armarPayloadTiktok(CONFIG, { ...BASE, value: 24990 }, AHORA).data[0].properties as Record<string, unknown>;
    expect(con).toEqual({ value: 24990, currency: "CLP" });

    for (const basura of [null, undefined, NaN, "muchos" as unknown as number]) {
      const sin = armarPayloadTiktok(CONFIG, { ...BASE, value: basura as number }, AHORA).data[0].properties;
      expect(sin, `con value=${String(basura)} se mandó un valor inválido`).toEqual({});
    }
  });

  it("la moneda del tenant se respeta cuando la define", () => {
    const p = armarPayloadTiktok(CONFIG, { ...BASE, value: 10, currency: "USD" }, AHORA).data[0].properties as Record<string, unknown>;
    expect(p.currency).toBe("USD");
  });
});

describe("los nombres de evento son los de TikTok, no los de Meta", () => {
  it("no se ofrece ningún nombre que TikTok no conozca", () => {
    // `Schedule` y `Purchase` son de Meta. Mandárselos a TikTok los toma como evento
    // PERSONALIZADO: se aceptan, no dan error y no sirven para optimizar — el fallo silencioso
    // más fácil de cometer al copiar el paso de CAPI.
    expect(EVENTOS_TIKTOK).not.toContain("Schedule" as never);
    expect(EVENTOS_TIKTOK).not.toContain("Purchase" as never);
    expect(EVENTOS_TIKTOK).toContain("CompletePayment");
    expect(EVENTOS_TIKTOK).toContain("PlaceAnOrder");
  });

  it("y la lista del editor es la MISMA que la del worker", () => {
    // Dos listas que se separan producen un paso que ofrece un evento que el backend no manda
    // bien. El editor vive en apps/web; acá se comprueba leyendo su archivo.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const editor = readFileSync(join(__dirname, "..", "..", "web", "src", "app", "(app)", "workflows", "[id]", "page.tsx"), "utf8");
    const linea = /const TIKTOK_EVENTS = \[([^\]]+)\]/.exec(editor)?.[1] ?? "";
    expect(linea, "no se pudo leer TIKTOK_EVENTS del editor (si no, este test no prueba nada)").not.toBe("");
    const delEditor = [...linea.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(delEditor).toEqual([...EVENTOS_TIKTOK]);
  });
});
