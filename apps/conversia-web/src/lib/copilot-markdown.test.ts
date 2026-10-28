import { describe, it, expect } from "vitest";
import { parseBlocks, parseInline } from "./copilot-markdown";

/**
 * COP 1 — el markdown del copiloto. El texto lo escribe un modelo de lenguaje, así que el
 * punto de estos tests es doble: que el énfasis se vea (antes se aplanaba y "te falta
 * **conectar tu WhatsApp**" perdía justo la parte accionable) y que NADA de lo que diga el
 * modelo pueda convertirse en un enlace a un destino que no sea el propio panel.
 */
describe("énfasis, código y texto", () => {
  it("las negritas se vuelven énfasis, no asteriscos a la vista", () => {
    expect(parseInline("te falta **conectar tu WhatsApp** hoy")).toEqual([
      { kind: "text", text: "te falta " },
      { kind: "bold", text: "conectar tu WhatsApp" },
      { kind: "text", text: " hoy" },
    ]);
  });

  it("un asterisco suelto se queda como texto", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ kind: "text", text: "2 * 3 = 6" }]);
  });

  it("el código entre comillas invertidas se marca", () => {
    expect(parseInline("usa `/cobros`")).toEqual([
      { kind: "text", text: "usa " },
      { kind: "code", text: "/cobros" },
    ]);
  });

  it("texto sin marcas queda en un solo token", () => {
    expect(parseInline("hola")).toEqual([{ kind: "text", text: "hola" }]);
  });

  it("no emite tokens de texto vacíos", () => {
    expect(parseInline("**todo**")).toEqual([{ kind: "bold", text: "todo" }]);
  });
});

describe("enlaces: solo el propio panel", () => {
  it("una ruta interna se vuelve enlace", () => {
    expect(parseInline("anda a [tus cobros](/cobros)")).toEqual([
      { kind: "text", text: "anda a " },
      { kind: "link", text: "tus cobros", href: "/cobros" },
    ]);
  });

  it("acepta la query de la ruta", () => {
    const t = parseInline("[acá](/cobros?pago=ok)");
    expect(t).toEqual([{ kind: "link", text: "acá", href: "/cobros?pago=ok" }]);
  });

  it("un enlace EXTERNO se queda como texto literal, no como enlace", () => {
    expect(parseInline("mira [esto](https://evil.example)")).toEqual([
      { kind: "text", text: "mira " },
      { kind: "text", text: "[esto](https://evil.example)" },
    ]);
  });

  it("javascript: y data: tampoco llegan a ser enlace", () => {
    for (const mal of ["javascript:alert(1)", "data:text/html,<script>", "//evil.example", "vbscript:x"]) {
      const t = parseInline(`[x](${mal})`);
      expect(t.every((x) => x.kind === "text"), mal).toBe(true);
    }
  });

  it("un enlace relativo sin barra inicial tampoco pasa", () => {
    expect(parseInline("[x](cobros)").every((t) => t.kind === "text")).toBe(true);
  });
});

describe("bloques", () => {
  it("separa párrafos", () => {
    const b = parseBlocks("primero\n\nsegundo");
    expect(b.map((x) => x.kind)).toEqual(["paragraph", "space", "paragraph"]);
  });

  it("agrupa los guiones en una sola lista", () => {
    const b = parseBlocks("te falta:\n- el rubro\n- el horario");
    expect(b.map((x) => x.kind)).toEqual(["paragraph", "list"]);
    expect(b[1].kind === "list" && b[1].items).toHaveLength(2);
  });

  it("una lista corta cuando vuelve el texto normal", () => {
    const b = parseBlocks("- uno\n- dos\ny eso es todo");
    expect(b.map((x) => x.kind)).toEqual(["list", "paragraph"]);
  });

  it("las marcas funcionan dentro de los ítems de la lista", () => {
    const b = parseBlocks("- falta **el rubro**");
    expect(b[0].kind === "list" && b[0].items[0]).toEqual([
      { kind: "text", text: "falta " },
      { kind: "bold", text: "el rubro" },
    ]);
  });

  it("un texto vacío no revienta", () => {
    expect(parseBlocks("")).toEqual([{ kind: "space" }]);
  });
});
