import { describe, it, expect } from "vitest";
import { LINK_TUBOT_A_CONVERSIA, RUTAS_CONVERSIA, linkParaMarca } from "./brand-links";
import { NOTIF_EVENTS } from "./catalog";

/**
 * CRE 3 — los enlaces de los avisos, por marca.
 *
 * El catálogo nació con TuBot y sus rutas quedaron escritas tal cual. En conversia-web
 * varias no existen, así que un cliente de Conversia que tocaba "alguien espera respuesta"
 * o "te quedan pocos créditos" caía en un 404 — y lo peor es QUIÉN lo ve: no el que está
 * montando, sino el que ya está pagando y acaba de recibir un aviso de que su bot se corta.
 *
 * El último bloque es el GUARDIÁN: recorre el catálogo completo y falla si un aviso nuevo
 * trae una ruta que en Conversia no lleva a ninguna parte.
 */
describe("TuBot no se toca", () => {
  it("sus enlaces quedan exactamente iguales", () => {
    for (const l of ["/inbox?c=abc", "/billing", "/facturacion", "/settings/plan", "/lo-que-sea"]) {
      expect(linkParaMarca(l, "tubot")).toBe(l);
    }
  });
});

describe("Conversia: las rutas se traducen", () => {
  it("la bandeja", () => {
    expect(linkParaMarca("/inbox", "conversia")).toBe("/conversaciones");
  });

  it("CONSERVA la query que abre la conversación correcta", () => {
    // Sin el `?c=`, el dueño cae en una bandeja vacía y no encuentra el mensaje del aviso.
    expect(linkParaMarca("/inbox?c=abc123", "conversia")).toBe("/conversaciones?c=abc123");
  });

  it("los enlaces de dinero van a Cobros", () => {
    expect(linkParaMarca("/billing", "conversia")).toBe("/cobros");
    expect(linkParaMarca("/facturacion", "conversia")).toBe("/cobros");
    expect(linkParaMarca("/settings/plan", "conversia")).toBe("/cobros");
  });

  it("la configuración va a Ajustes", () => {
    expect(linkParaMarca("/settings/notifications", "conversia")).toBe("/ajustes");
    expect(linkParaMarca("/settings/ia", "conversia")).toBe("/ajustes");
    expect(linkParaMarca("/settings/export", "conversia")).toBe("/ajustes");
  });

  it("los contactos van a Clientes", () => {
    expect(linkParaMarca("/contacts", "conversia")).toBe("/clientes");
  });

  it("una ruta con id se traduce por prefijo", () => {
    expect(linkParaMarca("/workflows/abc", "conversia")).toBe("/inicio");
    expect(linkParaMarca("/inbox/123", "conversia")).toBe("/conversaciones");
  });

  it("lo que ya es de Conversia se deja como está", () => {
    expect(linkParaMarca("/cobros", "conversia")).toBe("/cobros");
    expect(linkParaMarca("/ajustes", "conversia")).toBe("/ajustes");
  });

  it("una ruta desconocida va al panel, NUNCA a un 404", () => {
    expect(linkParaMarca("/pantalla-inventada", "conversia")).toBe("/inicio");
  });

  it("sin enlace no inventa uno", () => {
    expect(linkParaMarca(undefined, "conversia")).toBeUndefined();
  });

  it("tolera la barra final", () => {
    expect(linkParaMarca("/billing/", "conversia")).toBe("/cobros");
  });
});

describe("GUARDIÁN — todo aviso del catálogo lleva a una pantalla que existe en Conversia", () => {
  it("el catálogo se leyó de verdad", () => {
    expect(NOTIF_EVENTS.length).toBeGreaterThan(20);
  });

  it("ningún aviso deja a un cliente de Conversia en una ruta inexistente", () => {
    const rotos: string[] = [];
    for (const ev of NOTIF_EVENTS) {
      if (!ev.link) continue;
      // Se quitan los marcadores de plantilla ({conversationId}) antes de resolver la ruta.
      const plano = ev.link.replace(/\{[^}]+\}/g, "x");
      const destino = linkParaMarca(plano, "conversia")!;
      const base = destino.split("?")[0].replace(/\/+$/, "") || "/";
      if (!RUTAS_CONVERSIA.has(base)) rotos.push(`${ev.key}: ${ev.link} → ${destino}`);
    }
    expect(rotos).toEqual([]);
  });

  it("el mapa no tiene destinos que no existan en conversia-web", () => {
    const malos = Object.entries(LINK_TUBOT_A_CONVERSIA).filter(([, hacia]) => !RUTAS_CONVERSIA.has(hacia));
    expect(malos).toEqual([]);
  });
});
