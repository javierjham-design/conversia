import { describe, it, expect } from "vitest";
import { digestDeTurno, resumirResultado } from "../src/assistant/assistant.service";

/**
 * E1 — EL HISTORIAL Y EL CONTEXTO NO SE PIERDEN.
 *
 * Tres defectos distintos que se sentían como uno solo («Convi se olvida»):
 *  1. `mensajes` devolvía los 50 mensajes MÁS ANTIGUOS. Pasados ~25 turnos, al reabrir se veía
 *     el principio de la conversación y nunca lo último.
 *  2. El widget tomaba «el primer hilo abierto» de una lista que, para un dueño, traía los
 *     hilos de TODA la organización — podía ser el de otro usuario.
 *  3. Lo que Convi CONSULTABA no se guardaba, así que al retomar rediagnosticaba desde cero.
 */

describe("la memoria de herramientas (toolDigest)", () => {
  it("junta lo consultado del turno en una línea", () => {
    expect(digestDeTurno(["estadoDeCuenta → vencida", "verEstado → saldo 0"])).toBe(
      "estadoDeCuenta → vencida · verEstado → saldo 0",
    );
  });

  it("un turno SIN tools no guarda nada (null, no una cadena vacía)", () => {
    expect(digestDeTurno([])).toBeNull();
  });

  it("se recorta: es una PISTA para el modelo, no el resultado entero", () => {
    const largo = Array.from({ length: 50 }, (_, i) => `tool${i} → un resultado bastante largo`);
    const d = digestDeTurno(largo)!;
    expect(d.length).toBeLessThanOrEqual(300);
    expect(d.endsWith("…")).toBe(true);
  });

  it("respeta un tope distinto si se lo pasan", () => {
    expect(digestDeTurno(["a".repeat(100)], 20)!.length).toBe(20);
  });
});

describe("el resumen de un resultado de tool", () => {
  it("colapsa espacios y saltos: tiene que caber en una línea", () => {
    expect(resumirResultado('{\n  "saldo": 0,\n  "plan": "Base"\n}')).toBe('{ "saldo": 0, "plan": "Base" }');
  });

  it("un error se marca COMO error (si no, el modelo lo lee como un dato bueno)", () => {
    const r = resumirResultado("No se pudo conectar con Meta", true);
    expect(r.startsWith("error:")).toBe(true);
  });

  it("lo muy largo se corta con puntos suspensivos", () => {
    const r = resumirResultado("x".repeat(500));
    expect(r.length).toBeLessThanOrEqual(121);
    expect(r.endsWith("…")).toBe(true);
  });

  it("vacío no genera una línea de memoria mentirosa", () => {
    expect(resumirResultado("")).toBe("sin datos");
    expect(resumirResultado("   ")).toBe("sin datos");
  });
});

describe("el contrato de paginación hacia atrás", () => {
  /**
   * `mensajes` es un método de servicio con Prisma; acá se prueba la REGLA que lo gobierna con
   * un doble, porque lo que importa no es la consulta sino cuál de las dos puntas devuelve.
   */
  function paginar(todos: Array<{ id: string; createdAt: Date }>, porPagina: number, antesDe?: Date) {
    const filtrados = antesDe ? todos.filter((m) => m.createdAt < antesDe) : todos;
    const desc = [...filtrados].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const recorte = desc.slice(0, porPagina);
    const pagina = [...recorte].reverse();
    const hayMas = desc.length > porPagina;
    return { messages: pagina, anteriores: hayMas && pagina.length ? pagina[0].createdAt.toISOString() : null };
  }

  const todos = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, createdAt: new Date(2026, 10, 1, 0, i) }));

  it("sin cursor devuelve los ÚLTIMOS, no los primeros", () => {
    const r = paginar(todos, 50);
    expect(r.messages[r.messages.length - 1].id).toBe("m119");
    expect(r.messages[0].id).toBe("m70");
  });

  it("vienen en orden cronológico, que es como se lee un chat", () => {
    const r = paginar(todos, 50);
    const fechas = r.messages.map((m) => m.createdAt.getTime());
    expect(fechas).toEqual([...fechas].sort((a, b) => a - b));
  });

  it("el cursor `anteriores` trae la página de MÁS ATRÁS", () => {
    const p1 = paginar(todos, 50);
    const p2 = paginar(todos, 50, new Date(p1.anteriores!));
    expect(p2.messages[p2.messages.length - 1].id).toBe("m69");
    expect(p2.messages[0].id).toBe("m20");
  });

  it("al llegar al principio ya no ofrece más", () => {
    const p1 = paginar(todos, 50);
    const p2 = paginar(todos, 50, new Date(p1.anteriores!));
    const p3 = paginar(todos, 50, new Date(p2.anteriores!));
    expect(p3.messages[0].id).toBe("m0");
    expect(p3.anteriores).toBeNull();
  });

  it("un hilo corto cabe entero y no ofrece anteriores", () => {
    const r = paginar(todos.slice(0, 10), 50);
    expect(r.messages).toHaveLength(10);
    expect(r.anteriores).toBeNull();
  });
});

describe("de quién son los hilos", () => {
  /** La regla de `listar`: un admin ve todo, salvo que pida los suyos. */
  const verTodos = (esAdmin: boolean, soloMios?: boolean) => esAdmin && !soloMios;

  it("un usuario normal SIEMPRE ve solo los suyos", () => {
    expect(verTodos(false)).toBe(false);
    expect(verTodos(false, true)).toBe(false);
  });

  it("un administrador ve los de toda la organización en el historial", () => {
    expect(verTodos(true)).toBe(true);
  });

  it("…pero con `mine` ve solo los suyos: es lo que pide el widget para RETOMAR", () => {
    // Sin esto, el dueño retomaba «el primer hilo abierto» de la lista, que podía ser de otro
    // usuario; al escribir daba 404 y el widget decía «no está disponible en esta cuenta».
    expect(verTodos(true, true)).toBe(false);
  });
});
