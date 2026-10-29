import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * La tipografía de TuBot se sirve desde ARCHIVOS DEL REPO, no pidiéndosela a Google en
 * cada build.
 *
 * `next/font/google` descarga y parsea el CSS de Google DURANTE el build. Cuando esa
 * respuesta no viene como el loader espera, el build muere con un `TypeError: Cannot read
 * properties of null (reading '1')` que no tiene ninguna relación con el código que se
 * cambió. El 29-oct-2026 ese flake tumbó `e2e-robustness` —un check OBLIGATORIO— en un PR
 * que solo tocaba documentos: un build que sale a internet convierte cada merge en una
 * moneda al aire. conversia-web ya lo había cerrado en #569 con el mismo patrón.
 *
 * Volver a `next/font/google` reintroduce esa dependencia de red sin que nada más se rompa
 * —el build sigue auto-hospedando las fuentes, así que en el navegador no se nota—, y por
 * eso el guardián tiene que mirar el CÓDIGO.
 */

const RAIZ = join(__dirname, "..", "..");
const LAYOUT = join(RAIZ, "src", "app", "layout.tsx");
const FUENTES = ["src/app/fonts/inter-latin-variable.woff2", "src/app/fonts/sora-latin-variable.woff2"];

describe("tipografía de TuBot servida desde el repo", () => {
  const layout = readFileSync(LAYOUT, "utf8");

  it("el layout NO pide las fuentes a Google en build", () => {
    // Se busca el IMPORT, no la mención: el comentario del propio layout explica por qué no
    // se usa `next/font/google`, y un guardián que se cae por su propia explicación se borra.
    expect(layout).not.toMatch(/from\s+["']next\/font\/google["']/);
  });

  it("usa next/font/local y conserva las dos variables CSS que usa el design system", () => {
    expect(layout).toMatch(/from\s+["']next\/font\/local["']/);
    expect(layout).toContain("--font-sans");
    expect(layout).toContain("--font-display");
  });

  it("los dos archivos woff2 existen y son fuentes de verdad", () => {
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

  it("conserva el ajuste de fallback por métricas", () => {
    // Con fuentes locales Next no puede deducir la familia del fallback: sin esto el texto
    // SALTA al cambiar de la fuente de respaldo a la real. Las dos son sans → Arial.
    expect(layout.match(/adjustFontFallback: "Arial"/g) ?? []).toHaveLength(2);
  });
});
