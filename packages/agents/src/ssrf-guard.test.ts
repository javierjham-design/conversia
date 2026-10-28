import { describe, expect, it } from "vitest";
import { esIpProhibida, validarUrlExterna } from "./ssrf-guard";
import { fetchWebPageText } from "./web-fetch";

/**
 * §7.3 — SSRF en `leerWeb` y en `/public/crear/draft`.
 *
 * La URL la elige quien escribe en el chat (o quien usa el generador público), así que es
 * entrada de un tercero apuntando a nuestra red. El guard anterior solo miraba el TEXTO del
 * host, y su propia nota lo decía: sin re-resolución DNS. Dos agujeros reales:
 *  - un dominio público que RESUELVE a `169.254.169.254` (credenciales de la nube) o a un
 *    `10.x` interno pasaba el filtro;
 *  - con `redirect: "follow"`, el primer salto podía ser público y el segundo apuntar
 *    adentro, y el guard no volvía a mirar.
 */

const resuelveA = (...ips: string[]) => async () => ips;

describe("§7.3 — rangos de IP que no se deben alcanzar", () => {
  it("bloquea las privadas y el loopback", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.1.1", "172.16.0.1", "172.31.255.255", "0.0.0.0"]) {
      expect(esIpProhibida(ip), ip).toBe(true);
    }
  });

  it("bloquea los metadatos de la nube (169.254.169.254) — el objetivo clásico", () => {
    expect(esIpProhibida("169.254.169.254")).toBe(true);
  });

  it("bloquea CGNAT, multicast y los rangos reservados que el guard de texto no cubría", () => {
    for (const ip of ["100.64.0.1", "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1"]) {
      expect(esIpProhibida(ip), ip).toBe(true);
    }
  });

  it("bloquea IPv6 interna, incluida la IPv4 mapeada", () => {
    for (const ip of ["::1", "fd00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      expect(esIpProhibida(ip), ip).toBe(true);
    }
  });

  it("deja pasar direcciones públicas de verdad", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "190.1.2.3", "2606:4700::1111"]) {
      expect(esIpProhibida(ip), ip).toBe(false);
    }
  });

  it("lo que no es una IP no se da por bueno", () => {
    expect(esIpProhibida("no-soy-una-ip")).toBe(true);
    expect(esIpProhibida("")).toBe(true);
  });
});

describe("§7.3 — un dominio que apunta adentro se rechaza (éste era el agujero)", () => {
  it("dominio público que resuelve a los metadatos de la nube", async () => {
    const r = await validarUrlExterna("https://inocente.cl", { resolver: resuelveA("169.254.169.254") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/interna/i);
  });

  it("dominio que resuelve a una IP privada", async () => {
    const r = await validarUrlExterna("https://inocente.cl", { resolver: resuelveA("10.1.2.3") });
    expect(r.ok).toBe(false);
  });

  it("basta UNA IP interna entre varias para rechazar", async () => {
    // El atacante solo necesita que una resuelva adentro para que el intento sirva.
    const r = await validarUrlExterna("https://inocente.cl", { resolver: resuelveA("8.8.8.8", "127.0.0.1") });
    expect(r.ok).toBe(false);
  });

  it("si el dominio no resuelve, no se intenta", async () => {
    const r = await validarUrlExterna("https://inocente.cl", {
      resolver: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/resolver/i);
  });

  it("un dominio público normal pasa", async () => {
    const r = await validarUrlExterna("https://clinica.cl/precios", { resolver: resuelveA("190.1.2.3") });
    expect(r.ok).toBe(true);
  });

  it("sigue rechazando lo que ya rechazaba el guard de texto (http, credenciales, localhost)", async () => {
    expect((await validarUrlExterna("http://clinica.cl", { resolver: resuelveA("190.1.2.3") })).ok).toBe(false);
    expect((await validarUrlExterna("https://u:p@clinica.cl", { resolver: resuelveA("190.1.2.3") })).ok).toBe(false);
    expect((await validarUrlExterna("https://localhost", { resolver: resuelveA("190.1.2.3") })).ok).toBe(false);
    expect((await validarUrlExterna("file:///etc/passwd")).ok).toBe(false);
  });
});

describe("§7.3 — las redirecciones se validan SALTO A SALTO", () => {
  const html = (cuerpo: string) =>
    new Response(cuerpo, { status: 200, headers: { "content-type": "text/html" } });
  const redirige = (a: string) => new Response(null, { status: 302, headers: { location: a } });

  it("un salto hacia una IP interna se corta (antes se seguía sin mirar)", async () => {
    const vistas: string[] = [];
    const fetchImpl = (async (u: string) => {
      vistas.push(String(u));
      return String(u).includes("inocente") ? redirige("http://169.254.169.254/latest/meta-data/") : html("<p>secreto</p>");
    }) as unknown as typeof fetch;
    const r = await fetchWebPageText("https://inocente.cl", { fetchImpl, resolver: resuelveA("190.1.2.3") });
    expect(r.ok).toBe(false);
    // Lo importante: NUNCA se pidió la URL interna.
    expect(vistas.some((u) => u.includes("169.254"))).toBe(false);
  });

  it("una cadena de redirecciones públicas sí se sigue, y devuelve la URL FINAL", async () => {
    const fetchImpl = (async (u: string) =>
      String(u).includes("paso1") ? redirige("https://destino.cl/final") : html("<title>Hola</title><p>texto real</p>")) as unknown as typeof fetch;
    const r = await fetchWebPageText("https://paso1.cl", { fetchImpl, resolver: resuelveA("190.1.2.3") });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.url).toBe("https://destino.cl/final");
      expect(r.title).toBe("Hola");
      expect(r.text).toContain("texto real");
    }
  });

  it("un bucle de redirecciones se corta sin colgarse", async () => {
    const fetchImpl = (async () => redirige("https://vueltas.cl/otra")) as unknown as typeof fetch;
    const r = await fetchWebPageText("https://vueltas.cl", { fetchImpl, resolver: resuelveA("190.1.2.3") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/redirecciones/i);
  });

  it("un 302 sin destino no se interpreta como página", async () => {
    const fetchImpl = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    const r = await fetchWebPageText("https://clinica.cl", { fetchImpl, resolver: resuelveA("190.1.2.3") });
    expect(r.ok).toBe(false);
  });
});

describe("§7.3 — el cuerpo se lee con tope de BYTES", () => {
  it("una respuesta gigante no se descarga entera", async () => {
    // Antes era `(await res.text()).slice(0, 800_000)`: el recorte ocurría DESPUÉS de
    // traerlo todo a memoria. Acá el stream se corta y el lector se cancela.
    let entregados = 0;
    let cancelado = false;
    const trozo = new TextEncoder().encode("<p>" + "a".repeat(100_000) + "</p>");
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        entregados += trozo.byteLength;
        if (entregados > 50_000_000) return c.close(); // red de seguridad del propio test
        c.enqueue(trozo);
      },
      cancel() {
        cancelado = true;
      },
    });
    const fetchImpl = (async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const r = await fetchWebPageText("https://enorme.cl", { fetchImpl, resolver: resuelveA("190.1.2.3") });
    expect(r.ok).toBe(true);
    expect(cancelado).toBe(true);
    // Se leyó del orden del tope (800 KB), no los 50 MB que el servidor quería dar.
    expect(entregados).toBeLessThan(2_000_000);
  });
});
