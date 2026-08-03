import { describe, expect, it } from "vitest";
import { buildTemplateCsv, guessField, parseCSV, TEMPLATE_BASE_HEADERS } from "./contact-csv";

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

describe("plantilla CSV de import (round-trip)", () => {
  const customFields = [{ key: "prevision", label: "Previsión" }];

  it("la plantilla descargada se parsea tal cual (separador ,)", () => {
    const csv = buildTemplateCsv(customFields);
    const { headers, rows } = parseCSV(csv);
    expect(headers).toEqual([...TEMPLATE_BASE_HEADERS, "prevision"]);
    expect(rows).toHaveLength(2);
    expect(rows[0][0]).toBe("+56 9 1234 5678");
    expect(rows[0][5]).toBe("interesado|ortodoncia");
  });

  it("round-trip con ; (Excel Chile re-exporta con punto y coma)", () => {
    const csv = buildTemplateCsv(customFields);
    const excelStyle = parseCSV(csv); // parse original
    const reexported =
      "﻿" +
      [excelStyle.headers, ...excelStyle.rows]
        .map((r) => r.map((c) => (/[;"]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c)).join(";"))
        .join("\n");
    const { headers, rows } = parseCSV(reexported);
    expect(headers).toEqual([...TEMPLATE_BASE_HEADERS, "prevision"]);
    expect(rows[1][1]).toBe("Pedro");
  });

  it("empieza con BOM (tildes en Excel) y las cabeceras se mapean solas", () => {
    const csv = buildTemplateCsv([]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(guessField("telefono")).toBe("phone");
    expect(guessField("etapa")).toBe("stage");
    expect(guessField("etiquetas")).toBe("tags");
  });
});
