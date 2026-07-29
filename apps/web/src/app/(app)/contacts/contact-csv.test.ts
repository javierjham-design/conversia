import { describe, expect, it } from "vitest";
import { guessField, parseCSV } from "./contact-csv";

describe("parseCSV", () => {
  it("parsea cabeceras y filas separadas por coma", () => {
    const { headers, rows } = parseCSV("nombre,telefono\nAna,+56911111111\nLuis,+56922222222");
    expect(headers).toEqual(["nombre", "telefono"]);
    expect(rows).toEqual([
      ["Ana", "+56911111111"],
      ["Luis", "+56922222222"],
    ]);
  });

  it("detecta el separador ; y respeta comillas con comas internas", () => {
    const { headers, rows } = parseCSV('nombre;nota\n"Ana, la jefa";"dijo ""hola"""');
    expect(headers).toEqual(["nombre", "nota"]);
    expect(rows[0]).toEqual(["Ana, la jefa", 'dijo "hola"']);
  });

  it("descarta filas totalmente vacías", () => {
    const { rows } = parseCSV("nombre,telefono\nAna,+569\n\n,\nLuis,+560");
    expect(rows).toEqual([
      ["Ana", "+569"],
      ["Luis", "+560"],
    ]);
  });

  it("tolera CRLF y una última fila sin salto final", () => {
    const { rows } = parseCSV("a,b\r\n1,2\r\n3,4");
    expect(rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });
});

describe("guessField", () => {
  it("mapea cabeceras comunes a campos destino", () => {
    expect(guessField("Nombre")).toBe("firstName");
    expect(guessField("Apellido")).toBe("lastName");
    expect(guessField("Teléfono")).toBe("phone");
    expect(guessField("Celular")).toBe("phone");
    expect(guessField("Correo")).toBe("email");
    expect(guessField("País")).toBe("country");
    expect(guessField("Etiquetas")).toBe("tags");
    expect(guessField("columna_rara")).toBe("");
  });
});
