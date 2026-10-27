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
  },
  conversia: {
    key: "conversia",
    name: "Conversia",
    mfaIssuer: "Conversia.cl",
    paymentSubjectPrefix: "Conversia",
    userAgent: "Conversia/1.0",
    logoPath: "/brands/conversia-logo.svg",
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
