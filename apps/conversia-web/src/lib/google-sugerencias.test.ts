import { describe, expect, it } from "vitest";
import { normalizar, sugerirCalendario, sugerirParaEquipo } from "./google-sugerencias";

/**
 * ETAPA 4 — las sugerencias del asistente de 1 paso.
 *
 * Es la única parte de la pantalla con criterio, y de ella depende que el dueño de una
 * barbería pueda activar la sincronización sin entender qué es un calendario. Si la
 * sugerencia es buena, solo aprieta "Activar sincronización".
 */

const PRINCIPAL = { id: "local@gmail.com", name: "Local", primary: true };
const A = { id: "barberoa@gmail.com", name: "Barbero A", primary: false };
const B = { id: "ana.perez@gmail.com", name: "Ana Pérez", primary: false };
const OPCIONES = [PRINCIPAL, A, B];

describe("normalizar", () => {
  it("saca tildes, mayúsculas y puntuación", () => {
    expect(normalizar("Ana Pérez")).toBe("ana perez");
    expect(normalizar("ANA.PEREZ@gmail.com")).toBe("ana perez gmail com");
    expect(normalizar("")).toBe("");
  });
});

describe("sugerirCalendario", () => {
  it("coincide por CORREO exacto", () => {
    expect(sugerirCalendario({ id: "p1", name: "Quien sea", email: "ana.perez@gmail.com" }, OPCIONES)).toBe("ana.perez@gmail.com");
  });

  it("coincide por NOMBRE con el nombre del calendario", () => {
    expect(sugerirCalendario({ id: "p1", name: "Ana Pérez" }, OPCIONES)).toBe("ana.perez@gmail.com");
  });

  it("coincide por nombre contra el CORREO del calendario", () => {
    expect(sugerirCalendario({ id: "p1", name: "Ana" }, OPCIONES)).toBe("ana.perez@gmail.com");
  });

  it("ignora títulos y partículas al comparar", () => {
    // "Dra. Ana Pérez" tiene que calzar con "Ana Pérez"; si "dra" contara como palabra,
    // podría calzar con cualquier calendario que la contenga.
    expect(sugerirCalendario({ id: "p1", name: "Dra. Ana Pérez" }, OPCIONES)).toBe("ana.perez@gmail.com");
  });

  it("sin coincidencia cae al calendario PRINCIPAL", () => {
    expect(sugerirCalendario({ id: "p1", name: "Box 3" }, OPCIONES)).toBe("local@gmail.com");
  });

  it("no le da a dos profesionales el MISMO calendario propio", () => {
    // Es justo lo que esta etapa viene a resolver: dos barberos en un calendario.
    const tomados = new Set(["ana.perez@gmail.com"]);
    expect(sugerirCalendario({ id: "p2", name: "Ana Pérez" }, OPCIONES, tomados)).toBe("local@gmail.com");
  });

  it("el principal SÍ se puede repetir: es el calendario del negocio", () => {
    const tomados = new Set(["local@gmail.com"]);
    expect(sugerirCalendario({ id: "p2", name: "Box 1" }, OPCIONES, tomados)).toBe("local@gmail.com");
  });

  it("sin calendarios no sugiere nada", () => {
    expect(sugerirCalendario({ id: "p1", name: "Ana" }, [])).toBe("");
  });

  it("sin principal y sin coincidencia, no inventa", () => {
    expect(sugerirCalendario({ id: "p1", name: "Box 3" }, [A, B])).toBe("");
  });

  it("un nombre de una sola letra no calza con todo", () => {
    // Con palabras de 1-2 letras, un "Al" calzaría con "local@gmail.com" y le daríamos el
    // calendario del negocio como si fuera el suyo.
    expect(sugerirCalendario({ id: "p1", name: "Al" }, OPCIONES)).toBe("local@gmail.com");
  });
});

describe("sugerirParaEquipo", () => {
  it("con UN profesional le asigna el principal (el caso de la mayoría)", () => {
    expect(sugerirParaEquipo([{ id: "p1", name: "Javier" }], OPCIONES)).toEqual({ p1: "local@gmail.com" });
  });

  it("con varios, reparte sin repetir", () => {
    const r = sugerirParaEquipo(
      [
        { id: "p1", name: "Barbero A" },
        { id: "p2", name: "Ana Pérez" },
        { id: "p3", name: "Box 1" },
      ],
      OPCIONES,
    );
    expect(r).toEqual({ p1: "barberoa@gmail.com", p2: "ana.perez@gmail.com", p3: "local@gmail.com" });
  });

  it("dos profesionales con el mismo nombre no comparten calendario propio", () => {
    const r = sugerirParaEquipo(
      [
        { id: "p1", name: "Ana Pérez" },
        { id: "p2", name: "Ana Pérez" },
      ],
      OPCIONES,
    );
    expect(r.p1).toBe("ana.perez@gmail.com");
    expect(r.p2).toBe("local@gmail.com");
  });

  it("equipo vacío, sugerencias vacías", () => {
    expect(sugerirParaEquipo([], OPCIONES)).toEqual({});
  });
});
