import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { MessageMedia } from "@/lib/message-media";

/**
 * D3 — LA BANDEJA MUESTRA LOS MEDIOS.
 *
 * Hasta ahora, en `/conversaciones` un audio se veía como su transcripción, una foto como
 * «[imagen]» y un sticker como «[sticker]». Este spec prueba lo que el dueño ve y toca:
 * el visor de fotos (abrir, pasar, cerrar), el reproductor propio de las notas de voz, y que
 * los stickers y las ubicaciones se dibujen.
 *
 * Todo mockeado en el borde HTTP: corre en el job `e2e-conversia`, donde no hay API ni base,
 * así que es determinista y no depende de Meta.
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "content-type": "application/json",
};

function responder(route: Parameters<Parameters<Page["route"]>[1]>[0], body: unknown) {
  return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(body) });
}

/**
 * Imágenes de prueba con TAMAÑO y contenido distintos. Un PNG de 1×1 estirado por la burbuja
 * hace que la captura no se parezca a un chat de verdad y esconde los problemas de encuadre.
 */
function imagenFalsa(texto: string, w: number, h: number, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="100%" height="100%" fill="${color}"/>` +
    `<text x="50%" y="50%" fill="#fff" font-family="sans-serif" font-size="${Math.round(w / 12)}" text-anchor="middle" dominant-baseline="middle">${texto}</text></svg>`;
}
const IMAGENES: Record<string, { cuerpo: string; tipo: string }> = {
  m3: { cuerpo: imagenFalsa("radiografía", 900, 600, "#2b4a6f"), tipo: "image/svg+xml" },
  m4: { cuerpo: imagenFalsa("foto 2", 600, 800, "#6f2b4a"), tipo: "image/svg+xml" },
  m5: { cuerpo: imagenFalsa("foto 3", 800, 800, "#2b6f4a"), tipo: "image/svg+xml" },
  m6: { cuerpo: imagenFalsa("🐱", 300, 300, "transparent"), tipo: "image/svg+xml" },
};
/** Un MP3 mínimo: alcanza para que el elemento <audio> exista y la CSP se ejerza. */
const AUDIO = Buffer.from("SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAABAAABYgCA", "base64");

const media = (p: Partial<MessageMedia>): MessageMedia => ({
  kind: null, url: null, mime: null, filename: null, caption: null, animated: null,
  durationSec: null, transcript: null, location: null, contacts: null, reactions: null, ...p,
});

const CONV = "c1";
const mid = (n: number) => `m${n}`;
const u = (n: number, tipo: string) => `/conversations/${CONV}/messages/${mid(n)}/${tipo}`;

const MENSAJES = [
  { id: mid(1), direction: "INBOUND", type: "TEXT", visibility: "PUBLIC", body: "Hola, buenas tardes", authorType: "USER", authorName: null, status: "DELIVERED", createdAt: "2026-11-10T13:00:00-03:00", media: media({}) },
  { id: mid(2), direction: "INBOUND", type: "AUDIO", visibility: "PUBLIC", body: "quiero una hora para limpieza", authorType: "USER", authorName: null, status: "DELIVERED", createdAt: "2026-11-11T13:01:00-03:00", media: media({ kind: "audio", url: u(2, "audio"), durationSec: 42, transcript: "quiero una hora para limpieza" }) },
  { id: mid(3), direction: "INBOUND", type: "IMAGE", visibility: "PUBLIC", body: null, authorType: "USER", authorName: null, status: "DELIVERED", createdAt: "2026-11-11T13:02:00-03:00", media: media({ kind: "image", url: u(3, "image"), caption: "mi radiografía" }) },
  { id: mid(4), direction: "INBOUND", type: "IMAGE", visibility: "PUBLIC", body: null, authorType: "USER", authorName: null, status: "DELIVERED", createdAt: "2026-11-11T13:02:30-03:00", media: media({ kind: "image", url: u(4, "image") }) },
  { id: mid(5), direction: "INBOUND", type: "IMAGE", visibility: "PUBLIC", body: null, authorType: "USER", authorName: null, status: "DELIVERED", createdAt: "2026-11-11T13:03:00-03:00", media: media({ kind: "image", url: u(5, "image") }) },
  { id: mid(6), direction: "INBOUND", type: "STICKER", visibility: "PUBLIC", body: "Sticker", authorType: "USER", authorName: null, status: "DELIVERED", createdAt: "2026-11-11T13:04:00-03:00", media: media({ kind: "sticker", url: u(6, "image"), animated: true }) },
  { id: mid(7), direction: "INBOUND", type: "LOCATION", visibility: "PUBLIC", body: "📍 Clínica Norte", authorType: "USER", authorName: null, status: "DELIVERED", createdAt: "2026-11-11T13:05:00-03:00", media: media({ kind: "location", location: { lat: -38.73, lng: -72.59, name: "Clínica Norte", address: "Av. Alemania 01" } }) },
  { id: mid(8), direction: "INBOUND", type: "DOCUMENT", visibility: "PUBLIC", body: "📄 presupuesto.pdf", authorType: "USER", authorName: null, status: "DELIVERED", createdAt: "2026-11-11T13:06:00-03:00", media: media({ kind: "document", url: u(8, "document"), filename: "presupuesto.pdf", mime: "application/pdf" }) },
  { id: mid(9), direction: "OUTBOUND", type: "TEXT", visibility: "PUBLIC", body: "¡Hola! Te confirmo la hora para el martes a las 10:00. Más info en https://conversia.cl", authorType: "AGENT", authorName: null, status: "READ", createdAt: "2026-11-11T13:07:00-03:00", media: media({ reactions: [{ emoji: "❤️", at: "2026-11-11T13:08:00-03:00" }] }) },
  { id: mid(10), direction: "OUTBOUND", type: "TEXT", visibility: "PUBLIC", body: "Cualquier cosa me avisas 🙌", authorType: "AGENT", authorName: null, status: "DELIVERED", createdAt: "2026-11-11T13:07:30-03:00", media: media({}) },
];

async function montar(page: Page) {
  await page.route(/connect\.facebook\.net/, (r) => r.abort());
  await page.route(/:4000\//, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
    const p = new URL(req.url()).pathname;
    if (p === "/auth/me") return responder(route, { user: { emailVerified: true, settings: {} } });
    if (p === "/onboarding") return responder(route, { steps: [] });
    // Los archivos de medio: la API los proxea; acá devolvemos un PNG real.
    const medio = /\/messages\/([^/]+)\/(image|audio|video|document)$/.exec(p);
    if (medio) {
      const [, id, tipo] = medio;
      if (tipo === "audio") {
        return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "audio/mpeg", "x-media-duration": "42" }, body: AUDIO });
      }
      const img = IMAGENES[id] ?? IMAGENES.m3;
      return route.fulfill({ status: 200, headers: { ...CORS, "content-type": img.tipo }, body: img.cuerpo });
    }
    if (p === `/conversations/${CONV}/messages`) {
      return responder(route, {
        conversation: { id: CONV, status: "OPEN", aiEnabled: true, contact: { id: "k1", firstName: "Ana", lastName: "Pérez", profileName: null, phone: "+56911111111", avatarUrl: null } },
        messages: MENSAJES,
      });
    }
    if (p === "/conversations" && req.method() === "GET") {
      // La lista responde {items: [...]}, NO un arreglo pelado: devolver la forma equivocada
      // deja `items` en undefined y revienta el render entero (lección de #632).
      return responder(route, { items: [{ id: CONV, status: "OPEN", aiEnabled: true, unreadCount: 0, lastMessagePreview: "🎤 quiero una hora para limpieza", lastMessageAt: "2026-11-11T13:07:30-03:00", activeAgentId: null, activeAgentName: null, assignedUserId: null, assignedUserName: null, contact: { id: "k1", firstName: "Ana", lastName: "Pérez", profileName: null, phone: "+56911111111", avatarUrl: null } }] });
    }
    return responder(route, {});
  });
  await page.addInitScript(() => {
    try {
      // Sesión falsa con vencimiento lejano (mismo patrón que canales-reporte).
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "");
      localStorage.setItem("conversia_token", `${b64({ alg: "HS256" })}.${b64({ sub: "u1", exp })}.x`);
      localStorage.setItem("conversia_session_until", String(Date.now() + 3600_000));
    } catch {
      /* modo privado */
    }
  });
}

/** Guarda la captura en disco Y la adjunta al reporte: el archivo es lo que se puede mirar. */
async function capturar(page: Page, testInfo: TestInfo, nombre: string, opts: Parameters<Page["screenshot"]>[0] = {}) {
  const ruta = testInfo.outputPath(`${nombre}.png`);
  await page.screenshot({ ...opts, path: ruta });
  await testInfo.attach(`${nombre}.png`, { path: ruta, contentType: "image/png" });
}

async function abrirHilo(page: Page) {
  // El enlace profundo de la bandeja es `?c=` (lo usa Clientes).
  await page.goto(`/conversaciones?c=${CONV}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("burbuja-imagen").first()).toBeVisible({ timeout: 15_000 });
}

test("las fotos abren el visor, las flechas pasan entre ellas y Esc cierra", async ({ page }) => {
  await montar(page);
  await abrirHilo(page);

  await page.getByTestId("imagen-miniatura").first().click();
  const visor = page.getByTestId("visor");
  await expect(visor).toBeVisible();
  // Tres fotos en el hilo: el contador lo dice.
  await expect(page.getByTestId("visor-contador")).toHaveText("1 / 3");

  await page.getByTestId("visor-siguiente").click();
  await expect(page.getByTestId("visor-contador")).toHaveText("2 / 3");

  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("visor-contador")).toHaveText("3 / 3");

  await page.keyboard.press("Escape");
  await expect(visor).toHaveCount(0);
});

test("el visor también cierra con el botón y con un clic en el fondo", async ({ page }) => {
  await montar(page);
  await abrirHilo(page);

  await page.getByTestId("imagen-miniatura").first().click();
  await page.getByTestId("visor-cerrar").click();
  await expect(page.getByTestId("visor")).toHaveCount(0);

  await page.getByTestId("imagen-miniatura").first().click();
  await expect(page.getByTestId("visor-imagen")).toBeVisible();
  // Cerrar tocando fuera de la foto. Lo que se prueba es la GARANTÍA: existe una zona de
  // fondo que recibe el toque y cierra.
  const fondo = await page.getByTestId("visor").evaluate((caja) => {
    // Las medidas salen del RECT DEL VISOR, no de window.innerWidth. En un celular emulado el
    // viewport visual (innerWidth) y el de maquetado no coinciden —en un iPhone 13, 412 contra
    // 390— y un punto calculado con innerWidth cae FUERA de la página: el clic no llega a
    // nadie y el visor se queda abierto como si el cierre estuviera roto.
    const v = caja.getBoundingClientRect();
    const r = (caja.querySelector("[data-testid=visor-imagen]") as HTMLElement).getBoundingClientRect();
    // Un dedo. Un borde de 11 px no es "el fondo" para nadie, así que no vale como prueba.
    const DEDO = 40;
    const candidatos = [
      { franja: "izquierda", hueco: r.left - v.left, x: (v.left + r.left) / 2, y: v.top + v.height / 2 },
      { franja: "derecha", hueco: v.right - r.right, x: (r.right + v.right) / 2, y: v.top + v.height / 2 },
      { franja: "abajo", hueco: v.bottom - r.bottom, x: v.left + v.width / 2, y: (r.bottom + v.bottom) / 2 },
      { franja: "arriba", hueco: r.top - v.top, x: v.left + v.width / 2, y: (v.top + r.top) / 2 },
    ];
    // Y se pregunta QUIÉN recibe el toque: que el visor "se vea" no dice nada — lo que cierra
    // es que el clic llegue al fondo, y una capa encima (un pie de foto, un degradado, la
    // barra de abajo del panel) se lo come en silencio.
    return candidatos
      .filter((p) => p.hueco >= DEDO)
      .map((p) => {
        const t = document.elementFromPoint(Math.round(p.x), Math.round(p.y)) as HTMLElement | null;
        return { franja: p.franja, x: Math.round(p.x), y: Math.round(p.y), hueco: Math.round(p.hueco), quien: t ? `${t.tagName.toLowerCase()}${t.dataset.testid ? `[${t.dataset.testid}]` : ""}` : "nada" };
      });
  });
  expect(fondo.length, "con la foto puesta no queda ni una franja de fondo de 40 px").toBeGreaterThan(0);
  const tocable = fondo.find((p) => p.quien === "div[visor]");
  expect(tocable, `el fondo no recibe el toque: ${fondo.map((p) => `${p.franja}(${p.hueco}px)→${p.quien}`).join(", ")}`).toBeTruthy();
  await page.mouse.click(tocable!.x, tocable!.y);
  await expect(page.getByTestId("visor")).toHaveCount(0);

  // El pie de foto se sienta ENCIMA de la franja de abajo, que en un celular es casi el único
  // fondo que queda (la foto va de borde a borde). Es texto, no un control: si intercepta
  // punteros, el toque muere en un div decorativo y el visor parece no cerrarse.
  await page.getByTestId("imagen-miniatura").first().click();
  await expect(page.getByTestId("visor-pie")).toHaveCSS("pointer-events", "none");
  await page.keyboard.press("Escape");
});

test("la nota de voz muestra su duración ANTES de reproducir, y play cambia a pausa", async ({ page }) => {
  await montar(page);
  await abrirHilo(page);

  const audio = page.getByTestId("burbuja-audio");
  await expect(audio).toBeVisible();
  // La duración sale de media.durationSec: no hizo falta bajar el archivo.
  await expect(page.getByTestId("audio-duracion")).toHaveText("0:42");

  // El contrato que importa: el archivo NO se baja al montar, se baja al pulsar play. Afirmar
  // que el botón queda "sonando" seria fragil — en un navegador sin salida de audio (o con un
  // archivo de prueba que no es reproducible) `play()` rechaza y el botón vuelve atrás, sin
  // que nada del producto esté mal.
  const play = page.getByTestId("audio-play");
  await expect(play).toHaveAttribute("data-sonando", "0");
  expect(await page.locator("audio").count(), "no debe haber bajado nada todavía").toBe(0);
  await play.click();
  await expect(page.locator("audio")).toHaveAttribute("src", /^blob:/, { timeout: 10_000 });
});

test("la CSP deja reproducir el blob del audio (si no, el botón responde y no suena nada)", async ({ page }) => {
  const bloqueos: string[] = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy/i.test(t)) bloqueos.push(t);
  });
  await montar(page);
  await abrirHilo(page);
  await page.getByTestId("audio-play").click();
  await page.waitForTimeout(1500);
  // El fallo que esto caza no da error visible: solo una línea en consola que nadie mira.
  expect(bloqueos, `la CSP bloqueó un recurso: ${bloqueos.join(" | ")}`).toEqual([]);
});

test("la transcripción se despliega", async ({ page }) => {
  await montar(page);
  await abrirHilo(page);
  await expect(page.getByText("quiero una hora para limpieza").first()).toBeVisible();
});

test("sticker, ubicación y documento se dibujan (antes eran texto entre corchetes)", async ({ page }) => {
  await montar(page);
  await abrirHilo(page);
  await expect(page.getByTestId("burbuja-sticker")).toBeVisible();
  await expect(page.getByTestId("burbuja-ubicacion")).toBeVisible();
  await expect(page.getByRole("link", { name: /Google Maps/i })).toHaveAttribute("href", /maps\?q=-38\.73,-72\.59/);
  await expect(page.getByTestId("burbuja-documento")).toContainText("presupuesto.pdf");
});

test("separadores de día, reacción sobre el mensaje del bot y enlaces clicables", async ({ page }) => {
  await montar(page);
  await abrirHilo(page);
  // Dos días en el fixture → dos separadores.
  await expect(page.getByTestId("separador-dia")).toHaveCount(2);
  await expect(page.getByTestId("reaccion")).toContainText("❤️");
  await expect(page.getByRole("link", { name: "https://conversia.cl" })).toHaveAttribute("target", "_blank");
});

/**
 * Capturas de la etapa D3, en los dos tamaños que importan. No son un test: dejan la
 * evidencia visual que pide la entrega, y se guardan como adjuntos del reporte.
 */
test("capturas de escritorio y móvil", async ({ page }, testInfo) => {
  // Solo en el proyecto de escritorio: los proyectos de dispositivo traen viewport fijo y
  // cambiarlo a mano es pelear con el emulador para obtener la misma imagen.
  test.skip(testInfo.project.name !== "desktop", "las capturas se toman una sola vez");
  await montar(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await abrirHilo(page);
  await capturar(page, testInfo, "d3-escritorio", { fullPage: false });

  await page.getByTestId("imagen-miniatura").first().click();
  await expect(page.getByTestId("visor")).toBeVisible();
  await capturar(page, testInfo, "d3-escritorio-visor", );
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 375, height: 760 });
  await abrirHilo(page);
  await capturar(page, testInfo, "d3-movil", { fullPage: false });

  await page.getByTestId("imagen-miniatura").first().click();
  await expect(page.getByTestId("visor")).toBeVisible();
  await capturar(page, testInfo, "d3-movil-visor", );
});

test("a 375 px nada se desborda", async ({ page }) => {
  await montar(page);
  await page.setViewportSize({ width: 375, height: 760 });
  await abrirHilo(page);
  const culpables = await page.evaluate(() => {
    const limite = document.documentElement.clientWidth;
    // Solo lo que dibuja D3 (las burbujas del hilo). La barra de operación y el encabezado
    // del chat ya se salían antes de esta tanda y no se tocan acá: queda anotado en el PR.
    const raiz = document.querySelector('[data-testid^="mensaje-"]')?.parentElement ?? document.body;
    return [...raiz.querySelectorAll("*")]
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && r.right > limite + 1)
      .slice(0, 6)
      .map(({ el, r }) => {
        const duenio = el.closest("[data-testid]")?.getAttribute("data-testid") ?? "?";
        return `${el.tagName.toLowerCase()}<${duenio}> right=${Math.round(r.right)} w=${Math.round(r.width)} texto="${(el.textContent ?? "").slice(0, 20)}"`;
      });
  });
  expect(culpables, `elementos que se salen de los ${375} px: ${culpables.join(" | ")}`).toEqual([]);
});
