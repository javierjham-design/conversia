/**
 * Fixtures de la suite "COMO EL DUEÑO" (PRUEBA REAL en Docker).
 *
 * El navegador hace EXACTAMENTE lo que haría Javier. Todo contra el stack Docker local
 * (`pnpm sim:up`): api :4000, web :3002, postgres :5433. NUNCA contra producción.
 *
 * Marca por Origin (D8, packages/config/src/brands.ts): el servidor fija la marca según el
 * host base del Origin de la petición. En el sim WEB_URL_CONVERSIA=http://localhost:3002, así
 * que:  Origin localhost → "conversia";  cualquier otro host (o sin Origin) → "tubot".
 * El JWT NO lleva la marca (solo orgId), de modo que un token de org tubot autentica igual en
 * conversia-web y el gate del asistente responde 404 por la marca de la BD → reproduce el caso
 * real del pantallazo.
 */
import type { APIRequestContext, Page } from "@playwright/test";

export const SIM_API = process.env.SIM_API || "http://localhost:4000";
/** Host base ≠ localhost → el registro nace con marca tubot (el bug pre-#506 de Javier). */
const ORIGIN_TUBOT = "http://tubot.cl";
const ORIGIN_CONVERSIA = "http://localhost:3002";

export type Account = {
  token: string;
  organizationId: string;
  role: string;
  email: string;
  password: string;
  brand: "tubot" | "conversia";
};

/** Registra una cuenta vía API (fuera del navegador) con la marca que fija el Origin. */
export async function registerAccount(
  request: APIRequestContext,
  opts: { brand: "tubot" | "conversia"; vertical?: string; country?: string; name?: string; org?: string },
): Promise<Account> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const email = `qa+dueno-${opts.brand}-${stamp}@conversia.local`;
  const password = "PruebaRealDueno2026";
  const res = await request.post(`${SIM_API}/auth/register`, {
    headers: {
      "content-type": "application/json",
      // La marca la decide el servidor por este Origin (nunca el body).
      origin: opts.brand === "conversia" ? ORIGIN_CONVERSIA : ORIGIN_TUBOT,
    },
    data: {
      email,
      password,
      name: opts.name ?? "Dueño QA",
      organizationName: opts.org ?? `QA ${opts.brand} ${stamp}`,
      country: opts.country ?? "CL",
      ...(opts.vertical ? { vertical: opts.vertical } : {}),
    },
  });
  if (!res.ok()) throw new Error(`register ${opts.brand} falló: HTTP ${res.status()} — ${await res.text()}`);
  const body = (await res.json()) as { token: string; organizationId: string; role: string };
  return { ...body, email, password, brand: opts.brand };
}

/**
 * Deja la sesión lista en el navegador ANTES del primer paint: inyecta el token en
 * localStorage (misma clave que usa la app) y captura window.open para poder verificar el
 * fallback de soporte sin abrir pestañas reales.
 */
export async function useSession(page: Page, token: string): Promise<void> {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("conversia_token", t);
    } catch {
      /* private mode */
    }
    const w = window as unknown as { __opened: string[]; open: typeof window.open };
    w.__opened = [];
    w.open = ((url?: string | URL) => {
      try {
        w.__opened.push(String(url ?? ""));
      } catch {
        /* noop */
      }
      return null;
    }) as typeof window.open;
  }, token);
}

/** URLs que window.open recibió (el fallback de soporte del asistente). */
export async function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __opened?: string[] }).__opened ?? []);
}

/**
 * Hace que /canales crea que Meta está configurado (botón "Conectar" habilitado) y BLOQUEA el
 * SDK de Facebook → al conectar, la UI cae por el camino "popup/SDK bloqueado" (el del
 * pantallazo). Determinista: no depende de red externa ni de credenciales de Meta.
 */
export async function armarCanalesConPopupBloqueado(page: Page): Promise<void> {
  await page.route("**/public/meta-config**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ appId: "0", configId: "0", graphVersion: "v26.0", ready: true, mode: "coexistence" }),
    }),
  );
  // El SDK de Meta nunca carga → fbReady=false → connect() falla con "¿bloqueador?".
  await page.route(/connect\.facebook\.net/, (route) => route.abort());
}

/** Colector de errores de consola del navegador (regla de la suite: consola limpia). */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

// ───────────────────────── Backstage (simular el entorno real) ─────────────────────────
// Estas acciones representan lo que en producción hacen Meta (conexión del canal) y el cliente
// (escribir por WhatsApp): en el sim no hay Meta real, así que se hacen vía API con el token del
// dueño. El dueño en el navegador hace lo DEMÁS (registro, servicios, Bandeja, /cobros).

type Req = APIRequestContext;
const auth = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

/** GET /auth/me → slug de la organización (lo necesita el inbound mock: phone_number_id mock:<slug>). */
export async function orgSlug(request: Req, token: string): Promise<string> {
  const r = await request.get(`${SIM_API}/auth/me`, { headers: auth(token) });
  if (!r.ok()) throw new Error(`/auth/me falló: ${r.status()}`);
  const me = await r.json();
  const slug = me?.organization?.slug ?? me?.org?.slug;
  if (!slug) throw new Error(`/auth/me no trajo slug: ${JSON.stringify(me).slice(0, 200)}`);
  return slug;
}

/** Conecta un canal WhatsApp MOCK (en prod lo haría Meta). Queda status=active. Pásale el
 * `defaultAgentId` (del agente publicado) o el bot NO responde: la conversación no tendría agente. */
export async function attachMockChannel(request: Req, token: string, opts: { name?: string; defaultAgentId?: string } = {}): Promise<void> {
  const r = await request.post(`${SIM_API}/channels`, {
    headers: auth(token),
    data: { type: "MOCK", name: opts.name ?? "Simulado", ...(opts.defaultAgentId ? { defaultAgentId: opts.defaultAgentId } : {}) },
  });
  if (!r.ok()) throw new Error(`POST /channels MOCK falló: ${r.status()} ${await r.text()}`);
}

/** Publica + activa el agente de la org (nace como borrador) para que el bot responda.
 * Devuelve el id del agente (para asignarlo como default del canal). */
export async function publishPrimaryAgent(request: Req, token: string): Promise<string> {
  const list = await request.get(`${SIM_API}/agents`, { headers: auth(token) });
  if (!list.ok()) throw new Error(`GET /agents falló: ${list.status()}`);
  const agents = await list.json();
  const agent = Array.isArray(agents) ? agents[0] : (agents?.items ?? [])[0];
  if (!agent?.id) throw new Error(`La org no tiene agente para publicar`);
  await request.put(`${SIM_API}/agents/${agent.id}/draft`, {
    headers: auth(token),
    data: { systemPrompt: "Eres el asistente de prueba. Responde breve y amable.", config: {}, tools: [] },
  });
  const pub = await request.post(`${SIM_API}/agents/${agent.id}/publish`, { headers: auth(token), data: {} });
  if (!pub.ok()) throw new Error(`POST /agents/:id/publish falló: ${pub.status()} ${await pub.text()}`);
  await request.post(`${SIM_API}/agents/${agent.id}/active`, { headers: auth(token), data: { active: true } });
  return agent.id;
}

/** Deja la org lista para atender: publica el agente y conecta un canal MOCK con ese agente. */
export async function dejarOperando(request: Req, token: string): Promise<void> {
  const agentId = await publishPrimaryAgent(request, token);
  await attachMockChannel(request, token, { defaultAgentId: agentId });
}

/** Simula que un cliente escribe por WhatsApp (webhook mock de Meta Cloud). */
export async function sendInbound(request: Req, slug: string, text: string, waId = "56911111111"): Promise<void> {
  const body = {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "0",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "56900000000", phone_number_id: `mock:${slug}` },
              contacts: [{ profile: { name: "Cliente Simulado" }, wa_id: waId }],
              messages: [
                {
                  from: waId,
                  id: `wamid.sim.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
  const r = await request.post(`${SIM_API}/webhooks/whatsapp`, {
    headers: { "content-type": "application/json", "x-conversia-mock-token": "dev-mock-inbound-token" },
    data: body,
  });
  if (!r.ok()) throw new Error(`POST /webhooks/whatsapp falló: ${r.status()} ${await r.text()}`);
}

/** Espera (por API, desacoplado del SSE) a que el bot responda; devuelve el id de la conversación. */
export async function waitForBotReply(request: Req, token: string, timeoutMs = 40_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cs = await request.get(`${SIM_API}/conversations?status=all&order=recent`, { headers: auth(token) }).then((r) => r.json());
    const conv = (cs?.items ?? [])[0];
    if (conv?.id) {
      const ms = await request.get(`${SIM_API}/conversations/${conv.id}/messages`, { headers: auth(token) }).then((r) => r.json());
      if ((ms?.messages ?? []).some((m: { direction: string; authorType: string }) => m.direction === "OUTBOUND" && m.authorType === "AGENT")) {
        return conv.id;
      }
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
  throw new Error("El bot no respondió dentro del tiempo esperado");
}

/** Saldo de conversaciones (GET /billing/wallet/summary). */
export async function walletBalance(request: Req, token: string): Promise<number> {
  const r = await request.get(`${SIM_API}/billing/wallet/summary`, { headers: auth(token) });
  if (!r.ok()) throw new Error(`/billing/wallet/summary falló: ${r.status()}`);
  const w = await r.json();
  return Number(w?.balance ?? w?.remaining ?? NaN);
}

/** Recarga un pack de conversaciones por checkout mock (en prod sería la pasarela). */
export async function rechargePack(request: Req, token: string, code: string): Promise<void> {
  await request.post(`${SIM_API}/billing/buy-package`, { headers: auth(token), data: { code } }).catch(() => undefined);
  const r = await request.post(`${SIM_API}/billing/mock-confirm`, { headers: auth(token), data: { planCode: `pkg:${code}` } });
  if (!r.ok()) throw new Error(`POST /billing/mock-confirm falló: ${r.status()} ${await r.text()}`);
}

/** Primer pack de conversación del catálogo conversia (para recargar). */
export async function firstPackCode(request: Req): Promise<string> {
  const r = await request.get(`${SIM_API}/public/conversation-packs?brand=conversia`);
  const packs = await r.json();
  const code = (Array.isArray(packs) ? packs : []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.code;
  if (!code) throw new Error("No hay packs de conversación en el catálogo");
  return code;
}

/** Las 14 claves de rubro (orden alfabético = el de GET /public/verticals en el sim). */
export const RUBROS = [
  "abogados", "barberia", "centro_medico", "dental", "estetica", "generico", "gimnasio",
  "kinesiologia", "medspa", "peluqueria", "psicologia", "servicios_domicilio", "taller", "veterinaria",
] as const;

/**
 * El dueño se registra EN EL NAVEGADOR desde /registro (igual que llegando del apex Conversia).
 * Selecciona el rubro por índice (robusto a los nombres vivos del catálogo). Deja la sesión en
 * /inicio. Devuelve el correo usado.
 */
export async function registrarEnNavegador(
  page: Page,
  opts: { negocio: string; email?: string; nombre?: string; password?: string; rubroIndex?: number },
): Promise<{ email: string; password: string }> {
  const email = opts.email ?? `qa+dueno-a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@conversia.local`;
  const password = opts.password ?? "PruebaRealDueno2026";
  await page.goto("/registro", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Tu nombre").fill(opts.nombre ?? "Dueño QA");
  await page.getByLabel("Nombre del negocio").fill(opts.negocio);
  await page.getByLabel("Correo").fill(email);
  await page.getByLabel(/Contraseña/).fill(password);
  if (opts.rubroIndex != null) {
    await page.locator('form button[type="button"]').nth(opts.rubroIndex).click();
  }
  await page.getByRole("button", { name: /Crear cuenta/i }).click();
  await page.waitForURL(/\/inicio/, { timeout: 25_000 });
  return { email, password };
}

/** Lee el token de sesión que el navegador guardó tras registrarse/loguear. */
export async function tokenFromBrowser(page: Page): Promise<string> {
  const t = await page.evaluate(() => {
    try {
      return localStorage.getItem("conversia_token");
    } catch {
      return null;
    }
  });
  if (!t) throw new Error("No hay token en localStorage (¿registro no completado?)");
  return t;
}
