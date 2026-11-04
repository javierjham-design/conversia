import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * M0 — GUARDIÁN de las afirmaciones que el dueño prohibió.
 *
 * Son textos, así que ningún test de comportamiento los iba a atrapar: vuelven solos en el
 * primer copy-paste de una landing vieja o de un anuncio. Y el costo no es estético — "el más
 * barato de Chile" o "el más elegido" son afirmaciones sobre el mercado que no podemos
 * sostener, y "cancelas cuando quieras" era falso mientras no existiera el botón.
 *
 * Escanea solo las páginas PÚBLICAS: la portada, el generador, el registro, las páginas de
 * rubro que llegan en M2, los precios y los documentos legales. El panel queda afuera a
 * propósito, porque ahí hay textos de producto (el medidor dice "por conversación" con razón).
 */

const RAIZ = resolve(__dirname, "..");

/** Páginas que ve alguien que llegó por un anuncio. */
const PUBLICAS = [
  "app/page.tsx",
  // El TEXTO de la portada vive acá: `app/page.tsx` quedó como componente de servidor (lee el
  // catálogo para que el precio salga ya en el HTML) y no tiene una sola frase. Sin esta línea
  // el escáner seguiría "verde" vigilando un cascarón de seis líneas.
  "app/landing.tsx",
  "app/crear/page.tsx",
  "app/registro/page.tsx",
  "app/legal/page.tsx",
  "app/legal/terminos/page.tsx",
  "app/legal/privacidad/page.tsx",
  // M2 las agrega; mientras no existan se saltan solas.
  "app/precios/page.tsx",
  "app/barberias/page.tsx",
  "app/dental/page.tsx",
  "app/estetica/page.tsx",
  "app/kinesiologia/page.tsx",
];

function existe(rel: string): boolean {
  try {
    return statSync(resolve(RAIZ, rel)).isFile();
  } catch {
    return false;
  }
}

/** El texto de una página SIN sus comentarios: un comentario que nombra la frase prohibida
 *  para explicar por qué se quitó no puede hacer fallar el guardián. */
function textoVisible(rel: string): string {
  const src = readFileSync(resolve(RAIZ, rel), "utf8");
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ") // {/* comentario JSX */}
    .replace(/\/\*[\s\S]*?\*\//g, " ") //            /* comentario */
    // `[^\n]*` y no `.*$`: el repo guarda estos archivos con CRLF y `$` en modo multilínea no
    // matchea después del `\r`, así que con `.*$` los comentarios de línea NO se borraban —
    // y este mismo guardián fallaba por los comentarios que explican las frases que quitó.
    .replace(/^[ \t]*\/\/[^\n]*/gm, " "); //          // comentario de línea
}

const paginas = PUBLICAS.filter(existe).map((rel) => ({ rel, texto: textoVisible(rel) }));

/** Cada regla: qué se busca y POR QUÉ no se puede decir. */
const PROHIBIDAS: Array<{ nombre: string; re: RegExp; porque: string }> = [
  { nombre: "el más barato de Chile", re: /m[áa]s\s+barat[oa]\s+de\s+chile/i, porque: "afirmación sobre el mercado que no podemos comprobar" },
  { nombre: "sin planes mensuales", re: /sin\s+planes\s+mensuales/i, porque: "falso: el plan Base ES mensual" },
  { nombre: "el más elegido", re: /m[áa]s\s+elegid[oa]/i, porque: "afirmación de popularidad sin dato detrás" },
  { nombre: "30 conversaciones (escrito a mano)", re: /\b30\s+conversaciones/i, porque: "el regalo sale del catálogo activo, no de un número fijo" },
  { nombre: "precio viejo $18.900", re: /18[.,]900/, porque: "el precio sale del catálogo activo" },
  { nombre: "IA que no inventa (absoluto)", re: /(IA|asistente)\s+que\s+no\s+inventa|no\s+inventa\b(?!r)/i, porque: "ninguna IA puede garantizarlo; se dice de dónde saca la información" },
];

describe("las páginas públicas no usan las frases prohibidas", () => {
  it("hay páginas que escanear (si esto falla, el escáner quedó apuntando a la nada)", () => {
    expect(paginas.length).toBeGreaterThan(0);
    expect(paginas.map((p) => p.rel)).toContain("app/page.tsx");
    // La portada es la página del embudo: si su texto se mudó de archivo y nadie actualizó
    // esta lista, el escáner deja de vigilar justo lo que más se edita.
    expect(paginas.map((p) => p.rel)).toContain("app/landing.tsx");
    const portada = paginas.find((p) => p.rel === "app/landing.tsx")!.texto;
    expect(portada.length, "el texto de la portada no puede haber quedado vacío").toBeGreaterThan(5_000);
  });

  for (const regla of PROHIBIDAS) {
    it(`no dice "${regla.nombre}" — ${regla.porque}`, () => {
      const culpables = paginas.filter((p) => regla.re.test(p.texto)).map((p) => p.rel);
      expect(culpables, `aparece en: ${culpables.join(", ")}`).toEqual([]);
    });
  }
});

describe("\"cancelas cuando quieras\" exige que exista el botón de cancelar", () => {
  /**
   * La regla del dueño: esa frase solo se puede usar cuando el panel tenga el botón. Hoy el
   * endpoint existe en la api pero NINGUNA pantalla lo llama, así que la frase sería falsa.
   * Este test se cae el día que M3 publique el botón, y ahí hay que venir y permitir la frase
   * — a propósito: el recordatorio tiene que ser imposible de pasar por alto.
   */
  const hayBoton = (() => {
    const dirs = ["app/cobros", "components"];
    for (const d of dirs) {
      try {
        for (const f of readdirSync(resolve(RAIZ, d))) {
          const p = resolve(RAIZ, d, f);
          if (!statSync(p).isFile()) continue;
          if (/subscription\/cancel/.test(readFileSync(p, "utf8"))) return true;
        }
      } catch {
        /* la carpeta puede no existir */
      }
    }
    return false;
  })();

  it("mientras el botón no exista, ninguna página pública promete cancelar desde el panel", () => {
    if (hayBoton) {
      expect(hayBoton, "¡llegó el botón de cancelar (M3)! Ya se puede decir 'cancelas cuando quieras' y 'cancelas desde el panel': actualiza este test y los textos.").toBe(false);
      return;
    }
    const culpables = paginas
      .filter((p) => /cancela(s|r)?\s+(cuando\s+quieras|desde\s+el\s+panel)/i.test(p.texto))
      .map((p) => p.rel);
    expect(culpables, `promete cancelar desde el panel sin que el botón exista: ${culpables.join(", ")}`).toEqual([]);
  });
});

describe("la política de privacidad declara lo que la medición de M1 va a hacer", () => {
  const privacidad = paginas.find((p) => p.rel === "app/legal/privacidad/page.tsx")?.texto ?? "";

  it("existe y nombra el Pixel, la Conversions API y las cookies de Meta", () => {
    expect(privacidad).not.toBe("");
    expect(privacidad).toMatch(/Pixel de Meta/);
    expect(privacidad).toMatch(/Conversions API/);
    expect(privacidad).toMatch(/_fbp/);
    expect(privacidad).toMatch(/_fbc/);
  });

  it("dice cuánto duran y cómo oponerse", () => {
    expect(privacidad).toMatch(/90 d[íi]as/);
    expect(privacidad).toMatch(/Solo necesarias/);
  });

  it("explica el uso del WhatsApp del registro y que se acepta con una casilla", () => {
    expect(privacidad).toMatch(/casilla/);
    expect(privacidad).toMatch(/revocarlo|revocar/);
  });

  it("mantiene la sección de Google con la declaración de uso limitado", () => {
    // La verificación de la app de Google apunta a esta ancla: si se cae, se cae el trámite.
    expect(privacidad).toMatch(/id="google"/);
    expect(privacidad).toMatch(/Limited Use/);
  });

  it("conserva el ancla de cookies a la que apunta el aviso", () => {
    expect(privacidad).toMatch(/id="cookies"/);
  });
});
