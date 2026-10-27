import { getEnv } from "./index.js";

/**
 * MARCA POR ORGANIZACIÓN (F1). La plataforma corre dos marcas comerciales sobre el
 * mismo backend: TuBot (actual) y Conversia (conversia.cl). La marca es un DATO de la
 * organización (`organization.brand`); la config de cada marca es este MAPA. Prohibido
 * `if (org === ...)`: todo texto/link/remitente visible para el tenant o sus clientes
 * se resuelve con `brandOf(org)`. Una org sin marca o con `brand=tubot` se comporta
 * EXACTAMENTE como hoy (los valores de tubot salen del env actual, respetando overrides).
 */
export interface BrandConfig {
  key: string;
  name: string;
  webUrl: string;
  mailFrom: string;
  /** Reply-To de los correos de marca (null = sin Reply-To). Sale de MAIL_REPLY_TO. */
  replyTo: string | null;
  /** Key de Resend de ESTA marca (sus keys están restringidas por dominio). "" = sin envío. */
  resendApiKey: string;
  mfaIssuer: string;
  paymentSubjectPrefix: string;
  userAgent: string;
  logoPath: string;
  /** Rutas de la pantalla de dinero del panel de ESTA marca (los frontends no comparten rutas). */
  billing: BrandBillingConfig;
}

/**
 * Rutas de cobro del panel de una marca. Existen porque los dos frontends NO comparten
 * rutas: TuBot (apps/web) tiene `/billing` y `/settings/plan`; conversia-web tiene `/cobros`
 * y nada más. Mandar a un cliente de Conversia a `/billing` lo deja en un 404 después de
 * pagar (hallazgo 3 de la auditoría 26/27-oct-2026: "el cliente no puede pagar desde su
 * panel"). Las de TuBot son EXACTAMENTE las de hoy y no se tocan.
 */
export interface BrandBillingConfig {
  /** Pantalla de plan/pagos del panel. */
  path: string;
  /** Pantalla a la que vuelve la compra de un paquete de créditos/mensajes. */
  packagesPath: string;
  /** Query del retorno de un checkout PAGADO ("" = sin marca, como TuBot hoy). */
  paidQuery: string;
  /** Query del retorno de un checkout CANCELADO ("" = sin marca, como TuBot hoy). */
  cancelledQuery: string;
  /** Query del retorno del registro de tarjeta: la UI la lee para llamar `confirm-card`. */
  cardQuery: string;
}

/** Valores estáticos por marca (los dinámicos —webUrl/mailFrom/replyTo/resendApiKey— los pone brandOf). */
export const BRANDS: Record<string, Omit<BrandConfig, "webUrl" | "mailFrom" | "replyTo" | "resendApiKey">> = {
  tubot: {
    key: "tubot",
    name: "TuBot",
    mfaIssuer: "TuBot.cl",
    paymentSubjectPrefix: "TuBot",
    userAgent: "TuBot/1.0",
    logoPath: "/brands/tubot-logo.svg",
    // EXACTAMENTE lo de hoy en apps/web (TuBot en producción): /billing, /settings/plan y
    // ?card=1, sin marca de resultado en el retorno del checkout.
    billing: { path: "/billing", packagesPath: "/settings/plan", paidQuery: "", cancelledQuery: "", cardQuery: "card=1" },
  },
  conversia: {
    key: "conversia",
    name: "Conversia",
    mfaIssuer: "Conversia.cl",
    paymentSubjectPrefix: "Conversia",
    userAgent: "Conversia/1.0",
    logoPath: "/brands/conversia-logo.svg",
    // conversia-web NO tiene /billing ni /settings/plan: su pantalla de dinero es /cobros,
    // y lee ?pago=ok|cancelado para no dejar al cliente perdido tras volver de la pasarela.
    billing: { path: "/cobros", packagesPath: "/cobros", paidQuery: "pago=ok", cancelledQuery: "pago=cancelado", cardQuery: "card=1" },
  },
};

/**
 * Config completa de la marca de una organización. Fallback a tubot. Para tubot los
 * valores de remitente/URL salen del env (comportamiento actual, respeta overrides);
 * para conversia, de sus envs propias con fallback seguro para dev/staging.
 */
export function brandOf(org: { brand?: string | null } | null | undefined): BrandConfig {
  const env = getEnv();
  const key = (org?.brand ?? "tubot").toLowerCase();
  if (key === "conversia") {
    return {
      ...BRANDS.conversia,
      webUrl: env.WEB_URL_CONVERSIA ?? env.WEB_URL,
      mailFrom: "Conversia <no-reply@conversia.cl>",
      replyTo: env.MAIL_REPLY_TO || null,
      resendApiKey: env.RESEND_API_KEY_CONVERSIA || env.RESEND_API_KEY,
    };
  }
  return {
    ...BRANDS.tubot,
    webUrl: env.WEB_URL,
    mailFrom: env.RESEND_FROM,
    replyTo: env.MAIL_REPLY_TO || null,
    resendApiKey: env.RESEND_API_KEY,
    mfaIssuer: env.SUPER_ADMIN_MFA_ISSUER, // respeta override actual del env
  };
}

/**
 * Pega una query a una URL que PUEDE ya tener una (`?a=1` → `&b=2`). Las pasarelas
 * añaden sus propias marcas al retorno (`?paid=1`, `?mock_session=…`), así que sin esto
 * un retorno de Conversia (`/cobros?pago=ok`) saldría con dos `?` y el navegador
 * perdería el parámetro. Query vacía → URL tal cual.
 */
export function appendQuery(url: string, query: string): string {
  if (!query) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

/** URLs absolutas de retorno de cobro de una organización (checkout, tarjeta, paquetes). */
export interface BillingReturnUrls {
  /** Pantalla de plan/pagos del panel, sin query (usada también como urlReturn del collect). */
  home: string;
  /** Retorno de un checkout PAGADO. */
  success: string;
  /** Retorno de un checkout CANCELADO/abandonado. */
  cancel: string;
  /** Retorno del registro de tarjeta de Flow (la UI confirma con `subscription/confirm-card`). */
  card: string;
  /** Retorno de la compra de un paquete de créditos/mensajes, pagada. */
  packagesSuccess: string;
  /** Retorno de la compra de un paquete, cancelada. */
  packagesCancel: string;
}

/**
 * Retornos de cobro POR MARCA DE LA ORGANIZACIÓN. Única fuente de verdad: todo
 * `successUrl`/`cancelUrl`/`urlReturn` del módulo de facturación sale de aquí, nunca de
 * una ruta escrita a mano (que es cómo un cliente de Conversia terminaba en el `/billing`
 * de TuBot, inexistente en su panel).
 */
export function billingReturnUrls(org: { brand?: string | null } | null | undefined): BillingReturnUrls {
  const brand = brandOf(org);
  const b = brand.billing;
  const home = `${brand.webUrl}${b.path}`;
  const packages = `${brand.webUrl}${b.packagesPath}`;
  return {
    home,
    success: appendQuery(home, b.paidQuery),
    cancel: appendQuery(home, b.cancelledQuery),
    card: appendQuery(home, b.cardQuery),
    packagesSuccess: appendQuery(packages, b.paidQuery),
    packagesCancel: appendQuery(packages, b.cancelledQuery),
  };
}

/**
 * Marca derivada del Origin por allow-list (NUNCA del body): una petición desde el panel
 * de Conversia (WEB_URL_CONVERSIA) → "conversia"; todo lo demás (incluido TuBot) → "tubot".
 * Así el login/registro/super admin nace con la marca correcta sin confiar en el cliente.
 * Compartido por el auth de tenant y el del super admin (D8).
 */
export function brandFromOrigin(origin: string | undefined): string {
  const env = getEnv();
  // Comparación por FAMILIA DE DOMINIO (hallazgo prod 17-oct-2026): la marca Conversia
  // sirve en app.conversia.cl, conversia.cl y www.conversia.cl (el fix de CORS habilitó
  // el apex/www), pero esta función solo reconocía el valor exacto de WEB_URL_CONVERSIA
  // → registrarse desde conversia.cl creaba la cuenta con marca TUBOT (catálogo, trial
  // y asistente equivocados). Ahora: mismo dominio base (sin app./www.) → conversia.
  // Cualquier otro origen (tubot.cl incluido) sigue cayendo a tubot, como siempre.
  if (origin && env.WEB_URL_CONVERSIA) {
    const baseHost = (u: string): string | null => {
      try { return new URL(u.trim().toLowerCase()).hostname.replace(/^(app|www)\./, ""); } catch { return null; }
    };
    const o = baseHost(origin);
    const c = baseHost(env.WEB_URL_CONVERSIA);
    if (o && c && o === c) return "conversia";
  }
  return "tubot";
}

/**
 * ACENTO DE UI CONVERSIA (F3). Paleta CURADA de 6 acentos seguros (nunca color libre:
 * garantiza contraste y elegancia). El default por país se resuelve al crear la cuenta
 * con Organization.country (el usuario puede cambiarlo luego vía PATCH /me/preferences).
 * Los tokens de color de cada acento (ambos modos) viven en el design system del
 * frontend (apps/conversia-web/app/globals.css); aquí solo el mapa país → acento.
 */
/** Marca por defecto cuando una organización no la tiene puesta (comportamiento histórico). */
export const DEFAULT_BRAND = "tubot";

export interface MessagingFuseKeys {
  /** Contador diario de plantillas enviadas. */
  templateCounter: string;
  /** Bandera "el fusible de plantillas cortó hoy". */
  templateFuse: string;
  /** SETNX para alertar del corte una sola vez. */
  templateAlerted: string;
  serviceCounter: string;
  serviceFuse: string;
  serviceAlerted: string;
}

/**
 * §6.1 — Claves de Redis del fusible de mensajería, POR MARCA.
 *
 * El fusible global es la última red de la plataforma: al cortar, deja a TODOS los
 * tenants sin enviar. Con un contador único compartido, un pico de Conversia cortaba los
 * envíos de TuBot y al revés — marcas distintas, clientes distintos, incidentes que no
 * tienen nada que ver. Cada marca cuenta y corta por su cuenta.
 *
 * TuBot usa las claves SIN sufijo, que son las que están contando AHORA en producción:
 * renombrárselas le reiniciaría el contador del día y le borraría el estado del fusible a
 * mitad de jornada, que es lo único que no se puede hacer con un bot 24/7.
 *
 * Vive acá, y no en el worker, porque hay DOS lectores: el worker las escribe y
 * `/health/fuse` de la API las lee para el monitor externo. Si cada uno armara la clave
 * por su lado, el día que divergan el monitor diría "todo bien" con el fusible cortado.
 */
export function messagingFuseKeys(brand: string | null | undefined, date: string): MessagingFuseKeys {
  const b = (brand ?? DEFAULT_BRAND).trim().toLowerCase() || DEFAULT_BRAND;
  const seg = b === DEFAULT_BRAND ? "" : `${b}:`;
  return {
    templateCounter: `msgcap:g:${seg}${date}`,
    templateFuse: `msgcap:fuse:${seg}${date}`,
    templateAlerted: `msgcap:fuse-alerted:${seg}${date}`,
    serviceCounter: `msgcap:svc:g:${seg}${date}`,
    serviceFuse: `msgcap:svc-fuse:${seg}${date}`,
    serviceAlerted: `msgcap:svc-fuse-alerted:${seg}${date}`,
  };
}

/**
 * §6.1 — Resuelve un tope GLOBAL por marca.
 *
 * Orden: el valor de la marca manda; si no hay, SOLO tubot hereda el valor de la clave
 * sin marca (es el techo que el dueño ya configuró para TuBot, y heredarlo en otra marca
 * le daría a Conversia un límite calculado para el volumen de TuBot); el resto cae al
 * default de entorno.
 *
 * Es una función aparte, y pura, porque es la regla que decide si un fusible corta: se
 * testea sin Redis ni base de datos.
 */
export function resolveBrandCap(
  brand: string | null | undefined,
  values: { perBrand?: number; legacy?: number; fallback: number },
): number {
  const b = (brand ?? DEFAULT_BRAND).trim().toLowerCase() || DEFAULT_BRAND;
  const valido = (n: number | undefined) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined);
  const heredable = b === DEFAULT_BRAND ? valido(values.legacy) : undefined;
  return valido(values.perBrand) ?? heredable ?? values.fallback;
}

export type AccentKey = "menta" | "artico" | "indigo" | "lima" | "oro" | "coral";

export const ACCENTS: AccentKey[] = ["menta", "artico", "indigo", "lima", "oro", "coral"];

const ACCENT_BY_COUNTRY: Record<string, AccentKey> = {
  CL: "menta",
  AR: "artico",
  CO: "oro",
  MX: "lima",
  PE: "coral",
};

/** Acento por defecto según país (editable sin deploy). Resto LATAM/otros → índigo; sin país → menta. */
export function accentForCountry(country: string | null | undefined): AccentKey {
  const c = (country ?? "").toUpperCase();
  if (!c) return "menta";
  return ACCENT_BY_COUNTRY[c] ?? "indigo";
}
