import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GRUPOS, PRIMARIOS, RESTO, SECCIONES, esActiva, pestanaActiva, seccionActiva } from "./nav";

/**
 * EL MENÚ TIENE QUE DECIR QUÉ ES CADA COSA.
 *
 * Lo que vio el dueño (3-nov): el riel de la izquierda eran NUEVE iconos sin una sola
 * palabra, y el estado activo era un fondo tenue. Con 9 destinos, un icono es un acertijo:
 * "no se sabe bien a qué menú se está accediendo". Peor: `/caja`, `/mini-sitio`, `/clientes`
 * y `/ajustes` NO se enlazan desde ninguna otra pantalla, así que si el riel no se entiende
 * esas cuatro secciones quedan prácticamente escondidas.
 *
 * Y había una segunda mitad del problema: el texto del menú no era el mismo que el título de
 * la pantalla. El menú decía "Mi página" y la pantalla "Tu página web", así que ni al llegar
 * se confirmaba que habías llegado a donde apretaste.
 *
 * El arreglo es estructural, no cosmético: UNA sola tabla (`lib/nav.ts`) de la que salen a la
 * vez el menú, el título de la pantalla y las pestañas. No se puede escribir un título que
 * difiera del menú porque no hay dónde escribirlo.
 */

const NOMBRES = SECCIONES.map((s) => s.label);

describe("la tabla de navegación", () => {
  it("no repite rutas ni deja una sección sin nombre", () => {
    const hrefs = SECCIONES.map((s) => s.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const s of SECCIONES) {
      expect(s.label.trim().length).toBeGreaterThan(1);
      expect(s.href.startsWith("/")).toBe(true);
      // Los iconos de lucide son `forwardRef`, o sea objetos, no funciones.
      expect(s.Icon, `${s.href} sin icono`).toBeTruthy();
    }
  });

  it("agrupa en tres bloques con título (el título es lo que desambigua)", () => {
    expect(GRUPOS.length).toBe(3);
    for (const g of GRUPOS) {
      expect(g.titulo.trim().length).toBeGreaterThan(2);
      expect(g.items.length).toBeGreaterThan(0);
    }
    // Ninguna sección queda fuera de un grupo.
    expect(GRUPOS.flatMap((g) => g.items).length).toBe(SECCIONES.length);
  });

  it("Caja y Cobros viven en grupos DISTINTOS", () => {
    // Es el par que más confunde: "Caja" es el dinero del negocio del dueño y "Cobros" es lo
    // que Conversia le cobra a él. Hoy la pantalla de Caja lo aclara con un paréntesis
    // ("Esto es TU caja, distinta de tu plan Conversia"), que es un parche de texto a un
    // problema de estructura. Separarlos por grupo lo arregla donde corresponde.
    const grupoDe = (href: string) => GRUPOS.find((g) => g.items.some((i) => i.href === href))?.titulo;
    expect(grupoDe("/caja")).toBeDefined();
    expect(grupoDe("/cobros")).toBeDefined();
    expect(grupoDe("/caja")).not.toBe(grupoDe("/cobros"));
  });

  it("mantiene la palabra 'Cobros' (es el vocabulario con el que habla Convi)", () => {
    // `assistant.service.ts` le dice al cliente "En Cobros aparece lo que Meta te cobró este
    // mes". Si acá se renombra a "Mi plan", el copiloto manda a una pantalla que ya no se
    // llama así. El grupo desambigua; el nombre no se toca.
    expect(NOMBRES).toContain("Cobros");
    expect(NOMBRES).toContain("Caja");
  });

  it("la barra inferior de móvil son los 4 del día a día (y no una tajada arbitraria)", () => {
    expect(PRIMARIOS).toEqual(GRUPOS[0].items);
    expect(PRIMARIOS.length).toBe(4);
    expect(RESTO.flatMap((g) => g.items).length).toBe(SECCIONES.length - 4);
    // Los 4 de la barra son los de uso diario; nada de configuración ahí.
    expect(PRIMARIOS.map((s) => s.href)).toEqual(["/inicio", "/conversaciones", "/agenda", "/clientes"]);
  });
});

describe("esActiva", () => {
  it("Hoy solo se enciende en /inicio exacto", () => {
    expect(esActiva("/inicio", "/inicio")).toBe(true);
    expect(esActiva("/clientes", "/inicio")).toBe(false);
  });

  it("una sub-pantalla mantiene encendida su sección", () => {
    expect(esActiva("/agenda/configurar", "/agenda")).toBe(true);
  });

  it("NO se enciende por un prefijo que es otra ruta", () => {
    // El `startsWith` pelado de antes encendía /caja estando en /cajafoo. Hoy no existe esa
    // ruta, pero el día que exista /clientes-vip no debe encender Clientes.
    expect(esActiva("/cajafoo", "/caja")).toBe(false);
    expect(esActiva("/clientes-vip", "/clientes")).toBe(false);
  });
});

describe("seccionActiva", () => {
  it("resuelve la sección de una sub-pantalla", () => {
    expect(seccionActiva("/agenda/configurar")?.label).toBe("Agenda");
    expect(seccionActiva("/caja")?.label).toBe("Caja");
  });

  it("devuelve null fuera del panel (no inventa una sección)", () => {
    expect(seccionActiva("/login")).toBeNull();
    expect(seccionActiva("/")).toBeNull();
  });
});

describe("pestañas", () => {
  it("Agenda tiene sus dos pantallas como pestañas", () => {
    const agenda = SECCIONES.find((s) => s.href === "/agenda")!;
    expect(agenda.pestanas?.map((p) => p.href)).toEqual(["/agenda", "/agenda/configurar"]);
  });

  it("la pestaña activa es la MÁS específica que calza", () => {
    const agenda = SECCIONES.find((s) => s.href === "/agenda")!;
    // Estando en /agenda/configurar calzan las dos ("/agenda" por prefijo): gana la larga.
    expect(pestanaActiva(agenda.pestanas, "/agenda/configurar")?.label).toBe("Configurar");
    expect(pestanaActiva(agenda.pestanas, "/agenda")?.label).toBe("Calendario");
    expect(pestanaActiva(undefined, "/caja")).toBeNull();
  });

  it("ninguna pestaña se llama igual que un control de su propia pantalla", () => {
    // La Agenda tiene botones de vista Día/Semana/Próximas. Una pestaña "Semana" al lado
    // sería otra cosa con el mismo nombre en la misma pantalla.
    const agenda = SECCIONES.find((s) => s.href === "/agenda")!;
    expect(agenda.pestanas?.map((p) => p.label)).not.toContain("Semana");
  });

  it("toda pestaña cuelga de la ruta de su sección", () => {
    for (const s of SECCIONES) {
      for (const p of s.pestanas ?? []) {
        expect(p.href === s.href || p.href.startsWith(s.href + "/")).toBe(true);
      }
    }
  });
});

/**
 * Que la tabla esté bien no prueba que las PANTALLAS la usen. Es el mismo error que ya cometí
 * en esta base: probar la regla mientras la pantalla seguía llamando a otra cosa. Estos
 * componentes son React con `useEffect` y no se pueden montar desde vitest sin Next, así que
 * se revisa el código fuente.
 */
describe("el riel y las pantallas usan la tabla", () => {
  const leer = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

  it("AppShell saca el menú de lib/nav, no de una lista propia", () => {
    const src = leer("components/AppShell.tsx");
    expect(src).toMatch(/from "@\/lib\/nav"/);
    // La lista local duplicada es justo lo que permitía que el menú y los títulos divergieran.
    expect(src).not.toMatch(/^const NAV = \[/m);
  });

  it("el riel escribe la etiqueta de cada ítem y marca la página actual", () => {
    const src = leer("components/AppShell.tsx");
    // Buscar solo la cadena "nav-label" NO sirve de guardián: al quitarle la etiqueta a los
    // ítems del menú seguía apareciendo en el botón de cerrar sesión, y el test quedaba
    // verde con el riel otra vez mudo. Lo que hay que exigir es que el ítem imprima SU
    // nombre, en los dos sitios donde se dibuja el menú (riel y hoja "Más").
    const etiquetas = src.match(/<span className="nav-label">\{label\}<\/span>/g) ?? [];
    expect(etiquetas.length, "los ítems del menú no imprimen su nombre").toBeGreaterThanOrEqual(2);
    expect(src).toContain('aria-current={activa ? "page" : undefined}');
    // Y el título del grupo, que es lo que separa Caja de Cobros a la vista.
    expect(src).toMatch(/\{grupo\.titulo\}/);
    expect(src).toContain("nav-grupo-titulo");
  });

  it("el logo lleva al inicio", () => {
    // Un logo que no es enlace es un botón muerto en el sitio donde todo el mundo hace clic
    // para volver al principio.
    expect(leer("components/AppShell.tsx")).toMatch(/<a href="\/inicio"[^>]*className="shell-brand/);
  });

  /**
   * CADA pantalla del panel pone su título con `EncabezadoSeccion ruta="<su ruta>"`, así el
   * título SALE de la tabla. Las exenciones son dos y están justificadas acá: si alguien
   * agrega una tercera tiene que escribir por qué en este test.
   */
  const EXENTAS: Record<string, string> = {
    "/conversaciones":
      "no es una pantalla con encabezado: son dos paneles a altura completa (lista + hilo) y su " +
      "título vive dentro de la lista, igual que en WhatsApp.",
  };

  it("las exenciones son solo las declaradas", () => {
    expect(Object.keys(EXENTAS)).toEqual(["/conversaciones"]);
  });

  it("toda pantalla del panel pone su título desde la tabla", () => {
    const rutas = [...SECCIONES.map((s) => s.href), "/agenda/configurar"].filter((h) => !(h in EXENTAS));
    for (const href of rutas) {
      const src = leer(`app${href}/page.tsx`);
      expect(src, `${href} no usa EncabezadoSeccion`).toContain("EncabezadoSeccion");
      expect(src, `${href} no le pasa su propia ruta`).toContain(`ruta="${href}"`);
    }
  });

  it("ninguna pantalla del panel escribe su título a mano", () => {
    // Un `<h1>` escrito a mano es exactamente cómo el menú decía "Mi página" y la pantalla
    // "Tu página web". El título lo pone el componente; acá no debe quedar ninguno.
    for (const href of [...SECCIONES.map((s) => s.href), "/agenda/configurar"]) {
      if (href in EXENTAS) continue;
      const src = leer(`app${href}/page.tsx`);
      expect(src, `${href} todavía tiene un <h1> propio`).not.toMatch(/<h1/);
    }
  });
});
