import { test, expect } from "@playwright/test";
import { registerAccount, useSession } from "./_fixtures";

/**
 * JORNADA I — "¿A qué menú estoy entrando?" (reporte del dueño, 3-nov).
 *
 * Lo que vio: el riel de la izquierda eran NUEVE iconos sin una sola palabra. No se sabía a
 * qué sección se estaba entrando, y encima el nombre del menú no coincidía con el título de
 * la pantalla a la que llevaba (el menú decía "Mi página", la pantalla "Tu página web"), así
 * que ni al llegar se confirmaba. Y cuatro secciones (`/caja`, `/clientes`, `/mini-sitio`,
 * `/ajustes`) no se enlazan desde ninguna otra pantalla: si el riel no se entiende, están
 * escondidas.
 *
 * Esto se prueba en NAVEGADOR porque es lo único que demuestra que el texto se VE. Los tests
 * de `src/lib/nav.test.ts` encierran la tabla y el código fuente; acá se mira la pantalla:
 *  - escritorio: los nueve nombres a la vista, los títulos de grupo, y la sección actual
 *    marcada de verdad (`aria-current`);
 *  - el texto del menú y el título de la pantalla son el MISMO texto, verificado haciendo
 *    clic y comparando (no contra una constante escrita en el test);
 *  - móvil: la barra inferior con los cuatro del día a día y el resto en "Más", agrupado.
 */
test.skip(!process.env.RUN_DUENO, "Suite 'como el dueño': requiere el stack Docker (RUN_DUENO=1).");

/** Los nueve destinos, en el orden en que el riel los muestra. */
const MENU = [
  { href: "/inicio", nombre: "Hoy" },
  { href: "/conversaciones", nombre: "Conversaciones" },
  { href: "/agenda", nombre: "Agenda" },
  { href: "/clientes", nombre: "Clientes" },
  { href: "/caja", nombre: "Caja" },
  { href: "/mini-sitio", nombre: "Mi página web" },
  { href: "/cobros", nombre: "Cobros" },
  { href: "/canales", nombre: "Canales" },
  { href: "/ajustes", nombre: "Ajustes" },
];

const GRUPOS = ["Día a día", "Tu negocio", "Tu cuenta Conversia"];

test.describe("Jornada I — sé en qué menú estoy", () => {
  test("el menú dice con palabras qué es cada cosa y la pantalla repite ese mismo nombre", async ({ page, request }) => {
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "barberia" });
    await useSession(page, cuenta.token);
    await page.goto("/inicio", { waitUntil: "domcontentloaded" });

    const esMovil = (page.viewportSize()?.width ?? 1280) < 768;

    if (esMovil) {
      // En teléfono el riel no existe: barra inferior con los 4 del día a día + "Más".
      const barra = page.locator("nav.shell-tabs");
      await expect(barra).toBeVisible();
      for (const { nombre } of MENU.slice(0, 4)) {
        await expect(barra.getByText(nombre, { exact: true })).toBeVisible();
      }

      // NADA puede taparla: es la única navegación que hay en un teléfono. El aviso de
      // "Instala Conversia" se apoyaba justo encima (12px del borde, z-index 60 contra el 20
      // de la barra) y se comía el toque en los cinco ítems. Esto no se ve "visible/oculto":
      // el ítem está visible y aun así no se puede tocar, así que se pregunta por el
      // elemento que de verdad recibe el toque.
      const recibeElToque = await page.evaluate(() => {
        const caja = document.querySelector("nav.shell-tabs")?.getBoundingClientRect();
        if (!caja) return "no hay barra";
        const puntos: Array<[number, number]> = [
          [caja.left + caja.width * 0.1, caja.top + 24],
          [caja.left + caja.width * 0.5, caja.top + 24],
          [caja.right - caja.width * 0.1, caja.top + 24],
        ];
        for (const [x, y] of puntos) {
          const el = document.elementFromPoint(x, y);
          if (!el?.closest("nav.shell-tabs")) return `tapada en (${Math.round(x)},${Math.round(y)}) por ${el?.className || el?.tagName || "?"}`;
        }
        return "la barra";
      });
      expect(recibeElToque).toBe("la barra");
      // El resto vive en "Más", y ahí también va agrupado: es lo que distingue "Caja" (el
      // dinero del negocio) de "Cobros" (lo que Conversia te cobra). Todo acotado a la hoja:
      // el riel sigue en el DOM aunque el CSS lo esconda, así que buscar el texto a secas
      // encuentra dos y Playwright corta por "strict mode".
      await barra.getByRole("button", { name: "Más" }).click();
      const hoja = page.locator(".hoja-mas");
      await expect(hoja).toBeVisible();
      for (const { nombre } of MENU.slice(4)) {
        await expect(hoja.getByText(nombre, { exact: true })).toBeVisible();
      }
      for (const g of GRUPOS.slice(1)) {
        await expect(hoja.getByText(g, { exact: true })).toBeVisible();
      }
      return;
    }

    // ── Escritorio: el riel, con nombres y con grupos.
    const riel = page.locator("nav.shell-rail");
    await expect(riel).toBeVisible();

    for (const { href, nombre } of MENU) {
      const item = riel.locator(`a.nav-link[href="${href}"]`);
      // El nombre tiene que estar VISIBLE, no en un tooltip: un `title` no se lee de un vistazo.
      await expect(item, `el riel no muestra "${nombre}"`).toContainText(nombre);
    }
    for (const g of GRUPOS) {
      await expect(riel.getByText(g, { exact: true }), `falta el grupo "${g}"`).toBeVisible();
    }

    // La sección actual, marcada de verdad (y solo una).
    await expect(riel.locator('a[aria-current="page"]')).toHaveCount(1);
    await expect(riel.locator('a[aria-current="page"]')).toHaveAttribute("href", "/inicio");

    // ── El texto del menú ES el título de la pantalla. Se lee del propio menú y se compara
    // con el <h1> después de hacer clic: si alguien los desincroniza, esto se cae.
    for (const href of ["/caja", "/mini-sitio", "/clientes"]) {
      const enlace = page.locator(`nav.shell-rail a.nav-link[href="${href}"]`);
      const nombreEnElMenu = ((await enlace.textContent()) ?? "").trim();
      expect(nombreEnElMenu.length, `el menú no tiene texto para ${href}`).toBeGreaterThan(2);

      await enlace.click();
      await page.waitForURL(new RegExp(`${href}$`), { timeout: 15_000 });
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(nombreEnElMenu);
      // Y el riel marca la sección en la que acabamos de entrar.
      await expect(page.locator(`nav.shell-rail a.nav-link[href="${href}"]`)).toHaveAttribute("aria-current", "page");
    }
  });

  test("Agenda y Configurar son dos pestañas de la MISMA sección", async ({ page, request }) => {
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "barberia" });
    await useSession(page, cuenta.token);
    await page.goto("/agenda", { waitUntil: "domcontentloaded" });

    // Antes "Configurar" era un botón suelto arriba a la derecha y la vuelta era una flecha:
    // nada decía que fueran dos pantallas de lo mismo.
    const pestanas = page.locator("nav.pestanas");
    await expect(pestanas).toBeVisible();
    await expect(pestanas.getByRole("link", { name: "Calendario" })).toHaveAttribute("aria-current", "page");

    await pestanas.getByRole("link", { name: "Configurar" }).click();
    await page.waitForURL(/\/agenda\/configurar$/, { timeout: 15_000 });

    // El título sigue diciendo a qué sección pertenece, y la pestaña, en qué parte estás.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Agenda");
    await expect(page.locator("nav.pestanas").getByRole("link", { name: "Configurar" })).toHaveAttribute("aria-current", "page");
    // Y en el menú, la Agenda sigue encendida (no se "sale" de la sección al configurar).
    const enElMenu = page.locator('nav.shell-rail a[href="/agenda"], nav.shell-tabs a[href="/agenda"]').first();
    await expect(enElMenu).toHaveAttribute("aria-current", "page");
  });

  test("el índice de una pantalla larga solo ofrece atajos que existen", async ({ page, request }) => {
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "barberia" });
    await useSession(page, cuenta.token);

    // Cobros y Ajustes son las dos pantallas largas. El índice NO esconde nada (serían
    // pestañas, y Convi resalta por `data-copilot`: un elemento dentro de una pestaña
    // cerrada lo dejaría fallando en silencio), solo salta. Un atajo a un ancla que no
    // existe no lleva a ninguna parte, así que cada uno tiene que apuntar a algo real.
    for (const ruta of ["/cobros", "/ajustes"]) {
      await page.goto(ruta, { waitUntil: "domcontentloaded" });
      const atajos = await page.locator("nav.indice a").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));
      for (const destino of atajos) {
        expect(destino.startsWith("#"), `${ruta}: atajo raro "${destino}"`).toBe(true);
        await expect(page.locator(destino), `${ruta}: el ancla ${destino} no existe`).toHaveCount(1);
      }
    }
    // Ajustes siempre tiene sus cuatro bloques (no dependen de datos del servidor).
    await expect(page.locator("nav.indice a")).toHaveCount(4);
  });

  test("el logo vuelve al inicio y la campana lleva a lo que anuncia", async ({ page, request }) => {
    const cuenta = await registerAccount(request, { brand: "conversia", vertical: "barberia" });
    await useSession(page, cuenta.token);
    await page.goto("/caja", { waitUntil: "domcontentloaded" });

    if ((page.viewportSize()?.width ?? 1280) >= 768) {
      await page.locator('nav.shell-rail a[href="/inicio"].shell-brand').click();
      await page.waitForURL(/\/inicio$/, { timeout: 15_000 });
    } else {
      await page.goto("/inicio", { waitUntil: "domcontentloaded" });
    }

    // La campana era un botón sin onClick: el punto de aviso invitaba a apretar algo que no
    // hacía nada. Ahora es un enlace a las conversaciones, que es lo que el punto anuncia.
    // El nombre accesible siempre habla de "conversaciones que te esperan" para no chocar con
    // el ítem "Conversaciones" del menú, que es otra cosa.
    const campana = page.getByRole("link", { name: /conversaciones .*te esperan/i });
    await expect(campana).toHaveAttribute("href", "/conversaciones");
  });
});
