/**
 * OAuth de Google: permisos POR FUNCIÓN y app POR MARCA.
 *
 * Todo lo de acá es PURO (recibe el entorno, no lo lee) para poder probarlo sin red y sin
 * variables: lo usan la api (authorize/callback/refresh) y el worker (refresh), y una
 * diferencia entre los dos deja al tenant con un token que no se puede refrescar.
 *
 * Dos problemas que resuelve:
 *
 * 1. **Permisos de más.** Conectar Calendar pedía también `spreadsheets`. En la pantalla de
 *    Google eso se lee como "esta app quiere entrar a tus planillas", asusta al cliente y
 *    obliga a justificar un permiso sensible en la verificación. Ahora cada función pide lo
 *    suyo y Sheets se suma DESPUÉS con autorización incremental (`include_granted_scopes`).
 *
 * 2. **La app dice "TuBot" a los clientes de Conversia.** Si la marca es Conversia y hay
 *    credenciales propias cargadas, se usan esas; si no, las de siempre.
 *
 * ⚠️ REGRESIÓN: las conexiones que ya existen (TuBot) NO tienen `scopes` ni `oauthApp` en su
 * config. Para ellas se asume lo único que podía ser: los 3 permisos viejos y la app por
 * defecto. Si se resolviera la app por marca, una conexión vieja de una org Conversia se
 * intentaría refrescar con credenciales que NO emitieron ese token y se caería.
 */

export const GOOGLE_CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

export const GOOGLE_SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets"] as const;

/** Lo que se pedía antes de separar permisos (calendar.events + calendar.readonly + spreadsheets). */
export const GOOGLE_LEGACY_SCOPES: string[] = [...GOOGLE_CALENDAR_SCOPES, ...GOOGLE_SHEETS_SCOPES];

export type GoogleFeature = "calendar" | "sheets";

/** Permisos que pide una función concreta. */
export function scopesForFeature(feature: GoogleFeature): string[] {
  return feature === "sheets" ? [...GOOGLE_SHEETS_SCOPES] : [...GOOGLE_CALENDAR_SCOPES];
}

/**
 * Permisos para una petición de autorización, según lo que el cliente DECLARÓ.
 *
 * ⚠️ "No declaró función" NO es lo mismo que "calendar": son los permisos de SIEMPRE.
 *
 * El drawer de Google de TuBot (`apps/web`) es una sola tarjeta para Calendar **y** Sheets y
 * llama a `authorize` sin parámetro. Si eso cayera al default `calendar`, un tenant de TuBot
 * que conecte de cero se quedaría sin `spreadsheets` —y sin ninguna pantalla donde pedirlo—,
 * dejando muerto el paso "Añadir fila a Google Sheets" de Workflows. La UI de Conversia sí
 * declara `?feature=calendar`, así que su pantalla de Google sigue sin mencionar planillas,
 * que es el punto de separar permisos.
 *
 * Una función desconocida se RECHAZA (lanza) en vez de degradarse a los tres: un
 * `?feature=calendario` mal escrito no puede terminar pidiendo acceso a las planillas.
 */
export function scopesForAuthorize(feature: string | null | undefined): string[] {
  const declarada = typeof feature === "string" ? feature.trim() : "";
  if (!declarada) return [...GOOGLE_LEGACY_SCOPES];
  if (declarada !== "calendar" && declarada !== "sheets") {
    throw new Error(`Función de Google inválida: ${declarada} (calendar | sheets)`);
  }
  return scopesForFeature(declarada);
}

/** Credenciales de app de Google que se pueden usar. */
export type GoogleOAuthApp = "default" | "conversia";

export interface GoogleOAuthEnv {
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_CONVERSIA_CLIENT_ID?: string;
  GOOGLE_OAUTH_CONVERSIA_CLIENT_SECRET?: string;
}

/** ¿Hay credenciales propias de Conversia cargadas en este servicio? */
export function hasConversiaGoogleApp(env: GoogleOAuthEnv): boolean {
  return Boolean(env.GOOGLE_OAUTH_CONVERSIA_CLIENT_ID && env.GOOGLE_OAUTH_CONVERSIA_CLIENT_SECRET);
}

/**
 * Qué app usar para una conexión NUEVA, según la marca de la org. Conversia solo si además
 * están cargadas sus credenciales; si no, la de siempre (así se despliega sin paso previo).
 */
export function googleOAuthAppForBrand(brand: string | null | undefined, env: GoogleOAuthEnv): GoogleOAuthApp {
  return brand === "conversia" && hasConversiaGoogleApp(env) ? "conversia" : "default";
}

/**
 * Con qué app se emitió un token YA guardado. Sin `oauthApp` en la config la respuesta es
 * `default`: es la única app que existía cuando se guardó (ver la nota de regresión arriba).
 */
export function googleOAuthAppOfConnection(config: unknown): GoogleOAuthApp {
  const raw = config && typeof config === "object" ? (config as Record<string, unknown>).oauthApp : null;
  return raw === "conversia" ? "conversia" : "default";
}

/** client_id/client_secret de una app. `missing` = no están cargadas en este servicio. */
export function googleOAuthCredentials(app: GoogleOAuthApp, env: GoogleOAuthEnv): { clientId: string; clientSecret: string; app: GoogleOAuthApp; missing: boolean } {
  const clientId = (app === "conversia" ? env.GOOGLE_OAUTH_CONVERSIA_CLIENT_ID : env.GOOGLE_OAUTH_CLIENT_ID) ?? "";
  const clientSecret = (app === "conversia" ? env.GOOGLE_OAUTH_CONVERSIA_CLIENT_SECRET : env.GOOGLE_OAUTH_CLIENT_SECRET) ?? "";
  return { clientId, clientSecret, app, missing: !clientId || !clientSecret };
}

/**
 * Permisos realmente otorgados a una conexión. Google los devuelve con el token (`scope`);
 * una conexión anterior a este registro no los tiene guardados y se asume que pidió los 3
 * viejos — que es exactamente lo que hacía el código.
 */
export function grantedScopes(config: unknown): string[] {
  const raw = config && typeof config === "object" ? (config as Record<string, unknown>).scopes : null;
  if (Array.isArray(raw) && raw.length) return raw.map((s) => String(s));
  return [...GOOGLE_LEGACY_SCOPES];
}

/** Parsea el `scope` que devuelve Google ("a b c") a lista. */
export function parseGrantedScopes(scope: unknown): string[] {
  if (typeof scope !== "string" || !scope.trim()) return [];
  return scope.trim().split(/\s+/);
}

/** Permisos que le FALTAN a una conexión para usar una función. */
export function missingScopesForFeature(config: unknown, feature: GoogleFeature): string[] {
  const granted = grantedScopes(config);
  return scopesForFeature(feature).filter((s) => !granted.includes(s));
}

/** ¿La conexión puede usar esta función sin reconectar? */
export function canUseFeature(config: unknown, feature: GoogleFeature): boolean {
  return missingScopesForFeature(config, feature).length === 0;
}
