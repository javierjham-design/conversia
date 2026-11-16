import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * D5 — PARIDAD DE TIPOS EN EL PANEL DE TuBot.
 *
 * El hilo de TuBot dibujaba audio, imagen y documento, y TODO lo demás caía al `<p>` final
 * con el body crudo. Con D1 el worker empieza a guardar STICKER, VIDEO, LOCATION y CONTACTS
 * de verdad, así que sin esto el panel mostraría "Sticker" como texto plano.
 *
 * Esto se verifica leyendo el archivo porque no hay React Testing Library en el repo y montar
 * el hilo entero requiere sesión, SSE y backend. Lo que importa no es el render exacto: es que
 * ningún tipo quede sin rama, que es lo que pasó durante dos años.
 */
const RUTA = resolve(__dirname, "thread.tsx");
const src = readFileSync(RUTA, "utf-8");

describe("el switch del hilo cubre todos los tipos con medio", () => {
  for (const tipo of ["AUDIO", "IMAGE", "DOCUMENT", "STICKER", "VIDEO", "LOCATION", "CONTACTS"]) {
    it(`${tipo} tiene su rama`, () => {
      expect(src).toContain(`m.type === "${tipo}"`);
    });
  }

  it("los tipos nuevos tienen componente propio, no un <p> con el body", () => {
    for (const comp of ["StickerBubble", "VideoBubble", "LocationBubble", "ContactsBubble"]) {
      expect(src, `falta ${comp}`).toContain(`function ${comp}(`);
    }
  });
});

describe("usa el `media` de la API pero NO depende de él", () => {
  it("cae al payload crudo cuando `media` no viene (panel nuevo contra API vieja)", () => {
    expect(src).toMatch(/media\?\.location \|\| payload\.location/);
    expect(src).toMatch(/media\?\.location\?\.lat \?\? Number\(payload\.location\?\.latitude\)/);
  });
});

describe("lo que ya funcionaba no se toca (la regla de la tanda: TuBot es aditivo)", () => {
  it("audio, imagen y documento conservan sus componentes de siempre", () => {
    for (const comp of ["AudioBubble", "ImageBubble", "DocumentBubble"]) {
      expect(src).toContain(`function ${comp}(`);
    }
  });

  it("fixStreamedDuration SIGUE ahí: quitarlo exige comprobarlo en staging", () => {
    expect(src).toContain("function fixStreamedDuration(");
    expect(src).toMatch(/D5\.b — SE QUEDA/);
  });
});
