import { expect, test, type Page } from "@playwright/test";
// El fixture usa el MISMO tipo que el componente: si el contrato del reporte cambia, esto
// deja de compilar en vez de mentir en verde.
import type { ChequeoDeCanal, ReporteDeCanal } from "@/components/ReporteDeCanal";

/**
 * A2 — CANALES MUESTRA EL REPORTE DE CONEXIÓN.
 *
 * Cada test es uno de los caminos por los que la pantalla se veía igual que antes de
 * conectar (reproducidos en el stack local, ver el PR de A1):
 *   · coexistencia con el número sin publicar → "Conectado ·" sin número;
 *   · canal conectado sin asistente → el pie decía "conecta tu número";
 *   · canal en un estado distinto de `active` → el bloque de conexión se quedaba arriba.
 *
 * Todo va mockeado en el borde HTTP a propósito: este spec corre en el job `e2e-conversia`,
 * donde NO hay API ni base de datos, así que es determinista y no depende de Meta.
 */

type Canal = { id: string; type: string; name: string; status: string; displayPhone: string | null; defaultAgentName: string | null };
type Chequeo = ChequeoDeCanal;

const CHEQUEOS_OK: Chequeo[] = [
  { key: "numero", label: "Tu número está publicado en Meta", ok: true, detail: "+56 9 1234 5678 · Barbería Centro" },
  { key: "token", label: "El acceso con Meta está vigente", ok: true, detail: "Conexión con Meta confirmada." },
  { key: "webhook", label: "Meta nos avisa de tus mensajes", ok: true, detail: "Avisos activos" },
  { key: "asistente", label: "Un asistente atiende este canal", ok: true, detail: "Atiende Recepción" },
  { key: "calidad", label: "Calidad del número", ok: true, detail: "Verde" },
  { key: "cuenta", label: "Tu cuenta de WhatsApp no tiene avisos", ok: true, detail: "Sin avisos en los últimos 7 días" },
];

const REPORTE_SANO: ReporteDeCanal = {
  channelId: "ch1",
  channelType: "WHATSAPP_CLOUD",
  channelName: "WhatsApp +56 9 1234 5678",
  displayPhone: "+56 9 1234 5678",
  verifiedName: "Barbería Centro",
  qualityRating: "GREEN",
  mode: "coexistence",
  coexVerified: true,
  pendingNumber: false,
  wabaId: "999",
  channelStatus: "active",
  tokenHealthy: true,
  accountAlert: null,
  webhookSubscribed: true,
  defaultAgent: { id: "ag1", name: "Recepción" },
  lastInboundAt: null,
  lastOutboundAt: null,
  checks: CHEQUEOS_OK,
};

/** Estado mutable del backend falso: los tests lo cambian entre lecturas. */
function crearEstado(inicial: Partial<ReporteDeCanal> = {}, opts: { canales?: Canal[]; pasoHecho?: boolean; agentes?: Array<{ id: string; name: string }> } = {}) {
  return {
    reporte: { ...REPORTE_SANO, ...inicial },
    canales: opts.canales ?? [{ id: "ch1", type: "WHATSAPP_CLOUD", name: "WhatsApp", status: "active", displayPhone: "+56 9 1234 5678", defaultAgentName: "Recepción" }],
    pasoHecho: opts.pasoHecho ?? true,
    agentes: opts.agentes ?? [{ id: "ag1", name: "Recepción" }],
    patchs: [] as Array<Record<string, unknown>>,
    /** C2 — páginas de Facebook del cliente y lo que se conectó/desconectó. */
    paginas: [] as Array<{ id: string; name: string; pictureUrl: string | null }>,
    conectadas: [] as string[],
    borrados: [] as string[],
    /** Reporte propio de un canal (si no, se usa `reporte`). */
    reportes: {} as Record<string, ReporteDeCanal>,
  };
}
type Estado = ReturnType<typeof crearEstado>;

/**
 * Arnés HTTP. Dos cosas que no son obvias y sin las cuales no funciona nada:
 *
 * 1. **CORS.** La página corre en :3002 y la API en :4000, así que toda respuesta sintetizada
 *    es de otro origen: sin `access-control-allow-origin` el navegador la descarta y el
 *    `catch` del cliente la convierte en "no hay canales". El `authorization` que manda el
 *    cliente obliga además al preflight `OPTIONS`.
 * 2. **Una sola ruta para TODO el origen de la API.** El bundle resuelve la API como
 *    `127.0.0.1:4000` o `localhost:4000` según el build, y la página pide cosas que este
 *    spec no modela (`/assistant/context`, `/auth/google-config`). Con un único manejador no
 *    hay dudas de precedencia de patrones ni ruido de CORS en la consola.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
};
type Ruta = Parameters<Parameters<Page["route"]>[1]>[0];
const responder = (route: Ruta, body: unknown, status = 200) =>
  route.fulfill({ status, headers: { ...CORS, "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * Sesión creíble SIN API: el panel no pide permiso al servidor para pintarse, lee el `exp`
 * del JWT y el techo de 24 h guardados en localStorage (AppShell → `/login?expirada=1`).
 * La firma no se verifica en el cliente, así que basta un JWT con `exp` futuro.
 */
function sesionFalsa(): { token: string; plazo: string } {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return { token: `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "u1", exp })}.firma-de-prueba`, plazo: String(Date.now() + 3600_000) };
}

async function montarApi(page: Page, estado: Estado): Promise<void> {
  await page.route(/connect\.facebook\.net/, (r) => r.abort());
  await page.route(/:4000\//, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS, body: "" });
    const p = new URL(req.url()).pathname;
    if (p === "/auth/me") return responder(route, { user: { emailVerified: true, settings: {} } });
    if (p === "/onboarding") return responder(route, { steps: [{ key: "whatsapp", done: estado.pasoHecho }] });
    if (p === "/agents/assignable") return responder(route, estado.agentes);
    if (p === "/public/meta-config") return responder(route, { appId: "0", configId: "0", graphVersion: "v26.0", ready: true, mode: "coexistence" });
    if (p === "/channels/connection-extras") return responder(route, { preVerifiedPhoneId: null });
    if (p.endsWith("/status")) {
      // El reporte es POR CANAL: devolver el mismo para todos hacía que dos tarjetas
      // distintas compartieran `data-reporte-canal` y el selector encontrara dos.
      const idCanal = p.split("/")[2];
      return responder(route, { ...(estado.reportes[idCanal] ?? estado.reporte), channelId: idCanal });
    }
    if (p.startsWith("/channels") && req.method() === "PATCH") {
      const body = JSON.parse(req.postData() ?? "{}") as { defaultAgentId?: string };
      estado.patchs.push(body);
      const agente = estado.agentes.find((a) => a.id === body.defaultAgentId);
      if (agente) {
        estado.reporte = { ...estado.reporte, defaultAgent: agente };
        estado.canales = estado.canales.map((c) => ({ ...c, defaultAgentName: agente.name }));
        estado.pasoHecho = true;
      }
      return responder(route, { ok: true });
    }
    if (p === "/channels" && req.method() === "GET") return responder(route, estado.canales);
    // C2 — conexión de Instagram/Messenger.
    if (p === "/integrations/meta-crm/oauth/authorize") return responder(route, { url: "https://www.facebook.com/dialog/oauth?mock=1", purpose: "messaging" });
    if (p === "/integrations/meta-crm/pages") return responder(route, estado.paginas);
    const conectar = /^\/integrations\/meta-crm\/pages\/([^/]+)\/connect$/.exec(p);
    if (conectar) {
      estado.conectadas.push(conectar[1]);
      estado.canales = [...estado.canales, { id: "ig1", type: "INSTAGRAM", name: "Instagram · @barberiacentro", status: "active", displayPhone: null, defaultAgentName: "Recepción" }];
      return responder(route, { ok: true, purpose: "messaging", agentesAsignados: 1 });
    }
    if (p.startsWith("/channels/") && req.method() === "DELETE") {
      estado.borrados.push(p.split("/")[2]);
      estado.canales = estado.canales.filter((c) => c.id !== p.split("/")[2]);
      return responder(route, { ok: true });
    }
    // Todo lo demás que la página consulte y este spec no modele.
    return responder(route, {});
  });
  const s = sesionFalsa();
  await page.addInitScript(({ token, plazo }) => {
    try {
      localStorage.setItem("conversia_token", token);
      localStorage.setItem("conversia_session_until", plazo);
    } catch {
      /* modo privado */
    }
  }, s);
}

const tarjeta = (page: Page) => page.locator("[data-reporte-canal]");
const bloqueConectar = (page: Page) => page.getByRole("button", { name: /Conectar mi WhatsApp/i });

test("canal sano: el reporte es lo primero y el bloque de conexión ya no aparece", async ({ page }) => {
  const estado = crearEstado();
  await montarApi(page, estado);
  await page.goto("/canales", { waitUntil: "domcontentloaded" });

  await expect(tarjeta(page)).toBeVisible();
  await expect(tarjeta(page)).toContainText("+56 9 1234 5678");
  await expect(tarjeta(page)).toContainText("Atiende Recepción");
  await expect(tarjeta(page)).toContainText("Activo");
  await expect(tarjeta(page)).toContainText("Barbería Centro");
  await expect(bloqueConectar(page)).toBeHidden();
  // Debajo quedan las dos salidas, en pequeño.
  await expect(page.getByRole("button", { name: "Conectar otro número" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconectar" })).toBeVisible();
});

test("coexistencia sin número publicado: dice «Activándose», no «Conectado ·» a secas", async ({ page }) => {
  // Antes: el encabezado interpolaba `displayPhone` null y quedaba "Conectado ·" sin número,
  // mientras el pie pedía conectar el número que el dueño acababa de conectar.
  const estado = crearEstado(
    { displayPhone: null, pendingNumber: true, verifiedName: null, qualityRating: null, defaultAgent: null, checks: [{ key: "numero", label: "Tu número está publicado en Meta", ok: false, detail: "Meta todavía no publica el número en tu cuenta de WhatsApp. Suele tardar unos minutos.", fix: "No tienes que hacer nada: esta pantalla se actualiza sola en cuanto llegue." }] },
    { canales: [{ id: "ch1", type: "WHATSAPP_CLOUD", name: "WhatsApp (coexistencia)", status: "active", displayPhone: null, defaultAgentName: null }], pasoHecho: false },
  );
  await montarApi(page, estado);
  await page.goto("/canales", { waitUntil: "domcontentloaded" });

  await expect(tarjeta(page)).toContainText("Activándose");
  await expect(tarjeta(page)).toContainText("Meta suele tardar unos minutos");
  await expect(tarjeta(page)).toContainText("No tienes que hacer nada");
  await expect(bloqueConectar(page)).toBeHidden();
  // Y no queda un "Conectado ·" colgando sin número.
  await expect(tarjeta(page)).not.toContainText("Conectado ·");
});

test("cuando Meta publica el número, la pantalla lo muestra sola", async ({ page }, testInfo) => {
  // El refresco es cada 15 s: se comprueba en UN proyecto para no multiplicar la espera.
  test.skip(testInfo.project.name !== "desktop", "basta un navegador para el refresco automático");
  test.setTimeout(70_000);
  const estado = crearEstado(
    { displayPhone: null, pendingNumber: true, defaultAgent: null },
    { canales: [{ id: "ch1", type: "WHATSAPP_CLOUD", name: "WhatsApp (coexistencia)", status: "active", displayPhone: null, defaultAgentName: null }], pasoHecho: false },
  );
  await montarApi(page, estado);
  await page.goto("/canales", { waitUntil: "domcontentloaded" });
  await expect(tarjeta(page)).toContainText("Activándose");

  // Meta publica el número (lo que en producción trae el webhook `phone_number`).
  estado.reporte = { ...estado.reporte, displayPhone: "+56 9 4444 5555", pendingNumber: false };
  await expect(tarjeta(page)).toContainText("+56 9 4444 5555", { timeout: 40_000 });
  await expect(tarjeta(page)).not.toContainText("Activándose");
});

test("canal en un estado que no es «active»: la pantalla NO se ve como antes de conectar", async ({ page }) => {
  // Era la causa (c): `waActive` era la única condición que ocultaba el bloque de conexión.
  const estado = crearEstado(
    { channelStatus: "pending", pendingNumber: false },
    { canales: [{ id: "ch1", type: "WHATSAPP_CLOUD", name: "WhatsApp", status: "pending", displayPhone: "+56 9 1111 2222", defaultAgentName: null }], pasoHecho: false },
  );
  await montarApi(page, estado);
  await page.goto("/canales", { waitUntil: "domcontentloaded" });

  await expect(tarjeta(page)).toBeVisible();
  await expect(bloqueConectar(page)).toBeHidden();
  await expect(tarjeta(page)).toContainText("Activándose");
});

test("conectado sin asistente: el pie lo dice y el botón lo asigna ahí mismo", async ({ page }) => {
  // Era la causa (b): el pie decía "Paso pendiente: conecta tu número" sobre un número ya conectado.
  const estado = crearEstado(
    { defaultAgent: null, checks: [{ key: "asistente", label: "Un asistente atiende este canal", ok: false, detail: "Nadie está asignado a este número, así que los mensajes llegan y quedan sin responder.", fix: "Asigna tu asistente desde esta misma pantalla." }] },
    { canales: [{ id: "ch1", type: "WHATSAPP_CLOUD", name: "WhatsApp", status: "active", displayPhone: "+56 9 1234 5678", defaultAgentName: null }], pasoHecho: false },
  );
  await montarApi(page, estado);
  await page.goto("/canales", { waitUntil: "domcontentloaded" });

  await expect(page.getByText("Conectado, falta asignar el asistente.")).toBeVisible();
  await expect(page.getByText("Paso pendiente: conecta tu número")).toBeHidden();
  await expect(tarjeta(page)).toContainText("quedan sin responder");

  await page.locator('[data-accion="asignar-asistente"]').click();
  await expect(tarjeta(page)).toContainText("Atiende Recepción", { timeout: 15_000 });
  expect(estado.patchs).toEqual([{ defaultAgentId: "ag1" }]);
});

test("«Probar ahora»: espera el mensaje, lo detecta y dice cuánto tardó la respuesta", async ({ page }) => {
  const estado = crearEstado();
  await montarApi(page, estado);
  await page.goto("/canales", { waitUntil: "domcontentloaded" });

  await page.locator('[data-accion="probar-ahora"]').click();
  await expect(tarjeta(page)).toContainText("Escríbele «hola» a tu número desde otro celular");
  await expect(page.getByRole("link", { name: /Abrir el chat/i })).toHaveAttribute("href", /wa\.me\/56912345678/);

  // Llega el mensaje del cliente (en producción, el webhook de Meta).
  estado.reporte = { ...estado.reporte, lastInboundAt: "2026-11-10T14:00:00.000Z" };
  await expect(tarjeta(page)).toContainText("Recibimos tu mensaje", { timeout: 20_000 });

  // Y el asistente responde 7 s después.
  estado.reporte = { ...estado.reporte, lastOutboundAt: "2026-11-10T14:00:07.000Z" };
  await expect(tarjeta(page)).toContainText("tu asistente respondió en 7 s", { timeout: 20_000 });
});

test("A3 — el botón de Convi abre Canales YA probando (?probar=1)", async ({ page }) => {
  // Convi entrega `{kind:"whatsapp_test"}` y el widget navega acá. Si la prueba no arrancara
  // sola, el dueño llegaría a una pantalla cualquiera después de que le dijeron "probemos".
  const estado = crearEstado();
  await montarApi(page, estado);
  await page.goto("/canales?probar=1", { waitUntil: "domcontentloaded" });

  await expect(tarjeta(page)).toContainText("Escríbele «hola» a tu número desde otro celular");
  await expect(page.getByRole("link", { name: /Abrir el chat/i })).toBeVisible();
});

test("los chequeos con fallo muestran qué hacer; lo que no se pudo averiguar NO se pinta como error", async ({ page }) => {
  const estado = crearEstado({
    webhookSubscribed: false,
    checks: [
      { key: "webhook", label: "Meta nos avisa de tus mensajes", ok: false, detail: "Meta no nos está avisando de los mensajes de este número, así que tu asistente no los ve.", fix: "Vuelve a conectar tu WhatsApp: la reconexión deja el aviso configurado." },
      { key: "calidad", label: "Calidad del número", ok: false, unknown: true, detail: "Meta aún no reporta la calidad de este número." },
    ],
  });
  await montarApi(page, estado);
  await page.goto("/canales", { waitUntil: "domcontentloaded" });

  await expect(tarjeta(page)).toContainText("tu asistente no los ve");
  await expect(tarjeta(page)).toContainText("Vuelve a conectar tu WhatsApp");
  // El que no se pudo averiguar se muestra, pero sin "qué hacer" (no hay nada que hacer).
  await expect(tarjeta(page)).toContainText("Meta aún no reporta la calidad");
});

// ─────────────────────────── C2 — Instagram y Messenger ───────────────────────────

/** Reporte de un canal de página (Instagram/Messenger): no tiene número ni calidad. */
const REPORTE_IG: ReporteDeCanal = {
  channelId: "ig1",
  channelType: "INSTAGRAM",
  channelName: "Instagram · @barberiacentro",
  displayPhone: null,
  verifiedName: null,
  qualityRating: null,
  mode: "dedicated",
  coexVerified: false,
  pendingNumber: false,
  wabaId: null,
  channelStatus: "active",
  tokenHealthy: true,
  accountAlert: null,
  webhookSubscribed: true,
  defaultAgent: { id: "ag1", name: "Recepción" },
  lastInboundAt: null,
  lastOutboundAt: null,
  checks: [
    { key: "pagina", label: "Tu página está conectada", ok: true, detail: "Barbería Centro" },
    { key: "webhook", label: "Meta nos avisa de tus mensajes", ok: true, detail: "Avisos activos" },
    { key: "asistente", label: "Un asistente atiende este canal", ok: true, detail: "Atiende Recepción" },
  ],
  reviewApproved: false,
  pageName: "Barbería Centro",
};

test("sin conectar, Instagram y Messenger OFRECEN conectarse (ya no dicen «Próximamente»)", async ({ page }) => {
  const estado = crearEstado();
  await montarApi(page, estado);
  await page.goto("/canales", { waitUntil: "domcontentloaded" });

  await expect(page.locator('[data-accion="conectar-ig"]')).toBeVisible();
  await expect(page.locator('[data-accion="conectar-msj"]')).toBeVisible();
  await expect(page.getByText("Próximamente")).toBeHidden();
  // El requisito se dice ANTES de que el cliente se meta en el diálogo de Meta.
  await expect(page.getByText(/página de Facebook vinculada a tu cuenta de Instagram profesional/i)).toBeVisible();
});

test("al volver de Meta con una sola página, se conecta sola y la tarjeta queda activa", async ({ page }) => {
  const estado = crearEstado();
  estado.paginas = [{ id: "p1", name: "Barbería Centro", pictureUrl: null }];
  estado.reportes.ig1 = REPORTE_IG;
  await montarApi(page, estado);
  await page.goto("/canales?meta=ok", { waitUntil: "domcontentloaded" });

  await expect(page.locator('[data-reporte-canal="ig1"]')).toContainText("Instagram", { timeout: 15_000 });
  await expect(page.locator('[data-reporte-canal="ig1"]')).toContainText("Atiende Recepción");
  expect(estado.conectadas).toEqual(["p1"]);
  // Y la marca `?meta=ok` se limpia de la URL: recargar no debe reconectar.
  await expect(page).toHaveURL(/\/canales$/);
});

test("con varias páginas, el cliente elige cuál", async ({ page }) => {
  const estado = crearEstado();
  estado.paginas = [
    { id: "p1", name: "Barbería Centro", pictureUrl: null },
    { id: "p2", name: "Barbería Sur", pictureUrl: null },
  ];
  estado.reportes.ig1 = REPORTE_IG;
  await montarApi(page, estado);
  await page.goto("/canales?meta=ok", { waitUntil: "domcontentloaded" });

  const seleccion = page.locator('[data-seleccion="paginas"]');
  await expect(seleccion).toBeVisible({ timeout: 15_000 });
  await expect(seleccion).toContainText("Barbería Sur");
  expect(estado.conectadas).toEqual([]); // no conecta nada sin que elija

  await seleccion.getByText("Barbería Sur").click();
  await expect(page.locator('[data-reporte-canal="ig1"]')).toBeVisible({ timeout: 15_000 });
  expect(estado.conectadas).toEqual(["p2"]);
});

test("mientras Meta revisa la app, la tarjeta lo dice con calma", async ({ page }) => {
  const estado = crearEstado({}, {
    canales: [{ id: "ig1", type: "INSTAGRAM", name: "Instagram · @barberiacentro", status: "active", displayPhone: null, defaultAgentName: "Recepción" }],
  });
  estado.reportes.ig1 = REPORTE_IG;
  await montarApi(page, estado);
  await page.goto("/canales", { waitUntil: "domcontentloaded" });

  const aviso = page.locator('[data-aviso="revision-meta"]');
  await expect(aviso).toContainText("Meta está revisando nuestra app");
  await expect(aviso.getByText("Avísame cuando esté listo")).toBeVisible();
  // Nada de prometer lo que todavía no llega.
  await expect(aviso).toContainText("solo recibe los mensajes de cuentas de prueba");
});

test("se puede desconectar un canal de red social", async ({ page }) => {
  const estado = crearEstado({}, {
    canales: [{ id: "ig1", type: "INSTAGRAM", name: "Instagram · @barberiacentro", status: "active", displayPhone: null, defaultAgentName: "Recepción" }],
  });
  estado.reportes.ig1 = REPORTE_IG;
  await montarApi(page, estado);
  await page.goto("/canales", { waitUntil: "domcontentloaded" });

  await page.locator('[data-reporte-canal="ig1"] [data-accion="desconectar"]').click();
  await expect(page.locator('[data-accion="conectar-ig"]')).toBeVisible({ timeout: 15_000 });
  expect(estado.borrados).toEqual(["ig1"]);
});
