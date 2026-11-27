import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardián: los logos de las redes se pintan CON SU COLOR, no con el del panel.
 *
 * El problema que vino a resolver: los logos estaban dibujados con `fill="currentColor"`,
 * así que heredaban el color de la página —el de Instagram salía morado-Conversia, el de
 * WhatsApp también— y el dueño tenía que leer la etiqueta de al lado para saber qué red
 * era. Un logo repintado no cumple su único trabajo: que lo reconozcas sin leer.
 *
 * Son dos marcas con el MISMO archivo de logos (apps/web y apps/conversia-web). Si solo se
 * arregla uno, la otra marca queda con los logos despintados y nadie se entera, así que acá
 * se comparan carácter a carácter.
 */

const RAIZ = join(__dirname, "..", "..");
const PANELES = ["web", "conversia-web"] as const;
const iconos = (panel: string) => join(RAIZ, panel, "src", "components", "brand-icons.tsx");
const leer = (ruta: string) => readFileSync(ruta, "utf8").replace(/\r\n/g, "\n");

const ABRE = "// ===== PINTURA REAL DE LAS REDES";
const CIERRA = "// ===== FIN PINTURA REAL DE LAS REDES =====";

function bloqueDePintura(panel: string) {
  const src = leer(iconos(panel));
  const i = src.indexOf(ABRE);
  const j = src.indexOf(CIERRA);
  expect(i, `falta el inicio del bloque de pintura en apps/${panel}`).toBeGreaterThanOrEqual(0);
  expect(j, `falta el cierre del bloque de pintura en apps/${panel}`).toBeGreaterThan(i);
  return src.slice(i, j + CIERRA.length);
}

/** Todos los `.tsx` de un panel, menos el archivo de logos (que es el que define la pintura). */
function fuentesDelPanel(panel: string): string[] {
  const salida: string[] = [];
  const recorrer = (dir: string) => {
    for (const entrada of readdirSync(dir)) {
      const ruta = join(dir, entrada);
      if (statSync(ruta).isDirectory()) recorrer(ruta);
      else if (entrada.endsWith(".tsx") && entrada !== "brand-icons.tsx") salida.push(ruta);
    }
  };
  recorrer(join(RAIZ, panel, "src"));
  return salida;
}

describe("Logos de las redes: pintura real", () => {
  it("las dos marcas comparten EL MISMO bloque de pintura", () => {
    const [deWeb, deConversia] = PANELES.map(bloqueDePintura);
    // Si esto se cae, no basta con arreglar una: el bloque se copia tal cual a las dos.
    expect(deConversia).toBe(deWeb);
  });

  it("están los colores oficiales de las cuatro redes", () => {
    const bloque = bloqueDePintura("conversia-web");
    const oficiales = [
      "#25D366", // verde de WhatsApp
      "#FFD600", // degradado de Instagram: amarillo…
      "#FF0069", // …rosa…
      "#7638FA", // …violeta
      "#0099FF", // degradado de Messenger: azul…
      "#FF7061", // …coral
      "#00F2EA", // fantasma cian de TikTok
      "#FF004F", // fantasma rojo de TikTok
    ];
    for (const hex of oficiales) expect(bloque, `falta el color ${hex}`).toContain(hex);
  });

  it("ningún logo se pinta por omisión con el color de la página", () => {
    const bloque = bloqueDePintura("conversia-web");
    // WhatsApp: verde salvo que se pida `mono` a propósito.
    expect(bloque).toContain('fill={mono ? "currentColor" : VERDE_WHATSAPP}');
    // Instagram y Messenger: su degradado salvo que se pida `mono`.
    const conDegradado = bloque.match(/fill=\{mono \? "currentColor" : `url\(#\$\{id\}\)`\}/g) ?? [];
    expect(conDegradado.length, "Instagram y Messenger tienen que tomar su degradado").toBe(2);
    // TikTok: los dos fantasmas de color van SIEMPRE que no sea `mono`.
    expect(bloque).toContain("fill={CIAN_TIKTOK}");
    expect(bloque).toContain("fill={ROJO_TIKTOK}");
    // Y nadie se pinta con una variable del tema del panel.
    expect(bloque).not.toContain("var(--");
  });

  it("hay fondo y logo para TODAS las redes que tienen logo propio", () => {
    const bloque = bloqueDePintura("conversia-web");
    const redes = [...leer(join(RAIZ, "conversia-web", "src", "lib", "redes.ts")).matchAll(/\{ clave: "([a-z]+)", tipo:/g)].map((m) => m[1]);
    // «pruebas» es el canal mock: no es una marca y no tiene logo que poner.
    const conLogo = redes.filter((r) => r !== "pruebas");
    expect(conLogo.length).toBeGreaterThan(3);

    const fondos = bloque.slice(bloque.indexOf("export const FONDO_DE_RED"));
    const clavesDeFondo = [...fondos.slice(0, fondos.indexOf("};")).matchAll(/^ {2}([a-z]+):/gm)].map((m) => m[1]);
    expect(clavesDeFondo).toEqual(conLogo);

    const despachadas = [...bloque.matchAll(/clave === "([a-z]+)"/g)].map((m) => m[1]);
    expect(despachadas).toEqual(conLogo);
  });

  it("nadie REPINTA un logo de color (salvo que sea el glifo `mono`)", () => {
    // El error original: `<Icon size={22} style={{ color }} />`. El logo se dibujaba bien y
    // la pantalla lo repintaba encima. Un glifo `mono` sí puede tomar un color: es su razón
    // de ser (va en blanco sobre el cuadrito de marca).
    const tag = /<(?:WhatsApp|Instagram|Messenger|TikTok)Icon\b[^>]*>|<IconoDeRed\b[^>]*>|<Icon\b[^>]*>/g;
    const culpables: string[] = [];
    for (const panel of PANELES) {
      for (const ruta of fuentesDelPanel(panel)) {
        for (const m of leer(ruta).matchAll(tag)) {
          if (/\bcolor\b/.test(m[0]) && !/\bmono\b/.test(m[0])) {
            culpables.push(`${panel}: ${m[0].trim()}`);
          }
        }
      }
    }
    expect(culpables, "estos logos se están repintando con el color del panel").toEqual([]);
  });

  it("en el catálogo de TuBot cada red lleva SU logo, no un globito genérico", () => {
    const src = leer(join(RAIZ, "web", "src", "app", "(app)", "integrations", "page.tsx"));
    const esperados: Array<[string, string]> = [
      ["whatsapp", "WhatsAppIcon"],
      ["instagram", "InstagramIcon"],
      ["messenger", "MessengerIcon"],
      ["tiktok", "TikTokIcon"],
    ];
    for (const [clave, icono] of esperados) {
      const enElMapa = new RegExp(`^ {2}${clave}: <([A-Za-z]+)`, "m").exec(src);
      if (enElMapa) expect(enElMapa[1], `el catálogo pinta ${clave} con ${enElMapa[1]}`).toBe(icono);
      for (const fila of src.matchAll(new RegExp(`key: "${clave}",[\\s\\S]{0,240}?icon: <([A-Za-z]+)`, "g"))) {
        expect(fila[1], `la tarjeta de ${clave} pinta su icono con ${fila[1]}`).toBe(icono);
      }
    }
  });
});
