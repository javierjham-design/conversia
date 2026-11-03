import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COOKIE_CONSENTIMIENTO,
  esRutaDeMarketing,
  estadoConsentimiento,
  guardarConsentimiento,
  puedeMedir,
} from "./consentimiento";

/**
 * M0 — el consentimiento es la COMPUERTA del Pixel de Meta que llega en M1.
 *
 * Lo que más importa acá es el primer bloque: **sin respuesta no se mide**. Si ese default se
 * invierte, el sitio carga el Pixel de un visitante que nunca contestó, que es exactamente la
 * infracción que la Ley 21.719 castiga, y no hay forma de notarlo mirando la pantalla.
 */

/** `document.cookie` de verdad no existe en el entorno de test: se simula con acumulación. */
function montarCookies(inicial = "") {
  let almacen = inicial;
  vi.stubGlobal("document", {
    get cookie() {
      return almacen;
    },
    set cookie(v: string) {
      const [par] = v.split(";");
      const [nombre, valor] = (par ?? "").split("=");
      if (!nombre) return;
      const borra = /Max-Age=0/.test(v);
      const otras = almacen
        .split("; ")
        .filter((c) => c && c.split("=")[0] !== nombre.trim());
      almacen = borra ? otras.join("; ") : [...otras, `${nombre.trim()}=${valor ?? ""}`].join("; ");
    },
  });
  vi.stubGlobal("location", { protocol: "https:", hostname: "conversia.cl" });
}

beforeEach(() => montarCookies());
afterEach(() => vi.unstubAllGlobals());

describe("sin respuesta NO se mide (el default conservador)", () => {
  it("un visitante nuevo no tiene consentimiento y no se puede medir", () => {
    expect(estadoConsentimiento()).toBe("sin-respuesta");
    expect(puedeMedir()).toBe(false);
  });

  it("un valor basura en la cookie tampoco habilita la medición", () => {
    montarCookies(`${COOKIE_CONSENTIMIENTO}=si`);
    expect(estadoConsentimiento()).toBe("sin-respuesta");
    expect(puedeMedir()).toBe(false);
  });

  it("ni una cookie vacía", () => {
    montarCookies(`${COOKIE_CONSENTIMIENTO}=`);
    expect(puedeMedir()).toBe(false);
  });
});

describe("la decisión del visitante se respeta", () => {
  it("aceptar habilita la medición", () => {
    guardarConsentimiento("aceptado");
    expect(estadoConsentimiento()).toBe("aceptado");
    expect(puedeMedir()).toBe(true);
  });

  it("'solo necesarias' NO habilita la medición", () => {
    guardarConsentimiento("solo-necesarias");
    expect(estadoConsentimiento()).toBe("solo-necesarias");
    expect(puedeMedir()).toBe(false);
  });

  it("se puede cambiar de opinión en los dos sentidos", () => {
    guardarConsentimiento("aceptado");
    expect(puedeMedir()).toBe(true);
    guardarConsentimiento("solo-necesarias");
    expect(puedeMedir()).toBe(false);
    guardarConsentimiento("aceptado");
    expect(puedeMedir()).toBe(true);
  });

  it("la cookie se guarda con SameSite=Lax y Secure en https", () => {
    const escritas: string[] = [];
    vi.stubGlobal("document", { get cookie() { return ""; }, set cookie(v: string) { escritas.push(v); } });
    vi.stubGlobal("location", { protocol: "https:", hostname: "conversia.cl" });
    guardarConsentimiento("aceptado");
    expect(escritas[0]).toContain("SameSite=Lax");
    expect(escritas[0]).toContain("Secure");
    expect(escritas[0]).toContain("Path=/");
  });

  it("en http (desarrollo) no se marca Secure, o la cookie no se guardaría", () => {
    const escritas: string[] = [];
    vi.stubGlobal("document", { get cookie() { return ""; }, set cookie(v: string) { escritas.push(v); } });
    vi.stubGlobal("location", { protocol: "http:", hostname: "localhost" });
    guardarConsentimiento("aceptado");
    expect(escritas[0]).not.toContain("Secure");
  });
});

describe("en el servidor nada explota", () => {
  it("sin `document` el estado es 'sin-respuesta' y guardar no lanza", () => {
    vi.unstubAllGlobals();
    expect(estadoConsentimiento()).toBe("sin-respuesta");
    expect(puedeMedir()).toBe(false);
    expect(() => guardarConsentimiento("aceptado")).not.toThrow();
  });
});

describe("dónde se mide: lista BLANCA, no negra", () => {
  it("las rutas públicas de marketing sí", () => {
    for (const r of ["/", "/crear", "/registro", "/precios", "/barberias", "/dental", "/estetica", "/kinesiologia"]) {
      expect(esRutaDeMarketing(r), r).toBe(true);
    }
  });

  it("con barra final al final cuenta igual", () => {
    expect(esRutaDeMarketing("/barberias/")).toBe(true);
    expect(esRutaDeMarketing("/")).toBe(true);
  });

  it("el PANEL no se mide", () => {
    for (const r of ["/inicio", "/cobros", "/agenda", "/canales", "/bandeja", "/settings"]) {
      expect(esRutaDeMarketing(r), r).toBe(false);
    }
  });

  it("el mini-sitio del CLIENTE FINAL no se mide", () => {
    // En `/n/*` el visitante es el cliente de nuestro cliente: no llegó por un anuncio
    // nuestro y medirlo sería meter nuestro Pixel en el negocio de otro.
    expect(esRutaDeMarketing("/n/barberia-lopez")).toBe(false);
    expect(esRutaDeMarketing("/n/barberia-lopez/agendar")).toBe(false);
  });

  it("el super admin no se mide", () => {
    expect(esRutaDeMarketing("/admin")).toBe(false);
    expect(esRutaDeMarketing("/admin/asistente")).toBe(false);
  });

  it("una ruta NUEVA nace sin medición (el lado seguro)", () => {
    expect(esRutaDeMarketing("/promo-septiembre")).toBe(false);
    expect(esRutaDeMarketing("/legal/privacidad")).toBe(false);
  });

  it("una subruta de una página de rubro no se asume medible", () => {
    // `/barberias` mide; `/barberias/algo` es otra página y tiene que declararse.
    expect(esRutaDeMarketing("/barberias/santiago")).toBe(false);
  });
});
