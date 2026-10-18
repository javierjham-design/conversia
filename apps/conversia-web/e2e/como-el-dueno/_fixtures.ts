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
      body: JSON.stringify({ appId: "0", configId: "0", graphVersion: "v21.0", ready: true, mode: "coexistence" }),
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
