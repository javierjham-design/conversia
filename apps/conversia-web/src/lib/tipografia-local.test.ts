import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * La tipografía de la marca se sirve desde ARCHIVOS DEL REPO, no pidiéndosela a Google en
 * cada build.
 *
 * `next/font/google` descarga y parsea el CSS de Google DURANTE el build. Cuando esa
 * respuesta no viene como el loader espera, el build muere con un `TypeError: Cannot read
 * properties of null (reading '1')` que no tiene ninguna relación con el código que se
 * cambió. Era el flake que obligaba a re-lanzar el job `build` cada varios PRs: un verde
 * que en realidad era una moneda al aire, justo en el check obligatorio que decide si algo
 * se puede mergear.
 *
 * Volver a `next/font/google` reintroduce esa dependencia de red sin que nada más se rompa
 * —el build sigue auto-hospedando las fuentes, así que en el navegador no se nota—, y por
 * eso el guardián tiene que mirar el CÓDIGO. Que las fuentes carguen de verdad lo prueba
 * `e2e/pwa.spec.ts` en un navegador real.
 */

const RAIZ = join(__dirname, "..", "..");
const LAYOUT = join(RAIZ, "src", "app", "layout.tsx");
const FUENTES = [
  "src/app/fonts/fraunces-latin-variable.woff2",
  "src/app/fonts/fraunces-latin-variable-italic.woff2",
  "src/app/fonts/inter-latin-variable.woff2",
];

describe("tipografía servida desde el repo", () => {
  const layout = readFileSync(LAYOUT, "utf8");

  it("el layout NO pide las fuentes a Google en build", () => {
    // Se busca el IMPORT, no la mención: el comentario del propio layout explica por qué no
    // se usa `next/font/google`, y un guardián que se cae por su propia explicación se borra.
    expect(layout).not.toMatch(/from\s+["']next\/font\/google["']/);
  });

  it("usa next/font/local y declara las dos familias de la marca", () => {
    expect(layout).toMatch(/from\s+["']next\/font\/local["']/);
    expect(layout).toContain("--font-fraunces");
    expect(layout).toContain("--font-inter");
  });

  it("los tres archivos woff2 existen y son fuentes de verdad", () => {
    for (const f of FUENTES) {
      const p = join(RAIZ, f);
      expect(existsSync(p), `falta ${f}`).toBe(true);
      // Un woff2 arranca con la firma "wOF2"; un archivo truncado o un HTML de error no.
      const cabecera = readFileSync(p).subarray(0, 4).toString("latin1");
      expect(cabecera, `${f} no es un woff2`).toBe("wOF2");
      expect(statSync(p).size, `${f} sospechosamente chico`).toBeGreaterThan(10_000);
    }
  });

  it("el layout apunta a esos archivos (y no a rutas que no existen)", () => {
    for (const f of FUENTES) {
      const nombre = f.split("/").pop()!;
      expect(layout, `el layout no referencia ${nombre}`).toContain(nombre);
    }
  });

  it("conserva el ajuste de fallback por métricas (Fraunces serif, Inter sans)", () => {
    // Sin esto el titular —que es el elemento LCP y carga con display:"optional"— pinta con
    // un fallback de métricas distintas y el texto SALTA al cambiar de fuente.
    expect(layout).toContain('adjustFontFallback: "Times New Roman"');
    expect(layout).toContain('adjustFontFallback: "Arial"');
  });
});
