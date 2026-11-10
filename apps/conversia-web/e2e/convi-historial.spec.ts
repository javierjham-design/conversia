import { expect, test, type Page } from "@playwright/test";

/**
 * B3 — EL HILO DE CONVI SOBREVIVE A CAMBIAR DE SECCIÓN.
 *
 * El defecto: los mensajes vivían en el `useState` del widget y la navegación del panel usa
 * `<a href>` (recarga entera), así que ir de Inicio a Canales borraba la conversación. El
 * dueño le contaba a Convi su negocio, cambiaba de pantalla y empezaba de cero.
 *
 * Todo mockeado en el borde HTTP: este spec corre en `e2e-conversia`, sin API ni base.
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
};
type Ruta = Parameters<Parameters<Page["route"]>[1]>[0];
const responder = (route: Ruta, body: unknown, status = 200) =>
  route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });

type Mensaje = { role: string; content: string; actions?: unknown[] };
type Hilo = { id: string; title: string | null; status: string; lastMessageAt: string; preview: string | null };

/** Backend falso con memoria: los hilos y sus mensajes sobreviven a las recargas. */
function crearBackend() {
  const mensajes: Record<string, Mensaje[]> = { h1: [] };
  const hilos: Hilo[] = [{ id: "h1", title: null, status: "open", lastMessageAt: new Date().toISOString(), preview: null }];
  let seq = 1;
  return {
    hilos,
    mensajes,
    nuevoTurno(threadId: string, texto: string) {
      const h = hilos.find((x) => x.id === threadId)!;
      mensajes[threadId].push({ role: "user", content: texto });
      mensajes[threadId].push({ role: "assistant", content: `Anotado: ${texto}` });
      if (!h.title) h.title = texto.split(/\s+/).slice(0, 6).join(" ");
      if (!h.preview) h.preview = texto;
      h.lastMessageAt = new Date().toISOString();
    },
    nuevoHilo() {
      for (const h of hilos) if (h.status === "open") h.status = "archived";
      const id = `h${++seq}`;
      hilos.unshift({ id, title: null, status: "open", lastMessageAt: new Date().toISOString(), preview: null });
      mensajes[id] = [];
      return id;
    },
    abierto() {
      return hilos.find((h) => h.status === "open")!.id;
    },
  };
}
type Backend = ReturnType<typeof crearBackend>;

async function montar(page: Page, be: Backend) {
  await page.route(/:4000\//, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
    const p = new URL(req.url()).pathname;
    if (p === "/auth/me") return responder(route, { user: { emailVerified: true, settings: {} } });
    if (p === "/assistant/context") {
      return responder(route, { businessName: "Barbería QA", checklistPct: 100, mode: "asistencia", steps: [], saldo: null, canConfigure: true, avisos: [] });
    }
    if (p === "/assistant/threads" && req.method() === "GET") {
      return responder(route, { hilos: be.hilos, siguiente: null });
    }
    if (p === "/assistant/threads/new") {
      return responder(route, { id: be.nuevoHilo() });
    }
    const m = /^\/assistant\/threads\/([^/]+)\/messages$/.exec(p);
    if (m) {
      return responder(route, { thread: { id: m[1], title: null, status: "open" }, messages: be.mensajes[m[1]] ?? [], siguiente: null });
    }
    if (p === "/assistant/message") {
      const body = JSON.parse(req.postData() ?? "{}") as { message: string; threadId?: string };
      const id = body.threadId ?? be.abierto();
      be.nuevoTurno(id, body.message);
      return responder(route, { reply: `Anotado: ${body.message}`, mode: "asistencia", wrote: false, qa: null, actions: [], degradado: false, threadId: id });
    }
    if (p === "/onboarding") return responder(route, { steps: [] });
    // Las pantallas del panel esperan FORMAS concretas: `/channels` devuelve un arreglo.
    // Si se le responde `{}`, la página revienta y el error se lleva el widget entero.
    if (p === "/channels") return responder(route, []);
    return responder(route, {});
  });
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u1", exp: Math.floor(Date.now() / 1000) + 3600 })}.firma`;
  await page.addInitScript(([t, pl]) => {
    try {
      localStorage.setItem("conversia_token", t);
      localStorage.setItem("conversia_session_until", pl);
      // El widget se abre solo la primera vez de la sesión; acá se abre a mano.
      sessionStorage.setItem("convi_abierto", "0");
    } catch {
      /* modo privado */
    }
  }, [token, String(Date.now() + 3600_000)]);
}

/** La caja donde se le escribe a Convi (su placeholder es el ancla estable). */
const entrada = (page: Page) => page.getByPlaceholder(/Escríbele a Convi/i);

/** Abre el panel de Convi. El acceso lleva su nombre; el panel, la caja de texto. */
async function abrirConvi(page: Page) {
  if (await entrada(page).isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: /Convi/i }).first().click();
  await entrada(page).waitFor({ state: "visible", timeout: 15_000 });
}

test("la conversación sigue ahí después de cambiar de sección", async ({ page }) => {
  const be = crearBackend();
  await montar(page, be);
  await page.goto("/canales", { waitUntil: "domcontentloaded" });
  await abrirConvi(page);

  await entrada(page).fill("mi barbería abre de 9 a 19");
  await entrada(page).press("Enter");
  await expect(page.getByText("Anotado: mi barbería abre de 9 a 19")).toBeVisible({ timeout: 15_000 });

  await entrada(page).fill("el corte vale 12000");
  await entrada(page).press("Enter");
  await expect(page.getByText("Anotado: el corte vale 12000")).toBeVisible({ timeout: 15_000 });

  // La navegación del panel usa <a href>: cambiar de sección es una CARGA COMPLETA, con
  // contexto de JS nuevo. Eso es lo que borraba la conversación, y es lo que se reproduce acá.
  await page.goto("/canales", { waitUntil: "domcontentloaded" });
  await abrirConvi(page);

  await expect(page.getByText("mi barbería abre de 9 a 19").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("el corte vale 12000").first()).toBeVisible();
  await expect(page.getByText("Anotado: el corte vale 12000")).toBeVisible();
});

test("«Nueva conversación» archiva la anterior y el historial muestra las dos", async ({ page }) => {
  const be = crearBackend();
  await montar(page, be);
  await page.goto("/canales", { waitUntil: "domcontentloaded" });
  await abrirConvi(page);

  await entrada(page).fill("primera conversación sobre precios");
  await entrada(page).press("Enter");
  await expect(page.getByText("Anotado: primera conversación sobre precios")).toBeVisible({ timeout: 15_000 });

  await page.locator('[data-convi="nueva-conversacion"]').click();
  await expect(page.getByText("Anotado: primera conversación sobre precios")).toBeHidden();

  await entrada(page).fill("segunda conversación sobre horarios");
  await entrada(page).press("Enter");
  await expect(page.getByText("Anotado: segunda conversación sobre horarios")).toBeVisible({ timeout: 15_000 });

  // El historial lista las dos y deja volver a la primera.
  await page.locator('[data-convi="historial"]').click();
  const lista = page.locator('[data-convi="lista-historial"]');
  await expect(lista).toContainText("primera conversación sobre");
  await expect(lista).toContainText("segunda conversación sobre");

  await lista.getByText("primera conversación sobre").first().click();
  await expect(page.getByText("Anotado: primera conversación sobre precios")).toBeVisible({ timeout: 15_000 });
});

test("si el envío falla, el mensaje queda marcado y se puede reintentar", async ({ page }) => {
  const be = crearBackend();
  await montar(page, be);
  // El primer POST falla; el segundo (el reintento) pasa.
  let fallos = 0;
  await page.route(/:4000\/assistant\/message$/, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
    if (fallos++ === 0) return route.fulfill({ status: 500, headers: CORS, body: "{}" });
    const body = JSON.parse(route.request().postData() ?? "{}") as { message: string; threadId?: string };
    const id = body.threadId ?? be.abierto();
    be.nuevoTurno(id, body.message);
    return responder(route, { reply: `Anotado: ${body.message}`, mode: "asistencia", wrote: false, qa: null, actions: [], degradado: false, threadId: id });
  });
  await page.goto("/canales", { waitUntil: "domcontentloaded" });
  await abrirConvi(page);

  await entrada(page).fill("esto va a fallar la primera vez");
  await entrada(page).press("Enter");
  await expect(page.getByText("No se envió")).toBeVisible({ timeout: 15_000 });

  await page.locator('[data-convi="reintentar"]').click();
  await expect(page.getByText("Anotado: esto va a fallar la primera vez")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("No se envió")).toBeHidden();
});
