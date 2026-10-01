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
  mfaIssuer: string;
  paymentSubjectPrefix: string;
  userAgent: string;
  logoPath: string;
}

/** Valores estáticos por marca (los dinámicos —webUrl/mailFrom de tubot— los pone brandOf). */
export const BRANDS: Record<string, Omit<BrandConfig, "webUrl" | "mailFrom">> = {
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
    };
  }
  return {
    ...BRANDS.tubot,
    webUrl: env.WEB_URL,
    mailFrom: env.RESEND_FROM,
    mfaIssuer: env.SUPER_ADMIN_MFA_ISSUER, // respeta override actual del env
  };
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
