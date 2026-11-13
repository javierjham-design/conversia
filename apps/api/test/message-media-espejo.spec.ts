import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MessageMediaSchema, MessageMediaKindSchema } from "@conversia/types";

/**
 * EL ESPEJO DE `MessageMedia` EN conversia-web NO SE PUEDE DESINCRONIZAR.
 *
 * `conversia-web` no depende de ningún paquete del monorepo: es una app Next independiente
 * con su propio Dockerfile, igual que el panel de TuBot. Por eso el tipo está COPIADO en
 * `apps/conversia-web/src/lib/message-media.ts` (mismo patrón que ya usaba `copilot-actions`).
 *
 * Una copia sin guardián es una mentira esperando a que alguien agregue un campo de un lado.
 * Este test vive en la suite de la API porque es el único lugar que puede ver las dos cosas:
 * el esquema zod de verdad y el archivo del panel.
 */

const ESPEJO = resolve(__dirname, "../../conversia-web/src/lib/message-media.ts");

function campos(src: string): string[] {
  const i = src.indexOf("export interface MessageMedia {");
  expect(i, "no encontré la interfaz en el espejo").toBeGreaterThan(-1);
  const cuerpo = src.slice(i, src.indexOf("\n}", i));
  return [...cuerpo.matchAll(/^\s{2}(\w+)\s*:/gm)].map((m) => m[1]).sort();
}

describe("el espejo de MessageMedia sigue al contrato", () => {
  const src = readFileSync(ESPEJO, "utf-8");

  it("tiene EXACTAMENTE los mismos campos que el esquema zod", () => {
    const delEsquema = Object.keys(MessageMediaSchema.shape).sort();
    expect(campos(src)).toEqual(delEsquema);
  });

  it("tiene los mismos valores de kind", () => {
    for (const k of MessageMediaKindSchema.options) {
      expect(src, `falta el kind "${k}" en el espejo`).toContain(`"${k}"`);
    }
  });

  it("dice dónde vive el contrato de verdad, para quien lo lea primero", () => {
    expect(src).toContain("@conversia/types");
  });
});
