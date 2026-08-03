import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./exports";

/** El CSV de exports debe sobrevivir comillas, comas y saltos de línea (Excel). */
describe("exports CSV", () => {
  it("escapa comillas, comas y saltos de línea", () => {
    expect(csvCell('dijo "hola"')).toBe('"dijo ""hola"""');
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("línea1\nlínea2")).toBe('"línea1\nlínea2"');
    expect(csvCell(null)).toBe("");
  });

  it("arma el archivo con encabezados y filas", () => {
    const csv = toCsv(["nombre", "telefono"], [["María", "+5691111"], ['Pedro "PJ"', null]]);
    expect(csv.split("\n")[0]).toBe("nombre,telefono");
    expect(csv).toContain('"Pedro ""PJ""",');
  });
});
