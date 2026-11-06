import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CONVI TIENE QUE NOTARSE.
 *
 * Lo que vio el dueño (6-nov): el copiloto que monta el negocio conversando vivía en una
 * carita de 56px sin una sola palabra, abajo a la derecha. Es el mismo acertijo que eran los
 * nueve iconos mudos del menú — con el agravante de que acá lo que no se entiende es que
 * HAY ALGUIEN que te deja el asistente andando.
 *
 * Dos presencias, y cada una donde no estorba:
 *  1. EN EL FLUJO de la pantalla "Hoy": la tarjeta con el monito levantando su cartel. Ahí
 *     puede ser grande porque empuja al resto hacia abajo en vez de taparlo — la lección de
 *     `nada-tapa-la-barra.test.ts`, que costó dos bugs el mismo día.
 *  2. EL ACCESO flotante: deja de ser un círculo mudo mientras quede montaje por hacer.
 *
 * Estos son guardianes de CÓDIGO FUENTE (los componentes tienen `useEffect` y no se montan
 * desde vitest sin Next). Están escritos para fallar si se les quita LA PALABRA, no solo la
 * clase: ya pasó que un test de "nav-label" quedara verde con el menú otra vez mudo porque
 * la cadena seguía apareciendo en otro botón.
 */

const leer = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

describe("el cartel de Convi en Hoy", () => {
  const cartel = leer("components/ConviCartel.tsx");

  it("la pantalla Hoy lo dibuja", () => {
    const inicio = leer("app/inicio/page.tsx");
    expect(inicio).toContain("<ConviCartel />");
    expect(inicio).toMatch(/import \{ ConviCartel \} from "@\/components\/ConviCartel"/);
  });

  it("escribe la pancarta, el detalle y el botón que salen de la tabla", () => {
    // Las tres piezas vienen de `cartelDeConvi`: nada de texto suelto que pueda decir una
    // cosa acá y otra en la burbuja.
    expect(cartel).toContain("{cartel.pancarta}");
    expect(cartel).toContain("{cartel.detalle}");
    expect(cartel).toContain("{cartel.cta}");
    expect(cartel).toMatch(/cartelDeConvi\(ctx\)/);
  });

  it("el monito levanta su cartel y es grande", () => {
    const avatar = /<ConviAvatar[^>]*\/>/s.exec(cartel)?.[0] ?? "";
    expect(avatar, "no hay avatar en la tarjeta").toContain("pancarta");
    const size = Number(/size=\{(\d+)\}/.exec(avatar)?.[1]);
    expect(size, "a menos de 64px el cartel del monito no se lee").toBeGreaterThanOrEqual(64);
  });

  it("desaparece solo cuando el montaje terminó (no hay nada que cerrar)", () => {
    expect(cartel).toMatch(/ctx\.mode !== "implementacion"\) return null/);
  });
});

describe("el acceso flotante", () => {
  const widget = leer("components/SupportWidget.tsx");

  it("durante el montaje dice con palabras para qué está", () => {
    // Se exige la LÍNEA ENTERA, no la cadena suelta: `cartel.pancarta` también aparece
    // dentro del `aria-label`, así que buscarla a secas deja el test verde con el acceso
    // otra vez mudo en pantalla. Es el mismo agujero que tuvo el guardián de "nav-label"
    // —verde con el menú sin nombres porque la clase seguía en otro botón—, comprobado
    // rompiéndolo a propósito.
    expect(widget).toContain('<span className="cv-convi-acceso-t1">{cartel.pancarta}</span>');
    expect(widget).toMatch(/accesoConPalabras && cartel \?/);
  });

  it("pero se calla en Hoy, donde la tarjeta ya lo dice", () => {
    // Las dos presencias a la vez mostraban la MISMA frase dos veces en la misma pantalla,
    // una encima de la otra. Eso se lee como un error, no como insistencia.
    expect(widget).toMatch(/const accesoConPalabras = montaje && pathname !== "\/inicio" && anunciando;/);
  });

  it("y se encoge al círculo en cuanto el dueño toca la pantalla", () => {
    // Una píldora de 300px fija abajo a la derecha tapa campos del formulario justo en las
    // pantallas del montaje. Se encoge por INTERACCIÓN —no por un temporizador— para
    // desaparecer exactamente cuando estorbaría.
    expect(widget).toMatch(/setAnunciando\(true\)/);
    expect(widget).toMatch(/const callar = \(\) => setAnunciando\(false\)/);
    for (const ev of ["pointerdown", "keydown", "wheel", "touchmove"]) {
      expect(widget, `falta escuchar ${ev}`).toMatch(new RegExp(`"${ev}"`));
    }
  });

  it("y el progreso debajo, con el mismo texto que el panel", () => {
    expect(widget).toContain('<span className="cv-convi-acceso-t2">{textoDeProgreso(ctx!)}</span>');
  });

  it("sigue siendo un acceso discreto cuando el bot ya atiende", () => {
    // `cv-convi-acceso-ancho` solo mientras falte montaje: después vuelve al círculo.
    expect(widget).toMatch(/accesoConPalabras \? " cv-convi-acceso-ancho" : ""/);
  });
});

describe("el dibujo del cartel", () => {
  const avatar = leer("components/ConviAvatar.tsx");

  it("solo se dibuja cuando se pide", () => {
    expect(avatar).toMatch(/\{pancarta \? \(\s*<g className="cv-convi-sign">/);
  });

  it("encoge el cuerpo para que todo quepa en la caja del avatar", () => {
    // Sin esto el cartel se sale de los 56px del acceso (el SVG va con `overflow: visible`)
    // y se mete encima de lo que tenga al lado.
    expect(avatar).toMatch(/transform=\{pancarta \? "translate\([\d .]+\) scale\(0?\.\d+\)" : undefined\}/);
  });

  it("el encogido NO es una transformación de CSS", () => {
    // El saludo anima `transform` sobre `.cv-convi-body`: si el encogido viviera ahí, el
    // monito se agrandaría de golpe justo al saludar.
    expect(avatar).not.toMatch(/\.cv-convi-con-cartel \.cv-convi-body \{[^}]*transform:/);
  });
});
