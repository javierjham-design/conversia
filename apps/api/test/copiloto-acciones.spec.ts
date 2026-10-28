import { describe, it, expect } from "vitest";
import {
  COPILOT_TARGETS,
  MAX_ACTIONS_PER_TURN,
  NAVIGATE_ALLOWED,
  isNavigable,
  sanitizeActions,
} from "../src/assistant/actions";

/**
 * COP 1 — el protocolo de acciones del copiloto.
 *
 * Lo que decide el modelo termina moviendo la pantalla del dueño, así que el filtro del
 * servidor es la única garantía de que no lo mande a un 404 ni le dibuje un botón de pago
 * inventado. Estos tests prueban el filtro, no el modelo.
 */
describe("sanitizeActions — lista blanca de navegación", () => {
  it("deja pasar una ruta del panel", () => {
    expect(sanitizeActions([{ type: "navigate", to: "/cobros" }])).toEqual([{ type: "navigate", to: "/cobros" }]);
  });

  it("DESCARTA una ruta que no existe en conversia-web", () => {
    expect(sanitizeActions([{ type: "navigate", to: "/billing" }])).toEqual([]);
    expect(sanitizeActions([{ type: "navigate", to: "/settings/users" }])).toEqual([]);
  });

  it("descarta una ruta externa disfrazada de interna", () => {
    expect(sanitizeActions([{ type: "navigate", to: "//evil.example" }])).toEqual([]);
    expect(sanitizeActions([{ type: "navigate", to: "https://evil.example" }])).toEqual([]);
  });

  it("deja UNA sola navegación por turno (la primera)", () => {
    const out = sanitizeActions([
      { type: "navigate", to: "/cobros" },
      { type: "navigate", to: "/canales" },
    ]);
    expect(out).toEqual([{ type: "navigate", to: "/cobros" }]);
  });
});

describe("sanitizeActions — resaltados", () => {
  it("deja pasar un data-copilot conocido", () => {
    const out = sanitizeActions([{ type: "highlight", target: "negocio-datos", text: "Completa esto" }]);
    expect(out).toEqual([{ type: "highlight", target: "negocio-datos", text: "Completa esto" }]);
  });

  it("descarta un elemento inventado por el modelo", () => {
    expect(sanitizeActions([{ type: "highlight", target: "boton-magico", text: "Toca acá" }])).toEqual([]);
  });

  it("descarta un resaltado sin texto (un anillo sin explicación no ayuda)", () => {
    expect(sanitizeActions([{ type: "highlight", target: "plan", text: "   " }])).toEqual([]);
  });
});

describe("sanitizeActions — botones", () => {
  it("acepta los botones de pago y de WhatsApp sin payload", () => {
    const out = sanitizeActions([
      { type: "button", label: "Activar mi plan", kind: "pago" },
      { type: "button", label: "Conectar mi WhatsApp", kind: "whatsapp" },
    ]);
    expect(out.map((a) => a.type === "button" && a.kind)).toEqual(["pago", "whatsapp"]);
  });

  it("un botón INTERNO solo puede llevar a una ruta de la lista blanca", () => {
    expect(sanitizeActions([{ type: "button", label: "Ver mi agenda", kind: "interno", payload: "/agenda" }])).toHaveLength(1);
    expect(sanitizeActions([{ type: "button", label: "Ir", kind: "interno", payload: "/admin/secretos" }])).toEqual([]);
    expect(sanitizeActions([{ type: "button", label: "Ir", kind: "interno" }])).toEqual([]);
  });

  it("un botón EXTERNO solo puede ser https (nada de javascript: ni data:)", () => {
    expect(sanitizeActions([{ type: "button", label: "Ayuda", kind: "externo", payload: "https://conversia.cl/ayuda" }])).toHaveLength(1);
    expect(sanitizeActions([{ type: "button", label: "X", kind: "externo", payload: "javascript:alert(1)" }])).toEqual([]);
    expect(sanitizeActions([{ type: "button", label: "X", kind: "externo", payload: "data:text/html,<script>" }])).toEqual([]);
    expect(sanitizeActions([{ type: "button", label: "X", kind: "externo", payload: "http://conversia.cl" }])).toEqual([]);
  });
});

describe("sanitizeActions — forma del turno", () => {
  it("ignora basura y tipos desconocidos sin reventar", () => {
    expect(sanitizeActions([null, 42, "navigate", { type: "autodestruir" }, {}])).toEqual([]);
    expect(sanitizeActions("no es una lista")).toEqual([]);
    expect(sanitizeActions(undefined)).toEqual([]);
  });

  it("no repite la misma acción dos veces", () => {
    const out = sanitizeActions([{ type: "checklist_refresh" }, { type: "checklist_refresh" }]);
    expect(out).toEqual([{ type: "checklist_refresh" }]);
  });

  it("ordena: primero mover la pantalla, después señalar, celebrar y ofrecer", () => {
    const out = sanitizeActions([
      { type: "checklist_refresh" },
      { type: "button", label: "Pagar", kind: "pago" },
      { type: "highlight", target: "plan", text: "Acá" },
      { type: "navigate", to: "/cobros" },
    ]);
    expect(out.map((a) => a.type)).toEqual(["navigate", "highlight", "button", "checklist_refresh"]);
  });

  it("corta en el tope por turno (más que eso marea al dueño)", () => {
    const out = sanitizeActions([
      { type: "navigate", to: "/cobros" },
      { type: "highlight", target: "plan", text: "a" },
      { type: "celebrate", step: "pago" },
      { type: "button", label: "Pagar", kind: "pago" },
      { type: "checklist_refresh" },
    ]);
    expect(out).toHaveLength(MAX_ACTIONS_PER_TURN);
  });
});

describe("isNavigable", () => {
  it("acepta la ruta con query", () => {
    expect(isNavigable("/cobros?pago=ok")).toBe(true);
  });
  it("rechaza lo que no está en la lista", () => {
    expect(isNavigable("/no-existe")).toBe(false);
  });
});

describe("las listas blancas no quedan vacías por un refactor", () => {
  it("hay rutas y elementos definidos", () => {
    expect(NAVIGATE_ALLOWED.length).toBeGreaterThan(5);
    expect(COPILOT_TARGETS.length).toBeGreaterThan(5);
  });
  it("ninguna ruta de la lista apunta a las pantallas de TuBot", () => {
    for (const r of ["/billing", "/channels", "/agents", "/settings/users"]) {
      expect(NAVIGATE_ALLOWED as readonly string[]).not.toContain(r);
    }
  });
});
