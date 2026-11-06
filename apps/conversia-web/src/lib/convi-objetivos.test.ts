import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PANTALLA_DEL_OBJETIVO, dondeEsta } from "./convi";
import { SECCIONES } from "./nav";

/**
 * LO QUE CONVI PUEDE SEÑALAR TIENE QUE EXISTIR, Y TIENE QUE SABERSE DÓNDE ESTÁ.
 *
 * Son tres listas que hablan de lo mismo y viven en tres sitios:
 *  1. `COPILOT_TARGETS` en `apps/api/src/assistant/actions.ts` — lo único que el servidor
 *     deja salir hacia la UI.
 *  2. Los `data-copilot="…"` escritos en las pantallas — lo que de verdad se puede resaltar.
 *  3. `PANTALLA_DEL_OBJETIVO` acá — para poder DECIR dónde está cuando el resaltado falla.
 *
 * El spec del API ya ata (1) con (2). Este ata (1) con (3): si alguien suma un objetivo en
 * el servidor y no acá, Convi volvería a quedarse mudo cuando el elemento no esté en
 * pantalla, que es justo el caso que esto vino a arreglar.
 */

const RAIZ_API = join(__dirname, "..", "..", "..", "api", "src", "assistant", "actions.ts");

function objetivosDelServidor(): string[] {
  const src = readFileSync(RAIZ_API, "utf8");
  const bloque = /export const COPILOT_TARGETS = \[([\s\S]*?)\] as const;/.exec(src);
  if (!bloque) throw new Error("no se pudo leer COPILOT_TARGETS de apps/api (¿se renombró?)");
  // Sin los comentarios: cada entrada lleva al lado una explicación que también tiene
  // comillas ("tarjeta «Tu negocio» en /ajustes") y se colaba como si fuera un objetivo.
  const sinComentarios = bloque[1].replace(/\/\/[^\n]*/g, "");
  return [...sinComentarios.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function conDataCopilot(): Set<string> {
  const encontrados = new Set<string>();
  const recorrer = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) recorrer(p);
      else if (p.endsWith(".tsx")) {
        for (const m of readFileSync(p, "utf8").matchAll(/data-copilot="([^"{]+)"/g)) encontrados.add(m[1]);
      }
    }
  };
  recorrer(join(__dirname, ".."));
  return encontrados;
}

describe("los objetivos del copiloto", () => {
  it("la lista del servidor se puede leer (si no, este test no estaría probando nada)", () => {
    expect(objetivosDelServidor().length).toBeGreaterThan(5);
  });

  it("de TODOS los que el servidor puede mandar sabemos en qué pantalla están", () => {
    const faltan = objetivosDelServidor().filter((t) => !PANTALLA_DEL_OBJETIVO[t]);
    expect(faltan, `sin pantalla conocida en PANTALLA_DEL_OBJETIVO: ${faltan.join(", ")}`).toEqual([]);
  });

  it("y de todos sabemos decir el nombre de esa pantalla", () => {
    for (const t of objetivosDelServidor()) {
      expect(dondeEsta(t), `${t} no resuelve a una sección del menú`).toBeTruthy();
    }
  });

  it("cada pantalla del mapa es una ruta real del menú", () => {
    const rutas = new Set([...SECCIONES.map((s) => s.href), ...SECCIONES.flatMap((s) => (s.pestanas ?? []).map((p) => p.href))]);
    for (const [objetivo, ruta] of Object.entries(PANTALLA_DEL_OBJETIVO)) {
      expect(rutas.has(ruta), `${objetivo} apunta a ${ruta}, que no está en lib/nav.ts`).toBe(true);
    }
  });

  it("el mapa no promete señalar algo que no está marcado en ninguna pantalla", () => {
    // Al revés del test anterior: una entrada de más acá sería una promesa falsa.
    const marcados = conDataCopilot();
    const fantasmas = Object.keys(PANTALLA_DEL_OBJETIVO).filter((t) => !marcados.has(t));
    expect(fantasmas, `no existen como data-copilot en el código: ${fantasmas.join(", ")}`).toEqual([]);
  });
});
